import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  saveRunEnvelope,
  loadRunEnvelope,
  deleteRunEnvelope,
  stampEnvelopeStatus,
  listResumableEnvelopes,
  latestResumableEnvelope,
  resolveEnvelopeId,
  reconcileEnvelopeStaging,
  deriveCreatedPaths,
  buildResumeContextBlock,
  createCoalescingWriter,
  currentEnvelopesDir,
  dismissEnvelope,
  _setEnvelopeDirForTest,
  type RunEnvelope,
  type ReconcileResult,
} from "./diskRunEnvelope.js";

// ---- Fixtures ---------------------------------------------------------------

const DEAD_PID = 99999999; // assume no such process exists

function makeEnvelope(overrides: Partial<RunEnvelope> = {}): RunEnvelope {
  return {
    version: 1,
    sessionId: "sess-0000-1111-2222-3333",
    pid: DEAD_PID,
    repoPath: "/repo",
    model: "claude-sonnet-4-6",
    task: "add foo to bar.ts",
    createdAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    status: "token_budget_exceeded",
    executionPlan: null,
    todos: [],
    failureHistory: [],
    staging: [],
    flushedPaths: [],
    priorSessionSummary: "",
    ...overrides,
  };
}

// ---- Test setup -------------------------------------------------------------

let tmp: string;
let envDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "zone-envelope-"));
  envDir = join(tmp, ".zone", "sessions");
  _setEnvelopeDirForTest(envDir);
});

afterEach(async () => {
  _setEnvelopeDirForTest(null);
  await rm(tmp, { recursive: true, force: true });
});

// ---- Round-trip -------------------------------------------------------------

