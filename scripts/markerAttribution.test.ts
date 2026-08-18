import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  MARKER_NAME_RE,
  SELF_EXCLUDED_PATHS,
  fileKind,
  isEmittingLine,
  hasSinkWriteShape,
  scanTree,
  hazards,
  readTrackedFiles,
  type FileInput,
} from "./markerAttribution.js";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("MARKER_NAME_RE", () => {
  it("matches the bracketed tag shape and nothing shorter", () => {
    expect("[zone-foo]".match(MARKER_NAME_RE)).toEqual(["[zone-foo]"]);
    expect("[zone-foo-bar-2]".match(MARKER_NAME_RE)).toEqual(["[zone-foo-bar-2]"]);
    expect("[zone-]".match(MARKER_NAME_RE)).toBeNull();
  });
});

describe("fileKind — precedence for paths that could match more than one kind", () => {
  it("classifies a plain source file as source", () => {
    expect(fileKind("src/llm/agentLoop.ts")).toBe("source");
  });
  it("classifies a .test.ts file as test, even under scripts/ (test checked before script)", () => {
    expect(fileKind("scripts/deferredWorkAnaphorSweep.test.ts")).toBe("test");
    expect(fileKind("src/llm/agentLoop.test.ts")).toBe("test");
  });
  it("classifies a __tests__ manual probe as manual-probe, not source", () => {
    expect(fileKind("src/repo/__tests__/runImportContextManual.ts")).toBe("manual-probe");
  });
  it("classifies a non-test scripts/ file as script", () => {
    expect(fileKind("scripts/sweep.ts")).toBe("script");
  });
  it("classifies docs and markdown as doc", () => {
    expect(fileKind("docs/deferred-work.md")).toBe("doc");
    expect(fileKind("CLAUDE.md")).toBe("doc");
  });
  it("classifies json and snapshot-named files as snapshot", () => {
    expect(fileKind("src/repo/rankerBaseline.snapshot.json")).toBe("snapshot");
    expect(fileKind("package.json")).toBe("snapshot");
  });
});

describe("isEmittingLine — the shape rule, both directions", () => {
  const NAME = "[zone-example]";

  it("matches a whole-quoted-argument call: log(\"[zone-example]\", payload)", () => {
    expect(isEmittingLine(`log("${NAME}", JSON.stringify(payload));`, NAME)).toBe(true);
  });
  it("matches any callee name with the same shape (emitLog, ctx.emit's second argument)", () => {
    expect(isEmittingLine(`emitLog("${NAME}", { a: 1 });`, NAME)).toBe(true);
    expect(isEmittingLine(`ctx.emit("log", "${NAME}", payload);`, NAME)).toBe(true);
  });
  it("matches a template literal whose leading static chunk is the tag", () => {
    expect(isEmittingLine("log(`[zone-example] ${dynamicPart}`);", NAME)).toBe(true);
  });
  it("does NOT match the marker appearing inside a comment with no call shape — the item-196 case", () => {
    expect(isEmittingLine(`// (matching the sibling gate's own ${NAME}, fires on ...)`, NAME)).toBe(false);
  });
  it("does NOT match a bare mention with no trailing comma or paren", () => {
    expect(isEmittingLine(`See ${NAME} for details.`, NAME)).toBe(false);
  });
});

describe("hasSinkWriteShape — the object-literal-then-raw-write shape", () => {
  const NAME = "[zone-marker-sink-rotated]";
  it("matches an object literal name: property in a file that also calls appendFileSync", () => {
    const text = `
      const record = {
        name: "${NAME}",
        ts: new Date().toISOString(),
      };
      fs.appendFileSync(filePath, JSON.stringify(record) + "\\n", "utf8");
    `;
    expect(hasSinkWriteShape(text, NAME)).toBe(true);
  });
  it("does NOT match the object-literal shape alone, without a raw write call in the same file", () => {
    const text = `const record = { name: "${NAME}", ts: "x" };`;
    expect(hasSinkWriteShape(text, NAME)).toBe(false);
  });
  it("does NOT match a raw write call alone, without the marker as a name: property", () => {
    const text = `fs.appendFileSync(filePath, JSON.stringify({ other: 1 }), "utf8");`;
    expect(hasSinkWriteShape(text, NAME)).toBe(false);
  });
});

