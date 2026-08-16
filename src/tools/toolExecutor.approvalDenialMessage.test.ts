/**
 * Item 190/194: run_command's approval-denial message is written for a metacharacter
 * failure, which is correct — isBlockedCommand rejects destructive commands, not
 * metacharacter-carrying ones, so a piped or redirected command really does reach this
 * text and the advice is right for it. Three of six approved:false causes now carry their
 * own reason and their own message (investigation-deny, timeout, run-ending); two remain
 * deliberately unreasoned (a real user declining a prompt, and a non-interactive run
 * auto-denying with nobody to ask) and share the fallback below with the metacharacter
 * case, correctly, since naming a fallback that still covers two causes would repeat the
 * defect this item exists to fix.
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

  it("no reason (the two remaining unnamed causes): unchanged generic message", async () => {
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

  it("approval_timeout reason: names the cause, does not claim a permanent block", async () => {
    const result = await executeTool(
      "run_command",
      { command: "npm install" },
      repoPath,
      undefined,
      {
        runId: "test-run",
        onApprovalRequired: async () => ({ approved: false, reason: "approval_timeout" }),
      }
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("timeout window");
    expect(result.output).not.toContain("Command not auto-approved");
    expect(result.output).not.toContain("2>&1");
  });

  it("run_ending reason: names the cause, states there is nothing to retry", async () => {
    const result = await executeTool(
      "run_command",
      { command: "npm install" },
      repoPath,
      undefined,
      {
        runId: "test-run",
        onApprovalRequired: async () => ({ approved: false, reason: "run_ending" }),
      }
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("this run is ending");
    expect(result.output).not.toContain("Command not auto-approved");
    expect(result.output).not.toContain("2>&1");
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
