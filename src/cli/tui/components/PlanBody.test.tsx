import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PlanBody, type PlanBodyProps } from "./PlanBody.js";

const BASE_PROPS: PlanBodyProps = {
  objective: "Add a widget to the dashboard",
  steps: [
    { title: "Create the widget component", description: "New file under components/", filesLikely: ["src/Widget.tsx"] },
  ],
  riskHints: [],
  scopeSummary: "",
};

describe("PlanBody — content rendering", () => {
  it("renders the objective and step titles", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(BASE_PROPS.objective);
    expect(frame).toContain("Create the widget component");
  });

  it("renders 'Summary:' and the scopeSummary text when present", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} scopeSummary="Touches only the dashboard module." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Summary:");
    expect(frame).toContain("Touches only the dashboard module.");
  });

  it("does not render 'Summary:' when scopeSummary is empty", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} scopeSummary="" />);
    expect(lastFrame() ?? "").not.toContain("Summary:");
  });

  it("renders 'Scope:' and the notes when scopeNotes is present", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} scopeNotes="Two of the requested files were already correct." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Scope:");
    expect(frame).toContain("Two of the requested files were already correct.");
  });

  it("does not render 'Scope:' when scopeNotes is absent", () => {
    expect(lastFrame_(BASE_PROPS)).not.toContain("Scope:");
  });

  it("renders 'No changes needed:' and the reason when noChangeReason is set", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} noChangeReason="Verified clean." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No changes needed:");
    expect(frame).toContain("Verified clean.");
  });

  it("renders 'Could not verify:' and the reason when cannotVerifyReason is set", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} cannotVerifyReason="Reproduce command was blocked." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Could not verify:");
    expect(frame).toContain("Reproduce command was blocked.");
  });

  it("renders 'Answering read-only:' and the reason when answerOnlyReason is set", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} answerOnlyReason="The task is a question; nothing needs to change." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Answering read-only:");
    expect(frame).toContain("The task is a question; nothing needs to change.");
  });

  it("renders neither reason label on a normal multi-step plan", () => {
    const frame = lastFrame_(BASE_PROPS);
    expect(frame).not.toContain("No changes needed:");
    expect(frame).not.toContain("Could not verify:");
    expect(frame).not.toContain("Answering read-only:");
  });

  it('renders "Ready to answer?" instead of "Ready to code?" when answerOnlyReason is set', () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} answerOnlyReason="Nothing to change." />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to answer?");
    expect(frame).not.toContain("Ready to code?");
  });

  it('renders "Ready to code?" unchanged for a normal plan', () => {
    const frame = lastFrame_(BASE_PROPS);
    expect(frame).toContain("Ready to code?");
  });

  it("does not render 'Risks:' when riskHints is empty", () => {
    expect(lastFrame_(BASE_PROPS)).not.toContain("Risks:");
  });
});

