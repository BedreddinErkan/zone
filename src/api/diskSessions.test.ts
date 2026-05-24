import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  saveSession, listSessions, loadSession, loadLastSession,
  pruneOldSessions, type DiskSession,
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
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "zone-sessions-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

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
});
