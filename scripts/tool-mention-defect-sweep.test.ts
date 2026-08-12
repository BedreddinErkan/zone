import { describe, expect, it } from "vitest";
import {
  maskedLine,
  splitSentences,
  classifySentence,
  assertPlaceholderSane,
} from "./tool-mention-defect-sweep.mjs";

describe("maskedLine", () => {
  it("finds a single tool name mentioned in a line", () => {
    expect(maskedLine("use apply_patch to fix it")).toEqual(["apply_patch"]);
  });

  it("returns an empty array when no tool is mentioned", () => {
    expect(maskedLine("read the error and decide what to do")).toEqual([]);
  });

  it("distinguishes run_command_readonly from run_command via longest-name-first masking", () => {
    const found = maskedLine("use run_command_readonly (e.g. ls -la) to answer the query", [
      "run_command_readonly",
      "run_command",
    ]);
    expect(found).toEqual(["run_command_readonly"]);
    expect(found).not.toContain("run_command");
  });

  it("finds multiple distinct tool names on one line", () => {
    const found = maskedLine("use apply_patch for EXISTING files; write_file ONLY for new files");
    expect(found.sort()).toEqual(["apply_patch", "write_file"]);
  });
});

describe("splitSentences", () => {
  it("returns a single-sentence line unchanged (one element)", () => {
    expect(splitSentences("- Send the COMPLETE list every call — it replaces the prior list.")).toEqual([
      "- Send the COMPLETE list every call — it replaces the prior list.",
    ]);
  });

  it("splits a two-sentence line into two, matching APPLY_ROLLED_BACK's own original shape", () => {
    // This exact shape (a prohibition sentence followed by an instruction sentence naming a
    // different tool, both on one rendered line) is what a whole-line classifier cannot
    // separate — the reason this script classifies sentences, not lines.
    const parts = splitSentences(
      "- Do NOT use shell commands to bypass. Re-investigate, then retry with apply_patch or Task (≥3-file edits)."
    );
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe("- Do NOT use shell commands to bypass.");
    expect(parts[1]).toBe("Re-investigate, then retry with apply_patch or Task (≥3-file edits).");
  });

  it("does not fragment a ratio/range inside a sentence", () => {
    const parts = splitSentences(
      "Iter counter: you have a finite iteration budget (typically 10-15). After ~70% of your budget, you should be patching not exploring."
    );
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("10-15");
  });
});

describe("classifySentence", () => {
  it("classifies a negation-led sentence as prohibition", () => {
    expect(classifySentence("- Do NOT use shell commands to bypass.")).toBe("prohibition");
  });

  it("classifies a directive sentence as instruction", () => {
    expect(classifySentence("Re-investigate, then retry with apply_patch or Task (≥3-file edits).")).toBe(
      "instruction"
    );
  });

  it("classifies a behavior-description sentence as incidental", () => {
    expect(
      classifySentence(
        'revert_patch({path: "<rel-path>"}) restores a file to its pre-run state without deleting other changes.'
      )
    ).toBe("incidental");
  });

  it("classifies the now-fixed VERIFICATION WARNINGS residual as instruction (confirms the classifier would have caught it pre-fix)", () => {
    expect(
      classifySentence(
        "- Options: (a) read error locations and patch to fix; (b) call revert_patch({path}) to undo specific files; (c) accept if errors are pre-existing or out-of-scope."
      )
    ).toBe("instruction");
  });

  it('classifies the now-fixed PRIOR RUN CONTEXT residual as instruction (confirms the classifier would have caught it pre-fix)', () => {
    expect(
      classifySentence(
        '- If the block contains "Suggested: ", apply that direction (coordinated multi-file edit via Task).'
      )
    ).toBe("instruction");
  });
});

describe("assertPlaceholderSane", () => {
  it("throws on an empty placeholder", () => {
    expect(() => assertPlaceholderSane("")).toThrow(/empty or missing/);
  });

  it("throws on a non-string placeholder", () => {
    // @ts-expect-error deliberately wrong type, matching a config-typo failure mode
    expect(() => assertPlaceholderSane(undefined)).toThrow(/empty or missing/);
  });

  it('throws when the placeholder no longer contains the real "PLAN VISIBILITY (TodoWrite)" header', () => {
    expect(() => assertPlaceholderSane("some unrelated placeholder text")).toThrow(
      /no longer contains the real/
    );
  });

  it("returns true for a placeholder that is non-empty and carries the real header", () => {
    expect(assertPlaceholderSane("PLAN VISIBILITY (TodoWrite):\nanything after the header")).toBe(true);
  });
});
