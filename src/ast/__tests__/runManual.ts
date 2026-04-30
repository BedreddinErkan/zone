import fs from "node:fs";
import path from "node:path";
import { locateSymbol } from "../astSymbolLocator.ts";
import { validateSyntax } from "../astSyntaxValidator.ts";

type CheckResult = {
  label: string;
  pass: boolean;
  details?: unknown;
};

const fixturesDir = path.resolve("src/ast/__tests__/fixtures");

function readFixture(name: string): { filePath: string; content: string } {
  const filePath = path.join(fixturesDir, name);
  return {
    filePath,
    content: fs.readFileSync(filePath, "utf8"),
  };
}

function logSection(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function check(label: string, pass: boolean, details?: unknown): CheckResult {
  const result = { label, pass, details };
  console.log(
    `[assert] ${pass ? "PASS" : "FAIL"} ${label}` +
      (details !== undefined ? ` :: ${JSON.stringify(details)}` : "")
  );
  return result;
}

const checks: CheckResult[] = [];

const funcDecl = readFixture("func_decl.js");
const arrowConst = readFixture("arrow_const.ts");
const classFixture = readFixture("class_with_methods.tsx");
const anonDefault = readFixture("export_default_anon.js");
const namedDefault = readFixture("export_default_named.ts");
const brokenSyntax = readFixture("broken_syntax.js");

const locateResults = {
  add: locateSymbol(funcDecl.content, funcDecl.filePath, { name: "add" }),
  gen: locateSymbol(funcDecl.content, funcDecl.filePath, {
    name: "gen",
    kind: "function",
  }),
  multiply: locateSymbol(arrowConst.content, arrowConst.filePath, {
    name: "multiply",
  }),
  render: locateSymbol(classFixture.content, classFixture.filePath, {
    name: "render",
    kind: "method",
    className: "Foo",
  }),
  constructorMethod: locateSymbol(classFixture.content, classFixture.filePath, {
    name: "constructor",
    kind: "method",
    className: "Foo",
  }),
  defaultAnon: locateSymbol(anonDefault.content, anonDefault.filePath, {
    name: "__default__",
    kind: "export_default",
  }),
  defaultNamedAlias: locateSymbol(namedDefault.content, namedDefault.filePath, {
    name: "__default__",
    kind: "export_default",
  }),
  defaultNamedByName: locateSymbol(namedDefault.content, namedDefault.filePath, {
    name: "explicitName",
  }),
};

logSection("locateSymbol results", locateResults);

checks.push(
  check(
    "add found at lines 1-3",
    locateResults.add.ok &&
      locateResults.add.matches[0]?.startLine === 1 &&
      locateResults.add.matches[0]?.endLine === 3,
    locateResults.add
  )
);

checks.push(
  check(
    "multiply found in arrow_const.ts",
    locateResults.multiply.ok &&
      locateResults.multiply.matches.some((match) => match.kind === "arrow"),
    locateResults.multiply
  )
);

checks.push(
  check(
    "render found as method in class Foo",
    locateResults.render.ok &&
      locateResults.render.matches.length === 1 &&
      locateResults.render.matches[0]?.kind === "method" &&
      locateResults.render.matches[0]?.source.includes("render()"),
    locateResults.render
  )
);

checks.push(
  check(
    "render lookup excludes constructor",
    locateResults.render.ok &&
      locateResults.render.matches[0]?.source.includes("constructor(") !== true,
    locateResults.render
  )
);

checks.push(
  check(
    "constructor still independently locates as method",
    locateResults.constructorMethod.ok &&
      locateResults.constructorMethod.matches[0]?.source.includes("constructor(") === true,
    locateResults.constructorMethod
  )
);

checks.push(
  check(
    "__default__ resolves anonymous default export",
    locateResults.defaultAnon.ok &&
      locateResults.defaultAnon.matches.some((match) => match.kind === "export_default"),
    locateResults.defaultAnon
  )
);

checks.push(
  check(
    "explicitName resolves by its own name",
    locateResults.defaultNamedByName.ok &&
      locateResults.defaultNamedByName.matches.some(
        (match) =>
          match.kind === "export_default" &&
          match.source.includes("explicitName")
      ),
    locateResults.defaultNamedByName
  )
);

checks.push(
  check(
    "__default__ resolves named default export alias",
    locateResults.defaultNamedAlias.ok &&
      locateResults.defaultNamedAlias.matches.some(
        (match) =>
          match.kind === "export_default" &&
          match.source.includes("explicitName")
      ),
    locateResults.defaultNamedAlias
  )
);

const syntaxResults = {
  funcDecl: validateSyntax(funcDecl.content, funcDecl.filePath),
  arrowConst: validateSyntax(arrowConst.content, arrowConst.filePath),
  classFixture: validateSyntax(classFixture.content, classFixture.filePath),
  anonDefault: validateSyntax(anonDefault.content, anonDefault.filePath),
  namedDefault: validateSyntax(namedDefault.content, namedDefault.filePath),
  brokenSyntax: validateSyntax(brokenSyntax.content, brokenSyntax.filePath),
};

logSection("validateSyntax results", syntaxResults);

checks.push(
  check(
    "all valid fixtures parse successfully",
    syntaxResults.funcDecl.ok &&
      syntaxResults.arrowConst.ok &&
      syntaxResults.classFixture.ok &&
      syntaxResults.anonDefault.ok &&
      syntaxResults.namedDefault.ok,
    syntaxResults
  )
);

checks.push(
  check(
    "broken_syntax.js fails with error line",
    syntaxResults.brokenSyntax.ok === false &&
      syntaxResults.brokenSyntax.reason === "parse_error" &&
      typeof syntaxResults.brokenSyntax.errorLine === "number",
    syntaxResults.brokenSyntax
  )
);

const failed = checks.filter((item) => !item.pass);
logSection("assert summary", {
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
});

if (failed.length > 0) {
  process.exitCode = 1;
}
