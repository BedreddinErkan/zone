/**
 * Manual integration test for Phase 2C pre-flight syntax check in apply_patch.
 *
 * Run with:
 *   node --experimental-strip-types src/ast/__tests__/runPreflightManual.ts
 *
 * All test code lives inside an async IIFE to avoid top-level await.
 * No TypeScript type annotations are used so the Node.js 22 CJS-mode
 * TypeScript stripper does not trip on unhandled TS syntax.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Import from compiled dist so Node16-style .js sub-imports inside toolExecutor
// resolve correctly under --experimental-strip-types.
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-preflight-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

(async function main() {
  const checks = [];

  // ---- Test 1: broken file + scope => file_already_broken_pre_patch --------
  console.log("\n=== Test 1: Pre-existing syntax error + scope => preflight rejection ===");
  {
    const { tempDir, cleanup } = setupTempDir();

    // Deliberately broken JS: function with unclosed parenthesis
    const brokenContent =
      "function foo( {\n" +
      "  return 42;\n" +
      "}\n";

    const relPath = "broken_with_scope.js";
    fs.writeFileSync(path.join(tempDir, relPath), brokenContent, "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  return 42;\n" +
          "--- REPLACE ---\n" +
          "  return 99;",
        intent: "modify",
        scope: { symbolName: "foo", symbolKind: "function", className: null },
      },
      tempDir
    );

    checks.push(check(
      "Test 1a: result.success is false",
      result.success === false,
      { success: result.success }
    ));
    checks.push(check(
      "Test 1b: rejectionReason is file_already_broken_pre_patch",
      result.rejectionReason === "file_already_broken_pre_patch",
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "Test 1c: output mentions 'NOT caused by your patch'",
      result.output.includes("NOT caused by your patch"),
      { outputSlice: result.output.slice(0, 300) }
    ));
    checks.push(check(
      "Test 1d: output includes scope recovery instruction (Omit scope)",
      result.output.includes("Omit scope"),
      { outputSlice: result.output.slice(0, 400) }
    ));
    console.log("  output:", result.output.slice(0, 400));

    cleanup();
  }

  // ---- Test 2: broken file + no scope => file_already_broken_pre_patch -----
  console.log("\n=== Test 2: Pre-existing syntax error + no scope => preflight rejection ===");
  {
    const { tempDir, cleanup } = setupTempDir();

    // Different breakage: missing closing brace
    const brokenContent =
      "function bar() {\n" +
      "  const x = 1;\n";
    // intentionally no closing }

    const relPath = "broken_no_scope.js";
    fs.writeFileSync(path.join(tempDir, relPath), brokenContent, "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  const x = 1;\n" +
          "--- REPLACE ---\n" +
          "  const x = 2;",
        intent: "modify",
        scope: null,
      },
      tempDir
    );

    checks.push(check(
      "Test 2a: result.success is false",
      result.success === false,
      { success: result.success }
    ));
    checks.push(check(
      "Test 2b: rejectionReason is file_already_broken_pre_patch",
      result.rejectionReason === "file_already_broken_pre_patch",
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "Test 2c: output mentions 'NOT caused by your patch'",
      result.output.includes("NOT caused by your patch"),
      { outputSlice: result.output.slice(0, 300) }
    ));
    checks.push(check(
      "Test 2d: output does NOT include scope-specific recovery (no scope was given)",
      !result.output.includes("Omit scope"),
      { outputSlice: result.output.slice(0, 400) }
    ));
    console.log("  output:", result.output.slice(0, 400));

    cleanup();
  }

  // ---- Test 3: clean file => preflight passes, patch applies ---------------
  console.log("\n=== Test 3: Clean file => preflight passes, patch applies normally ===");
  {
    const { tempDir, cleanup } = setupTempDir();

    const cleanContent =
      "function greet(name) {\n" +
      "  return 'Hello ' + name;\n" +
      "}\n";

    const relPath = "clean_file.js";
    fs.writeFileSync(path.join(tempDir, relPath), cleanContent, "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  return 'Hello ' + name;\n" +
          "--- REPLACE ---\n" +
          "  return `Hello ${name}!`;",
        intent: "modify",
        scope: null,
      },
      tempDir
    );

    const after = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    checks.push(check(
      "Test 3a: result.success is true",
      result.success === true,
      { success: result.success, output: result.output.slice(0, 100) }
    ));
    checks.push(check(
      "Test 3b: rejectionReason is absent",
      result.rejectionReason === undefined,
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "Test 3c: replacement text present in file",
      after.includes("Hello ${name}!"),
      { afterSlice: after.slice(0, 200) }
    ));
    console.log("  patched file:\n" + after);

    cleanup();
  }

  // ---- Test 4: TypeScript broken file => preflight rejection ---------------
  console.log("\n=== Test 4: Broken TypeScript file => preflight rejection ===");
  {
    const { tempDir, cleanup } = setupTempDir();

    // TypeScript with broken syntax: unclosed generic
    const brokenTs =
      "function identity<T(x: T): T {\n" +
      "  return x;\n" +
      "}\n";

    const relPath = "broken.ts";
    fs.writeFileSync(path.join(tempDir, relPath), brokenTs, "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  return x;\n" +
          "--- REPLACE ---\n" +
          "  return x; // identity",
        intent: "modify",
        scope: null,
      },
      tempDir
    );

    checks.push(check(
      "Test 4a: result.success is false",
      result.success === false,
      { success: result.success }
    ));
    checks.push(check(
      "Test 4b: rejectionReason is file_already_broken_pre_patch",
      result.rejectionReason === "file_already_broken_pre_patch",
      { rejectionReason: result.rejectionReason }
    ));
    console.log("  output:", result.output.slice(0, 300));

    cleanup();
  }

  // ---- Summary -------------------------------------------------------------
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
})().catch((err) => {
  console.error("Unexpected error in test runner:", err);
  process.exitCode = 1;
});
