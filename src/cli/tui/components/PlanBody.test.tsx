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

  it("renders neither reason label on a normal multi-step plan", () => {
    const frame = lastFrame_(BASE_PROPS);
    expect(frame).not.toContain("No changes needed:");
    expect(frame).not.toContain("Could not verify:");
  });

  it("does not render 'Risks:' when riskHints is empty", () => {
    expect(lastFrame_(BASE_PROPS)).not.toContain("Risks:");
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
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
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
    expect(collapseWhitespace(frame)).toContain(collapseWhitespace(longDescription));
    expect(frame).not.toContain("…");
  });

  it("renders a riskHint over 120 chars in full, no trailing ellipsis", () => {
    const longHint =
      "This risk hint intentionally runs well past the old one-hundred-twenty character truncation cap " +
      "so the completeness guard has something real to check against, in ordinary prose with real words.";
    expect(longHint.length).toBeGreaterThan(120);
    const { lastFrame } = render(<PlanBody {...BASE_PROPS} riskHints={[longHint]} />);
    const frame = lastFrame() ?? "";
    expect(collapseWhitespace(frame)).toContain(collapseWhitespace(longHint));
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
    expect(collapseWhitespace(frame)).toContain(collapseWhitespace(longSummary));
    expect(frame).not.toContain("…");
  });
});

function lastFrame_(props: PlanBodyProps): string {
  return render(<PlanBody {...props} />).lastFrame() ?? "";
}
