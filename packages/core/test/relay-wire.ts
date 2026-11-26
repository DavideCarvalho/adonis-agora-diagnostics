import { createHmac, randomUUID } from 'node:crypto';

/**
 * The Redis relay's shared-secret wire, written out independently of the implementation so the
 * specs pin the format: `s1\n<HMAC-SHA256(key, "s1\n" + body), base64url>\n<body>`, where `key` is
 * `HMAC-SHA256(secret, "agora:diagnostics-relay:<redis channel>")` and `body` is
 * `{ node, id, ts, env }` as JSON.
 */

export const TEST_RELAY_SECRET = 'test-relay-secret-0123456789';
export const RELAY_CHANNEL = 'agora:diagnostics:relay';

export function relayKey(secret = TEST_RELAY_SECRET, channel = RELAY_CHANNEL): Buffer {
  return createHmac('sha256', secret).update(`agora:diagnostics-relay:${channel}`).digest();
}

export function signBody(body: string, secret = TEST_RELAY_SECRET, channel = RELAY_CHANNEL) {
  const tag = createHmac('sha256', relayKey(secret, channel))
    .update(`s1\n${body}`)
    .digest('base64url');
  return `s1\n${tag}\n${body}`;
}

/** A signed relay message, as another process holding `secret` would publish it. */
export function signed(
  node: string,
  env: unknown,
  options: { secret?: string; channel?: string; id?: string; ts?: number } = {},
): string {
  const body = JSON.stringify({
    node,
    id: options.id ?? randomUUID(),
    ts: options.ts ?? Date.now(),
    env,
  });
  return signBody(body, options.secret, options.channel);
}

/** The `{ node, id, ts, env }` body of a shared-secret relay message, without checking it. */
export function bodyOf<T = { node: string; id: string; ts: number; env: unknown }>(raw: string): T {
  const at = raw.indexOf('\n', raw.indexOf('\n') + 1);
  return JSON.parse(raw.slice(at + 1)) as T;
}
