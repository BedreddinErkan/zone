import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rankRelevantFiles } from "./rankRelevantFiles.js";
import type { RepoFile } from "../types/project.js";

/**
 * Ranker measurement ground. Everything here runs against the frozen snapshot below,
 * never the live tree — see the snapshot's own contentUnionNote for why the embedded
 * content is scoped to exactly this task set.
 *
 * reachesModel's width (INVESTIGATION_WIDTH, below) matches PLAN_INVESTIGATION_MAX_FILES,
 * not QUICK_PLAN_FILES -- the two production consumer widths diverged once the merge fix
 * landed, and every task in this file's own task set routes to the investigate branch
 * (verified: none is a pure addition), so this is the width that actually governs what
 * these seven tasks' plans would show. QUICK_PLAN_FILES stays untested by this harness.
 * mergedInFull only records presence anywhere in the merge, a materially different (and
 * weaker) claim than reaching the model — see item 79.
 *
 * grep is captured data, not re-run: its selection among matches beyond its four-file
 * cap is rg's own directory-walk order, established nondeterministic, so re-running it
 * inside a "frozen" test would inject exactly the instability this file exists to avoid.
 * A task's grep.deterministic flag says whether its frozen firstFour is the only possible
 * outcome (totalMatches <= 4) or one sample of many; mergedInFull is asserted only where
 * that flag is true.
 *
 * T6 and T7 (added after the first five) guard the ranker's un-boundaried keyword-substring
 * signal against regressions the first five tasks cannot see. T7 isolates the boundary risk
 * cleanly: its correctFile reaches the model only via "key" matched inside "Keys" with no
 * regex \b transition, and "key" is not blocklisted, so T7 stays green if a blocklist-only
 * fix ships. T6 was designed to isolate the blocklist risk the same way ("projects" is an
 * ENTITY_TERM_BLOCKLIST entry) but measurement found it is NOT clean the way T7 is: "projects"
 * also crosses the project/Structure hump join with no \b transition, so T6 goes red under
 * either candidate alone, not just blocklist. Use the pair together to tell them apart -- T6
 * red with T7 green implicates blocklist specifically; both red implicates boundary (or both).
 * Their own failureMeans field carries this in the data -- see there before treating a red T6
 * or T7 as a stale assertion to update.
 */

interface SnapshotTask {
  id: string;
  task: string;
  exposes: string;
  failureMeans?: string;
  correctFile: string | null;
  grep: {
    firstFour: string[];
    totalMatches: number;
    deterministic: boolean;
    correctFileAmongTotalMatches: boolean | null;
  };
}

interface Snapshot {
  capturedAtCommit: string;
  capturedAtDate: string;
  totalFileCount: number;
  paths: string[];
  contentUnionNote: string;
  contentUnion: Record<string, string>;
  tasks: SnapshotTask[];
}

const SNAPSHOT_PATH = path.join(process.cwd(), "src/repo/rankerBaseline.snapshot.json");
const snapshot: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8"));

function detectCategory(p: string): RepoFile["category"] {
  const n = p.replace(/\\/g, "/");
  if (n.startsWith("client/")) return "frontend";
  if (n.startsWith("server/")) return "backend";
  return "unknown";
}

// Reconstructed field-for-field from paths alone -- absolutePath is never read by the
// scoring logic (confirmed: zero references in rankRelevantFiles.ts), so a stand-in is safe.
const frozenFiles: RepoFile[] = snapshot.paths.map((p) => ({
  path: p,
  absolutePath: p,
  extension: p.includes(".") ? (p.split(".").pop() ?? "") : "",
  category: detectCategory(p),
}));

async function readFromUnion(p: string): Promise<string | null> {
  return Object.prototype.hasOwnProperty.call(snapshot.contentUnion, p)
    ? snapshot.contentUnion[p]!
    : null;
}

// Matches PLAN_INVESTIGATION_MAX_FILES -- every task in this file routes to the
// investigate branch, so this is the width that decides what their plans actually
// show. QUICK_PLAN_FILES (still 5) is untested here; see the header comment above.
const INVESTIGATION_WIDTH = 9;

interface Merge {
  rankedOnlyReachesModel: boolean;
  mergedReachesModel: boolean;
  mergedInFull: boolean;
}

async function computeMerge(entry: SnapshotTask): Promise<Merge | null> {
  if (entry.correctFile === null) return null;
  const ranked = await rankRelevantFiles({
    task: entry.task,
    files: frozenFiles,
    readContent: readFromUnion,
  });
  const rankedPaths = ranked.map((f) => f.path); // production default: ranker's own cap is 5
  const rankedOnlyIdx = rankedPaths.indexOf(entry.correctFile);

  const extra = entry.grep.firstFour.filter((p) => !rankedPaths.includes(p));
  const merged = [...rankedPaths, ...extra];
  const mergedIdx = merged.indexOf(entry.correctFile);

  return {
    rankedOnlyReachesModel: rankedOnlyIdx >= 0 && rankedOnlyIdx < INVESTIGATION_WIDTH,
    mergedReachesModel: mergedIdx >= 0 && mergedIdx < INVESTIGATION_WIDTH,
    mergedInFull: mergedIdx >= 0,
  };
}

