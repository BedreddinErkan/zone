import { describe, expect, it, beforeEach } from 'vitest';
import {
  assembleAgentSystemPrompt,
  assembleInvestigationSystemPrompt,
} from './agentLoop.js';

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
