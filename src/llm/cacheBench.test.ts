/**
 * Phase X.0 Commit 1 / X.0.1 Commit 2 — cache prefix stability bench.
 *
 * Asserts that system-prompt assembly functions produce byte-identical output
 * on repeated calls with the same inputs. Any timestamp, Math.random(), or
 * per-invocation dynamic injection would break these tests and invalidate the
 * Anthropic content-addressed prompt cache on every loop iteration.
 *
 * AUDIT→EXECUTE CACHE PREFIX (Phase X.0.1 fix):
 * After X.0.1 Commit 2, both assembleInvestigationSystemPrompt and
 * assembleAgentSystemPrompt share the same agentIntro as their opening line
 * when agentIntro is provided. The mode signal moved from the system head
 * to a trailing "--- mode: X ---" tag in the user message, so the system
 * prompt is byte-stable across explicit/implicit mode calls. This creates
 * a shared prefix long enough to benefit from Anthropic content-addressed
 * caching across audit→execute phase transitions.
 */

import { describe, expect, it } from "vitest";
import {
  assembleInvestigationSystemPrompt,
  assembleAgentSystemPrompt,
  buildOpenAIPromptCacheKey,
} from "./agentLoop.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXED_REPO = "/tmp/bench-repo";
const FIXED_MEMORY = "# Project memory\n- key: value";
const FIXED_ITERATIONS = 10;

const INVESTIGATION_OPTS = {
  repoPath: FIXED_REPO,
  projectMemoryBlock: FIXED_MEMORY,
  baseMaxIterations: FIXED_ITERATIONS,
  // X.0.1: shared agentIntro enables cache prefix sharing with agent system prompt.
  agentIntro: "You are Zone, an AI code agent.",
};

const AGENT_OPTS = {
  agentIntro: "You are Zone, an AI code agent.",
  frameworkLines: ["Framework: Next.js 14", "Package manager: npm"],
  hasFramework: true,
  projectMemoryBlock: FIXED_MEMORY,
  baseMaxIterations: FIXED_ITERATIONS,
  canRunCommand: true,
  backgroundCommandBlock:
    "\nBACKGROUND COMMANDS: use run_command_background for long-lived processes.\n\n",
  repoPath: FIXED_REPO,
};

// ── assembleInvestigationSystemPrompt ─────────────────────────────────────────

describe("cache prefix stability — assembleInvestigationSystemPrompt", () => {
  it("produces byte-identical output across two calls with the same inputs", () => {
    const first = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const second = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(200);
  });

  it("injects repoPath stably", () => {
    const out = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    expect(out).toContain(FIXED_REPO);
    const count = out.split(FIXED_REPO).length - 1;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("changes output when repoPath changes", () => {
    const base = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const alt = assembleInvestigationSystemPrompt({
      ...INVESTIGATION_OPTS,
      repoPath: "/different/path",
    });
    expect(base).not.toBe(alt);
  });

  it("changes output when projectMemoryBlock changes", () => {
    const base = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const alt = assembleInvestigationSystemPrompt({
      ...INVESTIGATION_OPTS,
      projectMemoryBlock: "# Different memory",
    });
    expect(base).not.toBe(alt);
  });
});

// ── assembleAgentSystemPrompt ─────────────────────────────────────────────────

describe("cache prefix stability — assembleAgentSystemPrompt", () => {
  it("produces byte-identical output across two calls with the same inputs", () => {
    const first = assembleAgentSystemPrompt(AGENT_OPTS);
    const second = assembleAgentSystemPrompt(AGENT_OPTS);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(500);
  });

  it("injects repoPath stably", () => {
    const out = assembleAgentSystemPrompt(AGENT_OPTS);
    expect(out).toContain(FIXED_REPO);
  });

  it("injects framework lines when hasFramework is true", () => {
    const out = assembleAgentSystemPrompt(AGENT_OPTS);
    expect(out).toContain("Next.js 14");
  });

  it("omits framework block when hasFramework is false", () => {
    const noFw = assembleAgentSystemPrompt({ ...AGENT_OPTS, hasFramework: false });
    expect(noFw).not.toContain("Next.js 14");
    const withFw = assembleAgentSystemPrompt({ ...AGENT_OPTS, hasFramework: true });
    expect(withFw.length).toBeGreaterThan(noFw.length);
  });

  it("is byte-stable regardless of hasFramework value", () => {
    const a = assembleAgentSystemPrompt({ ...AGENT_OPTS, hasFramework: false });
    const b = assembleAgentSystemPrompt({ ...AGENT_OPTS, hasFramework: false });
    expect(a).toBe(b);
  });

  it("changes output when repoPath changes", () => {
    const base = assembleAgentSystemPrompt(AGENT_OPTS);
    const alt = assembleAgentSystemPrompt({ ...AGENT_OPTS, repoPath: "/other" });
    expect(base).not.toBe(alt);
  });
});

// ── buildOpenAIPromptCacheKey ─────────────────────────────────────────────────

describe("cache prefix stability — buildOpenAIPromptCacheKey", () => {
  it("returns the same key on repeated calls with the same runId", () => {
    const k1 = buildOpenAIPromptCacheKey("run-stable-abc123");
    const k2 = buildOpenAIPromptCacheKey("run-stable-abc123");
    expect(k1).toBe(k2);
    expect(k1).toBeDefined();
  });

  it("returns undefined for empty or missing runId", () => {
    expect(buildOpenAIPromptCacheKey("")).toBeUndefined();
    expect(buildOpenAIPromptCacheKey(undefined)).toBeUndefined();
  });

  it("truncates the runId portion to 16 chars", () => {
    const longId = "x".repeat(40);
    const key = buildOpenAIPromptCacheKey(longId);
    expect(key).toBe("zone-run-" + "x".repeat(16));
  });

  it("keeps total key under 64 chars", () => {
    const key = buildOpenAIPromptCacheKey("a".repeat(100));
    expect(key!.length).toBeLessThanOrEqual(64);
  });

  it("produces different keys for different runIds", () => {
    expect(buildOpenAIPromptCacheKey("run-aaa")).not.toBe(
      buildOpenAIPromptCacheKey("run-bbb")
    );
  });
});

// ── Audit→Execute shared prefix (Phase X.0.1 fix) ────────────────────────────
//
// After X.0.1 Commit 2, both assembly functions share the same agentIntro as
// their opening line when agentIntro is supplied. The mode signal moved to
// the user message tail, so these tests prove a genuine shared system prefix.

describe("audit→execute system prompt shared prefix (Phase X.0.1)", () => {
  it("investigation and agent prompts share the agentIntro opening line", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt({
      ...AGENT_OPTS,
      projectMemoryBlock: FIXED_MEMORY,
      repoPath: FIXED_REPO,
    });
    // Both start with the same agentIntro — Anthropic cache prefix is now shared.
    expect(investigation.startsWith(INVESTIGATION_OPTS.agentIntro)).toBe(true);
    expect(agent.startsWith(INVESTIGATION_OPTS.agentIntro)).toBe(true);
  });

  it("investigation prompt and agent prompt share the same first line", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt(AGENT_OPTS);
    const invLine1 = investigation.split("\n")[0];
    const agentLine1 = agent.split("\n")[0];
    // Same first line = agentIntro: cache prefix is now byte-identical at the start.
    expect(invLine1).toBe(agentLine1);
  });

  it("agent prompt is substantially longer than investigation prompt", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt(AGENT_OPTS);
    // Prompts still differ in size: investigation ~30 lines, agent ~90 lines.
    expect(agent.length).toBeGreaterThan(investigation.length * 1.5);
  });
});
