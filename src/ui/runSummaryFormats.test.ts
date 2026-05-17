import { describe, expect, it } from 'vitest';
import {
  defaultFormatFor,
  formatBrief,
  formatDetailed,
  formatPR,
  formatPrompt,
  formatSlack,
  parseAgentSummary,
  type RunSummaryContext,
} from './runSummaryFormats.js';

const WELL_FORMED = `## What changed
- Added \`omit<T, K>\` utility to \`src/utils/omit.ts\` with type-safe key removal
- Updated barrel export in \`src/utils/index.ts\`

## Why
Completes the symmetry with the existing \`pick\` utility; both share the same generic signature pattern.

## Tests
tests_passed (npm test -- omit, 4 scenarios)

## Notes
None.`;

const MAX_ITER_SUMMARY = `## What changed
- Added \`group\` and \`pluck\` utilities to \`src/utils/collections.ts\`
- Tests added but barrel export update not completed

## Why
Plan called for both utilities plus barrel update; iteration limit hit before all steps finished.

## Tests
not_run (iteration cap reached before verification step)

## Notes
Plan steps "Update src/utils/index.ts barrel" did not complete. Hand-off to a follow-up run recommended.`;

const SUCCESS_CTX: RunSummaryContext = {
  terminationReason: 'natural_completion',
  category: 'success',
  filesChanged: [
    { path: 'src/utils/omit.ts', added: 12, removed: 0 },
    { path: 'src/utils/index.ts', added: 1, removed: 0 },
  ],
  costUsd: 0.42,
  cacheHitPct: 71,
  userFacingMessage: 'Run completed successfully',
};

const WARNING_CTX: RunSummaryContext = {
  terminationReason: 'max_iterations',
  category: 'warning',
  filesChanged: [{ path: 'src/worker/eventSource.ts', added: 25, removed: 5 }],
  costUsd: 0.31,
  cacheHitPct: 68,
  userFacingMessage: 'Hit max iteration limit (12/12). Narrow the task or split.',
};

const ERROR_CTX: RunSummaryContext = {
  terminationReason: 'upstream_unavailable',
  category: 'error',
  filesChanged: [],
  costUsd: 0.04,
  cacheHitPct: 0,
  userFacingMessage: 'The upstream LLM API was unavailable after retries.',
};

// ── parseAgentSummary ──────────────────────────────────────────────────────

describe('parseAgentSummary', () => {
  it('parses well-formed 4-section markdown to isStructured: true', () => {
    const s = parseAgentSummary(WELL_FORMED);
    expect(s.isStructured).toBe(true);
    expect(s.what).toContain('omit');
    expect(s.why).toContain('symmetry');
    expect(s.tests).toContain('tests_passed');
    expect(s.notes).toBe('None.');
  });

  it('isStructured false when fewer than 2 sections found', () => {
    const s = parseAgentSummary('Added some files to the repo. Everything is fine.');
    expect(s.isStructured).toBe(false);
    expect(s.what).toContain('Added some files');
    expect(s.why).toBe('');
    expect(s.tests).toBe('');
  });

  it('strips [ZONE_VERIFICATION: ...] tag before parsing', () => {
    const withTag = WELL_FORMED + '\n[ZONE_VERIFICATION: tests_passed]';
    const s = parseAgentSummary(withTag);
    expect(s.isStructured).toBe(true);
    expect(s.tests).not.toContain('ZONE_VERIFICATION');
    expect(s.what).not.toContain('ZONE_VERIFICATION');
  });

  it('APPLY_ROLLED_BACK in Notes section is preserved naturally', () => {
    const withRollback = `## What changed
- Attempted to refactor \`src/auth/session.ts\`

## Why
SSO work requires the new TokenProvider interface.

## Tests
tests_failed_by_patch (tsc: TS2305)

## Notes
APPLY_ROLLED_BACK. The TokenProvider type must be defined in a prior run.`;
    const s = parseAgentSummary(withRollback);
    expect(s.isStructured).toBe(true);
    expect(s.notes).toContain('APPLY_ROLLED_BACK');
  });

  it('handles case-insensitive section headers', () => {
    const mixed = `## WHAT CHANGED
Some change.

## WHY
Some reason.

## TESTS
tests_passed`;
    const s = parseAgentSummary(mixed);
    expect(s.isStructured).toBe(true);
    expect(s.what).toBe('Some change.');
    expect(s.why).toBe('Some reason.');
  });

  it('handles missing Notes section — notes is empty string', () => {
    const noNotes = `## What changed
- A change

## Why
A reason.

## Tests
tests_passed`;
    const s = parseAgentSummary(noNotes);
    expect(s.isStructured).toBe(true);
    expect(s.notes).toBe('');
  });

  it('returns isStructured: false and raw preserved for empty input', () => {
    const s = parseAgentSummary('');
    expect(s.isStructured).toBe(false);
    expect(s.raw).toBe('');
    expect(s.what).toBe('');
  });
});

