import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Mock finalizeStaging before importing the composer — vi.mock is hoisted by vitest
vi.mock("./staging.js", () => ({
  finalizeStaging: vi.fn(),
  runStagingVerification: vi.fn(),
  buildVerificationWarningsMessage: vi.fn(() => "VERIFICATION WARNINGS — test stub"),
}));

vi.mock("../../utils/logger.js", () => ({
  debugLog: vi.fn(),
  errorLog: vi.fn(),
  log: vi.fn(),
}));

import { verifyAndFinalize } from "./composer.js";
import { finalizeStaging } from "./staging.js";
import { debugLog } from "../../utils/logger.js";

const mockFinalizeStaging = finalizeStaging as Mock;
const mockDebugLog = debugLog as Mock;

/** Minimal VerifyAndFinalizeInput with ownsStagingFiles=true */
function makeInput(overrides: Partial<Parameters<typeof verifyAndFinalize>[0]> = {}): Parameters<typeof verifyAndFinalize>[0] {
  return {
    stagingFiles: new Map([
      ["/repo/src/foo.ts", "const x = 1;"],
    ]),
    repoPath: "/repo",
    framework: { language: "typescript", testCommand: "npm test", hasTests: true, testFilesDetected: true },
    withStagingTempFlush: async <T>(_staging: Map<string, string>, body: () => Promise<T>) => body(),
    verifyMode: "warn",
    ownsStagingFiles: true,
    ...overrides,
  };
}

/** Shared finalizeStaging pass result */
const PASS_RESULT = {
  flushed: true,
  filesFlushed: 1,
  flushFailures: 0,
  verification: {
    status: "pass" as const,
    label: "tsc",
    durationMs: 120,
    baselineErrorCount: 0,
    postErrorCount: 0,
  },
};

describe("verifyAndFinalize — VerifyOutcome parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { kind: "skipped", reason: "subagent_deferred" } when ownsStagingFiles=false', async () => {
    const outcome = await verifyAndFinalize(makeInput({ ownsStagingFiles: false }));
    expect(outcome).toEqual({ kind: "skipped", reason: "subagent_deferred" });
    expect(mockFinalizeStaging).not.toHaveBeenCalled();
  });

  it('returns { kind: "applied" } on verification pass', async () => {
    mockFinalizeStaging.mockResolvedValue(PASS_RESULT);
    const outcome = await verifyAndFinalize(makeInput());
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.filesFlushed).toBe(1);
      expect(outcome.verification.label).toBe("tsc");
      expect(outcome.verification.durationMs).toBe(120);
    }
  });

  it('returns { kind: "applied_with_warnings" } on regression in warn mode', async () => {
    mockFinalizeStaging.mockResolvedValue({
      flushed: true,
      filesFlushed: 1,
      flushFailures: 0,
      verification: {
        status: "fail" as const,
        label: "tsc",
        durationMs: 250,
        errorPreview: "src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.",
        baselineErrorCount: 0,
        postErrorCount: 2,
        regressed: true,
      },
    });
    const outcome = await verifyAndFinalize(makeInput({ verifyMode: "warn" }));
    expect(outcome.kind).toBe("applied_with_warnings");
    if (outcome.kind === "applied_with_warnings") {
      expect(outcome.filesFlushed).toBe(1);
      expect(typeof outcome.appendix).toBe("string");
      expect(outcome.appendix.length).toBeGreaterThan(0);
      expect(Array.isArray(outcome.errors)).toBe(true);
      expect(outcome.verification.regressed).toBe(true);
    }
  });

  it('returns { kind: "rolled_back" } on regression in rollback mode', async () => {
    const discardedStaging = new Map([["/repo/src/foo.ts", "const x = 1;"]]);
    mockFinalizeStaging.mockResolvedValue({
      flushed: false,
      filesFlushed: 0,
      flushFailures: 0,
      discardedStaging,
      verification: {
        status: "fail" as const,
        label: "tsc",
        durationMs: 200,
        errorPreview: "src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.",
        baselineErrorCount: 0,
        postErrorCount: 1,
        regressed: true,
      },
    });
    const outcome = await verifyAndFinalize(makeInput({ verifyMode: "rollback" }));
    expect(outcome.kind).toBe("rolled_back");
    if (outcome.kind === "rolled_back") {
      expect(outcome.restoredFiles).toContain("src/foo.ts");
      expect(Array.isArray(outcome.errors)).toBe(true);
      expect(typeof outcome.appendix).toBe("string");
      expect(outcome.appendix.length).toBeGreaterThan(0);
      expect(outcome.discardedStaging).toBe(discardedStaging);
    }
  });

  it('returns { kind: "pre_existing_errors" } when baseline > 0 and post <= baseline', async () => {
    mockFinalizeStaging.mockResolvedValue({
      flushed: true,
      filesFlushed: 1,
      flushFailures: 0,
      verification: {
        status: "fail" as const,
        label: "tsc",
        durationMs: 180,
        errorPreview: "src/foo.ts(3,1): error TS2304: Cannot find name 'baz'.",
        baselineErrorCount: 3,
        postErrorCount: 3,
        regressed: false,
      },
    });
    const outcome = await verifyAndFinalize(makeInput());
    expect(outcome.kind).toBe("pre_existing_errors");
    if (outcome.kind === "pre_existing_errors") {
      expect(outcome.filesFlushed).toBe(1);
      expect(typeof outcome.appendix).toBe("string");
      expect(outcome.appendix).toMatch(/pre-existing/i);
    }
  });

  it('returns { kind: "skipped", reason: "no_command_for_framework" } when framework is undefined', async () => {
    mockFinalizeStaging.mockResolvedValue({
      flushed: false,
      filesFlushed: 0,
      flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_command_for_framework" },
    });
    const outcome = await verifyAndFinalize(makeInput({ framework: undefined }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_command_for_framework");
    }
  });

  it('returns { kind: "skipped", reason: "no_staged_files" } when stagingFiles is empty', async () => {
    mockFinalizeStaging.mockResolvedValue({
      flushed: false,
      filesFlushed: 0,
      flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_staged_files" },
    });
    const outcome = await verifyAndFinalize(makeInput({ stagingFiles: new Map() }));
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("no_staged_files");
    }
  });

  it('returns { kind: "no_change" } when no_changes_made path fires', async () => {
    mockFinalizeStaging.mockResolvedValue({
      flushed: false,
      filesFlushed: 0,
      flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_changes_made" },
    });
    const outcome = await verifyAndFinalize(makeInput());
    expect(outcome.kind).toBe("no_change");
  });
});

