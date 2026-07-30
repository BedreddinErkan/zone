import { describe, expect, it } from 'vitest';
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

const INVEST_INPUT = {
  repoPath: '/repo',
  projectMemoryBlock: '',
  baseMaxIterations: 10,
};

describe('CE.2.1.a: BREVITY RULES in patch-mode system prompt', () => {
  it('patch mode prompt contains "BREVITY RULES" section header', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('BREVITY RULES');
  });

  it('patch mode prompt contains "Default to action over explanation"', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Default to action over explanation');
  });

  it('patch mode prompt contains "do I have enough to act?" decision trigger', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('do I have enough to act?');
  });

  it('Q&A archetype patch prompt does NOT contain "BREVITY RULES" (scope guard)', () => {
    // archetype=question → Q&A/LISTING MODE branch; "action over explanation" is wrong here
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).not.toContain('BREVITY RULES');
  });

  it('investigate mode prompt does NOT contain "BREVITY RULES" (scope guard)', () => {
    const prompt = assembleInvestigationSystemPrompt(INVEST_INPUT);
    expect(prompt).not.toContain('BREVITY RULES');
  });

  it('chat mode prompt does NOT contain "BREVITY RULES" (scope guard — chat uses investigation flow)', () => {
    // POST /api/chat routes to investigation flow (assembleInvestigationSystemPrompt)
    const prompt = assembleInvestigationSystemPrompt(INVEST_INPUT);
    expect(prompt).not.toContain('BREVITY RULES');
  });
});

describe('CE.2.1.d: EFFICIENCY CONTRACT block', () => {
  it('patch prompt contains "EFFICIENCY CONTRACT" header', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('EFFICIENCY CONTRACT');
  });

  it('patch prompt contains cost ceiling figures', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Cost ceiling: $0.50 typical / $1.00 hard');
  });

  it('patch prompt contains read counter cliff', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('5+ reads of the same file is a smell');
  });

  it('patch prompt contains relative iter phrasing (drift-safe)', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('~70% of your budget');
  });

  it('old buried note removed from patch prompt', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).not.toContain('Operate efficiently — the cost ceiling terminates');
  });

  it('Q&A archetype prompt does NOT contain "EFFICIENCY CONTRACT" (scope guard)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).not.toContain('EFFICIENCY CONTRACT');
  });

  it('investigation prompt does NOT contain "EFFICIENCY CONTRACT" (scope guard)', () => {
    const prompt = assembleInvestigationSystemPrompt(INVEST_INPUT);
    expect(prompt).not.toContain('EFFICIENCY CONTRACT');
  });
});

describe('Phase 1: GIT CONTEXT directive scoping', () => {
  it('patch mode prompt contains "GIT CONTEXT"', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('GIT CONTEXT');
  });

  it('Q&A archetype does NOT contain "GIT CONTEXT" (patch-mode only)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).not.toContain('GIT CONTEXT');
  });

  it('investigation archetype does NOT contain "GIT CONTEXT"', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).not.toContain('GIT CONTEXT');
  });
});

describe('R1/R6: DIVERGENCE CHECK directive and investigation archetype preamble', () => {
  it('patch mode contains "DIVERGENCE CHECK"', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('DIVERGENCE CHECK');
  });

  it('investigation archetype contains "DIVERGENCE CHECK"', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).toContain('DIVERGENCE CHECK');
  });

  it('question archetype does NOT contain "DIVERGENCE CHECK" (scope guard)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).not.toContain('DIVERGENCE CHECK');
  });

  it('investigation archetype gets "INVESTIGATION GUIDE" preamble, not "Q&A / LISTING MODE"', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).toContain('INVESTIGATION GUIDE');
    expect(prompt).not.toContain('Q&A / LISTING MODE');
  });

  it('investigation archetype does NOT contain "EFFICIENCY CONTRACT" (scope guard)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation' });
    expect(prompt).not.toContain('EFFICIENCY CONTRACT');
  });

  it('question archetype still gets "Q&A / LISTING MODE" (regression guard)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question' });
    expect(prompt).toContain('Q&A / LISTING MODE');
  });

  it('investigation archetype + planApproved:true gets the default branch instead (read-only suppression fix)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'investigation', planApproved: true });
    expect(prompt).not.toContain('INVESTIGATION GUIDE');
    expect(prompt).toContain('BREVITY RULES');
  });

  it('question archetype + planApproved:true gets the default branch instead (read-only suppression fix)', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, archetype: 'question', planApproved: true });
    expect(prompt).not.toContain('Q&A / LISTING MODE');
    expect(prompt).toContain('BREVITY RULES');
  });
});

describe('summaryFormat preset selection', () => {
  it('compact summaryFormat (explicit) produces the 900-char-cap block + tag present', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, summaryFormat: 'compact' });
    expect(prompt).toContain('hard cap 900 characters');
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
  });

  it('detailed summaryFormat produces the 2500-char block + tag unchanged', () => {
    const prompt = assembleAgentSystemPrompt({ ...PATCH_INPUT, summaryFormat: 'detailed' });
    expect(prompt).toContain('hard cap 2500 characters');
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
    expect(prompt).not.toContain('hard cap 900 characters');
  });

  it('undefined summaryFormat defaults to compact behavior', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('hard cap 900 characters');
    expect(prompt).toContain('[ZONE_VERIFICATION: tests_passed]');
  });
});
