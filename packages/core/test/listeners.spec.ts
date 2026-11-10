import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelName, emit } from '../src/channel.js';
import type { ListenerDelivery } from '../src/delivery.js';
import {
  bindListenerInvoker,
  createListenerInvoker,
  getListenerInvoker,
  startListenerDispatch,
  UnknownListenerError,
} from '../src/listener_dispatch.js';
import {
  decoratedMethodsOf,
  getListener,
  type ListenerClass,
  listenersFor,
  loadListeners,
  OnDiagnostic,
  registeredListeners,
  registerListenerClass,
  resetListeners,
} from '../src/listeners.js';
import { resetRegistry } from '../src/registry.js';
import { publishRelayed } from '../src/relayed.js';
import { onDiagnostic, unsubscribeAll } from '../src/subscriber.js';
import { trace } from '../src/trace.js';
import type { DiagnosticEvent } from '../src/types.js';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const make = (target: ListenerClass) => new (target as unknown as new () => object)();

describe('envelope id', () => {
  afterEach(() => resetRegistry());

  it('emit stamps a unique uuid on every envelope', () => {
    const seen: DiagnosticEvent[] = [];
    const listener = (msg: unknown) => seen.push(msg as DiagnosticEvent);
    diagnostics_channel.channel(channelName('billing', 'paid')).subscribe(listener);
    emit('billing', 'paid', { n: 1 });
    emit('billing', 'paid', { n: 2 });
    diagnostics_channel.channel(channelName('billing', 'paid')).unsubscribe(listener);

    expect(seen.map((e) => e.id)).toEqual([
      expect.stringMatching(UUID),
      expect.stringMatching(UUID),
    ]);
    expect(seen[0]?.id).not.toBe(seen[1]?.id);
  });

  it('trace stamps an id on every phase event', () => {
    const ids: unknown[] = [];
    const listener = (msg: unknown) => ids.push((msg as { id?: unknown }).id);
    const start = diagnostics_channel.channel('agora:billing:charge:start');
    const end = diagnostics_channel.channel('agora:billing:charge:end');
    start.subscribe(listener);
    end.subscribe(listener);
    trace('billing', 'charge', () => 1);
    start.unsubscribe(listener);
    end.unsubscribe(listener);

    expect(ids).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
  });
});

describe('@OnDiagnostic', () => {
  afterEach(() => resetListeners());

  it('records decorated methods (experimentalDecorators)', () => {
    class TrackRuns {
      @OnDiagnostic('agent', 'run.finished')
      async finished(_event: DiagnosticEvent) {}

      @OnDiagnostic('agent', /^tool\./)
      tool(_event: DiagnosticEvent) {}

      @OnDiagnostic('billing')
      all(_event: DiagnosticEvent) {}
    }

    expect(decoratedMethodsOf(TrackRuns)).toEqual([
      { lib: 'agent', event: 'run.finished', method: 'finished' },
      { lib: 'agent', event: /^tool\./, method: 'tool' },
      { lib: 'billing', event: undefined, method: 'all' },
    ]);
  });

  it('records decorated methods (standard decorators, through decorator metadata)', () => {
    class Listener {
      handle(_event: DiagnosticEvent) {}
    }
    const metadata: Record<symbol, unknown> = {};
    const decorate = OnDiagnostic('agent', 'run.finished') as unknown as (
      value: unknown,
      context: unknown,
    ) => void;
    decorate(Listener.prototype.handle, {
      kind: 'method',
      name: 'handle',
      static: false,
      private: false,
      metadata,
      addInitializer() {},
      access: {},
    });
    const metadataKey = (Symbol as { metadata?: symbol }).metadata ?? Symbol.for('Symbol.metadata');
    (Listener as unknown as Record<symbol, unknown>)[metadataKey] = metadata;

    expect(decoratedMethodsOf(Listener)).toEqual([
      { lib: 'agent', event: 'run.finished', method: 'handle' },
    ]);
  });

  it('does not leak a subclass method into its parent', () => {
    class Parent {
      @OnDiagnostic('agent', 'a')
      a(_event: DiagnosticEvent) {}
    }
    class Child extends Parent {
      @OnDiagnostic('agent', 'b')
      b(_event: DiagnosticEvent) {}
    }

    expect(decoratedMethodsOf(Parent).map((m) => m.method)).toEqual(['a']);
    expect(decoratedMethodsOf(Child).map((m) => m.method)).toEqual(['a', 'b']);
  });
});

