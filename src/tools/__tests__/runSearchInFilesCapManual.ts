import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

function writeLines(filePath, count, prefix) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(`${prefix} needle ${i}`);
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

(async function main() {
  const checks = [];

  {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-search-cap-small-"));
    try {
      fs.writeFileSync(path.join(repoPath, "a.ts"), Array.from({ length: 5 }, (_, i) => `needle a${i}`).join("\n") + "\n", "utf8");
      fs.writeFileSync(path.join(repoPath, "b.ts"), Array.from({ length: 5 }, (_, i) => `needle b${i}`).join("\n") + "\n", "utf8");
      fs.writeFileSync(path.join(repoPath, "c.ts"), Array.from({ length: 5 }, (_, i) => `needle c${i}`).join("\n") + "\n", "utf8");
      const result = await executeTool("search_in_files", { pattern: "needle", fileGlob: null }, repoPath);
      checks.push(check(
        "cap not reached includes summary without warning",
        result.success === true &&
          result.output.includes("[search_in_files] Found 15 matches across 3 files.") &&
          !result.output.includes("CAP REACHED"),
        { output: result.output }
      ));
    } finally {
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  }

  {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-search-cap-large-"));
    try {
      writeLines(path.join(repoPath, "huge.ts"), 600, "needle");
      const result = await executeTool("search_in_files", { pattern: "needle", fileGlob: null }, repoPath);
      checks.push(check(
        "cap reached summary reports 500 match ceiling",
        result.success === true &&
          result.output.includes("[search_in_files] Found 500 matches across 1 files.") &&
          result.output.includes("CAP REACHED at 500 matches"),
        { output: result.output }
      ));
    } finally {
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  }

  const failed = checks.filter((item) => !item.pass);
  console.log(`[search-cap-test] PASSED ${checks.length - failed.length}/2 assertions`);

  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const failedCheck of failed) {
      console.log(
        "  FAIL:",
        failedCheck.label,
        failedCheck.details !== undefined ? JSON.stringify(failedCheck.details) : ""
      );
    }
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("Unexpected error in test runner:", error);
  process.exitCode = 1;
});
