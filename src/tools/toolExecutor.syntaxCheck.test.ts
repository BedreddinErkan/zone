/**
 * W.1/W.2: SYNTAX_CHECKERS table — TS + Python path integration tests.
 * W.1 (migrated): TS path — TS1xxx errors → reject+rollback; TS2xxx → pass; non-TS files → skipped.
 * W.2: Python path — py_compile SyntaxError → reject+rollback; python3 unavailable → silently approve.
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
import { clearAvailabilityCache } from "./syntaxCheckers.js";

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
  clearAvailabilityCache();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── Python mock helpers ───────────────────────────────────────────────────────

/** python3 available (which succeeds), py_compile succeeds */
function makeExecPySuccess(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** python3 available, py_compile fails with SyntaxError */
function makeExecPySyntaxError(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && cmd.includes("py_compile")) {
        const stderr = `  File "/tmp/zone-tsc-abc.py", line 3\n    def foo(\n           ^\nSyntaxError: '(' was never closed\n`;
        const err = Object.assign(new Error("py_compile failed"), {
          code: 1,
          stdout: "",
          stderr,
        });
        callback(err);
      } else {
        // which python3 → success
        callback(null, { stdout: "/usr/bin/python3", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** python3 available, py_compile fails with IndentationError */
function makeExecPyIndentationError(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && cmd.includes("py_compile")) {
        const stderr = `  File "/tmp/zone-tsc-abc.py", line 2\n    \tpass\n    ^\nIndentationError: unexpected indent\n`;
        const err = Object.assign(new Error("py_compile failed"), {
          code: 1,
          stdout: "",
          stderr,
        });
        callback(err);
      } else {
        callback(null, { stdout: "/usr/bin/python3", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** python3 not on PATH → which fails → gracefulSkip → silently approve */
function makeExecPyUnavailable(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && cmd.includes("which")) {
        callback(new Error("not found"));
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

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

describe("W.2 — inline Python syntax validation", () => {
  it("approves valid .py file — patch applied successfully", async () => {
    makeExecPySuccess();
    writeRepoFile("src/ok.py", "def foo():\n    return 1\n");
    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/ok.py",
        patch: "--- FIND ---\n    return 1\n--- REPLACE ---\n    return 2",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );
    expect(result.success).toBe(true);
    expect(readRepoFile("src/ok.py")).toContain("return 2");
  });

  it("rejects .py file when py_compile returns SyntaxError — rolls back staging", async () => {
    const original = "def foo():\n    return 1\n";
    writeRepoFile("src/broken.py", original);
    makeExecPySyntaxError();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/broken.py",
        patch: "--- FIND ---\n    return 1\n--- REPLACE ---\n    return 2",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("SyntaxError");
    expect(result.output).toContain("src/broken.py");
    expect(result.rejectionReason).toBe("inline_ts_syntax_error");
    expect(readRepoFile("src/broken.py")).toBe(original);
  });

  it("rejects .py file with IndentationError — rollback message includes heuristic suggestion", async () => {
    const original = "def foo():\n    return 1\n";
    writeRepoFile("src/indent.py", original);
    makeExecPyIndentationError();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/indent.py",
        patch: "--- FIND ---\n    return 1\n--- REPLACE ---\n    return 2",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("IndentationError");
    // Heuristic suggestion should be present for IndentationError
    expect(result.output).toContain("Suggested:");
    expect(readRepoFile("src/indent.py")).toBe(original);
  });

  it("silently approves .py file when python3 is not on PATH (gracefulSkip)", async () => {
    makeExecPyUnavailable();
    writeRepoFile("src/nopython.py", "def foo():\n    return 1\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/nopython.py",
        patch: "--- FIND ---\n    return 1\n--- REPLACE ---\n    return 2",
        intent: "modify",
        scope: null,
      },
      repoPath,
      undefined,
      {}
    );

    // gracefulSkip: python3 unavailable → approve silently
    expect(result.success).toBe(true);
    expect(readRepoFile("src/nopython.py")).toContain("return 2");
  });

  it("skips Python check for .js files — patch proceeds without py_compile", async () => {
    makeExecPySyntaxError(); // would reject if called for .js
    writeRepoFile("src/skip.js", "const a = 1;\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/skip.js",
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
});
