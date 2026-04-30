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

function setupTempRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-find-refs-test-"));
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });

  fs.writeFileSync(path.join(repoPath, "src", "target.ts"), [
    "export function getUser() {",
    "  return 'user';",
    "}",
    "",
    "export function getOrder() {",
    "  return 'order';",
    "}",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(repoPath, "src", "consumer-a.ts"), [
    "import { getUser } from './target';",
    "export const a = getUser();",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(repoPath, "src", "consumer-b.ts"), [
    "import { getUser } from './target';",
    "export const b = getUser();",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(repoPath, "src", "consumer-c.ts"), [
    "import { getOrder } from './target';",
    "export const c = getOrder();",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(repoPath, "src", "consumer-d.ts"), [
    "import { getUser as fetchUser } from './target';",
    "export const d = fetchUser();",
    "",
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(repoPath, "src", "unrelated.ts"), [
    "export const unrelated = 1;",
    "",
  ].join("\n"), "utf8");

  return {
    repoPath,
    cleanup() {
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

(async function main() {
  const checks = [];
  const { repoPath, cleanup } = setupTempRepo();

  try {
    const direct = await executeTool(
      "find_references",
      { sourceFile: "src/target.ts", symbolName: "getUser" },
      repoPath
    );
    checks.push(check(
      "direct named import finds expected consumers",
      direct.success === true &&
        direct.output.includes("src/consumer-a.ts") &&
        direct.output.includes("src/consumer-b.ts") &&
        direct.output.includes("src/consumer-d.ts"),
      { output: direct.output }
    ));
    checks.push(check(
      "direct named import excludes unrelated consumers",
      !direct.output.includes("src/consumer-c.ts") &&
        !direct.output.includes("src/unrelated.ts"),
      { output: direct.output }
    ));
    checks.push(check(
      "aliased import is annotated",
      direct.output.includes("src/consumer-d.ts  (imported as: fetchUser)"),
      { output: direct.output }
    ));

    const noConsumers = await executeTool(
      "find_references",
      { sourceFile: "src/target.ts", symbolName: "nonExistentSymbol" },
      repoPath
    );
    checks.push(check(
      "symbol with no consumers returns no-files message",
      noConsumers.success === true &&
        noConsumers.output.startsWith('No files import "nonExistentSymbol"'),
      { output: noConsumers.output }
    ));

    const missingSource = await executeTool(
      "find_references",
      { sourceFile: "src/missing.ts", symbolName: "anything" },
      repoPath
    );
    checks.push(check(
      "missing source file reports graph lookup failure",
      missingSource.success === false &&
        missingSource.output.includes("Source file not found in dependency graph"),
      { output: missingSource.output }
    ));

    const emptySymbol = await executeTool(
      "find_references",
      { sourceFile: "src/target.ts", symbolName: "" },
      repoPath
    );
    checks.push(check(
      "empty symbol name is rejected",
      emptySymbol.success === false && emptySymbol.output === "symbolName is required",
      { output: emptySymbol.output }
    ));

    const otherSymbol = await executeTool(
      "find_references",
      { sourceFile: "src/target.ts", symbolName: "getOrder" },
      repoPath
    );
    const windowsPath = await executeTool(
      "find_references",
      { sourceFile: "src\\target.ts", symbolName: "getUser" },
      repoPath
    );
    checks.push(check(
      "different symbol and windows-style path both resolve correctly",
      otherSymbol.success === true &&
        otherSymbol.output.includes("src/consumer-c.ts") &&
        !otherSymbol.output.includes("src/consumer-a.ts") &&
        windowsPath.success === true &&
        windowsPath.output.includes("src/consumer-a.ts") &&
        windowsPath.output.includes("src/consumer-b.ts") &&
        windowsPath.output.includes("src/consumer-d.ts"),
      { otherOutput: otherSymbol.output, windowsOutput: windowsPath.output }
    ));
  } finally {
    cleanup();
  }

  const failed = checks.filter((item) => !item.pass);
  console.log(`[find-references-test] PASSED ${checks.length - failed.length}/7 assertions`);

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