describe("saveRunEnvelope / loadRunEnvelope", () => {
  it("round-trips a full envelope", async () => {
    const env = makeEnvelope({ todos: [{ id: "t1", text: "step 1", status: "completed" }] });
    await saveRunEnvelope(env);
    const loaded = await loadRunEnvelope(env.sessionId);
    // updatedAt is updated on save — exclude from deep-equal
    expect(loaded).toMatchObject({ ...env, updatedAt: expect.any(String) });
  });

  it("loads a pre-S10 envelope lacking createdPaths (treated as absent/[])", async () => {
    const env = makeEnvelope(); // no createdPaths field
    await saveRunEnvelope(env);
    // The persisted JSON must truly lack the field (optional, omitted when undefined).
    const raw = await readFile(join(envDir, `${env.sessionId}.envelope.json`), "utf-8");
    expect(raw).not.toContain("createdPaths");
    const loaded = await loadRunEnvelope(env.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.createdPaths).toBeUndefined();
    // Must not crash and must omit the created-on-disk line.
    expect(buildResumeContextBlock(loaded!, [])).not.toContain("Already created on disk");
  });

  it("returns null for unknown sessionId", async () => {
    expect(await loadRunEnvelope("does-not-exist")).toBeNull();
  });

  it("returns null for version mismatch", async () => {
    const env = makeEnvelope();
    await saveRunEnvelope(env);
    // Corrupt the version
    const p = join(envDir, `${env.sessionId}.envelope.json`);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.version = 99;
    await writeFile(p, JSON.stringify(raw));
    expect(await loadRunEnvelope(env.sessionId)).toBeNull();
  });

  it("atomic write leaves no .tmp file", async () => {
    await saveRunEnvelope(makeEnvelope());
    const files = await readdir(envDir);
    expect(files.some(f => f.endsWith(".tmp"))).toBe(false);
  });

  it("sets mode 0o600 on the file", async () => {
    const env = makeEnvelope();
    await saveRunEnvelope(env);
    const { promises: fs } = await import("node:fs");
    const stat = await fs.stat(join(envDir, `${env.sessionId}.envelope.json`));
    // mode & 0o777 to mask file type bits
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ---- Delete -----------------------------------------------------------------

describe("deleteRunEnvelope", () => {
  it("removes the envelope file", async () => {
    const env = makeEnvelope();
    await saveRunEnvelope(env);
    await deleteRunEnvelope(env.sessionId);
    expect(await loadRunEnvelope(env.sessionId)).toBeNull();
  });

  it("is idempotent (no throw if already gone)", async () => {
    await expect(deleteRunEnvelope("nonexistent")).resolves.toBeUndefined();
  });
});

// ---- Retention (age/count pruning + throttle) -------------------------------

describe("pruneOldEnvelopes / maybeCleanupOldEnvelopes", () => {
  async function writeEnvelopeAt(env: RunEnvelope, updatedAt: string): Promise<void> {
    await saveRunEnvelope(env);
    const p = join(envDir, `${env.sessionId}.envelope.json`);
    const raw = JSON.parse(await readFile(p, "utf-8"));
    raw.updatedAt = updatedAt;
    await writeFile(p, JSON.stringify(raw));
  }

  it("removes envelopes older than maxAgeDays", async () => {
    const { pruneOldEnvelopes } = await import("./diskRunEnvelope.js");
    const old = makeEnvelope({ sessionId: "sess-old" });
    const fresh = makeEnvelope({ sessionId: "sess-fresh" });
    const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date().toISOString();
    await writeEnvelopeAt(old, oldIso);
    await writeEnvelopeAt(fresh, freshIso);

    const result = await pruneOldEnvelopes();
    expect(result.removed).toBe(1);
    expect(await loadRunEnvelope("sess-old")).toBeNull();
    expect(await loadRunEnvelope("sess-fresh")).not.toBeNull();
  });

  it("never prunes a status:running envelope with a live pid, even if old", async () => {
    const { pruneOldEnvelopes } = await import("./diskRunEnvelope.js");
    const live = makeEnvelope({ sessionId: "sess-live", status: "running", pid: process.pid });
    const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await writeEnvelopeAt(live, oldIso);

    const result = await pruneOldEnvelopes();
    expect(result.removed).toBe(0);
    expect(await loadRunEnvelope("sess-live")).not.toBeNull();
  });

  it("prunes down to maxCount, oldest first, when over the count cap", async () => {
    const { pruneOldEnvelopes } = await import("./diskRunEnvelope.js");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const env = makeEnvelope({ sessionId: `sess-${i}` });
      const iso = new Date(now - i * 60 * 1000).toISOString(); // sess-0 newest, sess-4 oldest
      await writeEnvelopeAt(env, iso);
    }

    const result = await pruneOldEnvelopes({ maxAgeDays: 30, maxCount: 3 });
    expect(result.removed).toBe(2);
    expect(await loadRunEnvelope("sess-4")).toBeNull();
    expect(await loadRunEnvelope("sess-3")).toBeNull();
    expect(await loadRunEnvelope("sess-0")).not.toBeNull();
  });

  it("marker throttle: a second call within 24h is a no-op (ran:false)", async () => {
    const { maybeCleanupOldEnvelopes } = await import("./diskRunEnvelope.js");
    const old = makeEnvelope({ sessionId: "sess-old" });
    const oldIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await writeEnvelopeAt(old, oldIso);

    const first = await maybeCleanupOldEnvelopes();
    expect(first.ran).toBe(true);
    expect(first.removed).toBe(1);

    // Re-seed another stale envelope; throttle should suppress the second sweep.
    const old2 = makeEnvelope({ sessionId: "sess-old2" });
    await writeEnvelopeAt(old2, oldIso);
    const second = await maybeCleanupOldEnvelopes();
    expect(second.ran).toBe(false);
    expect(second.removed).toBe(0);
    expect(await loadRunEnvelope("sess-old2")).not.toBeNull();
  });

  it("marker not enumerated by listResumableEnvelopes or resolveEnvelopeId", async () => {
    const { maybeCleanupOldEnvelopes } = await import("./diskRunEnvelope.js");
    await saveRunEnvelope(makeEnvelope({ sessionId: "sess-live2" }));
    await maybeCleanupOldEnvelopes();
    const list = await listResumableEnvelopes();
    expect(list.some(e => (e as unknown as { file?: string }).file === ".envelope-last-cleanup")).toBe(false);
    expect(await resolveEnvelopeId(".envelope-last-cleanup")).toBeNull();
  });
});

// ---- Stamp ------------------------------------------------------------------

describe("stampEnvelopeStatus", () => {
  it("updates status and flushedPaths", async () => {
    const env = makeEnvelope({ status: "running", pid: process.pid });
    await saveRunEnvelope(env);
    await stampEnvelopeStatus(env.sessionId, "max_iterations", ["/repo/foo.ts"]);
    const loaded = await loadRunEnvelope(env.sessionId);
    expect(loaded?.status).toBe("max_iterations");
    expect(loaded?.flushedPaths).toEqual(["/repo/foo.ts"]);
  });

  it("is a no-op if the envelope does not exist", async () => {
    await expect(stampEnvelopeStatus("ghost", "unknown", [])).resolves.toBeUndefined();
  });
});

// ---- PID liveness + listResumableEnvelopes ----------------------------------

describe("listResumableEnvelopes — PID liveness", () => {
  it("excludes status:running with a live PID (run in progress)", async () => {
    const env = makeEnvelope({ status: "running", pid: process.pid });
    await saveRunEnvelope(env);
    const list = await listResumableEnvelopes();
    expect(list.map(e => e.sessionId)).not.toContain(env.sessionId);
  });

  it("includes status:running with a dead PID (hard-killed)", async () => {
    const env = makeEnvelope({ status: "running", pid: DEAD_PID });
    await saveRunEnvelope(env);
    const list = await listResumableEnvelopes();
    expect(list.map(e => e.sessionId)).toContain(env.sessionId);
  });

  it("includes stamped non-natural exits regardless of PID", async () => {
    const env = makeEnvelope({ status: "token_budget_exceeded", pid: process.pid });
    await saveRunEnvelope(env);
    const list = await listResumableEnvelopes();
    expect(list.map(e => e.sessionId)).toContain(env.sessionId);
  });

  it("returns newest first (by updatedAt)", async () => {
    const older = makeEnvelope({ sessionId: "sess-old" });
    await saveRunEnvelope(older);
    await new Promise(r => setTimeout(r, 15));
    const newer = makeEnvelope({ sessionId: "sess-new" });
    await saveRunEnvelope(newer);
    const list = await listResumableEnvelopes();
    const ids = list.map(e => e.sessionId);
    expect(ids.indexOf("sess-new")).toBeLessThan(ids.indexOf("sess-old"));
  });

  it("filters by repoPath when provided", async () => {
    const e1 = makeEnvelope({ sessionId: "sess-a", repoPath: "/repo-a" });
    const e2 = makeEnvelope({ sessionId: "sess-b", repoPath: "/repo-b" });
    await saveRunEnvelope(e1);
    await saveRunEnvelope(e2);
    const list = await listResumableEnvelopes("/repo-a");
    expect(list.map(e => e.sessionId)).toEqual(["sess-a"]);
  });

  it("returns empty array when directory does not exist", async () => {
    _setEnvelopeDirForTest(join(tmp, "nonexistent"));
    expect(await listResumableEnvelopes()).toEqual([]);
  });

  it("skips corrupt envelope files without throwing", async () => {
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "bad-id.envelope.json"), "not json");
    const good = makeEnvelope();
    await saveRunEnvelope(good);
    const list = await listResumableEnvelopes();
    expect(list.map(e => e.sessionId)).toContain(good.sessionId);
  });
});

// ---- latestResumableEnvelope ------------------------------------------------

describe("latestResumableEnvelope", () => {
  it("returns the most recent resumable envelope for the repo", async () => {
    const e1 = makeEnvelope({ sessionId: "sess-1", repoPath: "/r" });
    await saveRunEnvelope(e1);
    await new Promise(r => setTimeout(r, 15));
    const e2 = makeEnvelope({ sessionId: "sess-2", repoPath: "/r" });
    await saveRunEnvelope(e2);
    const latest = await latestResumableEnvelope("/r");
    expect(latest?.sessionId).toBe("sess-2");
  });

  it("returns null when no resumable envelopes exist", async () => {
    expect(await latestResumableEnvelope("/r")).toBeNull();
  });
});

// ---- resolveEnvelopeId ------------------------------------------------------

describe("resolveEnvelopeId", () => {
  it("resolves exact session ID", async () => {
    await saveRunEnvelope(makeEnvelope({ sessionId: "full-uuid-1234" }));
    expect(await resolveEnvelopeId("full-uuid-1234")).toBe("full-uuid-1234");
  });

  it("resolves an 8-char prefix", async () => {
    await saveRunEnvelope(makeEnvelope({ sessionId: "abcd1234-rest-of-uuid" }));
    expect(await resolveEnvelopeId("abcd1234")).toBe("abcd1234-rest-of-uuid");
  });

  it("returns null for no match", async () => {
    expect(await resolveEnvelopeId("xxxxxxxx")).toBeNull();
  });

  it("returns null if directory does not exist", async () => {
    _setEnvelopeDirForTest(join(tmp, "nonexistent"));
    expect(await resolveEnvelopeId("anything")).toBeNull();
  });
});

// ---- Reconciliation ---------------------------------------------------------

describe("reconcileEnvelopeStaging", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
  });

  function makeEntry(relPath: string, baseContent: string | null, stagedContent: string) {
    const absPath = join(repoRoot, relPath);
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const baseHash = baseContent !== null ? createHash("sha256").update(baseContent).digest("hex") : "";
    if (baseContent !== null) {
      writeFileSync(absPath, baseContent, "utf-8");
    }
    return {
      path: relPath,
      absPath,
      baseHash,
      baseExisted: baseContent !== null,
      content: stagedContent,
    };
  }

  it("restores when base-hash matches (file unchanged)", () => {
    const entry = makeEntry("foo.ts", "original content", "staged content");
    const env = makeEnvelope({ staging: [entry] });
    const { restored, dropNotes } = reconcileEnvelopeStaging(env);
    expect(restored.get(entry.absPath)).toBe("staged content");
    expect(dropNotes).toHaveLength(0);
  });

  it("drops and notes when base-hash mismatches (file changed since interrupt)", () => {
    const absPath = join(repoRoot, "bar.ts");
    writeFileSync(absPath, "original content", "utf-8");
    const entry = makeEntry("bar.ts", "original content", "staged content");
    // Now change the file
    writeFileSync(absPath, "someone edited this!", "utf-8");
    const env = makeEnvelope({ staging: [entry] });
    const { restored, dropNotes } = reconcileEnvelopeStaging(env);
    expect(restored.has(entry.absPath)).toBe(false);
    expect(dropNotes[0]).toMatch(/bar\.ts.*changed/);
  });

  it("restores a new file (base did not exist, still absent)", () => {
    const absPath = join(repoRoot, "new.ts");
    const entry = { path: "new.ts", absPath, baseHash: "", baseExisted: false, content: "new file content" };
    const env = makeEnvelope({ staging: [entry] });
    const { restored, dropNotes } = reconcileEnvelopeStaging(env);
    expect(restored.get(absPath)).toBe("new file content");
    expect(dropNotes).toHaveLength(0);
  });

  it("drops when a new file now exists on disk", () => {
    const absPath = join(repoRoot, "created.ts");
    writeFileSync(absPath, "someone created this", "utf-8");
    const entry = { path: "created.ts", absPath, baseHash: "", baseExisted: false, content: "staged" };
    const env = makeEnvelope({ staging: [entry] });
    const { restored, dropNotes } = reconcileEnvelopeStaging(env);
    expect(restored.has(absPath)).toBe(false);
    expect(dropNotes[0]).toMatch(/created\.ts.*created/);
  });

  it("drops when a base file was deleted", () => {
    const absPath = join(repoRoot, "gone.ts");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const entry = {
      path: "gone.ts",
      absPath,
      baseHash: createHash("sha256").update("was here").digest("hex"),
      baseExisted: true,
      content: "staged",
    };
    // File does NOT exist on disk
    const env = makeEnvelope({ staging: [entry] });
    const { restored, dropNotes } = reconcileEnvelopeStaging(env);
    expect(restored.has(absPath)).toBe(false);
    expect(dropNotes[0]).toMatch(/gone\.ts.*deleted/);
  });

  it("suppresses drop-note for flushedPaths (R2)", () => {
    const absPath = join(repoRoot, "flushed.ts");
    writeFileSync(absPath, "was flushed to disk by persistStagingOnError", "utf-8");
    const entry = makeEntry("flushed.ts", "original", "staged");
    // Hash mismatch — but path is in flushedPaths
    const env = makeEnvelope({ staging: [entry], flushedPaths: [absPath] });
    const { dropNotes } = reconcileEnvelopeStaging(env);
    expect(dropNotes).toHaveLength(0);
  });

  it("suppresses drop-note for a repo-relative flushedPaths entry — the format production actually emits", () => {
    const entry = makeEntry("flushed2.ts", "original", "staged");
    // makeEntry writes baseContent to absPath internally — a write BEFORE calling it
    // (as R2, above, does) is silently clobbered by that internal write, so disk ends
    // up matching baseHash and reconcileEnvelopeStaging never reaches the flushedSet
    // check at all (found via mutation 1 passing when it shouldn't have — traced and
    // confirmed empirically, not assumed; R2 itself has the same latent issue,
    // recorded for the ledger, not fixed here). The write simulating a post-stage
    // flush must happen AFTER makeEntry, so it's what's actually on disk when
    // reconcileEnvelopeStaging reads it.
    writeFileSync(entry.absPath, "staged", "utf-8");
    // Hash mismatch — but the relative path is in flushedPaths, the format item 14's
    // filesStaged actually produces. repoPath must be the real tmpdir root, not
    // makeEnvelope's own "/repo" default, or resolve() has nothing real to match.
    const env = makeEnvelope({ repoPath: repoRoot, staging: [entry], flushedPaths: ["flushed2.ts"] });
    const { dropNotes } = reconcileEnvelopeStaging(env);
    expect(dropNotes).toHaveLength(0);
  });

  it("a flushedPaths entry for a different file does not suppress this file's own drop-note", () => {
    const entry = makeEntry("bar2.ts", "original content", "staged content");
    writeFileSync(entry.absPath, "someone edited this!", "utf-8");
    const env = makeEnvelope({ repoPath: repoRoot, staging: [entry], flushedPaths: ["other-file.ts"] });
    const { dropNotes } = reconcileEnvelopeStaging(env);
    expect(dropNotes).toHaveLength(1);
    expect(dropNotes[0]).toMatch(/bar2\.ts.*changed/);
  });
});

