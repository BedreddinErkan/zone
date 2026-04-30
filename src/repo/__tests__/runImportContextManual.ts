/**
 * Manual integration test for Phase 3B-1: buildImportContextSummary.
 *
 * Run with:
 *   node --experimental-strip-types src/repo/__tests__/runImportContextManual.ts
 *
 * Uses the fixture project at src/repo/__tests__/fixtures/depgraph/.
 * All test code lives inside an async IIFE to avoid top-level await.
 * No TypeScript type annotations are used.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDependencyGraph } from "../../../dist/repo/buildDependencyGraph.js";
import { buildImportContextSummary } from "../../../dist/repo/buildImportContextSummary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Walk a directory recursively and return relative posix paths. */
function listFilesRelative(dir) {
  const results = [];
  function walk(current, base) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else {
        results.push(path.relative(base, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(dir, dir);
  return results;
}

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

(async function main() {
  const checks = [];
  const fixtureDir = path.resolve(__dirname, "fixtures/depgraph");

  const files = listFilesRelative(fixtureDir);
  const graph = await buildDependencyGraph(fixtureDir, files);
  console.log("Graph built. Nodes:", [...graph.nodes.keys()]);

  // ─── Test 1: summary for target.js (imported by service + controller) ─────
  console.log("\n=== Test 1: buildImportContextSummary for target.js ===");
  {
    const result = buildImportContextSummary(graph, "target.js", null);
    console.log("  summary:\n" + result.summary);
    console.log("  totalForward:", result.totalForward, "totalReverse:", result.totalReverse);

    checks.push(check(
      "T1: summary contains [zone-import-context] header",
      result.summary.includes("[zone-import-context]") && result.summary.includes("target.js"),
      { slice: result.summary.slice(0, 100) }
    ));
    checks.push(check(
      "T1: totalReverse >= 2 (service + controller import it)",
      result.totalReverse >= 2,
      { totalReverse: result.totalReverse }
    ));
    checks.push(check(
      "T1: summary mentions controller.js in Imported by section",
      result.summary.includes("controller.js"),
      { slice: result.summary.slice(0, 500) }
    ));
    checks.push(check(
      "T1: summary mentions service.js in Imported by section",
      result.summary.includes("service.js"),
      { slice: result.summary.slice(0, 500) }
    ));
  }

  // ─── Test 2: summary for target.js with symbol createAppointment ──────────
  console.log("\n=== Test 2: buildImportContextSummary for target.js + symbol ===");
  {
    const result = buildImportContextSummary(graph, "target.js", "createAppointment");
    console.log("  summary:\n" + result.summary);

    checks.push(check(
      "T2: Symbol line present",
      result.summary.includes("Symbol: createAppointment"),
      { slice: result.summary.slice(0, 200) }
    ));
    checks.push(check(
      "T2: Who uses section present",
      result.summary.includes("Who uses") && result.summary.includes("createAppointment"),
      { slice: result.summary }
    ));
    checks.push(check(
      "T2: controller.js appears as consumer of createAppointment",
      result.summary.includes("controller.js"),
      { summary: result.summary }
    ));
    checks.push(check(
      "T2: service.js appears as consumer of createAppointment",
      result.summary.includes("service.js"),
      { summary: result.summary }
    ));
  }

  // ─── Test 3: summary for controller.js (has forward imports, none reverse) ─
  console.log("\n=== Test 3: buildImportContextSummary for controller.js ===");
  {
    const result = buildImportContextSummary(graph, "controller.js", null);
    console.log("  summary:\n" + result.summary);

    checks.push(check(
      "T3: totalForward >= 2 (target + service)",
      result.totalForward >= 2,
      { totalForward: result.totalForward }
    ));
    checks.push(check(
      "T3: summary mentions target.js in Imports section",
      result.summary.includes("target.js"),
      { slice: result.summary.slice(0, 500) }
    ));
    checks.push(check(
      "T3: summary shows symbol detail for target.js imports",
      result.summary.includes("AppointmentService") || result.summary.includes("listAppointments"),
      { summary: result.summary }
    ));
  }

  // ─── Test 4: maxChars budget cap ──────────────────────────────────────────
  console.log("\n=== Test 4: maxChars budget cap ===");
  {
    const result = buildImportContextSummary(graph, "target.js", null, { maxChars: 100 });
    checks.push(check(
      "T4: summary length <= 100 chars",
      result.summary.length <= 100,
      { len: result.summary.length }
    ));
  }

  // ─── Test 5: unknown file graceful degradation ─────────────────────────────
  console.log("\n=== Test 5: unknown file => graceful not-found message ===");
  {
    const result = buildImportContextSummary(graph, "nonexistent.js", null);
    checks.push(check(
      "T5: summary mentions file not found",
      result.summary.includes("not found"),
      { summary: result.summary }
    ));
    checks.push(check(
      "T5: totalForward is 0",
      result.totalForward === 0,
      { totalForward: result.totalForward }
    ));
    checks.push(check(
      "T5: totalReverse is 0",
      result.totalReverse === 0,
      { totalReverse: result.totalReverse }
    ));
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
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
