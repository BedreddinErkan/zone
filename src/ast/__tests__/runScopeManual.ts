/**
 * Manual integration test for Phase 2B scope-bounded apply_patch + post-write
 * syntax validation.
 *
 * Run with:
 *   node --experimental-strip-types src/ast/__tests__/runScopeManual.ts
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
// src/ast/__tests__/** is excluded from tsc compilation so this path is fine.
import { executeTool } from "../../../dist/tools/toolExecutor.js";

const FIXTURES_DIR = path.resolve("src/ast/__tests__/fixtures");

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

function setupTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-scope-test-"));
  return {
    tempDir,
    cleanup() {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    },
  };
}

function copyFixture(tempDir, fixtureName) {
  fs.copyFileSync(path.join(FIXTURES_DIR, fixtureName), path.join(tempDir, fixtureName));
  return fixtureName;
}

(async function main() {
  const checks = [];

  // ---- Test 1: syntax-breaking patch => file reverted ----------------------
  console.log("\n=== Test 1: Syntax-breaking patch => file reverted ===");
  {
    const { tempDir, cleanup } = setupTempDir();
    const relPath = copyFixture(tempDir, "func_decl.js");
    const original = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    // Removes the closing brace of `add`, producing broken syntax.
    const syntaxBreakPatch =
      "--- FIND ---\n" +
      "function add(a, b) {\n" +
      "  return a + b;\n" +
      "}\n" +
      "--- REPLACE ---\n" +
      "function add(a, b) {\n" +
      "  return a + b;\n" +
      "  // intentionally broken - closing brace removed";

    const result = await executeTool(
      "apply_patch",
      { filePath: relPath, patch: syntaxBreakPatch, intent: "modify", scope: null },
      tempDir
    );

    const afterContent = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    checks.push(check("Test 1a: result.success is false", result.success === false, { success: result.success }));
    checks.push(check(
      "Test 1b: rejectionReason is syntax_broken_post_write",
      result.rejectionReason === "syntax_broken_post_write",
      { rejectionReason: result.rejectionReason }
    ));
    checks.push(check(
      "Test 1c: file on disk equals original (reverted)",
      afterContent === original,
      { originalLen: original.length, afterLen: afterContent.length, matches: afterContent === original }
    ));
    console.log("  output:", result.output.slice(0, 200));

    cleanup();
  }

  // ---- Test 2: scope not_found rejection -----------------------------------
  console.log("\n=== Test 2: scope.symbolName that does not exist => rejection ===");
  {
    const { tempDir, cleanup } = setupTempDir();
    const relPath = copyFixture(tempDir, "func_decl.js");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "function add(a, b) {\n" +
          "--- REPLACE ---\n" +
          "function add(a, b) {",
        intent: "modify",
        scope: { symbolName: "doesNotExist123", symbolKind: null, className: null },
      },
      tempDir
    );

    checks.push(check("Test 2a: result.success is false", result.success === false, { success: result.success }));
    checks.push(check(
      "Test 2b: output mentions the missing symbol name",
      result.output.includes("doesNotExist123"),
      { outputSlice: result.output.slice(0, 200) }
    ));
    console.log("  output:", result.output.slice(0, 200));

    cleanup();
  }

  // ---- Test 3: scope used successfully ------------------------------------
  console.log("\n=== Test 3: scope.symbolName='add' => patch applied inside function ===");
  {
    const { tempDir, cleanup } = setupTempDir();
    const relPath = copyFixture(tempDir, "func_decl.js");
    const original = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  return a + b;\n" +
          "--- REPLACE ---\n" +
          "  const result = a + b;\n" +
          "  return result;",
        intent: "modify",
        scope: { symbolName: "add", symbolKind: "function", className: null },
      },
      tempDir
    );

    const after = fs.readFileSync(path.join(tempDir, relPath), "utf8");

    checks.push(check("Test 3a: result.success is true", result.success === true, { success: result.success, output: result.output }));
    checks.push(check("Test 3b: file was modified", after !== original, { changed: after !== original }));
    checks.push(check(
      "Test 3c: replacement text present",
      after.includes("const result = a + b;") && after.includes("return result;"),
      { hasConstResult: after.includes("const result = a + b;") }
    ));
    checks.push(check(
      "Test 3d: gen function preserved unchanged",
      after.includes("async function* gen()") && after.includes("yield 1;"),
      { genPreserved: after.includes("async function* gen()") }
    ));
    console.log("  patched file:\n" + after);

    cleanup();
  }

  // ---- Test 4: scope multi_match rejection --------------------------------
  console.log("\n=== Test 4: scope with ambiguous multi-match => rejection ===");
  {
    const { tempDir, cleanup } = setupTempDir();

    // Two classes both have a `getValue` method.
    const multiMatchContent =
      "class A {\n" +
      "  getValue() {\n" +
      "    return 1;\n" +
      "  }\n" +
      "}\n" +
      "\n" +
      "class B {\n" +
      "  getValue() {\n" +
      "    return 2;\n" +
      "  }\n" +
      "}\n";

    const relPath = "multi_match.ts";
    fs.writeFileSync(path.join(tempDir, relPath), multiMatchContent, "utf8");

    const result = await executeTool(
      "apply_patch",
      {
        filePath: relPath,
        patch:
          "--- FIND ---\n" +
          "  getValue() {\n" +
          "--- REPLACE ---\n" +
          "  getValue() {",
        intent: "modify",
        // symbolKind=method without className => two matches expected
        scope: { symbolName: "getValue", symbolKind: "method", className: null },
      },
      tempDir
    );

    checks.push(check("Test 4a: result.success is false", result.success === false, { success: result.success }));
    checks.push(check(
      "Test 4b: output mentions multiple occurrences",
      result.output.includes("getValue") &&
        (result.output.includes("occurrences") || result.output.includes("2")),
      { outputSlice: result.output.slice(0, 200) }
    ));
    console.log("  output:", result.output.slice(0, 200));

    cleanup();
  }

  // ---- Test 5: declaration-line FIND must match within scope --------------
  console.log("\n=== Test 5: declaration-line FIND within scope ===");
  {
    const runDeclarationScopeCase = async ({
      label,
      fileContent,
      findLine,
      scopeSymbol,
      expectSuccess,
      expectNeedle,
    }) => {
      const { tempDir, cleanup } = setupTempDir();
      const relPath = "scoped_decl.js";
      fs.writeFileSync(path.join(tempDir, relPath), fileContent, "utf8");

      const result = await executeTool(
        "apply_patch",
        {
          filePath: relPath,
          patch:
            "--- FIND ---\n" +
            findLine + "\n" +
            "--- REPLACE ---\n" +
            findLine.replace(scopeSymbol, scopeSymbol + "Renamed"),
          intent: "modify",
          scope: { symbolName: "target", symbolKind: "function", className: null },
        },
        tempDir
      );

      const after = fs.readFileSync(path.join(tempDir, relPath), "utf8");
      checks.push(check(label, expectSuccess ? result.success === true : result.success === false, {
        success: result.success,
        output: result.output.slice(0, 200),
      }));
      if (expectSuccess) {
        checks.push(check(
          label + " replacement applied",
          after.includes(expectNeedle),
          { afterSlice: after.slice(0, 240) }
        ));
      }
      cleanup();
    };

    const lfContent = [
      "function unrelated() {}",
      "",
      "export async function target(a, b) {",
      "  return a + b;",
      "}",
      "",
    ].join("\n");
    await runDeclarationScopeCase({
      label: "Test 5a: LF declaration line matches inside scope",
      fileContent: lfContent,
      findLine: "export async function target(a, b) {",
      scopeSymbol: "target",
      expectSuccess: true,
      expectNeedle: "export async function targetRenamed(a, b) {",
    });

    const crlfContent = lfContent.replace(/\n/g, "\r\n");
    await runDeclarationScopeCase({
      label: "Test 5b: CRLF declaration line matches inside scope",
      fileContent: crlfContent,
      findLine: "export async function target(a, b) {",
      scopeSymbol: "target",
      expectSuccess: true,
      expectNeedle: "export async function targetRenamed(a, b) {",
    });

    const largeBodyLines = [
      "function unrelated() {}",
      "",
      "export async function target(a, b) {",
      ...Array.from({ length: 120 }, (_, i) => `  const line${i} = ${i};`),
      "  return a + b;",
      "}",
      "",
    ];
    await runDeclarationScopeCase({
      label: "Test 5c: large function declaration line matches inside scope",
      fileContent: largeBodyLines.join("\n"),
      findLine: "export async function target(a, b) {",
      scopeSymbol: "target",
      expectSuccess: true,
      expectNeedle: "export async function targetRenamed(a, b) {",
    });

    await runDeclarationScopeCase({
      label: "Test 5d: unrelated declaration outside scope does not match",
      fileContent: lfContent,
      findLine: "function unrelated() {}",
      scopeSymbol: "unrelated",
      expectSuccess: false,
      expectNeedle: "",
    });
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
