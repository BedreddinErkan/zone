import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  saveSession, listSessions, loadSession, loadLastSession,
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
    await saveSession(tmp, { ...baseSession, sessionId: "id-old" });
    await new Promise(r => setTimeout(r, 15));
    await saveSession(tmp, { ...baseSession, sessionId: "id-new" });
    const list = await listSessions(tmp);
    expect(list).toHaveLength(2);
    const first = await loadSession(tmp, list[0]);
    expect(first?.sessionId).toBe("id-new");
  });

  it("loadLastSession returns most recent", async () => {
    await saveSession(tmp, { ...baseSession, sessionId: "first" });
    await new Promise(r => setTimeout(r, 15));
    await saveSession(tmp, { ...baseSession, sessionId: "second" });
    expect((await loadLastSession(tmp))?.sessionId).toBe("second");
  });

  it("pruneOldSessions removes beyond keep limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveSession(tmp, { ...baseSession, sessionId: `id-${i}` });
      await new Promise(r => setTimeout(r, 10));
    }
    const removed = await pruneOldSessions(tmp, 3);
    expect(removed).toBe(2);
    expect(await listSessions(tmp)).toHaveLength(3);
  });

  it("loadLastSession returns null when no sessions", async () => {
    expect(await loadLastSession(tmp)).toBeNull();
  });

  describe("listSessionsMeta", () => {
    it("returns empty array when no sessions dir", async () => {
      expect(await listSessionsMeta(tmp)).toEqual([]);
    });

    it("returns SessionMeta for each session, newest first", async () => {
      const s1: DiskSession = {
        ...baseSession,
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
      await saveSession(tmp, { ...baseSession, sessionId: "id-valid" });

      const metas = await listSessionsMeta(tmp);
      expect(metas).toHaveLength(1);
      expect(metas[0].sessionId).toBe("id-valid");
    });
  });
});
