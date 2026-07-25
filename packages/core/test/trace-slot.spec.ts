import { describe, expect, it } from 'vitest';
import { TRACE_SLOT, trace } from '../src/index.js';

describe('TRACE_SLOT', () => {
  it('publishes trace on the @agora/diagnostics:trace global slot', () => {
    expect(TRACE_SLOT).toBe(Symbol.for('@agora/diagnostics:trace'));
    expect((globalThis as Record<symbol, unknown>)[TRACE_SLOT]).toBe(trace);
  });
});
