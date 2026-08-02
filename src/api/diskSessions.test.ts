import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import {
  saveSession, listSessions, loadSession, loadLastSession, loadSessionById,
  pruneOldSessions, listSessionsMeta, _setSessionsDirForTest, type DiskSession,
} from "./diskSessions.js";

const baseSession: DiskSession = {
  version: 1,
  sessionId: "test-id-000000000000",
  startedAt: "2026-05-24T10:00:00.000Z",
  lastActivityAt: "2026-05-24T10:30:00.000Z",
  cwd: "/test",
  model: "claude-sonnet-4-6",
  transcript: [{ kind: "user_prompt", text: "test task" }],
  totalCostUsd: 0.04,
  totalTokens: 4400,
  totalElapsedMs: 18934,
};

describe("diskSessions", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-sessions-"));
    _setSessionsDirForTest(join(tmp, ".zone", "sessions"));
  });
  afterEach(async () => {
    _setSessionsDirForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  it("saveSession + loadSession round-trips", async () => {
    const filename = await saveSession(tmp, baseSession);
    const loaded = await loadSession(tmp, filename);
    expect(loaded).toEqual(baseSession);
  });

  it("listSessions returns newest first", async () => {
    await saveSession(tmp, { ...baseSession, sessionId: "id-old", cwd: tmp });
    await new Promise(r => setTimeout(r, 15));
    await saveSession(tmp, { ...baseSession, sessionId: "id-new", cwd: tmp });
    const list = await listSessions(tmp);
    expect(list).toHaveLength(2);
    const first = await loadSession(tmp, list[0]);
    expect(first?.sessionId).toBe("id-new");
  });

  it("loadLastSession returns most recent", async () => {
    await saveSession(tmp, { ...baseSession, sessionId: "first", cwd: tmp });
    await new Promise(r => setTimeout(r, 15));
    await saveSession(tmp, { ...baseSession, sessionId: "second", cwd: tmp });
    expect((await loadLastSession(tmp))?.sessionId).toBe("second");
  });

  it("pruneOldSessions removes beyond keep limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveSession(tmp, { ...baseSession, sessionId: `id-${i}`, cwd: tmp });
      await new Promise(r => setTimeout(r, 10));
    }
    const removed = await pruneOldSessions(tmp, 3);
    expect(removed).toBe(2);
    expect(await listSessions(tmp)).toHaveLength(3);
  });

  it("loadLastSession returns null when no sessions", async () => {
    expect(await loadLastSession(tmp)).toBeNull();
  });

  describe("run envelopes share the directory but are not sessions", () => {
    /** Envelopes are `<sessionId>.envelope.json` — see diskRunEnvelope.ts. */
    async function writeEnvelopes(ids: string[]): Promise<void> {
      await mkdir(join(tmp, ".zone", "sessions"), { recursive: true });
      for (const id of ids) {
        await writeFile(
          join(tmp, ".zone", "sessions", `${id}.envelope.json`),
          JSON.stringify({ version: 1, sessionId: id, status: "running" }),
          "utf-8"
        );
      }
    }

    it("N transcripts and M envelopes with keep:N — everything survives", async () => {
      // The bug this pins: envelope filenames end in `.json`, so they matched the
      // session filter and were swept by the pruner. They also have no ISO prefix,
      // so they sorted by UUID — a leading hex digit decided whether a durable run
      // envelope or a real transcript got deleted.
      const N = 3;
      for (let i = 0; i < N; i++) {
        await saveSession(tmp, { ...baseSession, sessionId: `id-${i}`, cwd: tmp });
        await new Promise(r => setTimeout(r, 10));
      }
      // One sorting above the ISO transcripts, one below — the two failure modes.
      await writeEnvelopes(["e2e79f75-dead-4000-8000-000000000001", "0abc1234-dead-4000-8000-000000000002"]);

      const removed = await pruneOldSessions(tmp, N);

      expect(removed).toBe(0);
      expect(await listSessions(tmp)).toHaveLength(N);
      const remaining = await readdir(join(tmp, ".zone", "sessions"));
      expect(remaining.filter(f => f.endsWith(".envelope.json"))).toHaveLength(2);
    });

    it("listSessions excludes envelopes entirely", async () => {
      await saveSession(tmp, { ...baseSession, cwd: tmp });
      await writeEnvelopes(["e2e79f75-dead-4000-8000-000000000001"]);
      const list = await listSessions(tmp);
      expect(list).toHaveLength(1);
      expect(list.every(f => !f.includes("envelope"))).toBe(true);
    });

    it("loadLastSession never returns an envelope, whatever it sorts as", async () => {
      // "e2…" sorts above every "2026-…" transcript, so before the fix this was the
      // file --resume loaded — and it parses as JSON, so the failure was silent.
      await saveSession(tmp, { ...baseSession, cwd: tmp });
      await writeEnvelopes(["e2e79f75-dead-4000-8000-000000000001"]);
      const last = await loadLastSession(tmp);
      expect(last?.sessionId).toBe(baseSession.sessionId);
    });
  });

  describe("listSessionsMeta", () => {
    it("returns empty array when no sessions dir", async () => {
      expect(await listSessionsMeta(tmp)).toEqual([]);
    });

    it("returns SessionMeta for each session, newest first", async () => {
      const s1: DiskSession = {
        ...baseSession,
        cwd: tmp,
        sessionId: "id-older",
        transcript: [
          { kind: "user_prompt", text: "first task" },
          { kind: "user_prompt", text: "second task" },
        ],
        totalCostUsd: 0.02,
        model: "claude-haiku-4-5",
      };
      const s2: DiskSession = {
        ...baseSession,
        cwd: tmp,
        sessionId: "id-newer",
        transcript: [{ kind: "user_prompt", text: "newer task" }],
        totalCostUsd: 0.07,
        model: "claude-sonnet-4-6",
      };
      await saveSession(tmp, s1);
      await new Promise(r => setTimeout(r, 15));
      await saveSession(tmp, s2);

      const metas = await listSessionsMeta(tmp);
      expect(metas).toHaveLength(2);
      expect(metas[0].sessionId).toBe("id-newer");
      expect(metas[0].firstUserMessage).toBe("newer task");
      expect(metas[0].messageCount).toBe(1);
      expect(metas[0].totalCostUsd).toBe(0.07);
      expect(metas[1].sessionId).toBe("id-older");
      expect(metas[1].firstUserMessage).toBe("first task");
      expect(metas[1].messageCount).toBe(2);
    });

    it("skips corrupt files and returns valid entries", async () => {
      const dir = join(tmp, ".zone/sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "2026-01-01T00-00-00-000Z-corrupt.json"), "not json", "utf-8");
      await saveSession(tmp, { ...baseSession, sessionId: "id-valid", cwd: tmp });

      const metas = await listSessionsMeta(tmp);
      expect(metas).toHaveLength(1);
      expect(metas[0].sessionId).toBe("id-valid");
    });
  });

  describe("repo scoping", () => {
    it("listSessions returns only the querying repo's sessions", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "a-session", cwd: "/repo-a" });
      await saveSession(tmp, { ...baseSession, sessionId: "b-session", cwd: "/repo-b" });

      const list = await listSessions("/repo-a");
      expect(list).toHaveLength(1);
      const survivor = await loadSession(tmp, list[0]);
      expect(survivor?.sessionId).toBe("a-session");
    });

    it("loadLastSession from a repo with no sessions returns null, even when other repos have newer sessions", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "b-session", cwd: "/repo-b" });

      expect(await loadLastSession("/repo-a")).toBeNull();
    });

    it("loadLastSession returns the most recent within the repo — a newer foreign session does not shadow an older local one", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "a-session", cwd: "/repo-a" });
      await new Promise(r => setTimeout(r, 15));
      await saveSession(tmp, { ...baseSession, sessionId: "b-session", cwd: "/repo-b" });

      const last = await loadLastSession("/repo-a");
      expect(last?.sessionId).toBe("a-session");
    });

    it("pruneOldSessions stays global — a repo-scoped listing does not change eviction across repos", async () => {
      for (let i = 0; i < 2; i++) {
        await saveSession(tmp, { ...baseSession, sessionId: `a-${i}`, cwd: "/repo-a" });
        await new Promise(r => setTimeout(r, 10));
      }
      for (let i = 0; i < 2; i++) {
        await saveSession(tmp, { ...baseSession, sessionId: `b-${i}`, cwd: "/repo-b" });
        await new Promise(r => setTimeout(r, 10));
      }
      // 4 sessions total, none of either repo's own 2 exceeds keep:3 — only a global cap
      // sees anything to evict.
      const removed = await pruneOldSessions("/repo-a", 3);
      expect(removed).toBe(1);
    });

    it("a corrupt session file is skipped, not fatal, and the failure is logged", async () => {
      const dir = join(tmp, ".zone/sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "2026-01-01T00-00-00-000Z-corrupt.json"), "not json", "utf-8");
      await saveSession(tmp, { ...baseSession, sessionId: "id-valid", cwd: tmp });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const list = await listSessions(tmp);
      const survivor = await loadSession(tmp, list[0]);
      expect(survivor?.sessionId).toBe("id-valid");

      const call = logSpy.mock.calls.find((c) => c[0] === "[zone-session-load-failed]");
      expect(call?.[1]).toContain("2026-01-01T00-00-00-000Z-corrupt.json");
      logSpy.mockRestore();
    });
  });

  describe("lookup by id", () => {
    it("returns the session with an exact sessionId match", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "exact-match-id", cwd: tmp });
      const found = await loadSessionById(tmp, "exact-match-id");
      expect(found?.sessionId).toBe("exact-match-id");
    });

    it("returns the session matching a prefix, mirroring resolveEnvelopeId's startsWith rule", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "prefix-1234-full-id", cwd: tmp });
      const found = await loadSessionById(tmp, "prefix-1234");
      expect(found?.sessionId).toBe("prefix-1234-full-id");
    });

    it("returns null for an id that exists only in another repo", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "other-repo-session", cwd: "/repo-b" });
      const found = await loadSessionById("/repo-a", "other-repo-session");
      expect(found).toBeNull();
    });

    it("returns null on a miss rather than the most recent session — the defect this fixes", async () => {
      // The only session in the repo is therefore also the most recent one — a
      // `?? mostRecent`-shaped bug would return it here despite matching nothing.
      await saveSession(tmp, { ...baseSession, sessionId: "the-real-recent-session", cwd: tmp });
      const found = await loadSessionById(tmp, "nonexistent-id");
      expect(found).toBeNull();
    });

    it("resolves an ambiguous prefix to the newest match, not filesystem order", async () => {
      await saveSession(tmp, { ...baseSession, sessionId: "amb1234-older", cwd: tmp });
      await new Promise(r => setTimeout(r, 15));
      await saveSession(tmp, { ...baseSession, sessionId: "amb1234-newer", cwd: tmp });
      const found = await loadSessionById(tmp, "amb1234");
      expect(found?.sessionId).toBe("amb1234-newer");
    });
  });
});
