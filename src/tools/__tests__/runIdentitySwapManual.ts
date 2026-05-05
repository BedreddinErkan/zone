/**
 * Manual test for apply_patch declaration identity swap detection.
 *
 * Run after building dist:
 *   node --experimental-strip-types src/tools/__tests__/runIdentitySwapManual.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const toolExecutorModulePath =
  process.env.ZONE_TOOL_EXECUTOR_MODULE || "../../../dist/tools/toolExecutor.js";
const symbolLocatorModulePath =
  process.env.ZONE_SYMBOL_LOCATOR_MODULE || "../../../dist/ast/astSymbolLocator.js";

const { executeTool } = await import(toolExecutorModulePath);
const { extractDeclaredSymbols } = await import(symbolLocatorModulePath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

function patch(find, replace) {
  return `--- FIND ---\n${find}\n--- REPLACE ---\n${replace}`;
}

function writeFile(repoPath, filePath, content) {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function apply(repoPath, filePath, find, replace, progressEvents = []) {
  return executeTool(
    "apply_patch",
    {
      filePath,
      patch: patch(find, replace),
      intent: "modify",
      scope: null,
    },
    repoPath,
    (msg) => progressEvents.push(msg),
    {}
  );
}

function hasEvent(events, eventName) {
  return events.some((msg) => {
    try {
      return JSON.parse(msg).event === eventName;
    } catch {
      return false;
    }
  });
}

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-identity-swap-test-"));
const checks = [];

try {
  {
    const filePath = "bug43.ts";
    const find =
      'export const hasClerkWebhookSecret = () =>\n  Boolean(readEnv("CLERK_WEBHOOK_SIGNING_SECRET"));';
    const replace =
      'export const hasClerkEnv = () =>\n  Boolean(readEnv("CLERK_ENV"));';
    const original =
      'const readEnv = (name: string) => process.env[name];\n\n' +
      'export const isClerkConfigured = () =>\n' +
      "  hasClerkPublishableKey() && hasClerkSecretKey();\n\n" +
      find +
      "\n";
    writeFile(repoPath, filePath, original);
    const events = [];
    const result = await apply(repoPath, filePath, find, replace, events);
    const findDecls = extractDeclaredSymbols(find, filePath);
    const replaceDecls = extractDeclaredSymbols(replace, filePath);
    checks.push(check(
      "Bug 43 exact pattern is blocked",
      result.success === false &&
        result.rejectionReason === "declaration_identity_swap" &&
        result.error === "apply_patch_identity_swap" &&
        hasEvent(events, "zone-tool-apply-patch-identity-swap-blocked") &&
        findDecls.some((decl) => decl.name === "hasClerkWebhookSecret") &&
        replaceDecls.some((decl) => decl.name === "hasClerkEnv") &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8") === original,
      { result, events, findDecls, replaceDecls }
    ));
  }

  {
    const filePath = "rename.ts";
    const find =
      "export const hasClerkEnv = () =>\n  hasClerkPublishableKey() && hasClerkSecretKey();";
    const replace =
      "export const isClerkConfigured = () =>\n  hasClerkPublishableKey() && hasClerkSecretKey();";
    writeFile(repoPath, filePath, find + "\n");
    const events = [];
    const result = await apply(repoPath, filePath, find, replace, events);
    checks.push(check(
      "legitimate rename is allowed by size/line allowance",
      result.success === true &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8").includes("isClerkConfigured") &&
        hasEvent(events, "zone-tool-apply-patch-identity-swap-allowed-as-rename"),
      { result, events }
    ));
  }

  {
    const filePath = "body-only.ts";
    const find = "function foo() { return 1; }";
    const replace = "function foo() { return 2; }";
    writeFile(repoPath, filePath, find + "\n");
    const events = [];
    const result = await apply(repoPath, filePath, find, replace, events);
    checks.push(check(
      "body-only modification has no identity swap",
      result.success === true &&
        !hasEvent(events, "zone-tool-apply-patch-identity-swap-blocked") &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8").includes("return 2"),
      { result, events }
    ));
  }

  {
    const filePath = "expression.ts";
    const original = "function test(x: boolean, y: boolean) {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n";
    writeFile(repoPath, filePath, original);
    const events = [];
    const result = await apply(repoPath, filePath, "  if (x) {", "  if (y) {", events);
    checks.push(check(
      "pure expression patch has no identity swap",
      result.success === true &&
        !hasEvent(events, "zone-tool-apply-patch-identity-swap-blocked") &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8").includes("if (y)"),
      { result, events }
    ));
  }

  {
    const filePath = "partial-overlap.ts";
    const find = "function foo() { return 1; }\nfunction bar() { return 2; }";
    const replace = "function foo() { return 1; }\nfunction baz() { return 2; }";
    writeFile(repoPath, filePath, find + "\n");
    const events = [];
    const result = await apply(repoPath, filePath, find, replace, events);
    checks.push(check(
      "multiple symbols with partial overlap proceed",
      result.success === true &&
        !hasEvent(events, "zone-tool-apply-patch-identity-swap-blocked") &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8").includes("function baz"),
      { result, events }
    ));
  }

  {
    const filePath = "default-export.ts";
    const find = "export default function A() { return 1; }";
    const replace = "export default function B() { return 1; }";
    writeFile(repoPath, filePath, find + "\n");
    const events = [];
    const result = await apply(repoPath, filePath, find, replace, events);
    checks.push(check(
      "default export rename is handled as likely rename",
      result.success === true &&
        fs.readFileSync(path.join(repoPath, filePath), "utf8").includes("function B") &&
        hasEvent(events, "zone-tool-apply-patch-identity-swap-allowed-as-rename"),
      { result, events }
    ));
  }
} finally {
  fs.rmSync(repoPath, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.pass);
console.log(
  `[identity-swap-test] PASSED ${checks.length - failed.length}/${checks.length} assertions`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
