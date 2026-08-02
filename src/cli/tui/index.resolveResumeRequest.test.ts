/**
 * Tests for _resolveResumeRequest — what --resume <opts.resume> should load at startup — and
 * _composeResumeMessage, which reconciles its miss message against whether an envelope resume
 * was also found.
 *
 * _resolveResumeRequest is the session-lookup half of --resume (index.tsx:766-776), independent
 * of the envelope-resume half (durable run state, tested in index.resume.test.ts's
 * _runPromptImpl suite). Both halves run unconditionally whenever opts.resume is set — an
 * envelope hit does not skip the session lookup, since resumedSession independently drives the
 * displayed transcript (App.tsx's resumedTranscript) and the startup banner regardless of
 * envelope presence. _composeResumeMessage exists because a session-lookup miss must not claim
 * "starting fresh" when the envelope lookup then finds an interrupted run to resume anyway.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { saveSession, _setSessionsDirForTest, type DiskSession } from "../../api/diskSessions.js";
import { _resolveResumeRequest, _composeResumeMessage, RESUME_MISS_SUFFIX } from "./index.js";

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

  // The two functions are coupled by RESUME_MISS_SUFFIX: _composeResumeMessage only reworks a
  // miss message it recognizes. These pin the coupling from the producing side — a wording
  // change here that drifts from RESUME_MISS_SUFFIX fails one of these, not just the consuming
  // side's own mismatch-fallback test below.
  it("explicit-id miss message ends with the suffix _composeResumeMessage depends on", async () => {
    const result = await _resolveResumeRequest("nonexistent-id", tmp);

    expect(result.missMessage).toMatch(RESUME_MISS_SUFFIX);
  });

  it("bare-flag miss message ends with the suffix _composeResumeMessage depends on", async () => {
    const result = await _resolveResumeRequest(true, tmp);

    expect(result.missMessage).toMatch(RESUME_MISS_SUFFIX);
  });
});

describe("_composeResumeMessage", () => {
  it("session hit + envelope hit: no message", () => {
    expect(_composeResumeMessage(null, true)).toBeNull();
  });

  it("session hit + envelope miss: no message", () => {
    expect(_composeResumeMessage(null, false)).toBeNull();
  });

  it("session miss (id variant) + envelope miss: unchanged — the real starting-fresh case", () => {
    const missMsg = "No session matching 'abc123' found in this directory; starting fresh.";

    expect(_composeResumeMessage(missMsg, false)).toBe(missMsg);
  });

  it("session miss (id variant) + envelope hit: reworded, id preserved", () => {
    const missMsg = "No session matching 'abc123' found in this directory; starting fresh.";

    expect(_composeResumeMessage(missMsg, true)).toBe(
      "No session matching 'abc123' found in this directory, but an interrupted run was found and is resuming."
    );
  });

  it("session miss (generic variant) + envelope hit: reworded, generic phrasing preserved", () => {
    const missMsg = "No prior session found in this directory; starting fresh.";

    expect(_composeResumeMessage(missMsg, true)).toBe(
      "No prior session found in this directory, but an interrupted run was found and is resuming."
    );
  });

  it("a message not ending in the expected suffix logs a marker and never claims starting fresh", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const driftedMsg = "No session matching 'ghost-id' found in this directory.";

    const result = _composeResumeMessage(driftedMsg, true);

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-resume-message-mismatch]");
    expect(call?.[1]).toContain("ghost-id");
    expect(result).not.toContain("starting fresh");
    logSpy.mockRestore();
  });
});