describe('listener registry', () => {
  afterEach(() => resetListeners());

  class Listener {
    handle(_event: DiagnosticEvent) {}
    other(_event: DiagnosticEvent) {}
  }

  it('registers a [Class, method] reference under <ClassName>#<method>', () => {
    onDiagnostic('agent', 'run.finished', [Listener, 'handle']);
    expect(registeredListeners().map((l) => l.id)).toEqual(['Listener#handle']);
  });

  it('accepts an explicit id and a lib-wide reference', () => {
    onDiagnostic('agent', [Listener, 'other'], { id: 'agent-audit' });
    expect(getListener('agent-audit')).toMatchObject({ lib: 'agent', event: undefined });
  });

  it('rejects two different listeners with the same id', () => {
    onDiagnostic('agent', 'a', [Listener, 'handle'], { id: 'x' });
    expect(() => onDiagnostic('agent', 'a', [Listener, 'other'], { id: 'x' })).toThrow(
      /share the id "x"/,
    );
  });

  it('ignores the exact same registration twice', () => {
    onDiagnostic('agent', 'a', [Listener, 'handle']);
    onDiagnostic('agent', 'a', [Listener, 'handle']);
    expect(registeredListeners()).toHaveLength(1);
  });

  it('rejects a method that does not exist', () => {
    expect(() => onDiagnostic('agent', 'a', [Listener, 'nope'])).toThrow(/not a method/);
  });

  it('resolves lazy references at boot, then right away', async () => {
    onDiagnostic('agent', 'a', [async () => ({ default: Listener }), 'handle']);
    expect(registeredListeners()).toHaveLength(0);
    await loadListeners();
    expect(registeredListeners().map((l) => l.id)).toEqual(['Listener#handle']);

    class Late {
      run(_event: DiagnosticEvent) {}
    }
    onDiagnostic('agent', 'b', [async () => ({ default: Late }), 'run']);
    await nextTurn();
    expect(getListener('Late#run')).toBeDefined();
  });

  it('fails boot when a lazy reference does not export a class', async () => {
    onDiagnostic('agent', 'a', [
      async () => ({ default: 1 as unknown as ListenerClass }),
      'handle',
    ]);
    await expect(loadListeners()).rejects.toThrow(/does not default-export a class/);
  });

  it('registers decorated classes with a path id and matches exact, pattern and lib-wide', () => {
    class Track {
      @OnDiagnostic('agent', 'run.finished')
      exact(_event: DiagnosticEvent) {}
      @OnDiagnostic('agent', /^run\./)
      pattern(_event: DiagnosticEvent) {}
      @OnDiagnostic('agent')
      all(_event: DiagnosticEvent) {}
    }
    registerListenerClass(Track, 'app/listeners/diagnostics/track');

    const ids = (event: string) => listenersFor('agent', event).map((l) => l.id);
    expect(ids('run.finished')).toEqual([
      'app/listeners/diagnostics/track#exact',
      'app/listeners/diagnostics/track#pattern',
      'app/listeners/diagnostics/track#all',
    ]);
    expect(ids('run.started')).toEqual([
      'app/listeners/diagnostics/track#pattern',
      'app/listeners/diagnostics/track#all',
    ]);
    expect(ids('tool.called')).toEqual(['app/listeners/diagnostics/track#all']);
    expect(listenersFor('billing', 'run.finished')).toEqual([]);
  });
});