describe("PlanBody — title reflects which of four shapes the plan carries", () => {
  const ALL_TITLES = ["Ready to code?", "Ready to answer?", "Nothing to change?", "Could not verify?"];

  it('renders "Nothing to change?" for noChangeReason, not any of the other three titles', () => {
    const frame = lastFrame_({ ...BASE_PROPS, steps: [], noChangeReason: "Verified clean." });
    expect(frame).toContain("Nothing to change?");
    expect(frame).not.toContain("Ready to code?");
    expect(frame).not.toContain("Ready to answer?");
    expect(frame).not.toContain("Could not verify?");
  });

  it('renders "Could not verify?" for cannotVerifyReason, not any of the other three titles', () => {
    const frame = lastFrame_({ ...BASE_PROPS, steps: [], cannotVerifyReason: "Reproduce command was blocked." });
    expect(frame).toContain("Could not verify?");
    expect(frame).not.toContain("Ready to code?");
    expect(frame).not.toContain("Ready to answer?");
    expect(frame).not.toContain("Nothing to change?");
  });

  it('renders "Ready to answer?" for answerOnlyReason, not either of the two newly-added titles', () => {
    const frame = lastFrame_({ ...BASE_PROPS, steps: [], answerOnlyReason: "The task is a question; nothing needs to change." });
    expect(frame).toContain("Ready to answer?");
    expect(frame).not.toContain("Ready to code?");
    expect(frame).not.toContain("Nothing to change?");
    expect(frame).not.toContain("Could not verify?");
  });

  it("maps each of the four plan shapes to the exact title it should carry, not merely a distinct one", () => {
    const shapes: Array<{ name: string; props: PlanBodyProps; expectedTitle: string }> = [
      { name: "patch", props: BASE_PROPS, expectedTitle: "Ready to code?" },
      { name: "answer-only", props: { ...BASE_PROPS, steps: [], answerOnlyReason: "Nothing needs to change." }, expectedTitle: "Ready to answer?" },
      { name: "no-change", props: { ...BASE_PROPS, steps: [], noChangeReason: "Verified clean." }, expectedTitle: "Nothing to change?" },
      { name: "cannot-verify", props: { ...BASE_PROPS, steps: [], cannotVerifyReason: "Reproduce command was blocked." }, expectedTitle: "Could not verify?" },
    ];
    // A set-based check ("are there four distinct titles among the four frames?") would
    // pass under a mutation that assigns the right titles to the wrong fixtures — this
    // asserts the fixture -> title MAPPING, in one expect, so a permutation fails it too.
    const actual = shapes.map(({ name, props }) => {
      const frame = lastFrame_(props);
      const found = ALL_TITLES.filter((t) => frame.includes(t));
      return { name, title: found.length === 1 ? found[0] : found };
    });
    expect(actual).toEqual(shapes.map(({ name, expectedTitle }) => ({ name, title: expectedTitle })));
  });

  // The schema guarantees at most one reason field is ever set on a generated plan, but
  // that guarantee is enforced only at parse time. PlanBodyProps has no such constraint —
  // three independent optional strings — and a resumed session's transcript is a bare
  // `JSON.parse(...) as DiskSession`, never re-validated against the schema. So this shape
  // is reachable in practice, not just in the type system, and what the title does about
  // it should be a known, tested fact rather than an accident of branch order.
  it("when noChangeReason and cannotVerifyReason are both set, the title follows the reason box's own first-match precedence", () => {
    const frame = lastFrame_({
      ...BASE_PROPS,
      steps: [],
      noChangeReason: "Verified clean.",
      cannotVerifyReason: "Reproduce command was blocked.",
    });
    expect(frame).toContain("Nothing to change?");
    expect(frame).not.toContain("Could not verify?");
    expect(frame).not.toContain("Ready to code?");
    expect(frame).not.toContain("Ready to answer?");
  });
});

// Regression guard for the caps this pass removes from the old bordered-modal
// rendering (SCOPE_SUMMARY_MAX=200, RISK_HINT_MAX=120, STEP_DESCRIPTION_MAX=48,
// all in PlanReadyModal.tsx, deleted with the file in Commit 2). PlanBody has no
// analogous caps at all — every field renders in full, however long.
//
// Fixtures are real prose, not "x".repeat(N) — a repeated-character run has no
// word boundaries and doesn't exercise wrapping the way real content does (the
// exact degenerate-fixture pattern flagged in .zone/audits/lessons.md this
// session). Assertions compare with whitespace collapsed on both sides: at
// ink-testing-library's terminal width, text this long word-wraps across
// multiple lines, and a wrap point replaces a space with a newline — a plain
// `toContain` would fail on where Ink chose to wrap, not on whether a
// character was actually dropped or an ellipsis appended. Collapsing
// whitespace makes the check invariant to wrap position while still failing
// on any real content loss or a "…" (checked separately, unaffected by
// whitespace collapsing since "…" is not whitespace).
//
// Whitespace alone stopped being sufficient once color entered the picture.
// Under a color-emitting environment (FORCE_COLOR set — chalk's own
// supports-color detection checks FORCE_COLOR unconditionally and never
// reads the NO_COLOR env var at all, only a `--no-color` CLI flag, so
// NO_COLOR alone does not suppress an already-set FORCE_COLOR), Ink re-emits
// styling codes at a wrap point, not just a newline — a real character
// dropped mid-word here would slip past a whitespace-only compare too, since
// the fixture's own word boundary is what's supposed to catch it, and a
// styling code landing in the middle of that boundary defeats it by
// coincidence, not by design. normalizeFrame strips those codes first. Do
// not remove stripAnsi as redundant with collapseWhitespace: they normalize
// two different, unrelated things Ink inserts at the same wrap point, and
// only one of them is whitespace.
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

