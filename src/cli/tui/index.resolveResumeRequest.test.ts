/**
 * Tests for the clean-exit tail's user-facing text: _resolveResumeRequest (what to load at
 * startup), _composeResumeMessage (reconciling its miss message against whether an envelope
 * resume was also found), _buildExitResumeHint (what to tell the user on the way out, so they
 * know a resumable session exists and what to type), and _reportSaveFailure (what to tell them
 * when it couldn't be saved at all). The file's own name now undersells its scope — it started
 * as tests for _resolveResumeRequest specifically — but all four are the same clean-exit-tail
 * lifecycle moment, not worth fragmenting into separate files for.
 *
 * _resolveResumeRequest is the session-lookup half of --resume (index.tsx:766-776), independent
 * of the envelope-resume half (durable run state, tested in index.resume.test.ts's
 * _runPromptImpl suite). Both halves run unconditionally whenever opts.resume is set — an
 * envelope hit does not skip the session lookup, since resumedSession independently drives the
 * displayed transcript (App.tsx's resumedTranscript) and the startup banner regardless of
 * envelope presence. _composeResumeMessage exists because a session-lookup miss must not claim
 * "starting fresh" when the envelope lookup then finds an interrupted run to resume anyway.
 * _buildExitResumeHint exists because the same principle applies leaving as arriving: a thrown
 * saveSession must not print a hint pointing at a session that doesn't exist on disk.
 * _reportSaveFailure exists because that same thrown saveSession was, until now, silently
 * swallowed — the user was told nothing at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { saveSession, _setSessionsDirForTest, type DiskSession } from "../../api/diskSessions.js";
import {
  _resolveResumeRequest, _composeResumeMessage, RESUME_MISS_SUFFIX,
  _buildExitResumeHint, _reportSaveFailure,
} from "./index.js";

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

describe("_buildExitResumeHint", () => {
  const id = "abcdef12-3456-7890-abcd-ef1234567890";

  it("saved, non-empty transcript: hint names the id prefix", () => {
    // Hardcoded, not derived from RESUME_HINT_ID_LENGTH: deriving the expectation from the same
    // constant the implementation reads would make a mutation to that constant's own value
    // invisible to this test — both sides would shift together.
    expect(_buildExitResumeHint(3, true, id)).toBe(
      "Resume this session with: zone --resume abcdef12"
    );
  });

  it("empty transcript, nothing saved: no hint", () => {
    expect(_buildExitResumeHint(0, false, id)).toBeNull();
  });

  it("the id prefix is exactly 8 characters, taken from the real id", () => {
    const hint = _buildExitResumeHint(1, true, id);

    expect(hint).toContain("abcdef12");
    expect(hint).not.toContain("abcdef12-3456");
  });

  it("save failed: no hint, even with a non-empty transcript", () => {
    // A non-empty transcript alone must never be read as "print the hint" — the write itself
    // has to have succeeded. Distinct from the empty-transcript case above: this one proves the
    // saved flag is checked independently, not inferred from transcript length.
    expect(_buildExitResumeHint(3, false, id)).toBeNull();
  });
});

function makeFsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("_reportSaveFailure", () => {
  it("write-phase failure: the marker carries the real error code", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = makeFsError("ENOSPC", "no space left on device");

    _reportSaveFailure(err, false, "session-abc", "write");

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-session-save-failed]");
    expect(JSON.parse(call?.[1] as string).code).toBe("ENOSPC");
    logSpy.mockRestore();
  });

  it("write-phase failure: the returned message says the save failed and won't resume", () => {
    // Hardcoded literal, not derived from SAVE_FAILURE_CLAUSE: deriving the expectation from
    // the same constant the implementation reads would make a mutation to that constant's own
    // value invisible to this test — the exact lesson from f7cd3c2e's own mutation-2 stop-and-
    // report (see docs/deferred-work.md's "self-reference defeats a mutation test").
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = makeFsError("ENOSPC", "no space left on device");

    const message = _reportSaveFailure(err, false, "session-abc", "write");

    expect(message).toBe(
      "Could not save this session: no space left on device. It will not be available to resume."
    );
    logSpy.mockRestore();
  });

  it("write-phase failure: a non-Error throw is represented honestly, not coerced", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    _reportSaveFailure("disk gone", false, "session-abc", "write");

    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-session-save-failed]");
    const payload = JSON.parse(call?.[1] as string);
    expect(payload.isError).toBe(false);
    expect(payload.message).toBe("disk gone");
    logSpy.mockRestore();
  });

  it("saved=true (a prune-only failure): returns null and logs nothing", () => {
    // Item 24's prune decision, made testable: by the time pruneOldSessions runs, saved is
    // already true, so a caught error with saved=true can only be the prune failing — the
    // session itself is already safe on disk, and this stays deliberately silent.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = makeFsError("EACCES", "permission denied");

    const message = _reportSaveFailure(err, true, "session-abc", "write");

    expect(message).toBeNull();
    expect(logSpy.mock.calls.find((c) => c[0] === "[zone-session-save-failed]")).toBeUndefined();
    logSpy.mockRestore();
  });

  it("build-phase failure: distinct wording from write-phase, and the marker names the phase", () => {
    // buildDiskSession throwing (e.g. process.cwd() failing) means nothing was ever attempted
    // — "Could not save this session" would misreport that a write was tried and failed.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = new Error("ENOENT: no such file or directory, uv_cwd");

    const message = _reportSaveFailure(err, false, "session-abc", "build");

    expect(message).toBe(
      "Could not prepare this session to save: ENOENT: no such file or directory, uv_cwd. It will not be available to resume."
    );
    const call = logSpy.mock.calls.find((c) => c[0] === "[zone-session-save-failed]");
    expect(JSON.parse(call?.[1] as string).phase).toBe("build");
    logSpy.mockRestore();
  });
});
