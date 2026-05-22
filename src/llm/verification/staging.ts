import fs from "node:fs";
import { debugLog, errorLog } from "../../utils/logger.js";
import {
  selectVerificationCommand,
  runVerificationCommand,
  countVerificationErrors,
  execAsync_verify,
  strippedEnvKeys,
} from "./command.js";
import { sanitizeVerificationEnv } from "../../core/buildEnv.js";

export async function runStagingVerification(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
}): Promise<
  | { status: "pass"; label: string; durationMs: number; baselineErrorCount?: number; postErrorCount?: number }
  | {
      status: "fail";
      label: string;
      durationMs: number;
      errorPreview: string;
      // Phase J.3: counts let downstream distinguish a regression (post >
      // baseline) from a pre-existing failure (post <= baseline). Only
      // populated when we ran a baseline pass after the staged run failed.
      baselineErrorCount?: number;
      postErrorCount?: number;
      regressed?: boolean;
    }
  | { status: "skipped"; reason: string }
> {
  if (input.stagingFiles.size === 0) {
    return { status: "skipped", reason: "no_staged_files" };
  }
  const choice = selectVerificationCommand(input.framework);
  if (!choice) {
    return { status: "skipped", reason: "no_command_for_framework" };
  }

  const start = Date.now();
  // Run verification against temp-flushed staging.
  let stagedErr: unknown = null;
  let stagedExitCode = 0;
  try {
    await input.withStagingTempFlush(input.stagingFiles, async () => {
      return await execAsync_verify(choice.command, {
        cwd: input.repoPath,
        timeout: choice.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizeVerificationEnv(),
      });
    });
  } catch (err) {
    stagedErr = err;
    const code = Number((err as { code?: unknown }).code);
    stagedExitCode = Number.isFinite(code) ? code : 1;
  }

  if (stagedErr === null) {
    console.log(
      `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=0 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
    );
    return { status: "pass", label: choice.label, durationMs: Date.now() - start };
  }

  console.log(
    `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=${stagedExitCode} stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
  );
  const stagedStdout = String((stagedErr as { stdout?: unknown }).stdout ?? "");
  const stagedStderr = String((stagedErr as { stderr?: unknown }).stderr ?? "");
  const stagedCombined = (stagedStdout + "\n" + stagedStderr).trim();
  const stagedPreview =
    stagedCombined.split("\n").slice(0, 30).join("\n").slice(0, 2000) ||
    String((stagedErr as Error).message ?? stagedErr);
  const postErrorCount = countVerificationErrors(choice.label, stagedCombined);

  // Phase J.3: staged run failed. Compare to baseline (no staging). If the
  // baseline ALSO fails with ≥ the same error count, the patch didn't make
  // things worse — pre-existing errors shouldn't block apply.
  const baseline = await runVerificationCommand(choice, input.repoPath);
  const baselineErrorCount =
    baseline.status === "fail"
      ? countVerificationErrors(choice.label, baseline.errorPreview)
      : 0;

  const regressed = postErrorCount > baselineErrorCount;
  debugLog("[zone-verify-baseline]", JSON.stringify({
    label: choice.label,
    stagedExitCode,
    baselineStatus: baseline.status,
    baselineErrorCount,
    postErrorCount,
    regressed,
  }));

  return {
    status: "fail",
    label: choice.label,
    durationMs: Date.now() - start,
    errorPreview: stagedPreview,
    baselineErrorCount,
    postErrorCount,
    regressed,
  };
}

/** Phase F: formats post-loop verification regression as WARN text (patches stay on disk). */
export function buildVerificationWarningsMessage(opts: {
  errors: Array<{ file?: string; line?: number; col?: number; code: string; message: string }>;
  filesFlushed: number;
  baselineErrorCount?: number;
  postErrorCount?: number;
}): string {
  const header = `VERIFICATION WARNINGS — patches applied (${opts.filesFlushed} file${opts.filesFlushed !== 1 ? "s" : ""}), new errors detected.`;
  const counts =
    opts.baselineErrorCount !== undefined && opts.postErrorCount !== undefined
      ? `Errors: ${opts.postErrorCount} (baseline was ${opts.baselineErrorCount}).`
      : "";
  const errorLines = opts.errors.slice(0, 20).map((e) => {
    const loc = e.file ? `${e.file}${e.line !== undefined ? `:${e.line}` : ""}` : "";
    return `  ${loc ? `${loc} ` : ""}[${e.code}] ${e.message}`;
  });
  return [header, ...(counts ? [counts] : []), ...(errorLines.length ? ["Errors:", ...errorLines] : [])].join("\n");
}

/** @deprecated Use verifyAndFinalize() from ./composer.ts instead. */
export async function finalizeStaging(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
  /** Phase F: "warn" (default) keeps patches on disk and surfaces errors as warnings.
   *  "rollback" restores pre-Phase-F behavior: staging discarded when regression detected. */
  verifyMode?: "warn" | "rollback";
}): Promise<{
  flushed: boolean;
  verification:
    | { status: "pass"; label: string; durationMs: number; baselineErrorCount?: number; postErrorCount?: number }
    | {
        status: "fail";
        label: string;
        durationMs: number;
        errorPreview: string;
        baselineErrorCount?: number;
        postErrorCount?: number;
        regressed?: boolean;
      }
    | { status: "skipped"; reason: string };
  filesFlushed: number;
  flushFailures: number;
  // Phase J.3.1: when staging is discarded by a regression rollback, return
  // the staged content as a snapshot so runLlmPatchFlow can render the
  // "what was attempted" diff under the rolled-back banner. Keyed by the
  // same absolute paths as input.stagingFiles. Empty/undefined when no
  // discard happened (pass-through or pre-existing-errors).
  discardedStaging?: Map<string, string>;
}> {
  const verification = await runStagingVerification({
    stagingFiles: input.stagingFiles,
    repoPath: input.repoPath,
    framework: input.framework,
    withStagingTempFlush: input.withStagingTempFlush,
  });

  debugLog("[zone-staging-verification]", JSON.stringify({
    status: verification.status,
    label: "label" in verification ? verification.label : null,
    durationMs: "durationMs" in verification ? verification.durationMs : null,
    reason: "reason" in verification ? verification.reason : null,
    errorPreviewLen:
      verification.status === "fail" ? verification.errorPreview.length : 0,
    baselineErrorCount:
      "baselineErrorCount" in verification ? verification.baselineErrorCount : undefined,
    postErrorCount:
      "postErrorCount" in verification ? verification.postErrorCount : undefined,
    regressed:
      verification.status === "fail" ? verification.regressed : undefined,
  }));

  // Phase J.3 / Phase F: when verification regresses:
  //   - rollback mode (ZONE_VERIFY_MODE=rollback): discard staging, restore disk.
  //   - warn mode (default): skip discard, fall through to flush — patches stay on
  //     disk; agentLoop surfaces errors as VERIFICATION WARNINGS in the summary.
  if (verification.status === "fail" && verification.regressed !== false) {
    if ((input.verifyMode ?? "warn") === "rollback") {
      const discardedCount = input.stagingFiles.size;
      const discardedStaging = new Map<string, string>(input.stagingFiles);
      input.stagingFiles.clear();
      debugLog("[zone-staging-discard]", JSON.stringify({
        reason: "verification_regressed",
        discardedCount,
        baselineErrorCount: verification.baselineErrorCount,
        postErrorCount: verification.postErrorCount,
      }));
      return {
        flushed: false,
        verification,
        filesFlushed: 0,
        flushFailures: 0,
        discardedStaging,
      };
    }
    // warn mode: fall through — flush proceeds, errors surface in summary.
    debugLog("[zone-staging-warn-mode]", JSON.stringify({
      reason: "verification_regressed_warn_mode",
      baselineErrorCount: verification.baselineErrorCount,
      postErrorCount: verification.postErrorCount,
    }));
  }

  if (verification.status === "fail" && verification.regressed === false) {
    debugLog("[zone-staging-pre-existing-errors]", JSON.stringify({
      reason: "no_regression",
      baselineErrorCount: verification.baselineErrorCount,
      postErrorCount: verification.postErrorCount,
      label: verification.label,
    }));
    // Fall through to flush — patch will apply despite pre-existing errors.
  }

  let allUnchanged = true;
  let comparedCount = 0;
  for (const [abs, content] of input.stagingFiles) {
    comparedCount++;
    let diskContent: string | null = null;
    try {
      diskContent = fs.readFileSync(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        diskContent = null;
        allUnchanged = false;
        break;
      }
      allUnchanged = false;
      break;
    }
    if (diskContent !== content) {
      allUnchanged = false;
      break;
    }
  }

  if (allUnchanged && comparedCount > 0) {
    debugLog("[zone-staging-noop]", JSON.stringify({
      stagedCount: input.stagingFiles.size,
      comparedCount,
    }));
    return {
      flushed: false,
      verification: { status: "skipped", reason: "no_changes_made" },
      filesFlushed: 0,
      flushFailures: 0,
    };
  }

  // staging-flush-bug Tur: filesFlushed previously incremented immediately
  // after fs.writeFileSync regardless of whether disk actually persisted the
  // content. The smoke for run 71133d8f saw [zone-staging-flush] report 2
  // files written but on-disk mtime was unchanged — the log was lying. The
  // counter now reflects VERIFIED writes (re-read disk content matches
  // staging). Per-file [zone-staging-flush-write] logs surface mtime
  // before/after and content-match status to catch any future regression.
  let filesFlushed = 0;
  let flushFailures = 0;
  for (const [abs, content] of input.stagingFiles) {
    let mtimeBefore: number | null = null;
    try {
      mtimeBefore = fs.statSync(abs).mtimeMs;
    } catch {
      mtimeBefore = null;
    }
    try {
      fs.writeFileSync(abs, content, "utf8");
      let mtimeAfter: number | null = null;
      try {
        mtimeAfter = fs.statSync(abs).mtimeMs;
      } catch {
        mtimeAfter = null;
      }
      let diskContentMatches = false;
      try {
        diskContentMatches = fs.readFileSync(abs, "utf8") === content;
      } catch {
        diskContentMatches = false;
      }
      debugLog("[zone-staging-flush-write]", JSON.stringify({
        filePath: abs,
        bytesWritten: content.length,
        mtimeBefore,
        mtimeAfter,
        changed: mtimeBefore !== mtimeAfter,
        diskContentMatches,
      }));
      if (diskContentMatches) {
        filesFlushed++;
      } else {
        flushFailures++;
        errorLog("[zone-staging-flush-error]", {
          filePath: abs,
          error: "post_write_content_mismatch",
          bytesExpected: content.length,
        });
      }
    } catch (err) {
      flushFailures++;
      errorLog("[zone-staging-flush-error]", {
        filePath: abs,
        error: String((err as Error).message ?? err),
      });
    }
  }
  // Final integrity sweep: re-read all files at the moment we emit the
  // [zone-staging-flush] log. If a downstream restore overwrites any of our
  // writes between the per-file write and this point, postFlushMismatches
  // will be > 0 and surface the bug visibly.
  let postFlushMismatches = 0;
  for (const [abs, content] of input.stagingFiles) {
    try {
      if (fs.readFileSync(abs, "utf8") !== content) postFlushMismatches++;
    } catch {
      postFlushMismatches++;
    }
  }
  debugLog("[zone-staging-flush]", JSON.stringify({
    filesFlushed,
    failures: flushFailures,
    totalStaged: input.stagingFiles.size,
    postFlushMismatches,
  }));
  return { flushed: true, verification, filesFlushed, flushFailures };
}
