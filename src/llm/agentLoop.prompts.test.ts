import { describe, expect, it, beforeEach } from 'vitest';
import {
  assembleAgentSystemPrompt,
  assembleInvestigationSystemPrompt,
  buildCoachingPrompt,
  type SelfCorrectTrigger,
} from './agentLoop.js';
import { ZONE_TOOLS } from '../tools/toolDefinitions.js';

const PATCH_INPUT = {
  agentIntro: 'You are Zone, a coding agent.',
  frameworkLines: [],
  hasFramework: false,
  projectMemoryBlock: '',
  baseMaxIterations: 25,
  canRunCommand: false,
  backgroundCommandBlock: '',
  repoPath: '/repo',
};

describe('toolAbsenceBlock omitted: no literal "undefined" splice', () => {
  // PATCH_INPUT above never carried toolAbsenceBlock — it predates the field. When
  // that field was added as required (69630cb0), every direct call site like this
  // one silently passed `undefined`, and `input.toolAbsenceBlock +` string-coerced
  // it into a literal 9-character "undefined" spliced into the assembled prompt.
  // tsc --noEmit never caught it (tsconfig excludes *.test.ts), and no existing
  // assertion in this file happened to inspect that exact region of the string —
  // the fourteen call sites that omit the field are the finding; this is the test
  // that would have caught it, not just the ?? "" fallback that fixes it.
  it('assembleAgentSystemPrompt(PATCH_INPUT) contains no literal "undefined"', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).not.toContain('undefined');
  });
});

describe('UI.6.1: patch prompt FINAL SUMMARY block', () => {
  it('patch summary is free-form: no fixed section list, headings gone, tag block untouched', () => {
    // Scoped to the summary block itself, not the whole prompt: "## Tests" also appears
    // legitimately and unconditionally in the BREVITY RULES block further down ("...or the
    // ## Tests line. Brevity never touches tool payloads or verification output.") —
    // a whole-prompt not.toContain would false-fail against that unrelated, untouched line.
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    const summaryStart = prompt.indexOf('FINAL SUMMARY (required');
    const summaryEnd = prompt.indexOf('TRUNCATED FILE SECTIONS:');
    expect(summaryStart).toBeGreaterThan(-1);
    const summaryBlock = prompt.slice(summaryStart, summaryEnd);
    expect(summaryBlock).toContain('no fixed section list');
    expect(summaryBlock).toContain('REQUIRED — every summary states');
    expect(summaryBlock).not.toContain('## What changed');
    expect(summaryBlock).not.toContain('## Tests');
  });

  it('explicitly forbids triple-backtick code fences in summary', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Triple-backtick code fences');
  });

  // Carries forward the one lesson from the old EXAMPLES block the REQUIRED bullets don't
  // already cover in prose: what to WRITE when a run ends with a rolled-back patch and
  // nothing net-applied. See buildPatchSummary's own comment in agentLoop.ts for why the
  // other two old examples (natural_completion, max_iterations) were dropped rather than
  // carried forward too.
  it('carries a short example demonstrating a rolled-back/no-net-change outcome', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('rolled back');
    expect(prompt).toContain('nothing applied');
  });
});

