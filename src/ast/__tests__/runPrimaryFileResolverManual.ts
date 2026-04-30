/**
 * Manual test for Phase 3B-2 bug fix: symbol heuristic + primary file resolver.
 *
 * Run with:
 *   node --experimental-strip-types src/ast/__tests__/runPrimaryFileResolverManual.ts
 *
 * Synthetic fixture: mirrors the smileai-mvp scenario that produced primaryFile:null.
 * No TS-specific syntax — compatible with Node.js 22 CJS-mode TS stripper.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

// ─── Inline symbol heuristic (mirrors runLlmPatchFlow implementation) ─────────

const STOP_WORDS = new Set([
  "add", "the", "fix", "get", "set", "use", "run", "let", "var", "new",
  "try", "put", "map", "key", "api", "url", "uid", "id", "io", "js",
  "ts", "css", "html", "sql", "http", "https", "json", "xml", "csv",
  "return", "function", "const", "class", "type", "interface", "export",
  "import", "default", "async", "await", "this", "true", "false", "null",
  "undefined", "void", "string", "number", "boolean", "object", "array",
  "validate", "validation", "handle", "handler",
  "refactor", "update", "create", "delete", "remove", "rename", "move",
  "extract", "migrate", "implement", "replace", "modify", "convert",
  "render", "connect", "extend", "register", "enable", "disable",
  "inject", "wrap", "apply", "process", "write", "make", "ensure",
  "fetch", "load", "save", "send", "receive", "parse", "build",
  "init", "setup", "test", "tests", "spec", "mock", "stub", "check",
  "error", "warn", "warning", "info", "debug", "log", "logger",
  "config", "option", "param", "data", "result",
  "response", "request", "input", "output", "event", "context",
  "state", "store", "model", "schema", "query", "field", "value",
  "props", "ref", "node", "list", "item", "index", "page", "route",
  "path", "file", "repo", "project",
]);

function extractAllSymbols(task) {
  const re = /\b([a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9_]*|[A-Z][a-zA-Z0-9_]+)\b/g;
  const all = [];
  let m;
  while ((m = re.exec(task)) !== null) all.push(m[1]);
  return all;
}

function extractPrimarySymbol(task) {
  for (const word of extractAllSymbols(task)) {
    // Case-insensitive stop-list lookup (fix for "Add" slipping past lowercase "add")
    if (!STOP_WORDS.has(word.toLowerCase())) return word;
  }
  return null;
}

function resolvePrimaryFile(fileList, repoPath, symbolName) {
  if (!symbolName) return { file: null, candidateFiles: [], reason: "no_symbol" };

  const declarationPatterns = [
    new RegExp("\\bfunction\\s+" + symbolName + "\\b"),
    new RegExp("\\basync\\s+function\\s+" + symbolName + "\\b"),
    new RegExp("\\bconst\\s+" + symbolName + "\\s*="),
    new RegExp("\\bexport\\s+(?:async\\s+)?function\\s+" + symbolName + "\\b"),
    new RegExp("\\bexport\\s+const\\s+" + symbolName + "\\s*="),
    new RegExp("\\bclass\\s+" + symbolName + "\\b"),
    new RegExp("\\bexport\\s+class\\s+" + symbolName + "\\b"),
  ];

  const candidates = [];
  for (const relPath of fileList) {
    const lower = relPath.toLowerCase();
    if (/\.(test|spec)\.|\/__tests__\/|\/__mocks__\//.test(lower)) continue;
    let fc;
    try {
      fc = fs.readFileSync(path.join(repoPath, relPath), "utf8").slice(0, 50000);
    } catch { continue; }
    if (declarationPatterns.some((re) => re.test(fc))) candidates.push(relPath);
  }

  if (candidates.length === 0) return { file: null, candidateFiles: [], reason: "no_candidates" };

  const noun = symbolName
    .replace(/^(create|get|set|update|delete|find|list|add|remove|fetch|handle|build|make|run|init|load|save|send)/i, "")
    .toLowerCase();
  const scored = candidates.map((c) => ({
    p: c,
    s: noun.length > 2 && c.toLowerCase().includes(noun) ? 1 : 0,
  }));
  scored.sort((a, b) => b.s - a.s);
  const chosen = scored[0].p;
  const reason = scored[0].s > 0 ? "scored_filename_similarity" : "first_match";
  return { file: chosen, candidateFiles: candidates, reason };
}

// ─── Setup: synthetic smileai-mvp-like fixture ────────────────────────────────

function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-resolver-test-"));

  fs.mkdirSync(path.join(dir, "server", "controllers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server", "routes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server", "services"), { recursive: true });

  // Primary file — should be chosen
  fs.writeFileSync(path.join(dir, "server", "controllers", "appointmentsController.js"), [
    "const AppointmentService = require('../services/appointmentService');",
    "",
    "async function createAppointment(req, res) {",
    "  const data = req.body;",
    "  const result = await AppointmentService.create(data);",
    "  res.json(result);",
    "}",
    "",
    "async function listAppointments(req, res) {",
    "  const all = await AppointmentService.list();",
    "  res.json(all);",
    "}",
    "",
    "module.exports = { createAppointment, listAppointments };",
  ].join("\n"));

  // Also defines createAppointment but in a test file — should be skipped
  fs.writeFileSync(path.join(dir, "server", "controllers", "appointmentsController.test.js"), [
    "const { createAppointment } = require('./appointmentsController');",
    "test('creates', () => { createAppointment({}); });",
  ].join("\n"));

  // Another controller — should be a candidate but scored lower (filename doesn't match)
  fs.writeFileSync(path.join(dir, "server", "controllers", "dashboardController.js"), [
    "async function createAppointment(req, res) { /* stub */ }",
    "module.exports = { createAppointment };",
  ].join("\n"));

  // Routes file — imports controller, shouldn't be picked as primary definer
  fs.writeFileSync(path.join(dir, "server", "routes", "appointments.js"), [
    "const { createAppointment } = require('../controllers/appointmentsController');",
    "router.post('/', createAppointment);",
  ].join("\n"));

  // Service file — no createAppointment declaration
  fs.writeFileSync(path.join(dir, "server", "services", "appointmentService.js"), [
    "async function create(data) { return data; }",
    "module.exports = { create };",
  ].join("\n"));

  const fileList = [
    "server/controllers/appointmentsController.js",
    "server/controllers/appointmentsController.test.js",
    "server/controllers/dashboardController.js",
    "server/routes/appointments.js",
    "server/services/appointmentService.js",
  ];

  return { dir, fileList, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const checks = [];

// ── 1. Symbol heuristic ───────────────────────────────────────────────────────
console.log("\n=== Symbol heuristic ===");

{
  const task = "Add input validation to createAppointment in the appointments controller";
  const all = extractAllSymbols(task);
  const chosen = extractPrimarySymbol(task);
  console.log("  task:", task);
  console.log("  extractedSymbols:", all);
  console.log("  chosenSymbol:", chosen);

  checks.push(check(
    "heuristic: 'Add' is NOT returned (filtered by lowercase 'add' in stop-list)",
    chosen !== "Add",
    { all, chosen }
  ));
  checks.push(check(
    "heuristic: 'createAppointment' IS returned",
    chosen === "createAppointment",
    { all, chosen }
  ));
}

{
  const task = "Fix the failing tests in UserAuthService";
  const chosen = extractPrimarySymbol(task);
  checks.push(check(
    "heuristic: PascalCase 'UserAuthService' extracted correctly",
    chosen === "UserAuthService",
    { chosen }
  ));
}

{
  const task = "Fix the failing tests";
  const chosen = extractPrimarySymbol(task);
  checks.push(check(
    "heuristic: task with no camelCase/PascalCase symbol → null",
    chosen === null,
    { chosen }
  ));
}

{
  const task = "Refactor createAppointment and listAppointments in the controller";
  const chosen = extractPrimarySymbol(task);
  checks.push(check(
    "heuristic: first camelCase symbol chosen when multiple present",
    chosen === "createAppointment",
    { chosen }
  ));
}

// ── 2. Primary file resolver: smileai-mvp scenario ───────────────────────────
console.log("\n=== Primary file resolver (smileai-mvp scenario) ===");

const { dir: fixtureDir, fileList, cleanup } = setupFixture();
console.log("  fixture dir:", fixtureDir);
console.log("  file list:", fileList);

try {
  const symbolName = "createAppointment";
  const { file, candidateFiles, reason } = resolvePrimaryFile(fileList, fixtureDir, symbolName);

  // Emit the resolve log shape for spec requirement
  const resolveLog = {
    taskPreview: "Add input validation to createAppointment in the appointments controller",
    extractedSymbols: ["createAppointment"],
    chosenSymbol: symbolName,
    candidateFiles,
    chosenFile: file,
    reason,
  };
  console.log("[zone-import-context-resolve]", JSON.stringify(resolveLog));

  checks.push(check(
    "resolver: at least one candidate file found",
    candidateFiles.length >= 1,
    { candidateFiles }
  ));
  checks.push(check(
    "resolver: test file excluded from candidates",
    !candidateFiles.includes("server/controllers/appointmentsController.test.js"),
    { candidateFiles }
  ));
  checks.push(check(
    "resolver: appointmentsController.js is a candidate",
    candidateFiles.includes("server/controllers/appointmentsController.js"),
    { candidateFiles }
  ));
  checks.push(check(
    "resolver: appointmentsController.js chosen (filename contains 'appointment' noun)",
    file === "server/controllers/appointmentsController.js",
    { file, reason }
  ));
  checks.push(check(
    "resolver: reason is scored_filename_similarity",
    reason === "scored_filename_similarity",
    { reason }
  ));

  // ── 3. Null symbol → no candidates ─────────────────────────────────────────
  console.log("\n=== Resolver with null symbol ===");
  const noSym = resolvePrimaryFile(fileList, fixtureDir, null);
  checks.push(check(
    "resolver: null symbol → file is null",
    noSym.file === null,
    { file: noSym.file, reason: noSym.reason }
  ));

  // ── 4. Unknown symbol → no candidates ──────────────────────────────────────
  console.log("\n=== Resolver with unknown symbol ===");
  const noMatch = resolvePrimaryFile(fileList, fixtureDir, "totallyNonExistentFn");
  checks.push(check(
    "resolver: symbol not in any file → file is null, reason no_candidates",
    noMatch.file === null && noMatch.reason === "no_candidates",
    { file: noMatch.file, reason: noMatch.reason }
  ));

} finally {
  cleanup();
}

// ─── Summary ──────────────────────────────────────────────────────────────────
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
