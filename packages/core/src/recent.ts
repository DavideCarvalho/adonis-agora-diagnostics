import diagnostics_channel from 'node:diagnostics_channel';
import { CHANNEL_PREFIX } from './channel.js';
import { onChannelRegistered, registeredChannels } from './registry.js';
import type { DiagnosticEvent } from './types.js';

/** Default number of events the recent-events buffer keeps. */
export const DEFAULT_RECENT_SIZE = 500;

/** Bytes of serialized payload kept per buffered event. */
export const RECENT_PAYLOAD_BYTES = 2048;

/** One event in the recent-events buffer: the envelope, with its payload bounded and redacted. */
export interface RecentEvent {
  id?: string;
  ts: number;
  lib: string;
  event: string;
  traceId?: string;
  durationMs?: number;
  /** The payload with secret-looking keys replaced, or a `{ truncated, bytes, preview }` cut. */
  payload: unknown;
}

/** Filters for {@link recentEvents}. */
export interface RecentEventsFilter {
  lib?: string;
  /** An exact event name, or a RegExp (the string form `/run\./` is accepted too). */
  event?: string | RegExp;
  traceId?: string;
  /** How many of the newest matches to return (default 20). */
  limit?: number;
}

const SECRET_KEY = /(secret|token|password|passwd|authorization|cookie|api[_-]?key|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
  }
  return out;
}

/** The payload as kept in the buffer: redacted, and cut to {@link RECENT_PAYLOAD_BYTES}. */
export function boundPayload(payload: unknown): unknown {
  let json: string | undefined;
  const safe = redact(payload);
  try {
    json = JSON.stringify(safe);
  } catch {
    return '[unserializable]';
  }
  if (json === undefined) return undefined;
  const bytes = Buffer.byteLength(json);
  if (bytes <= RECENT_PAYLOAD_BYTES) return safe;
  return {
    truncated: true,
    bytes,
    preview: `${Buffer.from(json).subarray(0, RECENT_PAYLOAD_BYTES).toString('utf8')}…`,
  };
}

/**
 * A fixed-size ring of the last events published on every `agora:*` diagnostics channel of this
 * process. Subscribing to every channel turns off `emit`'s no-subscriber fast path, so the buffer is
 * only started where it is wanted (see `recent` in `config/diagnostics.ts`).
 */
export class RecentEventsBuffer {
  readonly size: number;
  #ring: Array<RecentEvent | undefined>;
  #next = 0;
  #count = 0;
  #subscribed: Array<{ name: string; listener: (message: unknown) => void }> = [];
  #offRegistered: (() => void) | null = null;

  constructor(size = DEFAULT_RECENT_SIZE) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(
        `@adonis-agora/diagnostics: recent.size must be a positive integer (got ${String(size)})`,
      );
    }
    this.size = size;
    this.#ring = new Array(size);
  }

  /** Whether the buffer is subscribed to the bus. */
  get started(): boolean {
    return this.#offRegistered !== null;
  }

  /** Subscribe to every current and future `agora:*` channel. Idempotent. */
  start(): void {
    if (this.started) return;
    const subscribe = (name: string) => {
      if (!name.startsWith(`${CHANNEL_PREFIX}:`)) return;
      const listener = (message: unknown) => this.push(message as DiagnosticEvent);
      diagnostics_channel.channel(name).subscribe(listener);
      this.#subscribed.push({ name, listener });
    };
    for (const name of registeredChannels()) subscribe(name);
    this.#offRegistered = onChannelRegistered(subscribe);
  }

  /** Unsubscribe from the bus. The buffered events stay readable. */
  stop(): void {
    this.#offRegistered?.();
    this.#offRegistered = null;
    for (const { name, listener } of this.#subscribed) {
      diagnostics_channel.channel(name).unsubscribe(listener);
    }
    this.#subscribed = [];
  }

  /** Record one envelope (normally called by the bus subscription). Never throws. */
  push(envelope: DiagnosticEvent): void {
    try {
      if (envelope === null || typeof envelope !== 'object') return;
      const entry: RecentEvent = {
        ...(envelope.id !== undefined ? { id: envelope.id } : {}),
        ts: envelope.ts,
        lib: envelope.lib,
        event: envelope.event,
        ...(envelope.traceId !== undefined ? { traceId: envelope.traceId } : {}),
        ...(envelope.durationMs !== undefined ? { durationMs: envelope.durationMs } : {}),
        payload: boundPayload(envelope.payload),
      };
      this.#ring[this.#next] = entry;
      this.#next = (this.#next + 1) % this.size;
      this.#count = Math.min(this.#count + 1, this.size);
    } catch {
      // Recording must never break an emitter.
    }
  }

  /** How many events are buffered. */
  get count(): number {
    return this.#count;
  }

  /** The newest events matching `filter`, newest first. */
  list(filter: RecentEventsFilter = {}): RecentEvent[] {
    const limit = Math.max(1, Math.floor(filter.limit ?? 20));
    const event = toMatcher(filter.event);
    const out: RecentEvent[] = [];
    for (let i = 1; i <= this.#count && out.length < limit; i++) {
      const entry = this.#ring[(this.#next - i + this.size) % this.size];
      if (entry === undefined) continue;
      if (filter.lib !== undefined && entry.lib !== filter.lib) continue;
      if (filter.traceId !== undefined && entry.traceId !== filter.traceId) continue;
      if (event !== undefined && !event(entry.event)) continue;
      out.push(entry);
    }
    return out;
  }

  /** Drop every buffered event. */
  clear(): void {
    this.#ring = new Array(this.size);
    this.#next = 0;
    this.#count = 0;
  }
}

/** `'run.done'` → exact match; `/run\./` (RegExp or its string form) → test. */
function toMatcher(event: string | RegExp | undefined): ((name: string) => boolean) | undefined {
  if (event === undefined || event === '') return undefined;
  if (event instanceof RegExp) return (name) => event.test(name);
  const literal = /^\/(.+)\/([a-z]*)$/.exec(event);
  if (literal) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(literal[1] as string, (literal[2] ?? '').replace(/[gy]/g, ''));
    } catch {
      throw new Error(`invalid event pattern ${event}`);
    }
    return (name) => pattern.test(name);
  }
  return (name) => name === event;
}

let active: RecentEventsBuffer | null = null;

/** Start the process-wide recent-events buffer (the provider does this). Returns it. */
export function startRecentEvents(size = DEFAULT_RECENT_SIZE): RecentEventsBuffer {
  if (active !== null && active.size === size) {
    active.start();
    return active;
  }
  active?.stop();
  active = new RecentEventsBuffer(size);
  active.start();
  return active;
}

/** Stop the process-wide buffer and forget it. */
export function stopRecentEvents(): void {
  active?.stop();
  active = null;
}

/** The process-wide buffer, or `null` when it is not running. */
export function recentEventsBuffer(): RecentEventsBuffer | null {
  return active;
}

/**
 * The last events of this process, newest first, when the recent-events buffer runs (on outside
 * production when the Agora dev tools are installed, or with `recent` in `config/diagnostics.ts`).
 * `[]` otherwise.
 */
export function recentEvents(filter?: RecentEventsFilter): RecentEvent[] {
  return active?.list(filter) ?? [];
}
