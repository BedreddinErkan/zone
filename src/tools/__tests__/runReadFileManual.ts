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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-readfile-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

function makeRepeatedText(length) {
  const chunk = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n";
  let out = "";
  while (out.length < length) out += chunk;
  return out.slice(0, length);
}

(async function main() {
  const checks = [];
  const { tempDir, cleanup } = setupTempDir();

  try {
    const mediumRelPath = "medium.txt";
    const mediumContent = makeRepeatedText(62_000);
    fs.writeFileSync(path.join(tempDir, mediumRelPath), mediumContent, "utf8");

    const boundaryRelPath = "boundary.txt";
    const boundaryContent = makeRepeatedText(150_000);
    fs.writeFileSync(path.join(tempDir, boundaryRelPath), boundaryContent, "utf8");

    const oversizedRelPath = "oversized.txt";
    const oversizedContent = makeRepeatedText(180_000);
    fs.writeFileSync(path.join(tempDir, oversizedRelPath), oversizedContent, "utf8");

    const emptyRelPath = "empty.txt";
    fs.writeFileSync(path.join(tempDir, emptyRelPath), "", "utf8");

    console.log("\n=== Default full read under 150k ===");
    const defaultRead = await executeTool("read_file", { filePath: mediumRelPath }, tempDir);
    checks.push(check(
      "default read succeeds",
      defaultRead.success === true,
      { success: defaultRead.success }
    ));
    checks.push(check(
      "default read returns full file without warning",
      defaultRead.output === mediumContent &&
        !defaultRead.output.includes("[FILE TRUNCATED"),
      { outputLength: defaultRead.output.length }
    ));

    console.log("\n=== Exact 150k boundary ===");
    const boundaryRead = await executeTool("read_file", { filePath: boundaryRelPath }, tempDir);
    checks.push(check(
      "boundary read returns full file without warning",
      boundaryRead.output === boundaryContent &&
        !boundaryRead.output.includes("[FILE TRUNCATED"),
      { outputLength: boundaryRead.output.length }
    ));

    console.log("\n=== Oversized file truncation ===");
    const truncatedRead = await executeTool("read_file", { filePath: oversizedRelPath }, tempDir);
    const expectedTruncatedPrefix = "[FILE TRUNCATED";
    const truncatedBody = truncatedRead.output.split("]\n\n")[1] ?? "";
    checks.push(check(
      "oversized read shows truncation warning",
      truncatedRead.output.startsWith(expectedTruncatedPrefix),
      { preview: truncatedRead.output.slice(0, 220) }
    ));
    checks.push(check(
      "oversized read returns first 150k chars",
      truncatedBody === oversizedContent.slice(0, 150_000),
      { bodyLength: truncatedBody.length }
    ));

    console.log("\n=== Empty file ===");
    const emptyRead = await executeTool("read_file", { filePath: emptyRelPath }, tempDir);
    checks.push(check(
      "empty file returns empty content without warning",
      emptyRead.output === "" && !emptyRead.output.includes("[FILE TRUNCATED"),
      { outputLength: emptyRead.output.length }
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
