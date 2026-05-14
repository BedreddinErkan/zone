/**
 * Phase V Commit 3: inline TS syntax validation pre-flush.
 * After apply_patch writes staged content, if the file is .ts/.tsx/.cts/.mts,
 * a tsc syntax check runs. TS1xxx errors → reject+rollback; TS2xxx → pass;
 * non-TS files → skipped.
 */

// ── hoisted exec mock ─────────────────────────────────────────────────────────
// execAsync in toolExecutor is promisify(exec) bound at module load; vi.mock must
// run before any import to replace the binding.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const execMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: execMock };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoPath, filePath), "utf8");
}

function makeExecSuccess(): void {
  execMock.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

function makeExecFailTs1(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && cmd.includes("tsc")) {
        const err = Object.assign(new Error("tsc failed"), {
          code: 1,
          stdout: `tmp.ts(2,1): error TS1005: ';' expected.\n`,
          stderr: "",
        });
        callback(err);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

function makeExecFailTs2(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && cmd.includes("tsc")) {
        const err = Object.assign(new Error("tsc failed"), {
          code: 1,
          stdout: `tmp.ts(1,1): error TS2305: Module 'foo' has no exported member 'bar'.\n`,
          stderr: "",
        });
        callback(err);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-itsc-"));
  makeExecSuccess();
});

afterEach(() => {
  vi.resetAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("inline TS syntax validation", () => {
  it("approves valid TS file — patch applied successfully", async () => {
    makeExecSuccess();
    writeRepoFile("src/ok.ts", "const x = 1;\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/ok.ts",
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("src/ok.ts")).toContain("const x = 2");
  });

  it("skips tsc for .js files — no inline check; patch proceeds", async () => {
    writeRepoFile("src/file.js", "const a = 1;\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/file.js",
        patch: "--- FIND ---\nconst a = 1;\n--- REPLACE ---\nconst a = 2;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
  });

  it("skips tsc for .md files — patch proceeds", async () => {
    writeRepoFile("README.md", "# Title\n\nOld text.\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "README.md",
        patch: "--- FIND ---\nOld text.\n--- REPLACE ---\nNew text.",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("README.md")).toContain("New text");
  });

  it("rejects TS file when tsc returns TS1xxx syntax error — rolls back staging", async () => {
    const original = "const x = 1;\n";
    writeRepoFile("src/broken.ts", original);
    makeExecFailTs1();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/broken.ts",
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );

    expect(result.success).toBe(false);
    // J.4: rejection body now uses the structured APPLY_ROLLED_BACK marker.
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("TS1005");
    expect(result.output).toContain("src/broken.ts");
    expect(result.rejectionReason).toBe("inline_ts_syntax_error");
    // File is rolled back to original
    expect(readRepoFile("src/broken.ts")).toBe(original);
  });

  it("passes TS file when tsc returns only TS2xxx (semantic/import) errors", async () => {
    writeRepoFile("src/semantic.ts", "const x = 1;\n");
    makeExecFailTs2();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/semantic.ts",
        patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    // TS2xxx semantic errors are project-level — single-file check ignores them
    expect(result.success).toBe(true);
  });
});
