import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

// Use vi.hoisted() to avoid ESM temporal dead zone in vi.mock() factories.
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// Stub sanitizeVerificationEnv to return a clean, predictable env.
vi.mock("../core/buildEnv.js", () => ({
  sanitizeVerificationEnv: () => ({ PATH: "/usr/bin:/bin" }),
}));

import {
  runUserPreToolUseHooks,
  runUserPostToolUseHooks,
  buildVetoContent,
  type PreToolUseResult,
} from "./userHookRunner.js";
import type { UserHookEntry } from "../api/diskHooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeProcess extends Partial<ChildProcess> {
  _emit: (event: string, ...args: unknown[]) => void;
  stdout: EventEmitter & { on: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { on: ReturnType<typeof vi.fn> };
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function makeChildProcess(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  throwSpawnError?: Error;
  /** delay in ms before emitting close, simulating slow process */
  closeDelayMs?: number;
}): FakeProcess {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stdoutListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stderrListeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const proc = {
    kill: vi.fn(),
    stdin: {
      write: vi.fn((_data: unknown, cb?: () => void) => { if (cb) cb(); }),
      end: vi.fn(),
    },
    stdout: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stdoutListeners[event] = stdoutListeners[event] ?? [];
        stdoutListeners[event].push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stderrListeners[event] = stderrListeners[event] ?? [];
        stderrListeners[event].push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    _emit(event: string, ...args: unknown[]) {
      if (event === "stdout") {
        stdoutListeners["data"]?.forEach((cb) => cb(...args));
      } else if (event === "stderr") {
        stderrListeners["data"]?.forEach((cb) => cb(...args));
      } else {
        listeners[event]?.forEach((cb) => cb(...args));
      }
    },
  } as unknown as FakeProcess;

  // Schedule events asynchronously so the runner can register listeners first.
  const delay = opts.closeDelayMs ?? 0;
  setTimeout(() => {
    if (opts.throwSpawnError) {
      proc._emit("error", opts.throwSpawnError);
      return;
    }
    if (opts.stdout) proc._emit("stdout", Buffer.from(opts.stdout));
    if (opts.stderr) proc._emit("stderr", Buffer.from(opts.stderr));
    proc._emit("close", opts.exitCode ?? 0);
  }, delay);

  return proc;
}

const REPO_PATH = "/fake/repo";
const META = { runId: "run-1", iter: 1 };

// ---------------------------------------------------------------------------
// runUserPreToolUseHooks
// ---------------------------------------------------------------------------

