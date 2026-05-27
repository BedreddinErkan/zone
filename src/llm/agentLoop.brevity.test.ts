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