describe("ranker measurement ground", () => {
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const merges = new Map<string, Merge | null>();

  beforeAll(async () => {
    for (const t of snapshot.tasks) {
      merges.set(t.id, await computeMerge(t));
    }
    console.log("\n=== ranker baseline, captured", snapshot.capturedAtCommit.slice(0, 8), snapshot.capturedAtDate, "===");
    for (const t of snapshot.tasks) {
      const m = merges.get(t.id);
      if (!m) {
        console.log(`  ${t.id}  (control, no correct file — ${t.exposes})`);
        continue;
      }
      console.log(
        `  ${t.id}  rankedOnlyReachesModel=${m.rankedOnlyReachesModel}  mergedReachesModel=${m.mergedReachesModel}  ` +
          `mergedInFull=${m.mergedInFull}${t.grep.deterministic ? "" : "  (grep sample-dependent, totalMatches=" + t.grep.totalMatches + ")"}`
      );
    }
  });

  // Records every task ID the assertions below actually look up, so the check at the
  // bottom of this file is derived from what the suite does rather than a second,
  // hand-maintained list that could itself drift out of sync with the assertions.
  // Registered in a SECOND beforeAll, after the one above: that ordering is load-bearing
  // -- the loop in the first beforeAll calls merges.get(t.id) for every ground task purely
  // to log it, and if this wrapper were installed before that loop ran, it would record
  // every ground ID as "referenced" regardless of what the assertions below actually ask
  // for, making the afterAll check below pass vacuously no matter what (verified: mutation
  // testing below confirms swapping this order silently un-catches an added, unreferenced
  // ground ID).
  const referencedIds = new Set<string>();
  beforeAll(() => {
    const originalById = byId.get.bind(byId);
    byId.get = ((key: string) => {
      referencedIds.add(key);
      return originalById(key);
    }) as typeof byId.get;
    const originalMerges = merges.get.bind(merges);
    merges.get = ((key: string) => {
      referencedIds.add(key);
      return originalMerges(key);
    }) as typeof merges.get;
  });

  it("frozen path list length matches the recorded total file count", () => {
    expect(snapshot.paths.length).toBe(snapshot.totalFileCount);
  });

  it("frozen path list has no duplicate entries", () => {
    expect(new Set(snapshot.paths).size).toBe(snapshot.paths.length);
  });

  it("every contentUnion key is a path the snapshot actually scanned", () => {
    const missing = Object.keys(snapshot.contentUnion).filter((p) => !snapshot.paths.includes(p));
    expect(missing).toEqual([]);
  });

  it("T3 (all-common-words control) carries no correct file", () => {
    expect(byId.get("T3")!.correctFile).toBeNull();
  });

  it("T1: correct file does not reach the model", () => {
    expect(merges.get("T1")!.mergedReachesModel).toBe(false);
  });

  // Inverted by the merge-width fix: this used to assert false. The correct file is
  // found by grep deterministically and was always present somewhere in the merge
  // (the sibling assertion below, unchanged) -- it sat at merged position nine, past
  // the old width-5 slice. Now that the investigation prompt takes nine, it reaches
  // the model. This is the regression guard on that fix.
  it("T2: correct file now reaches the model", () => {
    expect(merges.get("T2")!.mergedReachesModel).toBe(true);
  });

  // Safe to hard-assert unlike T1's mergedInFull: T2's grep.deterministic is true in the
  // frozen snapshot (totalMatches <= 4, verified at generation time), so this value is not
  // a sample that could differ on a re-capture.
  it("T2: correct file present somewhere in the full merge", () => {
    expect(merges.get("T2")!.mergedInFull).toBe(true);
  });

  it("T4: correct file reaches the model", () => {
    expect(merges.get("T4")!.mergedReachesModel).toBe(true);
  });

  it("T5: correct file does not reach the model", () => {
    expect(merges.get("T5")!.mergedReachesModel).toBe(false);
  });

  // T6 and T7 use single-assertion style like T1/T4/T5, not T2's dual style: both have
  // grep.deterministic=true with zero grep matches, so the merged array is exactly the
  // ranked-only array (capped at 5) with nothing appended -- mergedInFull and
  // mergedReachesModel are identical by construction for these two, unlike T2, where a real
  // grep extra makes them materially different claims. A second assertion here would just
  // restate the first.
  it("T6: correct file reaches the model (blocklist guard)", () => {
    expect(merges.get("T6")!.mergedReachesModel).toBe(true);
  });

  it("T7: correct file reaches the model (boundary guard)", () => {
    expect(merges.get("T7")!.mergedReachesModel).toBe(true);
  });

  // Runs after every it() above regardless of where in this file it is declared -- afterAll's
  // own semantics, not this check's position, is what makes it order-independent (verified:
  // relocating this block to before every it() and re-running the rename mutation below still
  // caught it, byte-identical failure). Both directions fail loudly: a ground ID renamed or
  // removed leaves a stale entry in referencedIds with nothing in groundIds to match it, and a
  // ground ID nothing above asserts on leaves a stale entry in groundIds with nothing in
  // referencedIds to match it.
  afterAll(() => {
    const groundIds = snapshot.tasks.map((t) => t.id).sort();
    expect([...referencedIds].sort()).toEqual(groundIds);
  });
});
