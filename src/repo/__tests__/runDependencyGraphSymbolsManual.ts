/**
 * Manual integration test for Phase 3B-1: symbol-level import tracking in
 * buildDependencyGraph.
 *
 * Run with:
 *   node --experimental-strip-types src/repo/__tests__/runDependencyGraphSymbolsManual.ts
 *
 * Uses the fixture project at src/repo/__tests__/fixtures/depgraph/.
 * All test code lives inside an async IIFE to avoid top-level await.
 * No TypeScript type annotations are used so the Node.js 22 CJS-mode
 * TypeScript stripper does not trip on unhandled TS syntax.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Import from compiled dist
import { buildDependencyGraph, parseImportClause } from "../../../dist/repo/buildDependencyGraph.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

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

(async function main() {
  const checks = [];
  const fixtureDir = path.resolve(__dirname, "fixtures/depgraph");

  // ─── Unit tests: parseImportClause ────────────────────────────────────────
  console.log("\n=== Unit: parseImportClause ===");

  {
    const r = parseImportClause("{ createAppointment, listAppointments }");
    checks.push(check(
      "clause: named two symbols",
      r.length === 2 &&
        r[0].kind === "named" && r[0].name === "createAppointment" &&
        r[1].kind === "named" && r[1].name === "listAppointments",
      r
    ));
  }

  {
    const r = parseImportClause("AppointmentService, { listAppointments, createAppointment as makeAppt }");
    checks.push(check(
      "clause: default + named + alias",
      r.length === 3 &&
        r.some((s) => s.kind === "default" && s.name === "AppointmentService") &&
        r.some((s) => s.kind === "named" && s.name === "listAppointments") &&
        r.some((s) => s.kind === "named" && s.name === "createAppointment" && s.alias === "makeAppt"),
      r
    ));
  }

  {
    const r = parseImportClause("* as svc");
    checks.push(check(
      "clause: namespace",
      r.length === 1 && r[0].kind === "namespace" && r[0].name === "svc",
      r
    ));
  }

  {
    const r = parseImportClause("");
    checks.push(check(
      "clause: empty string => []",
      r.length === 0,
      r
    ));
  }

  {
    const r = parseImportClause("DefaultExport");
    checks.push(check(
      "clause: default-only (bare identifier)",
      r.length === 1 && r[0].kind === "default" && r[0].name === "DefaultExport",
      r
    ));
  }

  // ─── Integration: buildDependencyGraph with symbol tracking ───────────────
  console.log("\n=== Integration: buildDependencyGraph symbol tracking ===");

  const files = listFilesRelative(fixtureDir);
  console.log("  fixture files:", files);
  const graph = await buildDependencyGraph(fixtureDir, files);
  console.log("  graph nodes:", [...graph.nodes.keys()]);

  const controllerNode = graph.nodes.get("controller.js");
  const serviceNode = graph.nodes.get("service.js");

  checks.push(check(
    "controller.js found in graph",
    !!controllerNode,
    { keys: [...graph.nodes.keys()] }
  ));

  if (controllerNode) {
    const symFromTarget = controllerNode.importedSymbolsBySource.get("target.js");
    console.log("  controller.js importedSymbolsBySource['target.js']:", JSON.stringify(symFromTarget));

    checks.push(check(
      "controller.js: importedSymbolsBySource has entry for target.js",
      !!symFromTarget && symFromTarget.length > 0,
      { symFromTarget }
    ));

    const hasDefault = symFromTarget && symFromTarget.some((s) => s.kind === "default" && s.name === "AppointmentService");
    checks.push(check(
      "controller.js: imports default AppointmentService from target.js",
      !!hasDefault,
      { symFromTarget }
    ));

    const hasListAppts = symFromTarget && symFromTarget.some((s) => s.kind === "named" && s.name === "listAppointments");
    checks.push(check(
      "controller.js: imports named listAppointments from target.js",
      !!hasListAppts,
      { symFromTarget }
    ));

    const hasMakeAppt = symFromTarget && symFromTarget.some(
      (s) => s.kind === "named" && s.name === "createAppointment" && s.alias === "makeAppt"
    );
    checks.push(check(
      "controller.js: imports createAppointment as makeAppt from target.js",
      !!hasMakeAppt,
      { symFromTarget }
    ));

    const symFromService = controllerNode.importedSymbolsBySource.get("service.js");
    console.log("  controller.js importedSymbolsBySource['service.js']:", JSON.stringify(symFromService));
    checks.push(check(
      "controller.js: namespace import from service.js recorded",
      !!symFromService && symFromService.some((s) => s.kind === "namespace" && s.name === "svc"),
      { symFromService }
    ));
  }

  if (serviceNode) {
    const symFromTarget = serviceNode.importedSymbolsBySource.get("target.js");
    console.log("  service.js importedSymbolsBySource['target.js']:", JSON.stringify(symFromTarget));

    checks.push(check(
      "service.js: imports named createAppointment from target.js",
      !!symFromTarget && symFromTarget.some((s) => s.kind === "named" && s.name === "createAppointment"),
      { symFromTarget }
    ));
  }

  // barrel.js uses re-export syntax, not import — symbols not tracked; just edges
  const barrelNode = graph.nodes.get("barrel.js");
  checks.push(check(
    "barrel.js found in graph",
    !!barrelNode,
    { keys: [...graph.nodes.keys()] }
  ));

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
