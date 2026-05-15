/**
 * Phase X.0 Commit 1 — cache prefix stability bench.
 *
 * Asserts that system-prompt assembly functions produce byte-identical output
 * on repeated calls with the same inputs. Any timestamp, Math.random(), or
 * per-invocation dynamic injection would break these tests and invalidate the
 * Anthropic content-addressed prompt cache on every loop iteration.
 *
 * AUDIT→EXECUTE CACHE GAP (documented here, not a failing assertion):
 * assembleInvestigationSystemPrompt and assembleAgentSystemPrompt produce
 * fundamentally different documents — ~30 lines (read-only investigation
 * rules) vs ~90 lines (patch rules, plan visibility, subagent guidance).
 * MODE_SYSTEM_PROMPT_PREFIX (~3 sentences, ~50 tokens) is prepended to both
 * when an explicit mode is set, but it does not create a shared prefix because
 * the remainder diverges entirely. The Anthropic content-addressed cache will
 * never hit across audit→execute phase transitions until the prompt bodies are
 * unified. That unification is tracked in Phase X.1.
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

// ── Audit→Execute divergence (documented, not a regression test) ─────────────
//
// These tests confirm and quantify the cache gap between audit and execute
// phases. They are informational — if X.1 unifies the system prompt prefix,
// update them to assert a shared prefix rather than full inequality.

describe("audit→execute system prompt divergence (Phase X.1 prerequisite)", () => {
  it("investigation prompt differs from agent prompt for the same repo/memory", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt({
      ...AGENT_OPTS,
      projectMemoryBlock: FIXED_MEMORY,
      repoPath: FIXED_REPO,
    });
    expect(investigation).not.toBe(agent);
  });

  it("investigation prompt opening line differs from agent prompt opening line", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt(AGENT_OPTS);
    const invLine1 = investigation.split("\n")[0];
    const agentLine1 = agent.split("\n")[0];
    // Both begin "You are Zone" but diverge immediately after — no shared prefix
    // long enough to benefit from Anthropic's content-addressed cache.
    expect(invLine1).not.toBe(agentLine1);
  });

  it("agent prompt is substantially longer than investigation prompt", () => {
    const investigation = assembleInvestigationSystemPrompt(INVESTIGATION_OPTS);
    const agent = assembleAgentSystemPrompt(AGENT_OPTS);
    // Document the size ratio so regressions (accidental shrinkage) are visible.
    expect(agent.length).toBeGreaterThan(investigation.length * 1.5);
  });
});