// ── formatBrief ────────────────────────────────────────────────────────────

describe('formatBrief', () => {
  it('produces a single-line output with emoji and metrics', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatBrief(s, SUCCESS_CTX);
    expect(result).toContain('✅');
    expect(result).toContain('2 files');
    expect(result).toContain('$0.42');
    expect(result).not.toContain('\n');
  });

  it('uses ⚠️ for warning category', () => {
    const s = parseAgentSummary(MAX_ITER_SUMMARY);
    const result = formatBrief(s, WARNING_CTX);
    expect(result).toContain('⚠️');
  });

  it('falls back gracefully when isStructured is false', () => {
    const s = parseAgentSummary('A quick fix was applied to resolve the issue.');
    const result = formatBrief(s, SUCCESS_CTX);
    expect(result).toContain('✅');
    expect(result).toContain('A quick fix');
  });
});

// ── formatDetailed ─────────────────────────────────────────────────────────

describe('formatDetailed', () => {
  it('renders all 4 sections plus metrics footer', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatDetailed(s, SUCCESS_CTX);
    expect(result).toContain('## What changed');
    expect(result).toContain('## Why');
    expect(result).toContain('## Tests');
    expect(result).toContain('## Notes');
    expect(result).toContain('$0.42');
    expect(result).toContain('71% cached');
  });

  it('omits ## Notes section when notes is empty', () => {
    const noNotes = `## What changed
- A change

## Why
A reason.

## Tests
tests_passed`;
    const s = parseAgentSummary(noNotes);
    const result = formatDetailed(s, SUCCESS_CTX);
    expect(result).not.toMatch(/^## Notes$/m);
  });

  it('renders unstructured input with raw text and footer', () => {
    const s = parseAgentSummary('Some prose summary without sections.');
    const result = formatDetailed(s, SUCCESS_CTX);
    expect(result).toContain('Some prose summary');
    expect(result).toContain('---');
  });
});

// ── formatPR ───────────────────────────────────────────────────────────────

describe('formatPR', () => {
  it('uses GitHub conventions — Summary, Changes, Test plan sections', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatPR(s, SUCCESS_CTX);
    expect(result).toContain('## Summary');
    expect(result).toContain('## Changes');
    expect(result).toContain('## Test plan');
  });

  it('uses <details> fallback when more than 3 files changed', () => {
    const manyCtx: RunSummaryContext = {
      ...SUCCESS_CTX,
      filesChanged: [
        { path: 'a.ts', added: 1, removed: 0 },
        { path: 'b.ts', added: 1, removed: 0 },
        { path: 'c.ts', added: 1, removed: 0 },
        { path: 'd.ts', added: 1, removed: 0 },
      ],
    };
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatPR(s, manyCtx);
    expect(result).toContain('<details>');
    expect(result).toContain('1 more files');
  });

  it('marks test checkbox [x] when tests_passed', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatPR(s, SUCCESS_CTX);
    expect(result).toContain('[x]');
  });

  it('marks test checkbox [ ] when not_run', () => {
    const s = parseAgentSummary(MAX_ITER_SUMMARY);
    const result = formatPR(s, WARNING_CTX);
    expect(result).toContain('[ ]');
  });
});

