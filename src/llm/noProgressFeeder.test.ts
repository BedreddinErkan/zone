import { describe, it, expect } from "vitest";
import { classifyVerifyCommand, parseVerifyOutputToKeySet, detectTruncation, computeFeederAction } from "./noProgressFeeder.js";

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

describe("detectTruncation", () => {
  it("output containing the truncation marker → true", () => {
    expect(detectTruncation("[... 42 lines truncated for context budget ...]")).toBe(true);
  });

  it("normal output → false", () => {
    expect(detectTruncation("src/foo.ts(1,1): error TS2304: Cannot find name 'x'.")).toBe(false);
  });

  it("empty string → false", () => {
    expect(detectTruncation("")).toBe(false);
  });
});

describe("computeFeederAction", () => {
  const KEY_A = "src/a.ts:1:TS2304:Cannot find name 'x'.";
  const KEY_B = "src/b.ts:2:TS2345:Type 'string' is not assignable.";

  it("applies=0, baseline=null → setBaseline with postKeys", () => {
    const postKeys = new Set([KEY_A]);
    const result = computeFeederAction(postKeys, 0, null, 1, false);
    expect(result.kind).toBe("setBaseline");
    if (result.kind === "setBaseline") {
      expect(result.keys).toBe(postKeys);
    }
  });

  it("applies=0, baseline already set → skip (baseline locked in)", () => {
    const result = computeFeederAction(new Set([KEY_A]), 0, new Set([KEY_A]), 1, false);
    expect(result.kind).toBe("skip");
  });

  it("applies>0, introduced keys (post minus baseline) → pushSnapshot with sorted keys + truncated flag", () => {
    const baseline = new Set([KEY_A]);
    const postKeys = new Set([KEY_A, KEY_B]);
    const result = computeFeederAction(postKeys, 2, baseline, 5, true);
    expect(result.kind).toBe("pushSnapshot");
    if (result.kind === "pushSnapshot") {
      expect(result.snapshot.introducedKeys).toEqual([KEY_B]); // sorted, KEY_A in baseline
      expect(result.snapshot.successfulAppliesAtCapture).toBe(2);
      expect(result.snapshot.iter).toBe(5);
      expect(result.snapshot.truncated).toBe(true);
    }
  });

  it("applies>0, null baseline (fallback) → pushSnapshot with all postKeys sorted", () => {
    const postKeys = new Set([KEY_B, KEY_A]); // intentionally unordered
    const result = computeFeederAction(postKeys, 1, null, 3, false);
    expect(result.kind).toBe("pushSnapshot");
    if (result.kind === "pushSnapshot") {
      // null baseline treated as empty → all postKeys are introduced, and sorted
      expect(result.snapshot.introducedKeys).toEqual([KEY_A, KEY_B].sort());
    }
  });

  it("applies>0, postKeys ⊆ baseline → skip (no net new errors)", () => {
    const baseline = new Set([KEY_A, KEY_B]);
    const postKeys = new Set([KEY_A]);
    expect(computeFeederAction(postKeys, 1, baseline, 2, false).kind).toBe("skip");
  });

  it("applies>0, empty postKeys → skip (nothing parses)", () => {
    expect(computeFeederAction(new Set<string>(), 3, new Set([KEY_A]), 4, false).kind).toBe("skip");
  });
});
