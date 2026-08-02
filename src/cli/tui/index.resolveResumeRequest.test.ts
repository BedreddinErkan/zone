/**
 * Tests for _resolveResumeRequest — what --resume <opts.resume> should load at startup.
 *
 * This is the session-lookup half of --resume (index.tsx:766-776), independent of the
 * envelope-resume half (durable run state, tested in index.resume.test.ts's _runPromptImpl
 * suite). Both halves run unconditionally whenever opts.resume is set — an envelope hit does
 * not skip this one, since resumedSession independently drives the displayed transcript
 * (App.tsx's resumedTranscript) and the startup banner regardless of envelope presence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { saveSession, _setSessionsDirForTest, type DiskSession } from "../../api/diskSessions.js";
import { _resolveResumeRequest } from "./index.js";

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

describe("_resolveResumeRequest", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-resolve-resume-"));
    _setSessionsDirForTest(join(tmp, ".zone", "sessions"));
  });
  afterEach(async () => {
    _setSessionsDirForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  it("string id, hit: returns the matching session and no miss message", async () => {
    await saveSession(tmp, { ...baseSession, sessionId: "wanted-session", cwd: tmp });

    const result = await _resolveResumeRequest("wanted-session", tmp);

    expect(result.session?.sessionId).toBe("wanted-session");
    expect(result.missMessage).toBeNull();
  });

  it("string id, miss: returns null and names the id, even with a more recent session present", async () => {
    // A more-recent, real, resumable session exists in the same repo — a `?? mostRecent`
    // fallback would return it. This proves the glue itself doesn't reintroduce that path.
    await saveSession(tmp, { ...baseSession, sessionId: "unrelated-recent-session", cwd: tmp });

    const result = await _resolveResumeRequest("nonexistent-id", tmp);

    expect(result.session).toBeNull();
    expect(result.missMessage).toContain("nonexistent-id");
  });

  it("bare true: unchanged regression-locked behavior — returns the most recent session", async () => {
    await saveSession(tmp, { ...baseSession, sessionId: "older", cwd: tmp });
    await new Promise(r => setTimeout(r, 15));
    await saveSession(tmp, { ...baseSession, sessionId: "newer", cwd: tmp });

    const result = await _resolveResumeRequest(true, tmp);

    expect(result.session?.sessionId).toBe("newer");
  });
});
