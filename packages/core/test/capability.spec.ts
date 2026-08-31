import { describe, expect, it } from 'vitest';
import {
  assertCapabilityNaming,
  CONTEXT_ACCESSOR,
  capability,
  EMIT_SLOT,
  TRACE_SLOT,
} from '../src/index.js';
import { TRACEPARENT_SLOT } from '../src/otel/traceparent.js';

describe('capability', () => {
  it('mints the canonical @agora/<lib>:<name> Symbol.for token', () => {
    expect(capability('context', 'accessor')).toBe(Symbol.for('@agora/context:accessor'));
    expect(capability('diagnostics', 'emit')).toBe(Symbol.for('@agora/diagnostics:emit'));
  });

  it('returns the same symbol across calls and across copies (Symbol.for identity)', () => {
    expect(capability('otel', 'traceparent')).toBe(capability('otel', 'traceparent'));
    // A second, independently-computed key resolves to the same registered symbol — the mechanism
    // that lets a producer and a consumer in different repos share one token.
    expect(capability('otel', 'traceparent')).toBe(Symbol.for('@agora/otel:traceparent'));
  });
});

describe('assertCapabilityNaming', () => {
  it('passes when every token follows the canonical naming', () => {
    expect(() =>
      assertCapabilityNaming('context', {
        ACCESSOR: capability('context', 'accessor'),
      }),
    ).not.toThrow();
  });

  it('throws, naming the offending export, on a non-canonical token', () => {
    expect(() => assertCapabilityNaming('context', { BAD: Symbol('ad-hoc') })).toThrowError(/BAD/);
  });

  it('throws when a token belongs to a different lib', () => {
    expect(() =>
      assertCapabilityNaming('diagnostics', { ACCESSOR: capability('context', 'accessor') }),
    ).toThrowError(/@agora\/diagnostics:/);
  });

  // Contract: the REAL exported global-slot keys must be minted by capability() and keep their
  // exact, byte-stable wire strings — cross-process global slots resolve them by `Symbol.for`.
  it('every exported slot key is minted by capability() (no hand-rolled drift)', () => {
    expect(() => assertCapabilityNaming('diagnostics', { EMIT_SLOT, TRACE_SLOT })).not.toThrow();
    expect(() => assertCapabilityNaming('context', { CONTEXT_ACCESSOR })).not.toThrow();
    expect(() => assertCapabilityNaming('otel', { TRACEPARENT_SLOT })).not.toThrow();
  });

  it('exported slot keys are byte-identical to their canonical Symbol.for strings', () => {
    expect(EMIT_SLOT).toBe(Symbol.for('@agora/diagnostics:emit'));
    expect(EMIT_SLOT).toBe(capability('diagnostics', 'emit'));
    expect(TRACE_SLOT).toBe(Symbol.for('@agora/diagnostics:trace'));
    expect(TRACE_SLOT).toBe(capability('diagnostics', 'trace'));
    expect(CONTEXT_ACCESSOR).toBe(Symbol.for('@agora/context:accessor'));
    expect(CONTEXT_ACCESSOR).toBe(capability('context', 'accessor'));
    expect(TRACEPARENT_SLOT).toBe(Symbol.for('@agora/otel:traceparent'));
    expect(TRACEPARENT_SLOT).toBe(capability('otel', 'traceparent'));
  });
});