// ---- deriveCreatedPaths -----------------------------------------------------

describe("deriveCreatedPaths", () => {
  const repoPath = "/repo";

  it("returns filesModified entries absent from stagingFiles (new-file creates), repo-relative", () => {
    const filesModified = new Set(["src/new1.ts", "src/new2.ts", "src/edit1.ts"]);
    const stagingFiles = new Map<string, string>([[resolve(repoPath, "src/edit1.ts"), "edited"]]);
    const created = deriveCreatedPaths(filesModified, stagingFiles, repoPath);
    expect([...created].sort()).toEqual(["src/new1.ts", "src/new2.ts"]);
    expect(created).not.toContain("src/edit1.ts");
  });

  it("separates new-file creates (createdPaths) from staged edits (staging) — envelope snapshot shape", () => {
    // Mirrors buildEnvelopeSnapshot: new files a-e went direct-to-disk (filesModified
    // only); the index.ts edit went to stagingFiles (both). createdPaths must hold a-e
    // and NOT index.ts; staging holds index.ts and NOT a-e.
    const newFiles = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    const editFile = "src/index.ts";
    const filesModified = new Set([...newFiles, editFile]);
    const stagingFiles = new Map<string, string>([[resolve(repoPath, editFile), "// edited"]]);

    const created = deriveCreatedPaths(filesModified, stagingFiles, repoPath);
    expect([...created].sort()).toEqual([...newFiles].sort());
    expect(created).not.toContain(editFile);
    // staging side: only the edit is present, none of the new files.
    expect([...stagingFiles.keys()]).toEqual([resolve(repoPath, editFile)]);
    for (const nf of newFiles) {
      expect(stagingFiles.has(resolve(repoPath, nf))).toBe(false);
    }
  });

  it("returns [] when every written path is staged (no new-file creates)", () => {
    const filesModified = new Set(["src/x.ts"]);
    const stagingFiles = new Map<string, string>([[resolve(repoPath, "src/x.ts"), "staged"]]);
    expect(deriveCreatedPaths(filesModified, stagingFiles, repoPath)).toEqual([]);
  });

  it("handles absolute-form filesModified entries", () => {
    const filesModified = new Set([resolve(repoPath, "src/abs.ts")]);
    const stagingFiles = new Map<string, string>();
    expect(deriveCreatedPaths(filesModified, stagingFiles, repoPath)).toEqual(["src/abs.ts"]);
  });

  it("multi_edit'd files (in stagingFiles) are NOT classified as creates — no false resume note", () => {
    // Safety invariant: count>0 multi_edit files appear in BOTH filesModified (Part A fix)
    // AND stagingFiles (stagedWrite at toolExecutor.ts:3161). deriveCreatedPaths filters by
    // !stagingFiles.has(abs), so they are correctly excluded from createdPaths and the
    // envelope never emits a false "do NOT recreate: src/a.ts" note on resume.
    const filesModified = new Set(["src/a.ts", "src/b.ts"]);
    const stagingFiles = new Map<string, string>([
      [resolve(repoPath, "src/a.ts"), "// edited by multi_edit"],
      [resolve(repoPath, "src/b.ts"), "// edited by multi_edit"],
    ]);
    const created = deriveCreatedPaths(filesModified, stagingFiles, repoPath);
    expect(created).toEqual([]); // both are in stagingFiles → not creates
  });
});