describe("scanTree — fixtures covering each E3 distribution shape", () => {
  const files: FileInput[] = [
    // zero emitters: mentioned only in a doc and a test — must NOT be credited.
    {
      path: "docs/deferred-work.md",
      text: `The [zone-doc-only] marker is discussed here, quoted like this: "[zone-doc-only]", too.`,
    },
    {
      path: "src/llm/foo.test.ts",
      text: `expect(mockLog).toHaveBeenCalledWith("[zone-doc-only]", expect.anything());`,
    },
    // one emitter: a real source file with a direct literal call.
    {
      path: "src/llm/oneEmitter.ts",
      text: `log("[zone-one-emitter]", JSON.stringify({ a: 1 }));`,
    },
    // one emitter, mentioned in a comment ELSEWHERE — the item-196 shape.
    {
      path: "src/llm/realEmitter.ts",
      text: `log("[zone-sibling]", JSON.stringify(payload));`,
    },
    {
      path: "src/llm/commentOnly.ts",
      text: `// (matching the sibling module's own [zone-sibling], fires on denial)`,
    },
    // several emitters: two real source files both emit the same marker.
    {
      path: "src/llm/emitterA.ts",
      text: `log("[zone-several]", JSON.stringify({ x: 1 }));`,
    },
    {
      path: "src/llm/emitterB.ts",
      text: `debugLog("[zone-several]", JSON.stringify({ y: 2 }));`,
    },
  ];

  const result = scanTree(files);

  it("zero-emitter case: mentioned in doc and test, emittedIn stays empty", () => {
    const attr = result.get("[zone-doc-only]")!;
    expect(attr.mentionedIn).toEqual(["docs/deferred-work.md", "src/llm/foo.test.ts"]);
    expect(attr.emittedIn).toEqual([]);
  });

  it("one-emitter case: a direct literal call in source is credited", () => {
    const attr = result.get("[zone-one-emitter]")!;
    expect(attr.emittedIn).toEqual(["src/llm/oneEmitter.ts"]);
  });

  it("the item-196 shape: the real emitter is credited, the commenting file is not", () => {
    const attr = result.get("[zone-sibling]")!;
    expect(attr.emittedIn).toEqual(["src/llm/realEmitter.ts"]);
    expect(attr.emittedIn).not.toContain("src/llm/commentOnly.ts");
    expect(attr.mentionedIn).toContain("src/llm/commentOnly.ts");
  });

  it("several-emitter case: both real emitters are credited, not just the first found", () => {
    const attr = result.get("[zone-several]")!;
    expect(attr.emittedIn).toEqual(["src/llm/emitterA.ts", "src/llm/emitterB.ts"]);
  });
});

describe("hazards — the fixture-level check", () => {
  const files: FileInput[] = [
    { path: "src/llm/realEmitter.ts", text: `log("[zone-sibling]", JSON.stringify(payload));` },
    { path: "src/llm/commentOnly.ts", text: `// (matching the sibling module's own [zone-sibling], fires on denial)` },
  ];
  const result = scanTree(files);
  const hz = hazards(result);

  it("reports exactly the commenting file as a hazard, naming the real emitter", () => {
    expect(hz).toEqual([
      { file: "src/llm/commentOnly.ts", marker: "[zone-sibling]", emitters: ["src/llm/realEmitter.ts"] },
    ]);
  });
});

/**
 * THE REAL CASE, not a fixture shape. Item 196 was corrupted because
 * commandApprovals.ts mentions [zone-run-command-readonly-blocked] in a comment while
 * toolExecutor.ts is the actual emitter. If this tool cannot get that one pairing right against
 * the real tree, nothing else about it matters.
 *
 * This couples the test to two real file paths — if either module is renamed, this test fails
 * for a reason unrelated to the attribution logic itself. Accepted deliberately: a rename that
 * silently passed here would mean the tool's real-world claim was never actually checked, which
 * is a worse failure mode than an occasional maintenance fix pointed at by a clear assertion
 * message.
 */
