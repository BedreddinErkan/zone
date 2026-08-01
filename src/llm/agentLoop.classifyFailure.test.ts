/**
 * CE.4.1.e: direct unit tests for classifyFailure and buildCoachingPrompt.
 * Both functions are pure (no I/O) and exported — no mock infrastructure needed.
 */

import { describe, it, expect } from "vitest";
import { classifyFailure, buildCoachingPrompt } from "./agentLoop.js";

const ENOENT_MSG = "ENOENT: no such file or directory, open '/repo/src/missing.ts'";

describe("classifyFailure — read_file_nonexistent trigger (CE.4.1.e)", () => {
  it("fires read_file_nonexistent for read_file + ENOENT output", () => {
    expect(classifyFailure("read_file", ENOENT_MSG, ENOENT_MSG)).toBe("read_file_nonexistent");
  });

  it("does NOT fire for read_file + EACCES (permission denied — different issue)", () => {
    const eacces = "EACCES: permission denied, open '/repo/restricted.ts'";
    expect(classifyFailure("read_file", eacces, eacces)).toBe("unknown");
  });

  it("does NOT return tool_path_enoent for read_file ENOENT (new trigger intercepts first)", () => {
    expect(classifyFailure("read_file", ENOENT_MSG, ENOENT_MSG)).not.toBe("tool_path_enoent");
  });

  it("still fires tool_path_enoent for write_file ENOENT (existing behavior preserved)", () => {
    expect(classifyFailure("write_file", ENOENT_MSG, ENOENT_MSG)).toBe("tool_path_enoent");
  });

  it("still fires tool_path_enoent for apply_patch ENOENT on the target path (not apply_patch subclass)", () => {
    // apply_patch with an ENOENT that doesn't match any apply_patch-specific pattern falls through
    expect(classifyFailure("apply_patch", ENOENT_MSG, ENOENT_MSG)).toBe("tool_path_enoent");
  });
});

describe("buildCoachingPrompt — read_file_nonexistent (CE.4.1.e)", () => {
  it("returns noop-read directive, not path-construction advice", () => {
    const text = buildCoachingPrompt("read_file_nonexistent", "", []);
    expect(text).toContain("does not exist");
    expect(text).toMatch(/NOT.*investigation|do not.*investigat/i);
    expect(text).toMatch(/FINAL SUMMARY|exit/i);
  });
});

describe("buildCoachingPrompt — apply_patch_marker_imbalance", () => {
  it("states the generic mismatch, not a specific false direction", () => {
    // Zone cannot see which direction the imbalance ran from this call site (errorPreview
    // carries the real counts only as prose inside result.output, not as structured data —
    // see toolExecutor.ts:1823). A specific "WRONG (one FIND, two REPLACE)" example is false
    // whenever the real submission ran the other direction; the fix is a true generic claim,
    // not a corrected specific one.
    const text = buildCoachingPrompt("apply_patch_marker_imbalance", "", []);
    expect(text).not.toContain("one FIND, two REPLACE - what you submitted");
    expect(text).toContain("did not match");
  });
});