describe('UI.6.2: read-only archetypes get the answer contract, patch keeps four-section', () => {
  // "FINAL SUMMARY (required" heads both patch templates and appears in neither the answer
  // contract nor anywhere else — the discriminator between the two. Not "## What changed":
  // ANSWER_SUMMARY names that section in its own FORBIDDEN list, so asserting its absence
  // would match the prompt's own forbid-instruction text against itself (same reasoning as
  // agentLoop.readOnlySuppressionTelemetry.test.ts's existing answer-contract test).
  it('question archetype (no answer-only plan) gets FINAL ANSWER, not the four-section contract', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).toContain('FINAL ANSWER (required');
    expect(prompt).not.toContain('FINAL SUMMARY (required');
  });

  it('investigation archetype (no answer-only plan) gets FINAL ANSWER, not the four-section contract', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).toContain('FINAL ANSWER (required');
    expect(prompt).not.toContain('FINAL SUMMARY (required');
  });

  it('patch run (default archetype) still gets the free-form patch contract, including the verification tag', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('FINAL SUMMARY (required');
    expect(prompt).toContain('REQUIRED — every summary states');
    expect(prompt).not.toContain('FINAL ANSWER (required');
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
  });

  it('question archetype WITH an approved plan (readOnlyPipelineSuppressed case) still gets the free-form patch contract', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question', planApproved: true });
    expect(prompt).toContain('FINAL SUMMARY (required');
    expect(prompt).not.toContain('FINAL ANSWER (required');
  });

  // isReadOnlyArchetype-based tests above only exercise the OR condition's second
  // disjunct. Nothing previously called assembleAgentSystemPrompt with answerOnly:true
  // directly, so a mutation that dropped `input.answerOnly ||` from the guard would very
  // likely pass undetected — this closes that gap.
  it('answerOnly:true selects ANSWER_SUMMARY directly, not via isReadOnlyArchetype', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, answerOnly: true });
    expect(prompt).toContain('FINAL ANSWER (required');
    expect(prompt).not.toContain('FINAL SUMMARY (required');
  });

  // The FINAL ASSESSMENT block (the [ZONE_VERIFICATION] tag demand) used to be gated on
  // input.answerOnly alone, independently of the summary-contract ternary immediately
  // above it — a read-only archetype with no approved plan got ANSWER_SUMMARY (whose own
  // FORBIDDEN list bars a "## Tests" section) while still being told to include one of
  // five test-outcome tags. These three are new, separate tests — not additions to the
  // three archetype tests above — so a mutation to isReadOnlyArchetype's own predicate
  // (which also gates the summary-contract ternary) can break those existing tests as
  // real collateral without that collateral silently becoming this gate's own evidence.
  it('question archetype (no answer-only plan) does NOT get the verification-tag demand, and gets the answer contract\'s forbidden-Tests line', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).not.toContain('[ZONE_VERIFICATION: tests_passed]');
    expect(prompt).toContain('A "## Tests" or "## What changed" section');
  });

  it('investigation archetype (no answer-only plan) does NOT get the verification-tag demand', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).not.toContain('[ZONE_VERIFICATION: tests_passed]');
  });

  it('question archetype WITH an approved plan still gets the verification-tag demand (planApproved nulls isReadOnlyArchetype)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question', planApproved: true });
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
  });
});

// Full SelfCorrectTrigger union (19 values) — kept as a literal array rather than derived,
// since TS unions aren't enumerable at runtime. If a trigger is added to the type without
// being added here, the sweep below silently stops covering it — no compiler signal exists
// for that gap.
const ALL_TRIGGERS: SelfCorrectTrigger[] = [
  'test_failed',
  'apply_patch_find_not_found',
  'apply_patch_multiple_matches',
  'apply_patch_semantic_smell',
  'apply_patch_syntax_broken_post_write',
  'apply_patch_repeated_failure_same_file',
  'apply_patch_pre_existing_broken',
  'apply_patch_scope_not_found',
  'apply_patch_replace_shorter_than_find',
  'apply_patch_find_block_empty',
  'apply_patch_empty_replace_no_intent',
  'apply_patch_marker_imbalance',
  'apply_patch_no_read_first',
  'apply_patch_content_before_find',
  'apply_patch_no_valid_blocks',
  'tool_command_spawn_failure',
  'tool_path_enoent',
  'read_file_nonexistent',
  'unknown',
];

const FIND_MARKER = '--- FIND ---';
const REPLACE_MARKER = '--- REPLACE ---';

interface CoachingSource {
  label: string;
  text: string;
}

/**
 * Collects every distinct string buildCoachingPrompt can emit, plus the apply_patch tool's
 * two description fields. PROVIDER_AGNOSTIC_HARDENING is gated on
 * `!options?.model || HARDENING_TARGETS.has(options.model)` — undefined and a real
 * HARDENING_TARGETS member both include it, any other model excludes it — so collecting
 * under only one model value would leave the excluded variant (and, for test_failed, the
 * variant reachable only with generatedPathDetected:true) invisible to the sweep. Dedup by
 * exact text: most triggers don't vary by these options at all.
 */
