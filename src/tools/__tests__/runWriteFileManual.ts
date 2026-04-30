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

function setupTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-writefile-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

(async function main() {
  const checks = [];
  const { tempDir, cleanup } = setupTempDir();

  try {
    console.log("\n=== New file + semantic smell => delete created file ===");
    const newSmellyPath = "newSmelly.jsx";
    const newSmellyContent = [
      "export function App() {",
      "  return <div className=\"a\" className=\"b\">Hello</div>;",
      "}",
      "",
    ].join("\n");
    const newSmellyWrite = await executeTool(
      "write_file",
      { filePath: newSmellyPath, content: newSmellyContent },
      tempDir
    );
    checks.push(check(
      "new file smell write fails",
      newSmellyWrite.success === false &&
        newSmellyWrite.rejectionReason === "semantic_smell_post_write",
      { result: newSmellyWrite }
    ));
    checks.push(check(
      "new file smell write removes created file",
      fs.existsSync(path.join(tempDir, newSmellyPath)) === false,
      { existsAfter: fs.existsSync(path.join(tempDir, newSmellyPath)) }
    ));

    console.log("\n=== Existing file + semantic smell => restore original ===");
    const existingSmellyPath = "existingSmelly.jsx";
    const originalExistingSmellyContent = [
      "export function App() {",
      "  return <div className=\"original\">Hello</div>;",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(
      path.join(tempDir, existingSmellyPath),
      originalExistingSmellyContent,
      "utf8"
    );
    const overwriteSmellyContent = [
      "export function App() {",
      "  return <div className=\"a\" className=\"b\">Hello</div>;",
      "}",
      "",
    ].join("\n");
    const existingSmellyWrite = await executeTool(
      "write_file",
      { filePath: existingSmellyPath, content: overwriteSmellyContent },
      tempDir
    );
    const restoredExistingSmellyContent = fs.readFileSync(
      path.join(tempDir, existingSmellyPath),
      "utf8"
    );
    checks.push(check(
      "existing file smell write fails",
      existingSmellyWrite.success === false &&
        existingSmellyWrite.rejectionReason === "semantic_smell_post_write",
      { result: existingSmellyWrite }
    ));
    checks.push(check(
      "existing file smell write restores original content",
      restoredExistingSmellyContent === originalExistingSmellyContent,
      { restoredLength: restoredExistingSmellyContent.length }
    ));

    console.log("\n=== New file + syntax error => delete created file ===");
    const newBrokenPath = "newBroken.jsx";
    const newBrokenContent = [
      "export function Broken() {",
      "  return <div>",
      "",
    ].join("\n");
    const newBrokenWrite = await executeTool(
      "write_file",
      { filePath: newBrokenPath, content: newBrokenContent },
      tempDir
    );
    checks.push(check(
      "new file syntax-broken write fails",
      newBrokenWrite.success === false &&
        newBrokenWrite.rejectionReason === "syntax_broken_post_write",
      { result: newBrokenWrite }
    ));
    checks.push(check(
      "new file syntax-broken write removes created file",
      fs.existsSync(path.join(tempDir, newBrokenPath)) === false,
      { existsAfter: fs.existsSync(path.join(tempDir, newBrokenPath)) }
    ));

    console.log("\n=== New nested file + valid write => parent dir auto-created ===");
    const nestedValidPath = path.join("server", "tests", "appointmentsController.test.js");
    const nestedValidContent = [
      "export const nested = true;",
      "",
    ].join("\n");
    const nestedValidWrite = await executeTool(
      "write_file",
      { filePath: nestedValidPath, content: nestedValidContent },
      tempDir
    );
    const nestedValidAbs = path.join(tempDir, nestedValidPath);
    checks.push(check(
      "new nested file write succeeds",
      nestedValidWrite.success === true,
      { result: nestedValidWrite }
    ));
    checks.push(check(
      "new nested file write creates parent directory and file",
      fs.existsSync(path.dirname(nestedValidAbs)) && fs.existsSync(nestedValidAbs),
      {
        dirExists: fs.existsSync(path.dirname(nestedValidAbs)),
        fileExists: fs.existsSync(nestedValidAbs),
      }
    ));

    console.log("\n=== New nested file + semantic smell => validation still rolls back ===");
    const nestedSmellyPath = path.join("server", "tests", "brokenNested.jsx");
    const nestedSmellyContent = [
      "export function BrokenNested() {",
      "  return <div className=\"a\" className=\"b\">Hello</div>;",
      "}",
      "",
    ].join("\n");
    const nestedSmellyWrite = await executeTool(
      "write_file",
      { filePath: nestedSmellyPath, content: nestedSmellyContent },
      tempDir
    );
    const nestedSmellyAbs = path.join(tempDir, nestedSmellyPath);
    checks.push(check(
      "new nested file smell write still fails validation",
      nestedSmellyWrite.success === false &&
        nestedSmellyWrite.rejectionReason === "semantic_smell_post_write",
      { result: nestedSmellyWrite }
    ));
    checks.push(check(
      "new nested file smell write removes created file after validation",
      fs.existsSync(nestedSmellyAbs) === false,
      { existsAfter: fs.existsSync(nestedSmellyAbs) }
    ));

    console.log("\n=== Existing file + valid write => success ===");
    const validPath = "valid.jsx";
    fs.writeFileSync(
      path.join(tempDir, validPath),
      "export const before = true;\n",
      "utf8"
    );
    const validContent = [
      "import React from \"react\";",
      "",
      "export function Valid() {",
      "  return <div className=\"ok\">Hello</div>;",
      "}",
      "",
    ].join("\n");
    const validWrite = await executeTool(
      "write_file",
      { filePath: validPath, content: validContent },
      tempDir
    );
    const validAfter = fs.readFileSync(path.join(tempDir, validPath), "utf8");
    checks.push(check(
      "valid write succeeds",
      validWrite.success === true,
      { result: validWrite }
    ));
    checks.push(check(
      "valid write keeps new content on disk",
      validAfter === validContent,
      { outputLength: validAfter.length }
    ));
  } finally {
    cleanup();
  }

  const failed = checks.filter((item) => !item.pass);
  console.log("\n=== assert summary ===");
  console.log(JSON.stringify(
    { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    null,
    2
  ));

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