// ── formatSlack ────────────────────────────────────────────────────────────

describe('formatSlack', () => {
  it('uses ✅ for success category', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatSlack(s, SUCCESS_CTX);
    expect(result).toContain('✅');
  });

  it('uses ⚠️ for warning category', () => {
    const s = parseAgentSummary(MAX_ITER_SUMMARY);
    const result = formatSlack(s, WARNING_CTX);
    expect(result).toContain('⚠️');
  });

  it('uses 🔴 for error category', () => {
    const errSummary = `## What changed
(none)

## Why
Upstream unavailable.

## Tests
not_run`;
    const s = parseAgentSummary(errSummary);
    const result = formatSlack(s, ERROR_CTX);
    expect(result).toContain('🔴');
  });

  it('does not contain ## markdown headers', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatSlack(s, SUCCESS_CTX);
    expect(result).not.toMatch(/^##/m);
  });

  it('uses bullet • for what-changed items', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatSlack(s, SUCCESS_CTX);
    expect(result).toContain('•');
  });
});

// ── formatPrompt ───────────────────────────────────────────────────────────

describe('formatPrompt', () => {
  it('includes [INSERT FOLLOWUP TASK HERE] placeholder', () => {
    const s = parseAgentSummary(WELL_FORMED);
    const result = formatPrompt(s, SUCCESS_CTX);
    expect(result).toContain('[INSERT FOLLOWUP TASK HERE]');
  });

  it('opens with halted-before-change message for error + 0 files changed', () => {
    const errSummary = `## What changed
(none)

## Why
API down.

## Tests
not_run`;
    const s = parseAgentSummary(errSummary);
    const result = formatPrompt(s, ERROR_CTX);
    expect(result).toContain('halted before any code change');
    expect(result).toContain('[INSERT FOLLOWUP TASK HERE]');
  });

  it('includes "Do not re-do" constraint for warning category', () => {
    const s = parseAgentSummary(MAX_ITER_SUMMARY);
    const result = formatPrompt(s, WARNING_CTX);
    expect(result).toContain('Do not re-do the work above');
  });

  it('handles isStructured: false gracefully', () => {
    const s = parseAgentSummary('Something was done to fix the issue.');
    const result = formatPrompt(s, SUCCESS_CTX);
    expect(result).toContain('[INSERT FOLLOWUP TASK HERE]');
    expect(result).toContain('Something was done');
  });
});

// ── defaultFormatFor ───────────────────────────────────────────────────────

describe('defaultFormatFor', () => {
  it('returns detailed for natural_completion', () => {
    expect(defaultFormatFor('success', 'natural_completion')).toBe('detailed');
  });

  it('returns prompt for max_iterations', () => {
    expect(defaultFormatFor('warning', 'max_iterations')).toBe('prompt');
  });

  it('returns prompt for token_budget_exceeded', () => {
    expect(defaultFormatFor('warning', 'token_budget_exceeded')).toBe('prompt');
  });

  it('returns prompt for compaction_exhausted', () => {
    expect(defaultFormatFor('error', 'compaction_exhausted')).toBe('prompt');
  });

  it('returns brief for upstream_unavailable', () => {
    expect(defaultFormatFor('error', 'upstream_unavailable')).toBe('brief');
  });

  it('returns brief for revision_approval_timeout', () => {
    expect(defaultFormatFor('neutral', 'revision_approval_timeout')).toBe('brief');
  });

  it('returns detailed for APPLY_ROLLED_BACK', () => {
    expect(defaultFormatFor('error', 'APPLY_ROLLED_BACK')).toBe('detailed');
  });

  it('falls back to detailed for unknown success reason', () => {
    expect(defaultFormatFor('success', 'unknown_reason')).toBe('detailed');
  });

  it('falls back to brief for unknown error reason', () => {
    expect(defaultFormatFor('error', 'unknown_reason')).toBe('brief');
  });
});