describe("the real regression case — commandApprovals.ts / toolExecutor.ts", () => {
  const MARKER = "[zone-run-command-readonly-blocked]";
  const COMMENTING_FILE = "src/api/commandApprovals.ts";
  const EMITTING_FILE = "src/tools/toolExecutor.ts";

  it("both real files are present in the tracked tree (the assertion below is meaningless otherwise)", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, COMMENTING_FILE))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, EMITTING_FILE))).toBe(true);
  });

  it("credits toolExecutor.ts as the emitter and does not credit commandApprovals.ts", () => {
    const result = scanTree(readTrackedFiles());
    const attr = result.get(MARKER);
    expect(attr).toBeDefined();
    expect(attr!.emittedIn).toContain(EMITTING_FILE);
    expect(attr!.emittedIn).not.toContain(COMMENTING_FILE);
    expect(attr!.mentionedIn).toContain(COMMENTING_FILE);
  });

  it("hazards() reports exactly that pair for this marker", () => {
    const result = scanTree(readTrackedFiles());
    const hz = hazards(result).filter((h) => h.marker === MARKER);
    expect(hz).toEqual([{ file: COMMENTING_FILE, marker: MARKER, emitters: [EMITTING_FILE] }]);
  });
});

/**
 * The self-exclusion, pinned as its own case rather than left implicit in the drift figure.
 * These two files carry fixture and documentation marker names that this codebase does not
 * emit; counting them makes the inventory an inventory of itself. The concrete failure that
 * proved it: the drift figures were first measured while both files were untracked, so
 * git ls-files could not see them, and committing them moved the total from 406 to 414.
 */
describe("self-exclusion — the tool does not inventory its own fixtures", () => {
  it("excludes exactly its own source and test file", () => {
    expect([...SELF_EXCLUDED_PATHS].sort()).toEqual([
      "scripts/markerAttribution.test.ts",
      "scripts/markerAttribution.ts",
    ]);
  });

  it("readTrackedFiles() returns neither of them, though git still tracks both", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    for (const p of SELF_EXCLUDED_PATHS) {
      expect(tracked).toContain(p); // the file really is tracked — otherwise this pins nothing
    }
    const readPaths = readTrackedFiles().map((f) => f.path);
    for (const p of SELF_EXCLUDED_PATHS) {
      expect(readPaths).not.toContain(p);
    }
  });

  it("the fixture names defined in this file are absent from the scanned inventory", () => {
    const result = scanTree(readTrackedFiles());
    // Built from parts so this assertion does not itself introduce the literal it checks for.
    const fixtureOnly = ["zone-doc-only", "zone-one-emitter", "zone-several", "zone-sibling"];
    for (const bare of fixtureOnly) {
      expect(result.has("[" + bare + "]")).toBe(false);
    }
  });
});

/**
 * Drift check against the live tree, asserting today's real figures rather than a cached copy —
 * matching tool-mention-defect-sweep.mjs's own convention. A future change to the tree that
 * shifts these numbers should make this test fail and prompt a review, not silently drift.
 */
describe("drift check — today's figures against the real tree", () => {
  it("406 marker names; emitter-count distribution zero=42 one=343 several=21; 21 hazards", () => {
    const result = scanTree(readTrackedFiles());
    expect(result.size).toBe(406);

    const dist = { zero: 0, one: 0, several: 0 };
    for (const attr of result.values()) {
      const c = attr.emittedIn.length;
      if (c === 0) dist.zero++;
      else if (c === 1) dist.one++;
      else dist.several++;
    }
    expect(dist).toEqual({ zero: 42, one: 343, several: 21 });
    expect(hazards(result)).toHaveLength(21);
  });
});
