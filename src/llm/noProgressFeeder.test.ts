import { describe, it, expect } from "vitest";
import { classifyVerifyCommand, parseVerifyOutputToKeySet } from "./noProgressFeeder.js";

describe("classifyVerifyCommand — tsc", () => {
  it.each([
    ["tsc --noEmit"],
    ["npx tsc --noEmit -p tsconfig.json"],
    ["npm run typecheck"],
    ["npm run tsc"],
  ])('"%s" → "tsc"', (cmd) => {
    expect(classifyVerifyCommand(cmd)).toBe("tsc");
  });
});

describe("classifyVerifyCommand — test", () => {
  it.each([
    ["npx vitest run"],
    ["npm test"],
    ["npm run test"],
    ["npm run test:unit"],
    ["npm run test:e2e"],
    ["npm run playwright"],
    ["pytest -q"],
    ["jest"],
    ["mocha --timeout 5000"],
  ])('"%s" → "test"', (cmd) => {
    expect(classifyVerifyCommand(cmd)).toBe("test");
  });
});

describe("classifyVerifyCommand — null", () => {
  it.each([
    ["grep -r 'error TS2304' src"],
    ["echo tsc"],
    ["ls"],
    [""],
    ["cat src/foo.ts"],
    ["node dist/index.js"],
  ])('"%s" → null', (cmd) => {
    expect(classifyVerifyCommand(cmd)).toBeNull();
  });
});

describe("classifyVerifyCommand — tsc wins when both could match", () => {
  it('npm run tsc → "tsc" not "test"', () => {
    // "npm run tsc" matches npm-wrapped tsc pattern; ensure tsc-first ordering holds
    expect(classifyVerifyCommand("npm run tsc")).toBe("tsc");
  });
});

describe("parseVerifyOutputToKeySet — tsc", () => {
  it("multi-file tsc output produces two keys, summary noise dropped", () => {
    // Two real error lines plus a summary line that produces code="" and gets filtered.
    const output = [
      "src/foo.ts(3,5): error TS2304: Cannot find name 'bar'.",
      "Found 2 errors in 2 files.",
      "src/baz.ts:10:3 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    ].join("\n");

    const keys = parseVerifyOutputToKeySet("tsc", output);

    expect(keys.size).toBe(2);
    // Keys have shape file:line:code:msg — assert on file+code prefix, not full message text
    expect([...keys].some((k) => k.startsWith("src/foo.ts:3:TS2304:"))).toBe(true);
    expect([...keys].some((k) => k.startsWith("src/baz.ts:10:TS2345:"))).toBe(true);
  });

  it("tsc help banner → empty Set (banner dropped by parseTscErrorPreview)", () => {
    const banner = [
      "Version 5.9.3",
      "tsc: The TypeScript Compiler",
      "COMMON COMMANDS",
      "  tsc                                      Compiles the current project",
    ].join("\n");

    expect(parseVerifyOutputToKeySet("tsc", banner).size).toBe(0);
  });

  it("empty output → empty Set", () => {
    expect(parseVerifyOutputToKeySet("tsc", "").size).toBe(0);
  });

  it("unrecognized noise lines → empty Set (code='' filtered out)", () => {
    expect(parseVerifyOutputToKeySet("tsc", "Watching for file changes.\nFound 0 errors.").size).toBe(0);
  });
});

describe("parseVerifyOutputToKeySet — test", () => {
  it("vitest inline failure with absolute path → one key, path relativized, contains :0:TEST:", () => {
    const output = "FAIL /repo/src/foo.test.ts > suite > my test\n";
    const keys = parseVerifyOutputToKeySet("test", output, "/repo");

    expect(keys.size).toBe(1);
    const key = [...keys][0]!;
    expect(key).toContain(":0:TEST:");
    expect(key.startsWith("src/foo.test.ts:")).toBe(true);
  });

  it("unrecognized runner output → empty Set", () => {
    expect(parseVerifyOutputToKeySet("test", "1 test failed\n").size).toBe(0);
  });

  it("empty output → empty Set", () => {
    expect(parseVerifyOutputToKeySet("test", "").size).toBe(0);
  });
});
