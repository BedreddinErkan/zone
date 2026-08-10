import { describe, it, expect, beforeAll } from "vitest";
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
 * these five tasks' plans would show. QUICK_PLAN_FILES stays untested by this harness.
 * mergedInFull only records presence anywhere in the merge, a materially different (and
 * weaker) claim than reaching the model — see item 79.
 *
 * grep is captured data, not re-run: its selection among matches beyond its four-file
 * cap is rg's own directory-walk order, established nondeterministic, so re-running it
 * inside a "frozen" test would inject exactly the instability this file exists to avoid.
 * A task's grep.deterministic flag says whether its frozen firstFour is the only possible
 * outcome (totalMatches <= 4) or one sample of many; mergedInFull is asserted only where
 * that flag is true.
 */

interface SnapshotTask {
  id: string;
  task: string;
  exposes: string;
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
});
