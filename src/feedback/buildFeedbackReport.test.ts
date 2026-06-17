import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFeedbackReport } from "./buildFeedbackReport.js";

const SESSION_ID = "test-session-abc123";
const RUN_ID = "run-abc12345def6";

function writeConversationTurn(
  repoPath: string,
  sessionId: string,
  turn: Record<string, unknown>,
): void {
  const dir = path.join(repoPath, ".zone", "conversations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(turn) + "\n", "utf8");
}

function writeCostLog(costLogDir: string, runId: string, summary: Record<string, unknown>): void {
  fs.mkdirSync(costLogDir, { recursive: true });
  const prefix = runId.slice(0, 8);
  fs.writeFileSync(
    path.join(costLogDir, `2026-06-17T00-00-00-000Z-${prefix}.jsonl`),
    JSON.stringify(summary) + "\n",
    "utf8",
  );
}

let tmpDirs: string[] = [];

function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zone-fb-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tmpDirs = [];
});

describe("buildFeedbackReport", () => {
  it("full: matching turn + cost-log → markdown and URLs contain expected data", async () => {
    const repoPath = mkTmpDir();
    const costLogDir = mkTmpDir();

    writeConversationTurn(repoPath, SESSION_ID, {
      type: "turn",
      ts: Date.now(),
      runId: RUN_ID,
      userPrompt: "fix the auth bug",
      summary: "Fixed auth module in src/auth.ts",
      outcome: "applied",
      changedFiles: ["src/auth.ts"],
    });

    writeCostLog(costLogDir, RUN_ID, {
      type: "run_summary",
      model: "claude-sonnet-4-6",
      finalIter: 3,
      totalCostUsd: 0.0123,
      runHitRatio: 0.42,
      runId: RUN_ID,
    });

    const report = await buildFeedbackReport({
      repoPath,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      userMessage: "This is my feedback",
      version: "0.0.1",
      platform: "linux",
      repoSlug: "BedreddinErkan/zone",
      costLogDir,
    });

    // Markdown contains all diagnostic fields
    expect(report.markdown).toContain("fix the auth bug");
    expect(report.markdown).toContain("Fixed auth module in src/auth.ts");
    expect(report.markdown).toContain("claude-sonnet-4-6");
    expect(report.markdown).toContain("$0.0123");
    expect(report.markdown).toContain("**Iterations:** 3");
    expect(report.markdown).toContain("This is my feedback");
    expect(report.markdown).toContain("**Version:** 0.0.1");
    expect(report.markdown).toContain("**Platform:** linux");
    expect(report.markdown).toContain(`**Run ID:** ${RUN_ID}`);

    // GitHub URL has right slug and parseable body
    expect(report.githubIssueUrl).toContain("/BedreddinErkan/zone/issues/new");
    expect(report.githubIssueUrl).toContain("title=");
    expect(report.githubIssueUrl).toContain("body=");
    const bodyParam = new URL("https://x.example" + report.githubIssueUrl.replace(/^https:\/\/github\.com/, "")).searchParams.get("body");
    expect(bodyParam).toContain("Fixed auth module");
    expect(bodyParam).toContain("claude-sonnet-4-6");

    // Mailto URL is well-formed
    expect(report.mailtoUrl).toMatch(/^mailto:feedback@zonecli\.dev\?subject=Zone%20feedback&body=/);
  });

  it("runId fallback: no matching turn → uses last turn", async () => {
    const repoPath = mkTmpDir();
    const costLogDir = mkTmpDir();

    writeConversationTurn(repoPath, SESSION_ID, {
      type: "turn",
      ts: Date.now(),
      runId: "other-run-id",
      userPrompt: "refactor utils",
      summary: "Refactored utilities",
      outcome: "applied",
      changedFiles: [],
    });

    const report = await buildFeedbackReport({
      repoPath,
      sessionId: SESSION_ID,
      runId: "different-run-id",
      userMessage: "My feedback",
      version: "0.0.1",
      platform: "linux",
      repoSlug: "BedreddinErkan/zone",
      costLogDir,
    });

    expect(report.markdown).toContain("refactor utils");
    expect(report.markdown).toContain("Refactored utilities");
  });

  it("degraded: missing session file AND empty cost-log dir → valid report, no throw", async () => {
    const repoPath = mkTmpDir();
    const costLogDir = mkTmpDir(); // empty dir

    const report = await buildFeedbackReport({
      repoPath,
      sessionId: "nonexistent-session",
      runId: "nonexistent-run",
      userMessage: "Bare minimum feedback",
      version: "0.0.1",
      platform: "darwin",
      repoSlug: "BedreddinErkan/zone",
      costLogDir,
    });

    expect(report.markdown).toContain("Bare minimum feedback");
    expect(report.markdown).toContain("**Version:** 0.0.1");
    expect(report.markdown).toContain("**Platform:** darwin");
    expect(report.markdown).toContain("**Run ID:** nonexistent-run");
    expect(typeof report.githubIssueUrl).toBe("string");
    expect(report.githubIssueUrl.length).toBeGreaterThan(10);
    expect(typeof report.mailtoUrl).toBe("string");
    expect(report.mailtoUrl.length).toBeGreaterThan(10);
  });

  it("URL cap: very long input → both URLs stay under 8000 chars", async () => {
    const repoPath = mkTmpDir();
    const costLogDir = mkTmpDir();

    const longMessage = "A".repeat(20_000);
    const longSummary = "B".repeat(1_000);

    writeConversationTurn(repoPath, SESSION_ID, {
      type: "turn",
      ts: Date.now(),
      runId: RUN_ID,
      userPrompt: longMessage,
      summary: longSummary,
      outcome: "applied",
      changedFiles: [],
    });

    const report = await buildFeedbackReport({
      repoPath,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      userMessage: longMessage,
      version: "0.0.1",
      platform: "linux",
      repoSlug: "BedreddinErkan/zone",
      costLogDir,
    });

    expect(report.githubIssueUrl.length).toBeLessThan(8000);
    expect(report.mailtoUrl.length).toBeLessThan(8000);
  });
});