// ---- buildResumeContextBlock ------------------------------------------------

describe("buildResumeContextBlock", () => {
  it("includes status and step info", () => {
    const env = makeEnvelope({
      status: "max_iterations",
      todos: [
        { id: "t1", text: "step one", status: "completed" },
        { id: "t2", text: "step two", status: "in_progress" },
        { id: "t3", text: "step three", status: "pending" },
      ],
    });
    const block = buildResumeContextBlock(env, []);
    expect(block).toContain("RESUMED RUN");
    expect(block).toContain("max_iterations");
    expect(block).toContain("step one");
    expect(block).toContain("step two");
    expect(block).toContain("fully restored");
  });

  it("includes drop notes when present", () => {
    const env = makeEnvelope();
    const block = buildResumeContextBlock(env, ["foo.ts: file changed since run was interrupted"]);
    expect(block).toContain("foo.ts");
    expect(block).toContain("conflicts");
  });

  it("lists createdPaths as already-created-on-disk (do NOT recreate)", () => {
    const env = makeEnvelope({ createdPaths: ["src/a.ts", "src/b.ts"] });
    const block = buildResumeContextBlock(env, []);
    expect(block).toContain("Already created on disk (do NOT recreate)");
    expect(block).toContain("src/a.ts");
    expect(block).toContain("src/b.ts");
  });

  it("omits the created-on-disk line when createdPaths is empty or absent", () => {
    const emptyEnv = makeEnvelope({ createdPaths: [] });
    expect(buildResumeContextBlock(emptyEnv, [])).not.toContain("Already created on disk");
    const absentEnv = makeEnvelope(); // pre-S10 envelope: no createdPaths field
    expect(buildResumeContextBlock(absentEnv, [])).not.toContain("Already created on disk");
  });
});

