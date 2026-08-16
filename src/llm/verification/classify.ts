import { debugLog } from "../../utils/logger.js";
import { parseVerificationError } from "../../core/parseVerificationError.js";
import { didApplyPatch } from "./logUtils.js";
import { SAFE_COMMAND_PREFIXES } from "../../api/commandApprovals.js";
import type { VerificationReason } from "./verificationReason.js";

/** Parse a [ZONE_VERIFICATION: <reason>] tag from text. Returns null if absent or unknown. */
export function parseVerificationTag(text: string): VerificationReason | null {
  const m = String(text || "").match(/\[ZONE_VERIFICATION:\s*([\w_]+)\]/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const valid: VerificationReason[] = [
    "tests_passed", "tests_skipped_no_infra", "tests_inconclusive",
    "tests_failed_unrelated", "tests_failed_by_patch", "no_verification_attempted",
    "verification_failed_staged",
    "no_changes_made",
  ];
  return (valid as string[]).includes(raw) ? (raw as VerificationReason) : null;
}

/** Remove any [ZONE_VERIFICATION: <reason>] tag (and surrounding whitespace/newlines) from text. */
export function stripVerificationTag(text: string): string {
  return String(text || "")
    .replace(/\s*\[ZONE_VERIFICATION:\s*[\w_]+\]\s*/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function normalizePatchedPath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").trim();
}

/** Parsed tsc error record used for identity-based regression detection. */
export type CodedError = { file?: string; line?: number; code: string; message: string };

export function errorKey(e: CodedError): string {
  const file = (e.file ?? "").replace(/\\/g, "/").trim();
  const line = e.line ?? 0;
  const msg = (e.message ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${file}:${line}:${e.code}:${msg}`;
}

export function buildErrorKeySet(errors: readonly CodedError[]): Set<string> {
  const keys = new Set<string>();
  for (const e of errors) { if (e.code) keys.add(errorKey(e)); }
  return keys;
}

function isSubset(sub: Set<string>, sup: Set<string>): boolean {
  for (const item of sub) { if (!sup.has(item)) return false; }
  return true;
}

/**
 * Pure: determines whether a verification failure represents a regression
 * (patch introduced new errors) or pre-existing errors (baseline already had them).
 *
 * Uses identity-based subset check when coded errors (tsc TS#### codes) are present —
 * this catches equal-count error swaps that count parity misses.
 * Falls back to count comparison when no coded errors exist (test runners, etc.).
 */
export function classifyVerificationResult(
  post: { count: number; codedErrors: readonly CodedError[] },
  baseline: { count: number; codedErrors: readonly CodedError[] }
): { regressed: boolean; isPreExisting: boolean } {
  const postKeys = buildErrorKeySet(post.codedErrors);
  const baselineKeys = buildErrorKeySet(baseline.codedErrors);

  let regressed: boolean;
  if (postKeys.size > 0 || baselineKeys.size > 0) {
    // Identity-based: a new error not present in the baseline set is a regression
    // even when total counts are equal (e.g. a swap of error classes).
    regressed = !isSubset(postKeys, baselineKeys);
  } else {
    // Count fallback: test runners and other verifiers produce no TS#### codes.
    regressed = post.count > baseline.count;
  }

  const isPreExisting = !regressed && baseline.count > 0;
  return { regressed, isPreExisting };
}

type FinalizeBranch =
  | "applied"
  | "applied_with_warnings"
  | "rolled_back"
  | "pre_existing_errors"
  | "skipped_no_command"
  | "no_change";

/**
 * Pure: maps a verification result + mode to the appropriate finalize branch label.
 * Used by the verifyAndFinalize composer to select the VerifyOutcome variant.
 */
export function deriveFinalizeBranch(
  verifyResult: { status: "pass" | "fail" | "skipped"; regressed?: boolean; reason?: string },
  verifyMode: "warn" | "rollback"
): FinalizeBranch {
  if (verifyResult.status === "pass") return "applied";
  if (verifyResult.status === "skipped") {
    return verifyResult.reason === "no_changes_made" ? "no_change" : "skipped_no_command";
  }
  // fail
  if (verifyResult.regressed === false) return "pre_existing_errors";
  return verifyMode === "rollback" ? "rolled_back" : "applied_with_warnings";
}

export function applyNoInfraVerificationOverride(input: {
  verificationReason: VerificationReason;
  framework?: { hasTests: boolean; testFilesDetected: boolean };
  patchApplied: boolean;
  triggeredBy: "natural_completion" | "max_iterations";
}): VerificationReason {
  if (
    input.framework &&
    !input.framework.hasTests &&
    input.patchApplied &&
    (input.verificationReason === "tests_inconclusive" ||
      input.verificationReason === "no_verification_attempted")
  ) {
    debugLog("[zone-agent-no-infra-override]", JSON.stringify({
      triggeredBy: input.triggeredBy,
      originalVerdict: input.verificationReason,
      overriddenTo: "tests_skipped_no_infra",
      reason: "framework has no runnable tests; downgraded inconclusive/no-verification to skipped",
      hasTests: false,
      testFilesDetected: input.framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }

  return input.verificationReason;
}

/** Infer verification reason from the tool call log when the agent gave no tag. */
export function inferVerificationFromLog(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean; testFilesDetected: boolean }
): VerificationReason {
  const patchApplied = didApplyPatch(log);
  if (framework && !framework.hasTests && patchApplied) {
    debugLog("[zone-agent-no-infra-verdict]", JSON.stringify({
      reason: "tests_skipped_no_infra",
      hasTests: false,
      testFilesDetected: framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }
  const hasInfraError = log.some(
    (e) =>
      e.tool === "run_command" &&
      /spawn.*enoent|enoent.*cmd\.exe|missing script|command not found|cannot find/i.test(
        String(e.result || "")
      )
  );
  const testsRan = log.some(
    (e) => e.tool === "run_command" && /\bpassed\b|\b\d+ pass/i.test(String(e.result || ""))
  );
  if (patchApplied && testsRan) return "tests_passed";
  if (patchApplied && hasInfraError) return "tests_inconclusive";
  // No write tool ever succeeded, so no patch could have caused a test failure — the
  // fallthrough below already returns this same value; kept explicit so this run shape
  // is named here rather than left to fall through silently.
  if (!patchApplied) return "no_verification_attempted";
  return "no_verification_attempted";
}

export function validateUnrelatedClaim(input: {
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  patchedFilePaths: string[];
  framework?: { hasTests: boolean };
}): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    input.framework && !input.framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";
  const anyRunCommand = input.log.some((entry) => entry.tool === "run_command");
  const looksLikePassingRunCommand = (output: string): boolean => {
    const text = String(output || "");
    return (
      /\ball tests passed\b/i.test(text) ||
      /\b0 failed\b/i.test(text) ||
      /\b\d+\s+passed\b.*\b0\s+failed\b/i.test(text)
    );
  };
  const isRunCommandFailure = (entry: {
    tool: string;
    result: string;
    success?: boolean;
  }): boolean => {
    if (entry.tool !== "run_command") return false;
    return entry.success === false;
  };
  const failingRunCommand = [...input.log]
    .reverse()
    .find(
      (entry) =>
        isRunCommandFailure(entry) &&
        !looksLikePassingRunCommand(String(entry.result || ""))
    );

  // Bug 44: stale-failure resolution check.
  // If a failing run_command was followed by a successful run_command,
  // the failure was resolved by a subsequent patch+retry. The agent's
  // `tests_failed_unrelated` claim might still be technically wrong (the
  // failure was related to their patch path), but it should not be demoted
  // to `tests_failed_by_patch` because the file is no longer failing.
  // This handles the canonical "agent encountered a build error, fixed it,
  // re-ran build, build passed" sequence.
  if (failingRunCommand) {
    const failingIdx = input.log.indexOf(failingRunCommand);
    const succeededAfter = input.log.slice(failingIdx + 1).some(
      (entry) => entry.tool === "run_command" && entry.success === true
    );
    if (succeededAfter) {
      return {
        accept: true,
        reason:
          "failing run_command was resolved by a later successful run_command — verification effectively passed",
      };
    }
  }

  if (!anyRunCommand) {
    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "no run_command in log — agent claimed test failure without ever running tests",
    };
  }

  if (!failingRunCommand) {
    return {
      accept: true,
      reason:
        "run_command(s) executed but none look like failure — accepting agent classification",
    };
  }

  const verificationError = parseVerificationError(
    String(failingRunCommand.result || ""),
    input.patchedFilePaths
  );
  const failingOutput = String(failingRunCommand.result || "");
  const normalizedPatched = input.patchedFilePaths.map(normalizePatchedPath);
  const failingFile = normalizePatchedPath(verificationError.failingFile ?? "");
  const failingFileIsPatched =
    !!failingFile &&
    normalizedPatched.some(
      (patchedFilePath) =>
        patchedFilePath === failingFile || failingFile.endsWith(patchedFilePath)
    );

  if (verificationError.isPreExisting === true) {
    return {
      accept: true,
      reason: "parser confirms pre-existing/tooling",
    };
  }

  if (
    !failingFile &&
    /npm warn|deprecated|warning:/i.test(failingOutput) &&
    !/command failed:/i.test(failingOutput)
  ) {
    return {
      accept: true,
      reason: "warning-only output without a failing file path is treated as tooling noise",
    };
  }

  if (failingFileIsPatched) {
    return {
      accept: false,
      demoteTo: "tests_failed_by_patch",
      reason:
        "failing file is in patchedFilePaths — agent's unrelated claim rejected",
    };
  }

  if (failingFile) {
    return {
      accept: true,
      reason: "parser extracted failing file outside patchedFilePaths",
    };
  }

  return {
    accept: false,
    demoteTo: noInfraDemote,
    reason:
      "cannot verify unrelated claim — no failing file extracted or evidence ambiguous",
  };
}

/** SAFE_COMMAND_PREFIXES.test covers most ecosystems but not these JS/Python runner
 *  forms (vitest/jest run without an npm-script wrapper, pytest via -m); supplemented
 *  here rather than widening the shared list, which serves command-approval, not
 *  test-invocation recognition. */
let testInvocationPrefixes: readonly string[] | null = null;

function getTestInvocationPrefixes(): readonly string[] {
  if (!testInvocationPrefixes) {
    testInvocationPrefixes = [
      ...SAFE_COMMAND_PREFIXES.test,
      "vitest",
      "npx vitest",
      "jest",
      "npx jest",
      "python -m pytest",
    ];
  }
  return testInvocationPrefixes;
}

function looksLikeTestInvocation(command: string): boolean {
  const trimmed = command.trim();
  return getTestInvocationPrefixes().some((p) => trimmed === p || trimmed.startsWith(`${p} `));
}

export function validatePassedClaim(
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean }
): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    framework && !framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";

  const candidates = toolCallLog.filter(
    (entry) =>
      (entry.tool === "run_command" || entry.tool === "run_command_readonly") &&
      looksLikeTestInvocation(String(entry.args.command ?? ""))
  );

  if (candidates.length === 0) {
    return {
      accept: false,
      demoteTo: framework && !framework.hasTests
        ? "tests_skipped_no_infra"
        : "no_verification_attempted",
      reason: "agent claimed tests passed without ever running a recognizable test command",
    };
  }

  const anyFailed = candidates.some((entry) => entry.success === false);
  if (anyFailed) {
    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "agent claimed tests passed but at least one test-command invocation exited non-zero",
    };
  }

  return {
    accept: true,
    reason: "test command(s) invoked and none exited non-zero",
  };
}
