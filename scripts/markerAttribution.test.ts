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
  summarize,
  driftGuardOk,
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
  it("does NOT match a backtick code span in a comment — the actual over-credit shape, not the case above", () => {
    // The item-196 test above uses NAME inside a template literal for interpolation only; the
    // resulting string carries no literal backtick character, so it never exercised this bug.
    // This fixture is built with a real backtick immediately before the marker, matching what
    // planApprovals.ts / applyRollbackFeedback.ts / taskClassifier.ts actually had in a comment.
    expect(isEmittingLine("// see `" + NAME + "` (elsewhere.ts)", NAME)).toBe(false);
  });
  it("does NOT match a wholeArgument-shaped comment with no backtick at all", () => {
    // wholeArgument has zero real-tree comment hits today, but the shape is reachable in
    // principle — a comment listing example values in quotes, ending in a comma or paren.
    expect(isEmittingLine(`// values are "${NAME}", "[zone-other]"`, NAME)).toBe(false);
    expect(isEmittingLine(`// e.g. "${NAME}")`, NAME)).toBe(false);
  });
  it("still matches a genuine template literal even though it now passes through the comment gate", () => {
    // Guards against an over-broad comment predicate silently swallowing real code.
    expect(isEmittingLine("console.log(`" + NAME + " ${label}`);", NAME)).toBe(true);
  });
  it("still matches real code carrying an inline trailing comment later on the same line", () => {
    // Added after a mutation-testing pass found this fixture missing: dropping the ^ anchor from
    // COMMENT_LINE_RE (so it scans anywhere in the line rather than only the start) survived the
    // suite as written, because no line in this codebase's actual emission credits happens to mix
    // real code with a later `//`/`*`/`/*`. This line manufactures that shape directly, so the
    // anchor's job — only excluding a line that OPENS with a comment marker — has its own pin
    // rather than relying on the corpus to contain an example of it.
    expect(isEmittingLine("log(`" + NAME + " ${v}`); // trailing note, not a comment-opened line", NAME)).toBe(true);
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
 * THE TEMPLATE-PREFIX REGRESSION CASE, in the same form as the block above. Item 196's own
 * illustrative example — `[zone-tier-grant-unusable]` (loopTelemetry.ts) — fires ` in
 * planApprovals.ts — was itself misclassified by the tool: a bare backtick immediately before a
 * marker inside a JSDoc comment reads identically to a template-literal prefix to a line-based
 * scan. Picked over the other two over-credited markers for having a single true emitter, the
 * simplest case to pin exactly.
 */
describe("the real regression case — planApprovals.ts / loopTelemetry.ts (template-prefix shape)", () => {
  const MARKER = "[zone-tier-grant-unusable]";
  const COMMENTING_FILE = "src/llm/planApprovals.ts";
  const EMITTING_FILE = "src/llm/loopTelemetry.ts";

  it("both real files are present in the tracked tree (the assertion below is meaningless otherwise)", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, COMMENTING_FILE))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, EMITTING_FILE))).toBe(true);
  });

  it("credits loopTelemetry.ts as the sole emitter and does not credit planApprovals.ts", () => {
    const result = scanTree(readTrackedFiles());
    const attr = result.get(MARKER);
    expect(attr).toBeDefined();
    expect(attr!.emittedIn).toEqual([EMITTING_FILE]);
    expect(attr!.mentionedIn).toContain(COMMENTING_FILE);
  });

  it("hazards() reports planApprovals.ts for this marker, naming loopTelemetry.ts as the real emitter", () => {
    // Filtered by file as well as marker: unlike the commandApprovals.ts/toolExecutor.ts case
    // above, this marker has TWO hazard-worthy mentioning files (agentLoop.ts is the other,
    // pinned in the next test), so filtering by marker alone returns both rows.
    const result = scanTree(readTrackedFiles());
    const hz = hazards(result).filter((h) => h.marker === MARKER && h.file === COMMENTING_FILE);
    expect(hz).toEqual([{ file: COMMENTING_FILE, marker: MARKER, emitters: [EMITTING_FILE] }]);
  });

  it("agentLoop.ts's own pre-existing hazard row for this marker no longer lists planApprovals.ts as a co-emitter", () => {
    // Before this fix, agentLoop.ts was ALREADY correctly flagged as a hazard for this marker
    // (it mentions it in a comment, correctly does not emit it) — but its reported `emitters`
    // list wrongly included planApprovals.ts, because that was the same false credit this whole
    // fix removes. This is not a new hazard row; it is an existing one whose content was wrong.
    const result = scanTree(readTrackedFiles());
    const hz = hazards(result).filter((h) => h.marker === MARKER && h.file === "src/llm/agentLoop.ts");
    expect(hz).toEqual([{ file: "src/llm/agentLoop.ts", marker: MARKER, emitters: [EMITTING_FILE] }]);
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
 * The structural fix for a recurring incident, not a repeat of the comment that already failed to
 * prevent it once. `readTrackedFiles()` scans `git ls-files` — the INDEX, not the working tree —
 * so a verification run that happens before `git add` sees a stale, pre-change picture and can
 * report the drift-check below as passing for a reason unrelated to what the tree actually
 * contains. This is documented in `markerAttribution.ts`'s own header (406->414) and it happened
 * again anyway (415->417, docs/deferred-work.md item 391) — proof that a comment alone is not
 * sufficient prevention, since updating the hardcoded numbers again would leave the exact same gap
 * open for a third occurrence.
 *
 * This test closes it structurally: it compares the tracked-only scan against a full-worktree scan
 * (tracked + untracked-but-not-gitignored, both read from disk) and fails LOUDLY, with a message
 * naming the actual mechanism, whenever they disagree — which is exactly the condition under which
 * the drift-check's hardcoded numbers cannot be trusted. On a clean tree, or a fully-staged one,
 * the two scans agree and this passes silently. It intentionally runs BEFORE the drift check below,
 * so a developer sees "your tree has an unstaged change that affects this scan" rather than a bare
 * "expected 417 to be 415" that gives no hint the real problem is `git add`, not the constant.
 */
describe("working-tree hazard — the tracked scan must agree with what staging would produce (item 391)", () => {
  it("driftGuardOk() passes on the actual working tree right now", () => {
    const result = driftGuardOk();
    if (!result.ok) {
      throw new Error(
        "markerAttribution's drift-check reads git's INDEX (git ls-files), not the working tree. " +
          "The tracked-only scan and the full-worktree scan (tracked + untracked-but-not-gitignored) " +
          "disagree, which means an untracked or unstaged-modified file would change this file's " +
          "numbers once staged — the drift-check assertion below is unreliable until you `git add` " +
          "(or revert) whatever changed. Run `git status --porcelain` to find it.\n" +
          `  tracked:  size=${result.tracked.size} dist=${JSON.stringify(result.tracked.dist)} hazards=${result.tracked.hazardCount}\n` +
          `  worktree: size=${result.worktree.size} dist=${JSON.stringify(result.worktree.dist)} hazards=${result.worktree.hazardCount}\n` +
          "See docs/deferred-work.md item 391."
      );
    }
    expect(result.ok).toBe(true);
  });

  it("fixture proof: an untracked file adding a new marker makes the guard disagree", () => {
    // Proves the guard actually discriminates rather than passing unconditionally — built from
    // scanTree/summarize directly (not driftGuardOk, which shells out to git against the real
    // tree and cannot be pointed at a fixture) so this needs no real filesystem write.
    const trackedOnly: FileInput[] = [
      { path: "src/llm/existing.ts", text: `log("[zone-existing]", JSON.stringify({}));` },
    ];
    const plusUntracked: FileInput[] = [
      ...trackedOnly,
      { path: "src/llm/brandNew.ts", text: `log("[zone-brand-new]", JSON.stringify({}));` },
    ];
    const trackedSummary = summarize(scanTree(trackedOnly));
    const worktreeSummary = summarize(scanTree(plusUntracked));
    expect(trackedSummary).not.toEqual(worktreeSummary);
    expect(worktreeSummary.size).toBe(trackedSummary.size + 1);
  });

  it("fixture proof: the guard agrees when nothing distinguishes tracked from worktree", () => {
    const files: FileInput[] = [
      { path: "src/llm/existing.ts", text: `log("[zone-existing]", JSON.stringify({}));` },
    ];
    expect(summarize(scanTree(files))).toEqual(summarize(scanTree(files)));
  });
});

/**
 * Drift check against the live tree, asserting today's real figures rather than a cached copy —
 * matching tool-mention-defect-sweep.mjs's own convention. A future change to the tree that
 * shifts these numbers should make this test fail and prompt a review, not silently drift.
 */
describe("drift check — today's figures against the real tree", () => {
  it("426 marker names; emitter-count distribution zero=43 one=362 several=21; 31 hazards", () => {
    // Re-derived via this file's own scanTree/hazards, not hand-added to the prior 410/349 —
    // the repository-tree write guard (ledger item 236) landed one new marker,
    // `[zone-repo-guard]`, so the total moved 410->411. It lands in `several`, not `one`:
    // BOTH halves of that guard emit it — homeGuard.ts refuses the write at the call and
    // globalHome.ts reports the inventory diff at teardown — so `several` moved 19->20 and
    // `one` was unchanged. That is deliberate co-emission of one marker by one guard, not a
    // hazard, and hazards() agrees at 24 with no row for this marker. An earlier version of
    // this comment predicted `one` moving to 350 by assuming a single emitter; the scan
    // corrected it, which is the reason these figures are re-derived rather than reasoned.
    //
    // 411->412: ledger item 259's `--max-turns` added `[zone-user-iter-cap]`, emitted at the one
    // site where the user's ceiling actually binds. Unlike `[zone-repo-guard]` above this one
    // does land in `one` (`src/llm/agentLoop.ts` alone) so `one` moves 349->350 — re-derived from
    // the scan rather than reasoned from the single-emitter assumption that misled the earlier
    // comment, and `hazards()` still agrees at 24 with no row for it.
    //
    // 412->413: item 259's `--max-budget-usd` added `[zone-run-usd-cap]`, emitted at the one site
    // where the per-run ceiling binds, so `one` moves 350->351. Hazards stay 24 — but only after a
    // correction worth recording: the first draft of that fix's own source comment NAMED
    // `[zone-graceful-degrade]` inside `patchUserFacingReason.ts`, a file that does not emit it,
    // which created a 25th hazard row out of prose alone. The referent was rewritten rather than
    // the constant bumped, which is this document's standing rule and, here, the difference between
    // recording a real attribution hazard and inventing one.
    //
    // 413->414: this pass's pre-push guard added `[zone-pre-push]`, emitted from
    // scripts/prePush.mjs. It lands in `zero`, not `one` — measured, and structural rather than a
    // miscount: fileKind() classifies anything under scripts/ as "script", and scanTree skips
    // every non-"source" file before recording an emission, so no marker emitted only from
    // scripts/ can reach `one` or `several` by construction. `zero` therefore reads "named but
    // never emitted" for this row when the truth is "emitted from a file kind the scanner does
    // not credit" — the first production emission of that shape, the only other script-only zero
    // row being a test fixture. Hazards stay 24: the guard's ledger entry names the marker, but
    // hazards() reports only mentions inside "source" files and docs/ is not one.
    //
    // 414->415: the tool-call record seam added `[zone-tool-call-record]`, emitted from
    // src/utils/toolCallSink.ts. It lands in `one`, so `one` moves 351->352. Two things about
    // this row were predicted before the scan and are worth keeping, because both are places a
    // plausible guess would have been wrong. First, the emission is credited through
    // hasSinkWriteShape (an object-literal `name:` property in a file that also calls
    // appendFileSync) rather than through isEmittingLine — the sink never passes the marker as a
    // call argument. Had the literal lived only in the exported TOOL_CALL_RECORD_NAME constant,
    // it would have matched NO shape (a `const x = "..."` line ends in `;`, not `,` or `)`) and
    // the row would have landed in `zero`, moving 43->44 for a reason that looks like a miscount
    // and is not. Second, hazards stay 24 even though the recorder's own test file names the
    // marker: fileKind maps *.test.ts to "test", and hazards() skips every non-"source" mention.
    // `[zone-agent-tool-call]` is deliberately untouched at one emitter — the new record is a
    // separate channel with a separate name, so no count keyed on the debug marker sums two
    // populations with different gating.
    //
    // 415->417: the ProviderProfile pass (docs/deferred-work.md item 387) added two warn-once
    // markers, `[zone-profile-no-pricing]` and `[zone-budget-gate-inert]`, both emitted from
    // src/llm/providerProfile.ts alone — both land in `one`, so `one` moves 352->354. `zero` and
    // `several` are unchanged.
    //
    // Hazards moved 24->26, NOT unchanged — the size of the two changes happening to match is
    // coincidence, not a reason to assume the hazard count tracks it. Both new rows are
    // src/llm/providerProfile.ts, from its own doc-comment prose citing two PRE-EXISTING markers
    // as illustrative examples: `[zone-pricing]` (real emitter usage/pricing.ts) and
    // `[zone-task-classifier-failure]` (real emitter src/llm/taskClassifier.ts). Legitimate prose,
    // correctly flagged — providerProfile.ts is a source file that mentions but does not emit
    // either. Confirmed no third hazard: the other pre-existing marker gaining a new mention in
    // this pass, `[zone-graceful-degrade]`, gained it only in docs/deferred-work.md, a "doc" file
    // hazards() does not scan.
    //
    // This exact count was ALSO the second occurrence of the incident this file's own header
    // already documented once (406->414): the verification suite ran before `git add`, so
    // readTrackedFiles() could not see the two new files yet and this test passed locally at 415
    // for a reason unrelated to the tree it claims to measure, then failed in CI against the
    // pushed commit. The "working-tree hazard" describe block above this one is the structural fix
    // for that recurrence — this comment records the numbers, that block is what actually prevents
    // a third one. See docs/deferred-work.md item 391.
    // 417 -> 418, one=354 -> 355: [zone-profile-partial-pricing] (providerProfile.ts), added by
    // ledger item 399 so a gateway priced with SKIPPED cache buckets says its reported cost is a
    // floor rather than a total. One marker, one emitter, no new hazard row.
    //
    // 418 -> 419, one=355 -> 356: the gateway-live-defects investigation (docs/deferred-work.md
    // item 405) added [zone-openai-request-issued], emitted once from src/llm/openaiAdapter.ts. One
    // marker, one emitter — but hazards moves 26->27, not unchanged: the new emission site's own
    // comment names [zone-llm-retry-attempt] as the precedent for firing on every retry attempt
    // (that marker is emitted from withExponentialBackoff.ts, not here), which is exactly the
    // sibling-marker-citation-in-prose shape item 387/391 already established as a legitimate
    // hazard row, not a bug — re-derived from the scan rather than assumed unchanged.
    //
    // 419 -> 420, one=356 -> 357: [zone-gateway-unresolved] (src/cli/config.ts), added by ledger
    // item 406 so a provider id naming no configured gateway is reported for what it is rather than
    // only through an unrecognized-provider warning that names the fallback. One marker, one
    // emitter. Hazards stay 27 — its only other mention is docs/deferred-work.md, a "doc" file
    // hazards() does not scan; re-derived from the scan rather than assumed unchanged.
    //
    // 420 -> 421, one=357 -> 358: [zone-mcp-tools-granted] (src/llm/loopTelemetry.ts, emitted from
    // src/llm/agentLoop.ts), added by ledger item 408 so the escape that makes an approved MCP
    // server's tools survive an allow-shaped filter is reported rather than silent — the silence
    // was half the original defect. One marker, one emitter. Hazards stay 27: its other mentions
    // are the ledger (a "doc" file hazards() does not scan) and its own test, whose assertion on
    // the payload is an emission-shaped reference rather than a prose citation of a sibling marker.
    //
    // This block's own `it` title had been stale since the 418/355/26 figures — three moves behind
    // the assertions below it, which the comments had each recorded correctly. Corrected to match
    // in the same pass rather than left, since a title that names different numbers than the test
    // asserts is exactly the drift this describe block exists to catch.
    //
    // 421 -> 422, one=358 -> 359, hazards 27 -> 28: [zone-mcp-tools-filtered]
    // (src/mcp/mcpClientManager.ts), added by ledger item 410 so a per-server tool allowlist reports
    // both what it dropped and any entry that matched nothing — the rename case an allowlist cannot
    // otherwise surface. One marker, one emitter. The hazard row is src/api/diskMcp.ts, whose
    // `tools` doc comment cites the marker by name to point at where an unmatched entry is reported;
    // that is the sibling-marker-citation-in-prose shape items 387/391 already established as a
    // legitimate row rather than a bug, and it is the same shape [zone-llm-retry-attempt] produced
    // one pass earlier. Re-derived from the scan, and the added row identified by grepping source
    // mentions against emitters, rather than assumed from the count moving by one.
    //
    // 422 -> 423, one=359 -> 360, hazards UNCHANGED at 28: [zone-anthropic-credit-error]
    // (src/llm/anthropicAdapter.ts), added by ledger item 413 so the shape a real out-of-balance
    // Anthropic account actually sends is recorded the first time a funded key hits it — that whole
    // arc (411/412/413) turned on not knowing whether credit exhaustion arrives as 402, a
    // status-less mid-stream frame, or a gateway-normalized 400, and no live call could settle it.
    // One marker, one emitter, and no new hazard row: unlike [zone-mcp-tools-filtered] above, its
    // only other mentions are its own test and the ledger, neither of which hazards() scans.
    //
    // 423 -> 425, one=360 -> 362, hazards 28 -> 31: [zone-plan-null-annotation]
    // (src/llm/executionPlan.ts) and [zone-plan-generation-failed] (src/core/runLlmPatchFlow.ts),
    // both added by ledger item 409 — the first records a coerced null subagent annotation so a
    // future prompt regression is louder than the rejection it replaced, the second makes a
    // plan-generation failure visible at all (it was a debugLog gated on ZONE_VERBOSE_LOGS=1).
    // Two markers, one emitter each.
    //
    // THREE hazard rows, not two, and each was identified by grepping source mentions against
    // emitters rather than inferred from the count moving: executionPlan.ts cites
    // [zone-plan-generation-failed] and [zone-plan] (both emitted by runLlmPatchFlow.ts), and
    // runLlmPatchFlow.ts cites [zone-plan-salvaged] (emitted by executionPlan.ts). All three are
    // deliberate cross-module pointers in comments — the sibling-marker-citation-in-prose shape
    // items 387/391 already established as a legitimate row rather than a bug. The two modules now
    // reference each other's markers in both directions, which is why one pass added three rows.
    //
    // 425 -> 426, several=20 -> 21, `one` and hazards UNCHANGED: [zone-mcp-approval], added by
    // ledger item 408's closure (the MCP approval gate). It lands in `several` rather than `one`,
    // deliberately: it is ONE marker name carrying two discriminated shapes — an `event:"config"`
    // emitted once per server at connect from src/mcp/mcpClientManager.ts, and an
    // `event:"decision"` emitted per gated call from src/llm/agentLoop.ts. That is co-emission by
    // one mechanism, the same shape [zone-repo-guard] above already has, not two features
    // accidentally sharing a name. Hazards stay 31: neither emitter cites the other's markers in
    // prose, and this marker's only other mentions are its own tests and the ledger.
    const result = scanTree(readTrackedFiles());
    expect(result.size).toBe(426);

    const dist = { zero: 0, one: 0, several: 0 };
    for (const attr of result.values()) {
      const c = attr.emittedIn.length;
      if (c === 0) dist.zero++;
      else if (c === 1) dist.one++;
      else dist.several++;
    }
    expect(dist).toEqual({ zero: 43, one: 362, several: 21 });
    expect(hazards(result)).toHaveLength(31);
  });

  /**
   * The three hazard rows this pass's fix creates, named exactly rather than left to the length
   * check alone — a length of 24 reached by a different set of three new rows would be the
   * interesting result the length check alone cannot distinguish. Measured after the fix, not
   * hand-derived: the prediction written before the fix landed also claimed zero pre-existing
   * hazard rows would change, and one did — agentLoop.ts's own row for [zone-tier-grant-unusable]
   * (pinned separately above) — so this list is deliberately the three ADDED rows only, not a
   * claim about the full 24.
   */
  it("adds exactly these three hazard rows and no others", () => {
    const result = scanTree(readTrackedFiles());
    const hz = hazards(result);
    const added = [
      {
        file: "src/llm/applyRollbackFeedback.ts",
        marker: "[zone-apply-rolled-back-marker]",
        emitters: ["src/llm/loopTelemetry.ts", "src/tools/toolExecutor.ts"],
      },
      {
        file: "src/llm/planApprovals.ts",
        marker: "[zone-tier-grant-unusable]",
        emitters: ["src/llm/loopTelemetry.ts"],
      },
      {
        file: "src/llm/taskClassifier.ts",
        marker: "[zone-context-window-fallback]",
        emitters: ["src/llm/models.ts"],
      },
    ];
    for (const row of added) expect(hz).toContainEqual(row);
    // and nothing else new: exactly these three plus the 21 pre-existing rows this file does
    // not re-enumerate — enforced by the total-length assertion above rather than repeated here.
  });
});