describe("verifyAndFinalize — load-bearing invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('"no_changes_made" path maps to { kind: "no_change" }, not { kind: "skipped" }', async () => {
    // Confirms the composer distinguishes "no_changes_made" from other skipped reasons.
    // finalizeStaging returns this when all staged content already matches disk.
    mockFinalizeStaging.mockResolvedValue({
      flushed: false,
      filesFlushed: 0,
      flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_changes_made" },
    });
    const outcome = await verifyAndFinalize(makeInput({ ownsStagingFiles: true }));
    expect(outcome.kind).toBe("no_change");
    expect("reason" in outcome).toBe(false);
  });

  it('composer passes stagingFiles map to finalizeStaging (wiring check)', async () => {
    mockFinalizeStaging.mockResolvedValue(PASS_RESULT);
    const stagingFiles = new Map([
      ["/repo/src/a.ts", "const a = 1;"],
      ["/repo/src/b.ts", "const b = 2;"],
    ]);
    await verifyAndFinalize(makeInput({ stagingFiles }));
    expect(mockFinalizeStaging).toHaveBeenCalledOnce();
    const callArg = mockFinalizeStaging.mock.calls[0][0];
    expect(callArg.stagingFiles).toBe(stagingFiles);
  });

  it('"skipped/no_staged_files" and "no_changes_made" are distinct outcome kinds', async () => {
    // skipped/no_staged_files → { kind: "skipped", reason: "no_staged_files" }
    mockFinalizeStaging.mockResolvedValue({
      flushed: false, filesFlushed: 0, flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_staged_files" },
    });
    const skippedOutcome = await verifyAndFinalize(makeInput({ stagingFiles: new Map() }));
    expect(skippedOutcome.kind).toBe("skipped");
    if (skippedOutcome.kind === "skipped") expect(skippedOutcome.reason).toBe("no_staged_files");

    // no_changes_made → { kind: "no_change" } — must NOT be conflated with skipped
    mockFinalizeStaging.mockResolvedValue({
      flushed: false, filesFlushed: 0, flushFailures: 0,
      verification: { status: "skipped" as const, reason: "no_changes_made" },
    });
    const noChangeOutcome = await verifyAndFinalize(makeInput());
    expect(noChangeOutcome.kind).toBe("no_change");
    expect(noChangeOutcome.kind).not.toBe("skipped");
  });
});
