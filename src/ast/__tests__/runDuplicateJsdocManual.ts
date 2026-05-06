import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSemanticSmells, validateSyntax } from "../astSyntaxValidator.ts";
import { executeTool } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log("[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
    (details !== undefined ? " :: " + JSON.stringify(details) : ""));
  return result;
}

function setupTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-dup-jsdoc-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

function runCase({ label, content, shouldDetect }) {
  const filePath = "Sample.ts";
  const syntax = validateSyntax(content, filePath);
  const smell = checkSemanticSmells(content, filePath, syntax.ast);
  return { label, syntax, smell, shouldDetect };
}

(async function main() {
  const checks = [];

  console.log("\n=== Direct duplicate_adjacent_jsdoc cases ===");

  const cases = [
    {
      label: "no JSDocs in file",
      content: "export const x = 1;\n",
      shouldDetect: false,
    },
    {
      label: "single JSDoc above function",
      content: "/**\n * Single doc.\n */\nexport function f() { return 1; }\n",
      shouldDetect: false,
    },
    {
      label: "two adjacent identical JSDocs (BUG)",
      content:
        "/**\n * Reads env.\n * @param key\n */\n" +
        "/**\n * Reads env.\n * @param key\n */\n" +
        "const readEnv = (key: string) => process.env[key] ?? null;\n",
      shouldDetect: true,
    },
    {
      label: "two different JSDocs adjacent (legit)",
      content:
        "/**\n * Function doc.\n */\n" +
        "/**\n * Type info.\n */\n" +
        "type Foo = { a: number };\n",
      shouldDetect: false,
    },
    {
      label: "two identical JSDocs with whitespace differences (BUG, normalized)",
      content:
        "/**\n * Reads env.\n */\n" +
        "/**\n *  Reads  env.\n */\n" +
        "const readEnv = (key: string) => null;\n",
      shouldDetect: true,
    },
    {
      label: "two identical plain /* */ block comments (out of scope)",
      content:
        "/* license header */\n" +
        "/* license header */\n" +
        "export const x = 1;\n",
      shouldDetect: false,
    },
    {
      label: "mixed /** */ and /* */ adjacent same content (only JSDoc-JSDoc flagged)",
      content:
        "/**\n * Same text.\n */\n" +
        "/* Same text. */\n" +
        "export const x = 1;\n",
      shouldDetect: false,
    },
  ].map(runCase);

  for (const tc of cases) {
    checks.push(check(`${tc.label} parses successfully`, tc.syntax.ok === true, { syntax: tc.syntax }));
    checks.push(check(
      `${tc.label} smell result`,
      tc.shouldDetect
        ? tc.smell.ok === false && tc.smell.reason === "duplicate_adjacent_jsdoc"
        : tc.smell.ok === true,
      { smell: tc.smell }
    ));
  }

  console.log("\n=== apply_patch integration regression ===");

  {
    const { tempDir, cleanup } = setupTempDir();
    const relPath = "env.ts";
    const originalContent = "const readEnv = (key: string) => process.env[key] ?? null;\n";
    fs.writeFileSync(path.join(tempDir, relPath), originalContent, "utf8");

    const patch =
      "--- FIND ---\n" +
      "const readEnv = (key: string) => process.env[key] ?? null;\n" +
      "--- REPLACE ---\n" +
      "/**\n * Reads env.\n */\n" +
      "/**\n * Reads env.\n */\n" +
      "const readEnv = (key: string) => process.env[key] ?? null;";

    const result = await executeTool(
      "apply_patch",
      { filePath: relPath, patch, intent: "modify", scope: null },
      tempDir
    );
    const after = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    checks.push(check("integration returns failure", result.success === false, { result }));
    checks.push(check(
      "integration reports semantic_smell_post_write",
      result.rejectionReason === "semantic_smell_post_write",
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "integration mentions duplicate_adjacent_jsdoc",
      result.output.includes("duplicate_adjacent_jsdoc"),
      { output: result.output }
    ));
    checks.push(check("integration reverts the file", after === originalContent, {}));

    cleanup();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log("\n=== assert summary ===");
  console.log(JSON.stringify(
    { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    null, 2
  ));

  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const fc of failed) {
      console.log("  FAIL:", fc.label, fc.details !== undefined ? JSON.stringify(fc.details) : "");
    }
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("Unexpected error in test runner:", error);
  process.exitCode = 1;
});