// ---- createCoalescingWriter -------------------------------------------------

describe("createCoalescingWriter", () => {
  it("calls saveFn on trigger", async () => {
    let count = 0;
    const writer = createCoalescingWriter(async () => { count++; });
    writer.trigger();
    await new Promise(r => setTimeout(r, 20));
    expect(count).toBe(1);
  });

  it("collapses concurrent triggers during an in-flight write", async () => {
    let count = 0;
    let resolve: (() => void) | null = null;

    const writer = createCoalescingWriter(() => {
      count++;
      return new Promise<void>(r => { resolve = r; });
    });

    // Start first write
    writer.trigger();
    await new Promise(r => setTimeout(r, 0)); // yield so run() starts
    // Trigger two more while first is in-flight — both should collapse to one dirty flag
    writer.trigger();
    writer.trigger();

    // Complete the first write
    resolve?.();
    await new Promise(r => setTimeout(r, 20)); // allow re-run to start and finish

    // Expect: 2 writes (first + one re-run), not 3
    expect(count).toBe(2);
  });

  it("forceFlush waits for in-flight write then does one final write", async () => {
    let count = 0;
    let resolve: (() => void) | null = null;

    const writer = createCoalescingWriter(() => {
      count++;
      if (count === 1) return new Promise<void>(r => { resolve = r; });
      return Promise.resolve();
    });

    writer.trigger();
    await new Promise(r => setTimeout(r, 0)); // yield so run() starts

    const flushPromise = writer.forceFlush();
    resolve?.(); // complete the in-flight write
    await flushPromise;

    expect(count).toBe(2); // first write + forceFlush write
  });

  it("swallows errors (best-effort)", async () => {
    const writer = createCoalescingWriter(async () => { throw new Error("disk full"); });
    writer.trigger();
    await new Promise(r => setTimeout(r, 20));
    // No unhandled rejection
  });

  it("drain waits for a write that was queued behind another", async () => {
    // run() re-assigns inFlightPromise to a fresh run() when it finishes dirty,
    // so awaiting it ONCE returns while the follow-up write is still outstanding.
    // That is the whole difference between drain and a bare await, and it is what
    // decides whether stampEnvelopeStatus is really the last write of a run.
    const gates: Array<() => void> = [];
    const finished: number[] = [];
    const writer = createCoalescingWriter(() => {
      const n = gates.length + 1;
      return new Promise<void>((r) => {
        gates.push(() => { finished.push(n); r(); });
      });
    });

    writer.trigger();                              // write 1 starts
    await new Promise(r => setTimeout(r, 10));
    writer.trigger();                              // dirty ⇒ write 2 follows

    let drainResolved = false;
    const drained = writer.drain().then(() => { drainResolved = true; });

    gates[0]!();                                   // write 1 completes, write 2 begins
    await new Promise(r => setTimeout(r, 10));
    expect(drainResolved).toBe(false);             // ← `while` → `if` fails here

    gates[1]!();
    await drained;
    expect(drainResolved).toBe(true);
    expect(finished).toEqual([1, 2]);
  });
});

