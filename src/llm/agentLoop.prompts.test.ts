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
  it('contains FINAL SUMMARY heading and four section markers', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('FINAL SUMMARY');
    expect(prompt).toContain('## What changed');
    expect(prompt).toContain('## Why');
    expect(prompt).toContain('## Tests');
    expect(prompt).toContain('## Notes');
  });

  it('explicitly forbids triple-backtick code fences in summary', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Triple-backtick code fences');
  });

  it('includes natural_completion example and reference to recovery-mode examples', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Example 1');
    expect(prompt).toContain('APPLY_ROLLED_BACK'); // reference line contains keyword
    expect(prompt).toContain('final-summary-recovery-examples.md');
  });

  // CE.2.1.b: Examples 2 + 3 moved to .zone/audits/final-summary-recovery-examples.md
  it('CE.2.1.b: Example 2 body not present in patch prompt', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).not.toContain('Example 2');
  });

  it('CE.2.1.b: Example 3 body not present in patch prompt', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).not.toContain('Example 3');
  });

  it('CE.2.1.b: EXAMPLES section < 600 chars after reduction', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    const examplesStart = prompt.indexOf('EXAMPLES:');
    const examplesEnd = prompt.indexOf('TRUNCATED FILE SECTIONS:');
    const examplesSection = prompt.slice(examplesStart, examplesEnd);
    expect(examplesSection.length).toBeLessThan(600);
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

  it('patch run (default archetype) still gets the four-section contract, including the verification tag', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('FINAL SUMMARY (required');
    expect(prompt).toContain('## What changed');
    expect(prompt).not.toContain('FINAL ANSWER (required');
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
  });

  it('question archetype WITH an approved plan (readOnlyPipelineSuppressed case) still gets the four-section contract', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question', planApproved: true });
    expect(prompt).toContain('FINAL SUMMARY (required');
    expect(prompt).not.toContain('FINAL ANSWER (required');
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