function collectCoachingSources(): CoachingSource[] {
  const modelVariants: Array<{ label: string; model: string | undefined }> = [
    { label: 'model=undefined', model: undefined },
    { label: 'model=gpt-4o(hardening-target)', model: 'gpt-4o' },
    { label: 'model=claude-opus-5(non-target)', model: 'claude-opus-5' },
  ];
  const seen = new Map<string, string>();
  for (const trigger of ALL_TRIGGERS) {
    // generatedPathDetected only matters for test_failed — it gates a second branch that
    // itself carries the hardening suffix. Sweeping it for every trigger would be harmless
    // (inert elsewhere) but this stays explicit about why it varies here specifically.
    const genPathStates = trigger === 'test_failed' ? [false, true] : [false];
    for (const mv of modelVariants) {
      for (const generatedPathDetected of genPathStates) {
        const text = buildCoachingPrompt(trigger, '', [], { model: mv.model, generatedPathDetected });
        if (!seen.has(text)) {
          seen.set(text, `${trigger} (${mv.label}, generatedPathDetected=${generatedPathDetected})`);
        }
      }
    }
  }

  const sources: CoachingSource[] = [...seen.entries()].map(([text, label]) => ({ label, text }));

  const applyPatchTool = ZONE_TOOLS.find((t) => t.function.name === 'apply_patch');
  const patchParamDescription = (
    applyPatchTool?.function.parameters as { properties?: { patch?: { description?: string } } } | undefined
  )?.properties?.patch?.description;
  sources.push({ label: 'apply_patch tool description', text: applyPatchTool?.function.description ?? '' });
  sources.push({ label: 'apply_patch patch parameter description', text: patchParamDescription ?? '' });

  return sources;
}

/**
 * A line carrying exactly one marker literal is block-shaped and must start at column zero.
 * A line carrying two is the inline form (out of scope). A line carrying one marker
 * embedded in a larger sentence — e.g. "...include them in `--- REPLACE ---`:" — is neither:
 * found empirically while building this sweep (apply_patch_content_before_find's own,
 * already-correct coaching text triggered a false positive under the literal one-marker
 * rule), so "block-shaped" additionally requires the marker to be the whole line, trimmed —
 * a prose sentence that merely names a marker inline is a third shape, not a delimiter line,
 * and needs no anchoring.
 */
function findColumnZeroViolations(sources: CoachingSource[]): { violations: string[]; blockShapedLineCount: number } {
  const violations: string[] = [];
  let blockShapedLineCount = 0;
  for (const { label, text } of sources) {
    for (const line of text.split('\n')) {
      const findCount = (line.match(/--- FIND ---/g) ?? []).length;
      const replaceCount = (line.match(/--- REPLACE ---/g) ?? []).length;
      if (findCount + replaceCount !== 1) continue;
      const marker = findCount === 1 ? FIND_MARKER : REPLACE_MARKER;
      if (line.trim() !== marker) continue; // prose mention, not a delimiter line
      blockShapedLineCount += 1;
      if (!line.startsWith(marker)) {
        violations.push(`${label}: ${JSON.stringify(line)}`);
      }
    }
  }
  return { violations, blockShapedLineCount };
}

describe('patch-format teaching surfaces: no indented block-shaped FIND/REPLACE marker', () => {
  // Measured at HEAD post-fix: 16 block-shaped marker lines across 24 distinct sources.
  // Floor set with a margin below that, not at it — a legitimate future wording change
  // that drops a line or two shouldn't make this test fragile, but a collection that finds
  // near-zero real content (the vacuous-pass failure mode this control exists to catch)
  // still fails loudly.
  const MIN_BLOCK_SHAPED_LINES = 12;

  it('every collected coaching/tool-schema source is a non-empty string', () => {
    const sources = collectCoachingSources();
    const empty = sources.filter((s) => s.text.length === 0).map((s) => s.label);
    expect(empty).toEqual([]);
  });

  it('sweep finds a real, substantial number of block-shaped marker lines (plausibility floor)', () => {
    const { blockShapedLineCount } = findColumnZeroViolations(collectCoachingSources());
    expect(blockShapedLineCount).toBeGreaterThanOrEqual(MIN_BLOCK_SHAPED_LINES);
  });

  it('no block-shaped FIND/REPLACE marker line is indented, across every trigger and both tool-schema description fields', () => {
    const { violations } = findColumnZeroViolations(collectCoachingSources());
    expect(violations).toEqual([]);
  });
});

