/**
 * Stage 3A: per-edit approval gate.
 * write_file and apply_patch under editApprovalMode==="manual" call
 * onEditApprovalRequired before writing. Under "auto" (no callback), they skip
 * the gate. Command trust (setTrustAllForRun) does NOT bypass the edit gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "./toolExecutor.js";
import { setTrustAllForRun, clearTrustedCommandsForRun } from "../api/commandApprovals.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-edit-approval-test-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// ─── write_file ───────────────────────────────────────────────────────────────

describe("write_file — edit approval gate", () => {
  it("onEditApprovalRequired called and write blocked on rejection", async () => {
    const onEditApproval = vi.fn().mockResolvedValue(false);
    const result = await executeTool(
      "write_file",
      { filePath: "new-file.ts", content: "export const x = 1;" },
      repoPath,
      undefined,
      { runId: "test-run", onEditApprovalRequired: onEditApproval }
    );
    expect(onEditApproval).toHaveBeenCalledWith("new-file.ts", "test-run");
    expect(result.success).toBe(false);
    expect(result.output).toContain("edit_rejected_by_user");
    expect(result.output).toContain("shell");
    expect(fs.existsSync(path.join(repoPath, "new-file.ts"))).toBe(false);
  });

  it("onEditApprovalRequired called and file IS written on approval", async () => {
    const onEditApproval = vi.fn().mockResolvedValue(true);
    const result = await executeTool(
      "write_file",
      { filePath: "approved.ts", content: "export const x = 1;" },
      repoPath,
      undefined,
      { runId: "test-run", onEditApprovalRequired: onEditApproval }
    );
    expect(onEditApproval).toHaveBeenCalledWith("approved.ts", "test-run");
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(repoPath, "approved.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, "approved.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("no callback: write proceeds without prompting (auto mode)", async () => {
    const result = await executeTool(
      "write_file",
      { filePath: "auto.ts", content: "export const y = 2;" },
      repoPath,
      undefined,
      { runId: "test-run" /* no onEditApprovalRequired */ }
    );
    // Auto mode: no approval gate, write succeeds
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(repoPath, "auto.ts"))).toBe(true);
  });

  it("scope separation: setTrustAllForRun (command trust) does NOT bypass edit gate", async () => {
    setTrustAllForRun("trust-run");
    const onEditApproval = vi.fn().mockResolvedValue(false);
    try {
      const result = await executeTool(
        "write_file",
        { filePath: "trusted-cmd.ts", content: "x" },
        repoPath,
        undefined,
        { runId: "trust-run", onEditApprovalRequired: onEditApproval }
      );
      // Command trust-all must NOT bypass the edit gate
      expect(onEditApproval).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.output).toContain("edit_rejected_by_user");
      expect(result.output).toContain("shell");
    } finally {
      clearTrustedCommandsForRun("trust-run");
    }
  });
});

// ─── apply_patch ──────────────────────────────────────────────────────────────

describe("apply_patch — edit approval gate", () => {
  it("onEditApprovalRequired called and patch blocked on rejection", async () => {
    writeRepoFile("target.ts", "export const a = 1;");
    const onEditApproval = vi.fn().mockResolvedValue(false);
    const filesRead = new Set(["target.ts"]);
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "target.ts",
        patch: "--- FIND ---\nconst a = 1;\n--- REPLACE ---\nconst a = 2;",
        intent: "modify",
      },
      repoPath,
      undefined,
      { runId: "test-run", onEditApprovalRequired: onEditApproval, filesReadThisRun: filesRead }
    );
    expect(onEditApproval).toHaveBeenCalledWith("target.ts", "test-run");
    expect(result.success).toBe(false);
    expect(result.output).toContain("edit_rejected_by_user");
    expect(result.output).toContain("shell");
    // File must be unchanged
    expect(fs.readFileSync(path.join(repoPath, "target.ts"), "utf8")).toContain("const a = 1;");
  });

  it("no callback: patch proceeds without prompting (auto mode)", async () => {
    writeRepoFile("auto-target.ts", "export const b = 1;\n");
    const filesRead = new Set(["auto-target.ts"]);
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "auto-target.ts",
        patch: "--- FIND ---\nconst b = 1;\n--- REPLACE ---\nconst b = 2;",
        intent: "modify",
      },
      repoPath,
      undefined,
      { runId: "test-run", filesReadThisRun: filesRead }
    );
    // No approval gate in auto mode
    expect(result.success).toBe(true);
  });
});