// ---- A queued write lands where it was queued for ---------------------------

describe("write-time vs enqueue-time directory resolution", () => {
  it("a queued write ignores a directory change made while it waited", async () => {
    // How the park-durability tests leaked envelopes into the real ~/.zone:
    // saveRunEnvelope resolved envelopesDir() when the queued write finally ran,
    // so a checkpoint outliving afterEach's _setEnvelopeDirForTest(null) wrote to
    // the user's home directory instead of the tmpdir it was queued for.
    const boundDir = currentEnvelopesDir();
    let release: (() => void) | undefined;
    const writer = createCoalescingWriter(async () => {
      await new Promise<void>((r) => { release = r; });
      await saveRunEnvelope(makeEnvelope({ sessionId: "queued" }), { dir: boundDir });
    });

    writer.trigger();
    await new Promise(r => setTimeout(r, 10));

    const elsewhere = join(tmp, "elsewhere");
    _setEnvelopeDirForTest(elsewhere);              // the directory moves mid-flight
    release!();
    await writer.drain();

    expect(await readdir(boundDir)).toContain("queued.envelope.json");
    // Nothing was created at the new location: the write went where it was queued for.
    await expect(readdir(elsewhere)).rejects.toThrow();
  });
});

// ---- Migration: envelopes written before per-run keying ---------------------