describe("runUserPreToolUseHooks", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const applyHook: UserHookEntry = { command: "check.sh", matchTools: ["apply_patch"] };

  // T-PREVETO-PASS
  it("returns vetoed:false when hook exits 0", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 0 }));
    const result = await runUserPreToolUseHooks(
      [applyHook], "apply_patch", {}, REPO_PATH, META,
    );
    expect(result.vetoed).toBe(false);
  });

  // T-PREVETO-NONZERO
  it("returns vetoed:true when hook exits non-zero", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 1, stderr: "blocked!" }));
    const result = await runUserPreToolUseHooks(
      [applyHook], "apply_patch", {}, REPO_PATH, META,
    ) as { vetoed: true };
    expect(result.vetoed).toBe(true);
    expect(result.result.exitCode).toBe(1);
    expect(result.result.stderr).toBe("blocked!");
  });

  // T-PREVETO-FAILCLOSED-ERROR
  it("returns vetoed:true (errored) when spawn emits error", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({ throwSpawnError: new Error("ENOENT") }));
    const result = await runUserPreToolUseHooks(
      [applyHook], "apply_patch", {}, REPO_PATH, META,
    ) as { vetoed: true };
    expect(result.vetoed).toBe(true);
    expect(result.result.errored).toBe(true);
  });

  // T-PREVETO-FAILCLOSED-TIMEOUT
  it("returns vetoed:true (timedOut) when process exceeds timeoutMs", async () => {
    // Hook with 50ms timeout; process closes after 200ms
    const slowHook: UserHookEntry = { command: "slow.sh", timeoutMs: 50 };
    const proc = makeChildProcess({ exitCode: 0, closeDelayMs: 200 });
    mockSpawn.mockReturnValue(proc);
    const result = await runUserPreToolUseHooks(
      [slowHook], "apply_patch", {}, REPO_PATH, META,
    ) as { vetoed: true };
    expect(result.vetoed).toBe(true);
    expect(result.result.timedOut).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  }, 1000);

  it("skips hooks that do not match the tool", async () => {
    const writeHook: UserHookEntry = { command: "x.sh", matchTools: ["write_file"] };
    // spawn should NOT be called since the hook doesn't match apply_patch
    const result = await runUserPreToolUseHooks(
      [writeHook], "apply_patch", {}, REPO_PATH, META,
    );
    expect(result.vetoed).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // T-ENV-SANITIZE
  it("env does not contain API keys from sanitizeVerificationEnv", async () => {
    mockSpawn.mockImplementation((_, __, opts: { env: Record<string, string> }) => {
      // Verify sanitized env was used (mocked to return only PATH)
      expect(opts.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(opts.env["GH_TOKEN"]).toBeUndefined();
      expect(opts.env["ZONE_HOOK_EVENT"]).toBe("PreToolUse");
      return makeChildProcess({ exitCode: 0 });
    });
    await runUserPreToolUseHooks([applyHook], "apply_patch", {}, REPO_PATH, META);
  });

  // T-INJECTION-ENV
  it("omits ZONE_TOOL_FILE when file path contains shell metacharacters", async () => {
    const hookWithPath: UserHookEntry = { command: "check.sh", matchTools: ["write_file"] };
    mockSpawn.mockImplementation((_, __, opts: { env: Record<string, string> }) => {
      expect(opts.env["ZONE_TOOL_FILE"]).toBeUndefined();
      return makeChildProcess({ exitCode: 0 });
    });
    await runUserPreToolUseHooks(
      [hookWithPath], "write_file",
      { file_path: "src/foo;rm -rf /tmp/test.ts" },
      REPO_PATH, META,
    );
  });

  it("sets ZONE_TOOL_FILE when file path is safe", async () => {
    const hookWithPath: UserHookEntry = { command: "check.sh", matchTools: ["write_file"] };
    mockSpawn.mockImplementation((_, __, opts: { env: Record<string, string> }) => {
      expect(opts.env["ZONE_TOOL_FILE"]).toBe("src/safe-file.ts");
      return makeChildProcess({ exitCode: 0 });
    });
    await runUserPreToolUseHooks(
      [hookWithPath], "write_file",
      { file_path: "src/safe-file.ts" },
      REPO_PATH, META,
    );
  });

  // T-STDIN-JSON
  it("writes JSON payload to stdin", async () => {
    let writtenPayload: string | null = null;
    const proc = makeChildProcess({ exitCode: 0 });
    proc.stdin.write = vi.fn((data: string) => { writtenPayload = data; });
    mockSpawn.mockReturnValue(proc);

    await runUserPreToolUseHooks(
      [applyHook], "apply_patch", {}, REPO_PATH, { runId: "r-42", iter: 3 },
    );

    expect(writtenPayload).not.toBeNull();
    const parsed = JSON.parse(writtenPayload!);
    expect(parsed.event).toBe("PreToolUse");
    expect(parsed.toolName).toBe("apply_patch");
    expect(parsed.runId).toBe("r-42");
    expect(parsed.iter).toBe(3);
    expect(parsed.repoPath).toBe(REPO_PATH);
  });
});

// ---------------------------------------------------------------------------
// runUserPostToolUseHooks
// ---------------------------------------------------------------------------

describe("runUserPostToolUseHooks", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const postHook: UserHookEntry = { command: "post.sh", feedOutputToModel: true };

  // T-POST-SUCCESS + T-POST-FEED-MODEL
  it("calls feedOutputCallback with stdout when hook exits 0 and feedOutputToModel:true", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 0, stdout: "linted!\n" }));
    const cb = vi.fn();
    await runUserPostToolUseHooks(
      [postHook], "write_file", { file_path: "src/x.ts" },
      REPO_PATH, { ...META, callId: "call-1" }, cb,
    );
    expect(cb).toHaveBeenCalledWith("linted!\n");
  });

  it("does NOT call feedOutputCallback when feedOutputToModel is false", async () => {
    const noFeedHook: UserHookEntry = { command: "post.sh", feedOutputToModel: false };
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 0, stdout: "output\n" }));
    const cb = vi.fn();
    await runUserPostToolUseHooks(
      [noFeedHook], "write_file", {}, REPO_PATH, { ...META, callId: "c1" }, cb,
    );
    expect(cb).not.toHaveBeenCalled();
  });

  // T-POST-NONFATAL
  it("does not throw when post hook exits non-zero", async () => {
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 1, stderr: "lint error" }));
    const cb = vi.fn();
    await expect(
      runUserPostToolUseHooks(
        [postHook], "write_file", {}, REPO_PATH, { ...META, callId: "c2" }, cb,
      ),
    ).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not throw when post hook times out", async () => {
    const slowHook: UserHookEntry = { command: "slow.sh", timeoutMs: 50, feedOutputToModel: true };
    mockSpawn.mockReturnValue(makeChildProcess({ exitCode: 0, closeDelayMs: 200 }));
    const cb = vi.fn();
    await expect(
      runUserPostToolUseHooks(
        [slowHook], "write_file", {}, REPO_PATH, { ...META, callId: "c3" }, cb,
      ),
    ).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  }, 1000);
});