describe('PROVIDER_AGNOSTIC_HARDENING legibility: each label is followed by a blank line before its block', () => {
  const LABELS = ['CORRECT removal:', 'INCORRECT (comment-out is NOT a fix):'];

  function hardeningText(): string {
    // undefined model satisfies the `!options?.model` disjunct — includes the suffix.
    return buildCoachingPrompt('apply_patch_syntax_broken_post_write', '', [], { model: undefined });
  }

  it('both labels are present in the hardening text (plausibility floor)', () => {
    const text = hardeningText();
    const found = LABELS.filter((label) => text.includes(label));
    expect(found).toEqual(LABELS);
  });

  it('each label is immediately followed by a blank line before its FIND/REPLACE block', () => {
    const text = hardeningText();
    const lines = text.split('\n');
    const violations: string[] = [];
    for (const label of LABELS) {
      const labelLineIdx = lines.findIndex((l) => l === label);
      if (labelLineIdx === -1) {
        violations.push(`label not found on its own line: ${JSON.stringify(label)}`);
        continue;
      }
      if (lines[labelLineIdx + 1] !== '') {
        violations.push(`no blank line after ${JSON.stringify(label)} — next line was ${JSON.stringify(lines[labelLineIdx + 1])}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// UI.6.3 ("## Tests enum stays parseable by the real parser") deleted, not retargeted.
// It protected the ## Tests heading's enum staying in sync with parseVerificationTag's
// accepted values — a duplicate elicitation this task removed by design (deriveVerdict
// only ever reads the [ZONE_VERIFICATION] tag; the heading never fed it). Nothing
// comparable remains to retarget it to: the FINAL ASSESSMENT block's own 5-value list is
// a separate, untouched contract with a different value count and purpose.

describe('UI.6.4: summaryFormat interpolates both the token range and the char cap together', () => {
  it('compact pairs 150-300 tokens with the 900-char cap', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, summaryFormat: 'compact' });
    expect(prompt).toContain('150-300 tokens; hard cap 900 characters');
  });

  it('detailed pairs 300-500 tokens with the 2500-char cap', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, summaryFormat: 'detailed' });
    expect(prompt).toContain('300-500 tokens; hard cap 2500 characters');
  });
});

describe('WEB_SEARCH_DIRECTIVE — unconditional in both prompt modes', () => {
  it('is present in patch mode (default archetype)', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('WEB SEARCH:');
  });

  it('is present in Q&A/listing mode (archetype: question)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).toContain('WEB SEARCH:');
  });

  it('is present in investigation mode', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).toContain('WEB SEARCH:');
  });
});

describe('D1: VERIFIER SHELL DISCIPLINE block in patch prompt', () => {
  it('contains VERIFIER SHELL DISCIPLINE header, PRIORITY RULE, and both few-shot examples', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('VERIFIER SHELL DISCIPLINE');
    expect(prompt).toContain('PRIORITY RULE');
    expect(prompt).toContain('Example A');
    expect(prompt).toContain('Example B');
    expect(prompt).toContain('no matches found');
  });
});

describe('UI.6.1: investigation prompt slim FINAL SUMMARY variant', () => {
  it('contains slim FINAL SUMMARY line without structured section contract', () => {
    const prompt = assembleInvestigationSystemPrompt({
      repoPath: '/repo',
      projectMemoryBlock: '',
      baseMaxIterations: 10,
    });
    expect(prompt).toContain('FINAL SUMMARY');
    expect(prompt).not.toContain('## What changed');
    expect(prompt).not.toContain('Triple-backtick code fences');
  });
});

describe('RC1-fix: commandTool param — investigation prompt tool/mandate variants', () => {
  const BASE = { repoPath: '/repo', projectMemoryBlock: '', baseMaxIterations: 6 };

  describe('commandTool: "run_command" (plan investigation)', () => {
    let prompt: string;
    beforeEach(() => {
      prompt = assembleInvestigationSystemPrompt({ ...BASE, commandTool: 'run_command' });
    });

    it('lists run_command in tools (not run_command_readonly)', () => {
      expect(prompt).toContain('run_command');
      expect(prompt).not.toContain('run_command_readonly');
    });

    it('does NOT contain the "Do not call run_command" forbid line', () => {
      expect(prompt).not.toContain('Do not call run_command');
    });

    it('contains REPRODUCE-FIRST MANDATE with MUST wording', () => {
      expect(prompt).toContain('REPRODUCE-FIRST MANDATE');
      expect(prompt).toContain('MUST');
    });

    it('contains the NO PROBLEM FOUND valid-outcome block', () => {
      expect(prompt).toContain('NO PROBLEM FOUND');
    });

    it('does NOT contain fixInstruction (INVESTIGATION_OUTPUT_FORMAT suppressed)', () => {
      expect(prompt).not.toContain('fixInstruction');
    });

    it('references ExecutionPlan no-change outcome (noChangeReason)', () => {
      expect(prompt).toContain('noChangeReason');
    });

    it('A2: contains BARE directive (metachars block auto-approval)', () => {
      expect(prompt).toContain('BARE');
      expect(prompt).toContain('2>&1');
    });

    it('B1: contains STOP directive for unrunnable commands', () => {
      expect(prompt).toContain('STOP');
      expect(prompt).toContain('did not run');
    });

    it('B1: contains cannotVerifyReason field reference', () => {
      expect(prompt).toContain('cannotVerifyReason');
    });

    it('B1: Process steps are gated on ONLY AFTER', () => {
      expect(prompt).toContain('ONLY AFTER');
    });
  });

  describe('commandTool: "run_command_readonly" (scope-audit)', () => {
    let prompt: string;
    beforeEach(() => {
      prompt = assembleInvestigationSystemPrompt({ ...BASE, commandTool: 'run_command_readonly' });
    });

    it('lists run_command_readonly in tools (not run_command)', () => {
      expect(prompt).toContain('run_command_readonly');
      expect(prompt).not.toMatch(/^- run_command:/m);
    });

    it('contains "Do not call run_command" forbid line', () => {
      expect(prompt).toContain('Do not call run_command');
    });

    it('contains REPRODUCE-FIRST MANDATE', () => {
      expect(prompt).toContain('REPRODUCE-FIRST MANDATE');
    });

    it('contains fixInstruction (INVESTIGATION_OUTPUT_FORMAT kept)', () => {
      expect(prompt).toContain('fixInstruction');
    });

    it('contains NO PROBLEM FOUND block', () => {
      expect(prompt).toContain('NO PROBLEM FOUND');
    });
  });

  describe('commandTool: null (HTTP/chat investigation)', () => {
    let prompt: string;
    beforeEach(() => {
      prompt = assembleInvestigationSystemPrompt({ ...BASE, commandTool: null });
    });

    it('does NOT reference run_command or run_command_readonly', () => {
      expect(prompt).not.toContain('run_command_readonly');
      expect(prompt).not.toMatch(/- run_command:/);
    });

    it('does NOT contain REPRODUCE-FIRST MANDATE (no command tool)', () => {
      expect(prompt).not.toContain('REPRODUCE-FIRST MANDATE');
    });

    it('contains NO PROBLEM FOUND block (honest-outcome always present)', () => {
      expect(prompt).toContain('NO PROBLEM FOUND');
    });

    it('contains fixInstruction (INVESTIGATION_OUTPUT_FORMAT kept)', () => {
      expect(prompt).toContain('fixInstruction');
    });

    it('R2: suppressOutputFormat:true suppresses INVESTIGATION_OUTPUT_FORMAT (rootCause field absent)', () => {
      const suppressed = assembleInvestigationSystemPrompt({ ...BASE, commandTool: null, suppressOutputFormat: true });
      // "rootCause" is unique to the JSON schema block — not present in noProblemBlock
      expect(suppressed).not.toContain('rootCause');
    });

    it('R2: suppressOutputFormat:true also suppresses noProblemBlock', () => {
      const suppressed = assembleInvestigationSystemPrompt({ ...BASE, commandTool: null, suppressOutputFormat: true });
      // "VALID TERMINAL OUTCOME" is unique to noProblemBlock — not in INVESTIGATION_OUTPUT_FORMAT
      expect(suppressed).not.toContain('VALID TERMINAL OUTCOME');
    });
  });

  describe('commandTool: undefined (backward-compat default)', () => {
    it('behaves like null: no run_command line, no mandate, keeps output format', () => {
      const prompt = assembleInvestigationSystemPrompt({ ...BASE });
      expect(prompt).not.toContain('run_command_readonly');
      expect(prompt).not.toContain('REPRODUCE-FIRST MANDATE');
      expect(prompt).toContain('fixInstruction');
      expect(prompt).toContain('NO PROBLEM FOUND');
    });
  });
});
