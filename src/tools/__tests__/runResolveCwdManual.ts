import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRunCommandCwd } from "../../../dist/tools/toolExecutor.js";

function check(
  label: string,
  pass: boolean,
  details?: Record<string, unknown>
): { label: string; pass: boolean; details?: Record<string, unknown> } {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks: Array<{ label: string; pass: boolean; details?: Record<string, unknown> }> = [];
const repoPath = process.cwd();
const missingAbsPath = path.join(os.tmpdir(), "zone-test-nonexistent-9z9z9z");

console.log("\n=== resolve cwd ===");

{
  const result = resolveRunCommandCwd(null, repoPath);
  checks.push(
    check(
      "null cwd falls back to repoPath",
      result.ok === true && result.cwd === repoPath,
      result
    )
  );
}

{
  const result = resolveRunCommandCwd("", repoPath);
  checks.push(
    check(
      "empty string cwd falls back to repoPath",
      result.ok === true && result.cwd === repoPath,
      result
    )
  );
}

{
  const result = resolveRunCommandCwd("   ", repoPath);
  checks.push(
    check(
      "whitespace cwd falls back to repoPath",
      result.ok === true && result.cwd === repoPath,
      result
    )
  );
}

{
  const expected = path.resolve(repoPath, "src");
  const result = resolveRunCommandCwd("src", repoPath);
  checks.push(
    check(
      "relative cwd resolves against repoPath",
      result.ok === true && result.cwd === expected,
      { result, expected }
    )
  );
}

{
  const expected = path.normalize(repoPath);
  const result = resolveRunCommandCwd(repoPath, repoPath);
  checks.push(
    check(
      "absolute cwd to existing dir is used as-is",
      result.ok === true && path.normalize(result.cwd) === expected,
      { result, expected }
    )
  );
}

{
  const result = resolveRunCommandCwd("definitely-not-a-real-folder-xyz", repoPath);
  checks.push(
    check(
      "relative missing cwd returns does not exist error",
      result.ok === false && result.error.includes("does not exist"),
      result
    )
  );
}

{
  if (fs.existsSync(missingAbsPath)) {
    fs.rmSync(missingAbsPath, { recursive: true, force: true });
  }
  const result = resolveRunCommandCwd(missingAbsPath, repoPath);
  checks.push(
    check(
      "absolute missing cwd returns does not exist error",
      result.ok === false && result.error.includes("does not exist"),
      result
    )
  );
}

{
  const result = resolveRunCommandCwd(path.join(repoPath, "package.json"), repoPath);
  checks.push(
    check(
      "file cwd returns not a directory error",
      result.ok === false && result.error.includes("not a directory"),
      result
    )
  );
}

{
  const result = resolveRunCommandCwd(42 as unknown, repoPath);
  checks.push(
    check(
      "non-string cwd type returns invalid type error",
      result.ok === false && result.error.includes("Invalid cwd type"),
      result
    )
  );
}

const passedCount = checks.filter((entry) => entry.pass).length;
console.log(`\n[resolve-cwd-test] PASSED ${passedCount}/9 assertions`);

if (passedCount !== 9) {
  process.exitCode = 1;
}