describe('listener dispatch', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    calls.length = 0;
    unsubscribeAll();
    resetListeners();
    resetRegistry();
    bindListenerInvoker(null);
  });

  const calls: Array<{ method: string; event: DiagnosticEvent }> = [];
  class Track {
    @OnDiagnostic('agent', 'run.finished')
    finished(event: DiagnosticEvent) {
      calls.push({ method: 'finished', event });
    }
    @OnDiagnostic('agent')
    async boom(_event: DiagnosticEvent) {
      throw new Error('boom');
    }
  }

  it('runs listeners in-process without a delivering transport, and logs a failing one', async () => {
    registerListenerClass(Track, 'track');
    const onListenerError = vi.fn();
    const invoke = createListenerInvoker(make);
    stop = startListenerDispatch({ invoke, onListenerError, onDeliveryError: vi.fn() });

    expect(() => emit('agent', 'run.finished', { ok: true })).not.toThrow();
    await nextTurn();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toMatchObject({
      lib: 'agent',
      event: 'run.finished',
      payload: { ok: true },
    });
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), 'track#boom', calls[0]?.event);
  });

  it('keeps function observers and raw channel subscribers working next to listeners', async () => {
    registerListenerClass(Track, 'track');
    const observed = vi.fn();
    const raw = vi.fn();
    onDiagnostic('agent', 'run.finished', observed);
    diagnostics_channel.channel('agora:agent:run.finished').subscribe(raw);
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      onListenerError: () => {},
      onDeliveryError: vi.fn(),
    });

    emit('agent', 'run.finished', { ok: true });
    await nextTurn();
    diagnostics_channel.channel('agora:agent:run.finished').unsubscribe(raw);

    expect(observed).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('does not deliver trace span phases to a lib-wide listener', async () => {
    registerListenerClass(Track, 'track');
    const onListenerError = vi.fn();
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      onListenerError,
      onDeliveryError: vi.fn(),
    });
    trace('agent', 'step', () => 1);
    await nextTurn();
    expect(onListenerError).not.toHaveBeenCalled();
  });

  it('hands origin events to a delivering transport, once per listener and turn', async () => {
    registerListenerClass(Track, 'track');
    const batches: ListenerDelivery[][] = [];
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      deliver: (deliveries) => {
        batches.push([...deliveries]);
      },
      onListenerError: vi.fn(),
      onDeliveryError: vi.fn(),
    });

    emit('agent', 'run.finished', { n: 1 });
    emit('agent', 'run.started', { n: 2 });
    expect(batches).toEqual([]); // off the emitter's stack
    await nextTurn();

    expect(calls).toEqual([]); // the transport owns execution
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((d) => [d.listenerId, d.envelope.event])).toEqual([
      ['track#finished', 'run.finished'],
      ['track#boom', 'run.finished'],
      ['track#boom', 'run.started'],
    ]);
    expect(batches[0]?.[0]?.envelope.id).toMatch(UUID);
    expect(batches[0]?.[0]?.envelope.id).toBe(batches[0]?.[1]?.envelope.id);
  });

  it('never delivers a relayed copy of an event', async () => {
    registerListenerClass(Track, 'track');
    const deliver = vi.fn();
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      deliver,
      onListenerError: vi.fn(),
      onDeliveryError: vi.fn(),
    });
    const relayed: DiagnosticEvent = {
      v: 1,
      id: 'from-another-process',
      ts: Date.now(),
      lib: 'agent',
      event: 'run.finished',
      payload: {},
    };
    publishRelayed(relayed, () =>
      diagnostics_channel.channel('agora:agent:run.finished').publish(relayed),
    );
    await nextTurn();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('reports a rejected delivery without throwing', async () => {
    registerListenerClass(Track, 'track');
    const onDeliveryError = vi.fn();
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      deliver: async () => {
        throw new Error('queue down');
      },
      onListenerError: vi.fn(),
      onDeliveryError,
    });
    emit('agent', 'run.finished', {});
    await nextTurn();
    await nextTurn();
    expect(onDeliveryError).toHaveBeenCalledWith(expect.any(Error), expect.any(Array));
  });

  it('subscribes channels of listeners registered after dispatch started', async () => {
    stop = startListenerDispatch({
      invoke: createListenerInvoker(make),
      onListenerError: () => {},
      onDeliveryError: vi.fn(),
    });
    registerListenerClass(Track, 'track');
    emit('agent', 'run.finished', {});
    await nextTurn();
    expect(calls).toHaveLength(1);
  });
});

describe('listener invoker', () => {
  afterEach(() => {
    resetListeners();
    bindListenerInvoker(null);
  });

  it('rejects with the handler error, so a transport can retry', async () => {
    class Failing {
      run(_event: DiagnosticEvent) {
        throw new Error('nope');
      }
    }
    onDiagnostic('agent', 'a', [Failing, 'run']);
    const invoke = createListenerInvoker(make);
    await expect(invoke('Failing#run', {} as DiagnosticEvent)).rejects.toThrow('nope');
  });

  it('rejects with E_UNKNOWN_DIAGNOSTICS_LISTENER for an id this process does not know', async () => {
    const invoke = createListenerInvoker(make);
    const error = await invoke('missing#handle', {} as DiagnosticEvent).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownListenerError);
    expect((error as UnknownListenerError).code).toBe('E_UNKNOWN_DIAGNOSTICS_LISTENER');
  });

  it('is published on a global slot for code without the transport context', () => {
    const invoke = createListenerInvoker(make);
    const unbind = bindListenerInvoker(invoke);
    expect(getListenerInvoker()).toBe(invoke);
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for('@agora/diagnostics:listener-invoker')],
    ).toBe(invoke);
    unbind();
    expect(getListenerInvoker()).toBeNull();
  });
});
