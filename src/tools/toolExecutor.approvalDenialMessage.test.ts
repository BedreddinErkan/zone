/**
 * Item 190 fix: run_command's approval-denial message was written for a metacharacter
 * failure and rendered unconditionally, even though isBlockedCommand rejects any
 * metacharacter-carrying command earlier, before onApprovalRequired is ever reached. A
 * gate-3 (investigation) denial now carries a reason; this pins that the rendered message
 * differs by reason, and that every other approved:false cause (which carries no reason)
 * keeps the prior message unchanged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-approval-msg-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("run_command approval-denial message (item 190)", () => {
  it("investigation_not_diagnostic reason: names the allowlist cause, not metacharacters", async () => {
    const result = await executeTool(
      "run_command",
      { command: "git ls-files" },
      repoPath,
      undefined,
      {
        runId: "test-run",
        onApprovalRequired: async () => ({
          approved: false,
          reason: "investigation_not_diagnostic",
        }),
      }
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("investigation diagnostic allowlist");
    // The old message's actionable-but-wrong advice for this cause — a bare command has no
    // metacharacters to strip, so "re-run it BARE" is nonsensical here. The new message
    // explicitly names and rules out the metacharacter cause instead of implying it.
    expect(result.output).not.toContain("re-run it BARE");
    expect(result.output).not.toContain("2>&1");
  });

  it("no reason (the other four approved:false causes): unchanged generic message", async () => {
    const result = await executeTool(
      "run_command",
      { command: "npm install" },
      repoPath,
      undefined,
      {
        runId: "test-run",
        onApprovalRequired: async () => ({ approved: false }),
      }
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Command not auto-approved");
    expect(result.output).toContain("2>&1");
    expect(result.output).not.toContain("investigation diagnostic allowlist");
  });

  it("approved: true still runs the command regardless of reason's presence", async () => {
    const result = await executeTool(
      "run_command",
      { command: "exit 0" },
      repoPath,
      undefined,
      {
        runId: "test-run",
        onApprovalRequired: async () => ({ approved: true }),
      }
    );
    expect(result.success).toBe(true);
  });
});
