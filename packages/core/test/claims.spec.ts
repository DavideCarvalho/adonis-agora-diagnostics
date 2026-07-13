import { describe, expect, it } from 'vitest';
import { claimDiagnostics, isDiagnosticClaimed } from '../src/claims.js';

describe('diagnostics claims registry', () => {
  it('is unclaimed before any claimDiagnostics call', () => {
    expect(isDiagnosticClaimed('spec-a', 'never-claimed')).toBe(false);
  });

  it('claims every event passed, releasing all of them together', () => {
    const release = claimDiagnostics('spec-b', ['one', 'two']);

    expect(isDiagnosticClaimed('spec-b', 'one')).toBe(true);
    expect(isDiagnosticClaimed('spec-b', 'two')).toBe(true);
    expect(isDiagnosticClaimed('spec-b', 'three')).toBe(false);

    release();

    expect(isDiagnosticClaimed('spec-b', 'one')).toBe(false);
    expect(isDiagnosticClaimed('spec-b', 'two')).toBe(false);
  });

  it('a key claimed twice survives a single release (reference-counted)', () => {
    const releaseFirst = claimDiagnostics('spec-c', ['shared']);
    const releaseSecond = claimDiagnostics('spec-c', ['shared']);

    expect(isDiagnosticClaimed('spec-c', 'shared')).toBe(true);

    releaseFirst();
    expect(isDiagnosticClaimed('spec-c', 'shared')).toBe(true); // second claimant still holds it

    releaseSecond();
    expect(isDiagnosticClaimed('spec-c', 'shared')).toBe(false);
  });

  it('releasing only removes the keys THIS call added, not a sibling key claimed separately', () => {
    const releaseFirst = claimDiagnostics('spec-d', ['a']);
    const releaseSecond = claimDiagnostics('spec-d', ['b']);

    releaseFirst();

    expect(isDiagnosticClaimed('spec-d', 'a')).toBe(false);
    expect(isDiagnosticClaimed('spec-d', 'b')).toBe(true); // untouched by the first release

    releaseSecond();
    expect(isDiagnosticClaimed('spec-d', 'b')).toBe(false);
  });

  it('release() is idempotent — calling it more than once has no extra effect', () => {
    const releaseOuter = claimDiagnostics('spec-e', ['x']);
    const releaseInner = claimDiagnostics('spec-e', ['x']);

    releaseOuter();
    releaseOuter(); // second call must NOT double-decrement the shared refcount

    expect(isDiagnosticClaimed('spec-e', 'x')).toBe(true); // releaseInner's claim still holds

    releaseInner();
    expect(isDiagnosticClaimed('spec-e', 'x')).toBe(false);
  });

  it('shares state through a globalThis singleton, so a second module copy sees the same claims', () => {
    const CLAIMS_KEY = Symbol.for('@agora/diagnostics:claims');
    const slot = (globalThis as Record<symbol, Map<string, number> | undefined>)[CLAIMS_KEY];
    expect(slot).toBeDefined();

    const release = claimDiagnostics('spec-f', ['shared-copy']);
    expect(slot?.get('spec-f:shared-copy')).toBe(1);

    release();
  });
});