// Same construction as applyRollbackFeedback.ts's own stripAnsi (J.4.1): built
// from String.fromCharCode(0x1b) rather than a literal control character so
// this source file stays free of raw control bytes some editors/tooling
// normalize away. Not imported from the `strip-ansi` package — that package
// is not a direct dependency of this repo (absent from package.json); it is
// pulled in only transitively, by ink-gradient and by ink's own
// string-width/wrap-ansi, so importing it here would add an undeclared
// dependency this repo has already, deliberately, avoided once.
function stripAnsi(s: string): string {
  const esc = String.fromCharCode(0x1b);
  const ansiPattern = new RegExp(esc + "\\[[0-9;]*[A-Za-z]", "g");
  return s.replace(ansiPattern, "");
}

function normalizeFrame(s: string): string {
  return collapseWhitespace(stripAnsi(s));
}

describe("PlanBody — full-render regression guard (no caps)", () => {
  it("renders a step description over 48 chars in full, no trailing ellipsis", () => {
    const longDescription =
      "This description intentionally runs past the old forty-eight character truncation cap by a wide margin.";
    expect(longDescription.length).toBeGreaterThan(48);
    const { lastFrame } = render(
      <PlanBody {...BASE_PROPS} steps={[{ title: "Step", description: longDescription, filesLikely: [] }]} />
    );
    const frame = lastFrame() ?? "";
    expect(normalizeFrame(frame)).toContain(normalizeFrame(longDescription));
    expect(frame).not.toContain("…");
  });

  it("renders a riskHint over 120 chars in full, no trailing ellipsis", () => {
    const longHint =
      "This risk hint intentionally runs well past the old one-hundred-twenty character truncation cap " +
      "so the completeness guard has something real to check against, in ordinary prose with real words.";
    expect(longHint.length).toBeGreaterThan(120);
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} riskHints={[longHint]} />);
    const frame = lastFrame() ?? "";
    expect(normalizeFrame(frame)).toContain(normalizeFrame(longHint));
    expect(frame).not.toContain("…");
  });

  it("renders a scopeSummary over 200 chars in full, no trailing ellipsis", () => {
    const longSummary =
      "This plan touches several unrelated-looking files because the dashboard widget shares a layout " +
      "helper with the settings page, and that helper is what actually needs the new configuration option " +
      "threaded through it before the widget itself can read a real value.";
    expect(longSummary.length).toBeGreaterThan(200);
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} scopeSummary={longSummary} />);
    const frame = lastFrame() ?? "";
    expect(normalizeFrame(frame)).toContain(normalizeFrame(longSummary));
    expect(frame).not.toContain("…");
  });
});

describe("PlanBody — narrative (D3)", () => {
  it("renders the narrative through MarkdownText, not the fixed objective/steps layout, when present", () => {
    const { lastFrame } = render(
      <PlanBody {...BASE_PROPS} narrative={"## Fix the guard\n\nOne targeted change."} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Fix the guard");
    expect(frame).toContain("One targeted change.");
    // The fixed layout's own labels must not also appear — this is a REPLACEMENT, not an addition.
    expect(frame).not.toContain("Objective:");
    expect(frame).not.toContain(BASE_PROPS.objective);
  });

  it("renders the fixed objective/steps/riskHints/scopeNotes layout, unchanged, when narrative is absent", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} scopeSummary="s" scopeNotes="n" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Objective:");
    expect(frame).toContain(BASE_PROPS.objective);
  });

  it("renders a 'Files:' line under the narrative when plan-level filesLikely is populated", () => {
    const { lastFrame } = render(
      <PlanBody {...BASE_PROPS} narrative="Do the thing." filesLikely={["src/a.ts", "src/b.ts"]} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Files:");
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("src/b.ts");
  });

  it("renders no 'Files:' line when narrative is present but filesLikely is absent", () => {
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} narrative="Do the thing." />);
    expect(lastFrame() ?? "").not.toContain("Files:");
  });

  it("still shows the terminal-shape reason banner alongside a narrative (orthogonal, not replaced)", () => {
    const { lastFrame } = render(
      <PlanBody {...BASE_PROPS} steps={[]} narrative="Investigated; nothing to change." answerOnlyReason="Behavior is correct." />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to answer?");
    expect(frame).toContain("Answering read-only:");
    expect(frame).toContain("Behavior is correct.");
    expect(frame).toContain("Investigated; nothing to change.");
  });
});

function lastFrame_(props: PlanBodyProps): string {
  return render(<PlanBody {...props} />).lastFrame() ?? "";
}
