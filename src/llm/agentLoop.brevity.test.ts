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
