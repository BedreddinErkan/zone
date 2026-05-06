/**
 * Manual test: finalizeStaging pass-writes-to-disk and fail-leaves-disk-untouched.
 *
 * Bug origin: smoke 71133d8f reported [zone-staging-flush] {filesFlushed:2}
 * but on-disk mtime was unchanged. The counter was incrementing on
 * fs.writeFileSync return without any post-write verification. After fix
 * filesFlushed reflects post-write content match.
 *
 * Run with:
 *   node --experimental-strip-types src/llm/__tests__/runFinalizeStagingManual.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { finalizeStaging } from "../../../dist/llm/agentLoop.js";
import { withStagingTempFlush } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks = [];

// ── pass branch (no framework => verification skipped => writes happen) ──────

console.log("\n=== finalizeStaging: pass branch writes to disk ===");

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zone-finalize-pass-"));
  const f1 = path.join(tmp, "fileA.txt");
  const f2 = path.join(tmp, "sub", "fileB.txt");
  fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
  fs.writeFileSync(f1, "ORIGINAL_A");
  fs.writeFileSync(f2, "ORIGINAL_B");

  const stagingFiles = new Map([
    [f1, "MODIFIED_A"],
    [f2, "MODIFIED_B"],
  ]);

  const result = await finalizeStaging({
    stagingFiles,
    repoPath: tmp,
    framework: undefined, // no verification command => skipped status
    withStagingTempFlush,
  });

  checks.push(check(
    "pass: result.flushed is true",
    result.flushed === true,
    { result }
  ));

  // verification skipped (no framework / no command)
  checks.push(check(
    "pass: verification status is skipped (no framework)",
    result.verification.status === "skipped",
    { verification: result.verification }
  ));

  checks.push(check(
    "pass: filesFlushed equals 2",
    result.filesFlushed === 2,
    { filesFlushed: result.filesFlushed }
  ));

  checks.push(check(
    "pass: flushFailures is 0",
    result.flushFailures === 0,
    { flushFailures: result.flushFailures }
  ));

  // Most important: disk content actually matches staging
  checks.push(check(
    "pass: fileA.txt disk content is MODIFIED_A",
    fs.readFileSync(f1, "utf8") === "MODIFIED_A",
    { actual: fs.readFileSync(f1, "utf8") }
  ));
  checks.push(check(
    "pass: fileB.txt disk content is MODIFIED_B",
    fs.readFileSync(f2, "utf8") === "MODIFIED_B",
    { actual: fs.readFileSync(f2, "utf8") }
  ));

  fs.rmSync(tmp, { recursive: true });
}

// ── fail branch (framework set, but tsc command in tmp dir will fail) ────────
//
// Note: the verification path tries `npx tsc --noEmit`. In a tmp dir with no
// tsconfig.json, tsc will exit non-zero — verification fails, staging must
// be discarded, and disk must be untouched.

console.log("\n=== finalizeStaging: fail branch leaves disk untouched ===");

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zone-finalize-fail-"));
  const f1 = path.join(tmp, "fileC.ts");
  fs.writeFileSync(f1, "ORIGINAL_C");

  const stagingFiles = new Map([
    [f1, "let x: number = 'broken';"], // semantically broken — would fail tsc anyway, but tsc itself errors first because there's no project
  ]);

  const result = await finalizeStaging({
    stagingFiles,
    repoPath: tmp,
    framework: { language: "typescript" },
    withStagingTempFlush,
  });

  checks.push(check(
    "fail: result.flushed is false",
    result.flushed === false,
    { result }
  ));

  checks.push(check(
    "fail: verification status is fail",
    result.verification.status === "fail",
    { verification: result.verification }
  ));

  checks.push(check(
    "fail: filesFlushed is 0",
    result.filesFlushed === 0,
    { filesFlushed: result.filesFlushed }
  ));

  // CRITICAL: disk must be the original content (not the staged "broken" content)
  checks.push(check(
    "fail: fileC.ts disk content is still ORIGINAL_C (verification fail discarded)",
    fs.readFileSync(f1, "utf8") === "ORIGINAL_C",
    { actual: fs.readFileSync(f1, "utf8") }
  ));

  // staging map should be cleared on fail
  checks.push(check(
    "fail: stagingFiles map cleared",
    stagingFiles.size === 0,
    { remaining: stagingFiles.size }
  ));

  fs.rmSync(tmp, { recursive: true });
}

// ── post-write verification: content mismatch should mark as failure ─────────
//
// Force an artificial post-write mismatch by passing a stagingFiles map whose
// content differs from what was just written. We achieve this by intercepting
// the staging entry after the write — but we can't easily do that without
// more invasive plumbing. Skip this scenario; the [zone-staging-flush-write]
// log is the smoke-time signal for it.

// ── Summary ──────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
console.log("\n=== assert summary ===");
console.log(JSON.stringify(
  { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  null, 2
));
if (failed.length > 0) {
  console.log("\nFailed checks:");
  for (const f of failed) {
    console.log("  FAIL:", f.label, f.details !== undefined ? JSON.stringify(f.details) : "");
  }
  process.exitCode = 1;
}