describe("pre-cutover envelopes keyed by sessionId", () => {
  const LEGACY_SESSION = "legacy-1111-2222-3333-4444";

  /** Exactly what HEAD wrote: filename is the sessionId, and there is no runId. */
  async function writeLegacyFixture(): Promise<void> {
    mkdirSync(envDir, { recursive: true });
    const env = makeEnvelope({ sessionId: LEGACY_SESSION, task: "the old run" });
    delete (env as Partial<RunEnvelope>).runId;
    writeFileSync(join(envDir, `${LEGACY_SESSION}.envelope.json`), JSON.stringify(env), "utf-8");
  }

  it("stays loadable, listable and resumable under its own name", async () => {
    await writeLegacyFixture();

    const loaded = await loadRunEnvelope(LEGACY_SESSION);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBeUndefined();
    expect(loaded!.task).toBe("the old run");

    const listed = await listResumableEnvelopes("/repo");
    expect(listed).toHaveLength(1);
    // The key comes from the filename it was read from — never inferred.
    expect(listed[0]!.key).toBe(LEGACY_SESSION);

    // Re-saving keeps it where it is rather than migrating it out from under a
    // user who may have written the id down.
    await saveRunEnvelope(loaded!);
    expect(await readdir(envDir)).toContain(`${LEGACY_SESSION}.envelope.json`);
  });

  it("resolves by filename prefix and by sessionId prefix alike", async () => {
    await writeLegacyFixture();
    // Post-cutover envelope: filename is the runId, so its sessionId is NOT its
    // filename and only the content scan can find it.
    await saveRunEnvelope(makeEnvelope({
      sessionId: "newsess-aaaa-bbbb-cccc",
      runId: "newrun-dddd-eeee-ffff",
      task: "the new run",
    }));

    expect(await resolveEnvelopeId(LEGACY_SESSION)).toBe(LEGACY_SESSION);
    expect(await resolveEnvelopeId("legacy-1")).toBe(LEGACY_SESSION);
    expect(await resolveEnvelopeId("newrun-d")).toBe("newrun-dddd-eeee-ffff");
    // ← the migration guarantee: a sessionId the user already knows still works
    expect(await resolveEnvelopeId("newsess-")).toBe("newrun-dddd-eeee-ffff");
    expect(await resolveEnvelopeId("no-such-id")).toBeNull();
  });
});

// ---- Setting a suspended run aside ------------------------------------------

