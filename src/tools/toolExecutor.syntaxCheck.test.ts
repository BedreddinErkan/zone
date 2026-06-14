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
import {
  clearAvailabilityCache,
  _setTscAvailabilityForTest,
  _resetCheckerWarningsForTest,
} from "./syntaxCheckers.js";

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
      // Match only the actual tsc invocation (contains --no-install), not probe calls like "which tsc".
      if (typeof cmd === "string" && cmd.includes("--no-install")) {
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
      // Match only the actual tsc invocation (contains --no-install), not probe calls like "which tsc".
      if (typeof cmd === "string" && cmd.includes("--no-install")) {
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

describe("Lane 0.D — inline TS check ESNext flag regression", () => {
  it("tsc invocation includes --module ESNext flag", async () => {
    let capturedCmd: string | null = null;
    execMock.mockImplementation(
      (cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        if (typeof cmd === "string" && cmd.includes("tsc")) capturedCmd = cmd;
        callback(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof import("node:child_process").exec>;
      }
    );
    writeRepoFile("src/esm.ts", "export const x = 1;\n");
    await executeTool(
      "apply_patch",
      { filePath: "src/esm.ts", patch: "--- FIND ---\nexport const x = 1;\n--- REPLACE ---\nexport const x = 2;", intent: "modify", scope: null },
      repoPath, undefined, {}
    );
    expect(capturedCmd).not.toBeNull();
    expect(capturedCmd).toContain("--module");
    expect(capturedCmd).toContain("ESNext");
  });

  it("approves .ts file when tsc returns only TS2307 + TS2339 (module resolution noise, as seen in run 0d0106f9)", async () => {
    execMock.mockImplementation(
      (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
        if (typeof cmd === "string" && cmd.includes("tsc")) {
          callback(Object.assign(new Error("tsc"), {
            code: 1,
            stdout: "tmp.ts(1,1): error TS2307: Cannot find module './config.js'.\ntmp.ts(5,3): error TS2339: Property 'x' does not exist.\n",
            stderr: "",
          }));
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof import("node:child_process").exec>;
      }
    );
    writeRepoFile("src/modfile.ts", "const x = 1;\n");
    const result = await executeTool(
      "apply_patch",
      { filePath: "src/modfile.ts", patch: "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;", intent: "modify", scope: null },
      repoPath, undefined, {}
    );
    expect(result.success).toBe(true);
  });
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

// ── W.3 experimental checker helpers ─────────────────────────────────────────

/** Go: which + gofmt succeed */
function makeExecGoSuccess(): void {
  execMock.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** Go: which succeeds, gofmt exits non-zero with parse error on stderr */
function makeExecGoSyntaxError(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && /^gofmt\b/.test(cmd)) {
        const stderr = `/tmp/zone-tsc-abc.go:3:1: expected declaration, found 'IDENT' bad\n`;
        callback(Object.assign(new Error("gofmt failed"), { code: 2, stdout: "", stderr }));
      } else {
        callback(null, { stdout: "/usr/bin/gofmt", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** Ruby: which + ruby -c succeed */
function makeExecRubySuccess(): void {
  execMock.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: "Syntax OK", stderr: "" });
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** Ruby: which succeeds, ruby -c exits non-zero with SyntaxError on stderr */
function makeExecRubySyntaxError(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && /^ruby\b/.test(cmd)) {
        const stderr = `/tmp/zone-tsc-abc.rb:2: syntax error, unexpected end-of-input (SyntaxError)\n`;
        callback(Object.assign(new Error("ruby -c failed"), { code: 1, stdout: "", stderr }));
      } else {
        callback(null, { stdout: "/usr/bin/ruby", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** Java: which + javac succeed */
function makeExecJavaSuccess(): void {
  execMock.mockImplementation(
    (_cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

/** Java: which succeeds, javac exits non-zero with error on stderr */
function makeExecJavaSyntaxError(): void {
  execMock.mockImplementation(
    (cmd: string, _opts: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
      if (typeof cmd === "string" && /^javac\b/.test(cmd)) {
        const stderr = `/tmp/zone-tsc-abc.java:5: error: ';' expected\n`;
        callback(Object.assign(new Error("javac failed"), { code: 1, stdout: "", stderr }));
      } else {
        callback(null, { stdout: "/usr/bin/javac", stderr: "" });
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    }
  );
}

function setExperimentalCheckers(csv: string): void {
  process.env.ZONE_EXPERIMENTAL_SYNTAX_CHECKERS = csv;
}

function clearExperimentalCheckers(): void {
  delete process.env.ZONE_EXPERIMENTAL_SYNTAX_CHECKERS;
}

// ── Go tests ──────────────────────────────────────────────────────────────────

describe("W.3 — Go experimental checker", () => {
  afterEach(() => clearExperimentalCheckers());

  it("disabled by default — .go file approved without invoking gofmt", async () => {
    makeExecGoSyntaxError(); // would reject if called
    writeRepoFile("src/main.go", "package main\nfunc main() {}\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/main.go",
        patch: "--- FIND ---\nfunc main() {}\n--- REPLACE ---\nfunc main() { return }",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    // Experimental gate blocks checker → treat as no checker → approve
    expect(result.success).toBe(true);
  });

  it("enabled + valid Go file — patch approved", async () => {
    setExperimentalCheckers("go");
    makeExecGoSuccess();
    writeRepoFile("src/ok.go", "package main\nfunc main() {}\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/ok.go",
        patch: "--- FIND ---\nfunc main() {}\n--- REPLACE ---\nfunc main() { return }",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(true);
  });

  it("enabled + gofmt parse error — patch rejected and rolled back", async () => {
    setExperimentalCheckers("go");
    const original = "package main\nfunc main() {}\n";
    writeRepoFile("src/broken.go", original);
    makeExecGoSyntaxError();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/broken.go",
        patch: "--- FIND ---\nfunc main() {}\n--- REPLACE ---\nfunc main() { bad",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("src/broken.go");
    expect(result.rejectionReason).toBe("inline_ts_syntax_error");
    expect(readRepoFile("src/broken.go")).toBe(original);
  });
});

// ── Ruby tests ────────────────────────────────────────────────────────────────

describe("W.3 — Ruby experimental checker", () => {
  afterEach(() => clearExperimentalCheckers());

  it("disabled by default — .rb file approved without invoking ruby -c", async () => {
    makeExecRubySyntaxError(); // would reject if called
    writeRepoFile("src/app.rb", "def foo; end\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/app.rb",
        patch: "--- FIND ---\ndef foo; end\n--- REPLACE ---\ndef foo; 1; end",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(true);
  });

  it("enabled + valid Ruby file — patch approved", async () => {
    setExperimentalCheckers("rb");
    makeExecRubySuccess();
    writeRepoFile("src/ok.rb", "def foo; end\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/ok.rb",
        patch: "--- FIND ---\ndef foo; end\n--- REPLACE ---\ndef foo; 1; end",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(true);
  });

  it("enabled + ruby -c SyntaxError — patch rejected and rolled back", async () => {
    setExperimentalCheckers("rb");
    const original = "def foo; end\n";
    writeRepoFile("src/broken.rb", original);
    makeExecRubySyntaxError();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/broken.rb",
        patch: "--- FIND ---\ndef foo; end\n--- REPLACE ---\ndef foo",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("SyntaxError");
    expect(result.rejectionReason).toBe("inline_ts_syntax_error");
    expect(readRepoFile("src/broken.rb")).toBe(original);
  });
});

// ── Java tests ────────────────────────────────────────────────────────────────

describe("W.3 — Java experimental checker", () => {
  afterEach(() => clearExperimentalCheckers());

  it("disabled by default — .java file approved without invoking javac", async () => {
    makeExecJavaSyntaxError(); // would reject if called
    writeRepoFile("src/Main.java", "public class Main { public static void main(String[] args) {} }\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/Main.java",
        patch: "--- FIND ---\npublic class Main { public static void main(String[] args) {} }\n--- REPLACE ---\npublic class Main { }",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(true);
  });

  it("enabled + valid Java file — patch approved", async () => {
    setExperimentalCheckers("java");
    makeExecJavaSuccess();
    writeRepoFile("src/Main.java", "public class Main { public static void main(String[] args) {} }\n");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/Main.java",
        patch: "--- FIND ---\npublic class Main { public static void main(String[] args) {} }\n--- REPLACE ---\npublic class Main { }",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(true);
  });

  it("enabled + javac error — patch rejected and rolled back", async () => {
    setExperimentalCheckers("java");
    const original = "public class Main { public static void main(String[] args) {} }\n";
    writeRepoFile("src/Main.java", original);
    makeExecJavaSyntaxError();

    const result = await executeTool(
      "apply_patch",
      {
        filePath: "src/Main.java",
        patch: "--- FIND ---\npublic class Main { public static void main(String[] args) {} }\n--- REPLACE ---\npublic class Main {",
        intent: "modify",
        scope: null,
      },
      repoPath, undefined, {}
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^APPLY_ROLLED_BACK\n/);
    expect(result.output).toContain("src/Main.java");
    expect(result.rejectionReason).toBe("inline_ts_syntax_error");
    expect(readRepoFile("src/Main.java")).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: tsc unavailability — warn-once + non-blocking + --no-install
// ---------------------------------------------------------------------------
describe("Fix 3 — tsc unavailability: warn once, approve, no hang", () => {
  beforeEach(() => {
    clearAvailabilityCache();
    _resetCheckerWarningsForTest();
  });

  afterEach(() => {
    _setTscAvailabilityForTest(null);
    _resetCheckerWarningsForTest();
    clearAvailabilityCache();
  });

  async function applyTsPatch(progressMessages: string[]) {
    writeRepoFile("src/warn.ts", "export const a = 1;\n");
    return executeTool(
      "apply_patch",
      {
        filePath: "src/warn.ts",
        patch: "--- FIND ---\nexport const a = 1;\n--- REPLACE ---\nexport const a = 2;",
        intent: "modify",
        scope: null,
      },
      repoPath,
      (msg: string) => progressMessages.push(msg),
      {},
    );
  }

  it("Case 1 — warns exactly once across multiple edits when tsc is unavailable", async () => {
    _setTscAvailabilityForTest(() => Promise.resolve(false));

    const msgs: string[] = [];

    // First edit — warning should fire.
    await applyTsPatch(msgs);
    // Reset file so second edit can apply cleanly.
    writeRepoFile("src/warn.ts", "export const a = 1;\n");
    // Second edit — warning must NOT fire again.
    await applyTsPatch(msgs);

    const warnings = msgs.filter((m) => m.includes("zone-tsc-unavailable"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TypeScript syntax checking skipped");
    expect(warnings[0]).toContain("npm install --save-dev typescript");
  });

  it("Case 2 — edit still applies (non-blocking) when tsc is unavailable", async () => {
    _setTscAvailabilityForTest(() => Promise.resolve(false));

    const msgs: string[] = [];
    const result = await applyTsPatch(msgs);

    expect(result.success).toBe(true);
    expect(readRepoFile("src/warn.ts")).toContain("const a = 2");
  });

  it("Case 3 — no warning emitted when tsc is available (happy path)", async () => {
    _setTscAvailabilityForTest(() => Promise.resolve(true));
    makeExecSuccess();

    const msgs: string[] = [];
    const result = await applyTsPatch(msgs);

    expect(result.success).toBe(true);
    expect(msgs.filter((m) => m.includes("zone-tsc-unavailable"))).toHaveLength(0);
  });

  it("Case 4 — npx invocation includes --no-install flag", async () => {
    _setTscAvailabilityForTest(() => Promise.resolve(true));

    let capturedCmd: string | null = null;
    execMock.mockImplementation(
      (cmd: string, _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        if (typeof cmd === "string" && cmd.includes("tsc")) capturedCmd = cmd;
        callback(null, { stdout: "", stderr: "" });
        return {} as ReturnType<typeof import("node:child_process").exec>;
      },
    );

    const msgs: string[] = [];
    await applyTsPatch(msgs);

    expect(capturedCmd).not.toBeNull();
    expect(capturedCmd).toContain("--no-install");
  });
});
