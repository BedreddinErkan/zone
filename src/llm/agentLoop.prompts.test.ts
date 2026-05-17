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

  it('includes few-shot examples covering success, max_iterations, and APPLY_ROLLED_BACK', () => {
    const prompt = assembleAgentSystemPrompt(PATCH_INPUT);
    expect(prompt).toContain('Example 1');
    expect(prompt).toContain('Example 2');
    expect(prompt).toContain('Example 3');
    expect(prompt).toContain('APPLY_ROLLED_BACK');
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