describe("dismissEnvelope", () => {
  const KEY = "run-set-aside";

  async function suspendedWithStaging(): Promise<void> {
    await saveRunEnvelope(makeEnvelope({
      sessionId: "sess-x", runId: KEY, repoPath: "/repo",
      status: "awaiting_user_input",
      pendingQuestion: { toolCallId: "t2", question: "Which module?", iter: 3 },
      staging: [{
        path: "src/a.ts", absPath: "/repo/src/a.ts", baseHash: "abc",
        baseExisted: true, content: "// edits that never reached the working tree",
      }],
    }));
  }

  it("preserves staged work that exists nowhere else", async () => {
    // flushRunCheckpoint writes the envelope BEFORE the wait, and
    // persistStagingOnError runs only on the graceful-abort branch — so a hard
    // kill during a park leaves the envelope as the sole copy of every
    // successful apply_patch. One keystroke must not destroy that.
    await suspendedWithStaging();
    await dismissEnvelope(KEY);

    const after = await loadRunEnvelope(KEY);
    expect(after, "the envelope was deleted rather than set aside").not.toBeNull();
    expect(after!.dismissedAt).toBeTruthy();
    expect(after!.staging[0]!.content).toContain("never reached the working tree");
    expect(after!.pendingQuestion?.question).toBe("Which module?");
  });

  it("stops being offered, but stays listed and reachable by key", async () => {
    await suspendedWithStaging();
    await dismissEnvelope(KEY);

    // Not offered: this is what silences the startup toast and a bare /resume.
    expect(await latestResumableEnvelope("/repo")).toBeNull();
    // Still listed, so "N set aside" can report it and --resume can load it.
    const listed = await listResumableEnvelopes("/repo");
    expect(listed.map(e => e.key)).toEqual([KEY]);
    expect(await resolveEnvelopeId(KEY)).toBe(KEY);
  });

  it("does not hide an envelope the user has not set aside", async () => {
    await suspendedWithStaging();
    await saveRunEnvelope(makeEnvelope({
      sessionId: "sess-y", runId: "run-still-live", repoPath: "/repo",
      updatedAt: "2026-07-28T23:00:00.000Z",
    }));
    await dismissEnvelope(KEY);
    expect((await latestResumableEnvelope("/repo"))?.key).toBe("run-still-live");
  });
});

// ---- A failed write is audible ----------------------------------------------

describe("saveRunEnvelope failure", () => {
  it("logs the path and the error, then rethrows", async () => {
    // Every caller swallows this — createCoalescingWriter's catch, forceFlush's
    // .catch — so without the log a full disk or a permission error loses the
    // envelope in total silence, and a parked envelope is sometimes the only copy
    // of staged work that never reached the working tree.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const blocked = join(tmp, "blocked");
      await writeFile(blocked, "a file where a directory needs to be", "utf-8");

      await expect(
        saveRunEnvelope(makeEnvelope(), { dir: join(blocked, "sessions") }),
      ).rejects.toThrow();

      const failures = logSpy.mock.calls.filter(c => c[0] === "[zone-envelope-write-failed]");
      expect(failures).toHaveLength(1);
      const payload = JSON.parse(String(failures[0]![1])) as { path: string; error: string };
      expect(payload.path).toContain("blocked");
      expect(payload.error).toMatch(/ENOTDIR|EEXIST|ENOENT|EACCES/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── Inc-1: messages field round-trip + back-compat ────────────────────────────

describe("Inc-1 resume: messages field in RunEnvelope", () => {
  it("A. round-trip: messages survives JSON serialization via save+load", async () => {
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
    const env = makeEnvelope({ messages: msgs });
    await saveRunEnvelope(env);
    const loaded = await loadRunEnvelope(env.sessionId);
    expect(loaded).not.toBeNull();
    expect(Array.isArray(loaded!.messages)).toBe(true);
    expect((loaded!.messages as { role: string }[])[0].role).toBe("system");
    expect((loaded!.messages as { role: string }[])[1].content).toBe("task");
  });

  it("C. back-compat: envelope without messages loads without error", async () => {
    const env = makeEnvelope({}); // messages field absent
    await saveRunEnvelope(env);
    const loaded = await loadRunEnvelope(env.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toBeUndefined();
    // Existing resume helpers must not throw when messages is absent
    const { restored, dropNotes } = reconcileEnvelopeStaging(loaded!);
    expect(restored.size).toBe(0);
    expect(() => buildResumeContextBlock(loaded!, dropNotes)).not.toThrow();
  });
});