// ---------------------------------------------------------------------------
// buildVetoContent
// ---------------------------------------------------------------------------

describe("buildVetoContent", () => {
  const baseVeto = {
    vetoed: true as const,
    hookDesc: "block-generated",
    result: { exitCode: 1, stdout: "", stderr: "blocked by policy", timedOut: false, errored: false },
    filePath: "src/generated/foo.ts",
  };

  it("first veto includes exit code and stderr snippet", () => {
    const msg = buildVetoContent("apply_patch", "src/generated/foo.ts", baseVeto, false);
    expect(msg).toContain("[hook_blocked]");
    expect(msg).toContain("PreToolUse hook 'block-generated'");
    expect(msg).toContain("apply_patch");
    expect(msg).toContain("src/generated/foo.ts");
    expect(msg).toContain("exit 1");
    expect(msg).toContain("blocked by policy");
    expect(msg).not.toContain("PERMANENTLY BLOCKED");
  });

  // T-VETO-PERMANENT
  it("permanent veto contains PERMANENTLY BLOCKED", () => {
    const msg = buildVetoContent("apply_patch", "src/generated/foo.ts", baseVeto, true);
    expect(msg).toContain("PERMANENTLY BLOCKED");
    expect(msg).not.toContain("Do not retry");
    expect(msg).toContain("Do NOT retry");
  });

  it("handles null filePath gracefully", () => {
    const msg = buildVetoContent("apply_patch", null, { ...baseVeto, filePath: null }, false);
    expect(msg).toContain("[hook_blocked]");
    expect(msg).toContain("apply_patch");
  });

  it("shows timeout in exit note when timedOut", () => {
    const timedOutVeto = {
      ...baseVeto,
      result: { ...baseVeto.result, timedOut: true, exitCode: null },
    };
    const msg = buildVetoContent("apply_patch", "src/foo.ts", timedOutVeto, false);
    expect(msg).toContain("timed out");
  });

  it("truncates long stderr to 500 chars", () => {
    const longStderr = "x".repeat(600);
    const veto = { ...baseVeto, result: { ...baseVeto.result, stderr: longStderr } };
    const msg = buildVetoContent("apply_patch", "src/foo.ts", veto, false);
    expect(msg.length).toBeLessThan(800);
  });
});
