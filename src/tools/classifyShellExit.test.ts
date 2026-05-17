import { describe, expect, it } from 'vitest';
import { classifyShellExit } from './classifyShellExit.js';

describe('classifyShellExit', () => {
  it('returns success for exitCode=0 regardless of stdout or cmd', () => {
    const r = classifyShellExit(0, 'anything', 'some command');
    expect(r.classification).toBe('success');
    expect(r.hint).toBeNull();
  });

  it('returns likely_no_matches for exitCode=1 + zero-count stdout + grep-pipe pattern', () => {
    const r = classifyShellExit(1, '0\n', 'grep FAIL | wc -l');
    expect(r.classification).toBe('likely_no_matches');
    expect(r.hint).not.toBeNull();
    expect(r.hint).toContain('grep no-match');
  });

  it('returns failure for exitCode=1 with non-zero-count output (real failure)', () => {
    const r = classifyShellExit(1, '5 errors found', 'npx tsc --noEmit');
    expect(r.classification).toBe('failure');
    expect(r.hint).toBeNull();
  });

  it('returns failure for exitCode=1 with zero-count stdout but no grep-pipe pattern', () => {
    const r = classifyShellExit(1, '0', 'echo hi && exit 1');
    expect(r.classification).toBe('failure');
    expect(r.hint).toBeNull();
  });
});
