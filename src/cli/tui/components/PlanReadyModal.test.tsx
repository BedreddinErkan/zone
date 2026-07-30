import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { EventEmitter } from "node:events";
import React from "react";
import {
  PlanReadyModal,
  estimateWrappedLines,
  estimatePlanContentLines,
  walkTiers,
  firedTierNames,
  NO_CUTS,
} from "./PlanReadyModal.js";
import { StoreProvider } from "../store.js";
import type { StoreAction } from "../store.js";
import { Composer } from "./Composer.js";
import { StatusBar } from "./StatusBar.js";

const mockLog = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", () => ({ log: mockLog }));

/**
 * ink-testing-library hardcodes columns=100, which masks width-squeeze bugs.
 * `staticHarness.tsx:renderTranscriptAt` uses the same override-stdout
 * technique but is wired specifically to <Transcript />, which never calls
 * useInput — PlanReadyModal does, so a stdout-only mock isn't enough: Ink's
 * useInput calls stdin.setRawMode, and without it Ink catches the throw and
 * re-renders an error frame ("Raw mode is not supported…"), silently
 * replacing the real content. The stdin shape below is copied from
 * ink-testing-library's own internal mock (node_modules/ink-testing-library/
 * build/index.js) — the minimum Ink's input handling requires.
 */
class MockStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

function renderPlanReadyModalAt(
  proposal: React.ComponentProps<typeof PlanReadyModal>["proposal"],
  dispatch: (action: StoreAction) => void,
  columns: number,
): { lastFrame: () => string | undefined; unmount: () => void } {
  let lastFrame: string | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 40,
    isTTY: false, // deliberate, not absence: this harness wants the budget mechanism OFF
                  // (NO_CUTS always) for its ~33 callers — see makeTtyStdoutMock below for
                  // the one place a TTY stdout gets built instead.
    write: (frame: string) => { lastFrame = frame; return true; },
  });
  const instance = inkRender(
    <PlanReadyModal proposal={proposal} dispatch={dispatch} />,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdout: stdout as any, stdin: new MockStdin() as any, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return {
    lastFrame: () => lastFrame,
    unmount: () => instance.unmount(),
  };
}

// A bare private-mode set/reset sequence with nothing else — e.g. Ink's own
// bracketed-paste-mode toggle ("\x1b[?2004h"/"...l", written directly via
// stdout.write from a usePaste effect, bypassing Ink's render/reconciler
// entirely). Only fires once `stdout.isTTY` is true (gated on stdin.isTTY
// *and* stdout.isTTY together), which renderPlanReadyModalAt never sets —
// this harness does, to activate the budget path, so it must filter these
// out or the "last write wins" capture below would clobber real frame
// content with a bare escape code and nothing else.
const MODE_TOGGLE_ONLY_RE = /^\x1b\[\?\d+[hl]$/;

// Shared, module-level: measured (not guessed) values pin 1/pin 4 confirm
// directly — used by the acceptance grid below so it can't silently drift
// from what those pins actually found.
const FRAME_CHROME_LINES = 9;
const FOOTER_LINES_NORMAL = 3; // conservative: the narrower (60-col) footer height
const SIBLING_LINES = 5;

// Height-budget variant of the harness above — same isTTY+columns mock, but
// `rows` is a parameter instead of hardcoded 40, since the budget mechanism
// reads stdout.rows directly. Kept separate from renderPlanReadyModalAt
// (which stays untouched, columns-only) rather than adding a rows param to
// it, per house convention.
/**
 * The only way a test gets a stdout mock with the budget path active —
 * isTTY:true is baked into the return value here, not a per-call-site object
 * literal a future test could copy-paste without it. That exact omission is
 * what silently disabled the budget mechanism earlier this session: isTTY
 * missing => stdout?.isTTY falsy => contentBudget stays undefined => cutState
 * stays NO_CUTS => every assertion that only checks for an absence still
 * passes. See renderPlanReadyModalAt above for the sibling harness that
 * wants the mechanism off — it now states that explicitly instead.
 */
function makeTtyStdoutMock(
  columns: number,
  rows: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { stdout: any; getLastFrame: () => string | undefined } {
  let lastFrame: string | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true as const,
    write: (frame: string) => {
      if (!MODE_TOGGLE_ONLY_RE.test(frame)) lastFrame = frame;
      return true;
    },
  });
  return { stdout, getLastFrame: () => lastFrame };
}

function renderPlanReadyModalAtRows(
  proposal: React.ComponentProps<typeof PlanReadyModal>["proposal"],
  dispatch: (action: StoreAction) => void,
  columns: number,
  rows: unknown,
): { lastFrame: () => string | undefined; rerender: () => void; unmount: () => void } {
  const { stdout, getLastFrame } = makeTtyStdoutMock(columns, rows);
  const element = <PlanReadyModal proposal={proposal} dispatch={dispatch} />;
  const instance = inkRender(
    element,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { stdout: stdout as any, stdin: new MockStdin() as any, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  return {
    lastFrame: getLastFrame,
    rerender: () => instance.rerender(element),
    unmount: () => instance.unmount(),
  };
}

const mockResolvePlanApproval = vi.hoisted(() => vi.fn().mockReturnValue({ ok: true }));

vi.mock("../../../llm/planApprovals.js", () => ({
  resolvePlanApproval: mockResolvePlanApproval,
}));

const PROPOSAL = {
  planId: "plan-modal-001",
  runId: "run-modal-001",
  objective: "Add a login feature",
  steps: [
    { title: "Add login route", description: "Create the route", filesLikely: ["src/routes/login.ts"] },
    { title: "Add tests", description: "Write tests", filesLikely: ["src/routes/login.test.ts"] },
  ],
  riskHints: [] as string[],
  scopeSummary: "Add a login feature end to end.",
};

/**
 * Ink renders this Box with borderStyle="double" + paddingX={2} and no explicit
 * width, so every line is right-padded to the widest line's width and framed
 * with a border char on both sides — a raw line NEVER literally ends with the
 * content's own last character. A long unbroken string also wraps across
 * multiple lines with no gap in the actual content (verified empirically: the
 * per-line border/padding strip below reconstructs the original contiguous
 * string exactly). Both helpers strip only the border char + its immediately
 * adjacent whitespace, never touching interior content.
 */
function stripBoxChars(line: string): string {
  return line.replace(/^[║╔╚]\s*/, "").replace(/\s*[║╗╝]$/, "");
}

function flattenContent(frame: string): string {
  return frame.split("\n").map(stripBoxChars).join("");
}

function makeDispatch() {
  return vi.fn();
}

function wait(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let activeUnmount: (() => void) | null = null;

beforeEach(() => {
  mockResolvePlanApproval.mockClear();
  mockLog.mockClear();
  activeUnmount = null;
});

afterEach(() => {
  activeUnmount?.();
  activeUnmount = null;
});

describe("PlanReadyModal — normal mode", () => {
  it("renders plan objective and steps", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to code?");
    expect(frame).toContain("Add a login feature");
    expect(frame).toContain("Add login route");
    expect(frame).toContain("Create the route");
  });

  it("truncates a long step description at 48 chars with a trailing … marker", () => {
    const longDesc = "x".repeat(250);
    const proposal = {
      ...PROPOSAL,
      steps: [{ title: "Long step", description: longDesc, filesLikely: [] }],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    // A plain toContain("x".repeat(48) + "…") is satisfied by ANY longer run
    // of x's too — the last 48 characters of a 60-x run followed by "…" are
    // themselves "x".repeat(48) + "…", so that assertion can't tell 48 from
    // 60. Capture the full contiguous run with a greedy regex instead, so the
    // match's own length pins the boundary exactly, in both directions.
    const match = flattenContent(frame).match(/x+…/);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("x".repeat(48) + "…");
  });

  it("does not append … when step description is under the 48-char cap", () => {
    const shortDesc = "A short, untruncated description.";
    const proposal = {
      ...PROPOSAL,
      steps: [{ title: "Short step", description: shortDesc, filesLikely: [] }],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain(shortDesc); // positive first
    // Scoped to this fixture's own line, not the whole frame — an unrelated
    // overflow line elsewhere must not be able to satisfy this check.
    const line = frame.split("\n").find((l) => l.includes(shortDesc));
    expect(line).toBeDefined();
    expect(stripBoxChars(line!)).not.toContain("…");
  });

  it("renders footer with 4 numbered actions and no (stub) labels", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
    expect(frame).not.toContain("stub");
  });

  it("[1] calls resolvePlanApproval with accept_all and no feedback", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("1");
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "accept_all",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[2] calls resolvePlanApproval with manual", () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("2");
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "manual",
    });
  });

  it("Esc calls resolvePlanApproval with reject and dispatches RUN_ABORTED", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("\x1b");
    await wait(); // Ink may defer escape-sequence disambiguation
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "reject",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "RUN_ABORTED" });
  });
});

describe("PlanReadyModal — feedback sub-mode", () => {
  it("[3] enters feedback mode (shows input prompt, hides normal footer)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Feedback (then revise):");
    expect(frame).toContain("Enter to submit");
    expect(frame).not.toContain("[1] auto-accept");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });

  it("[4] enters feedback mode with approve_with_feedback label", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Feedback (then run):");
  });

  it("Esc in feedback mode returns to normal mode without resolving", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("\x1b");
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] auto-accept");
    expect(mockResolvePlanApproval).not.toHaveBeenCalled();
  });

  it("typing text then Enter submits feedback decision with typed text", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");
    await wait();
    stdin.write("add unit tests");
    await wait();
    stdin.write("\r"); // Enter
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "feedback",
      feedback: "add unit tests",
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "PLAN_READY_RESOLVED" });
  });

  it("[4] + type + Enter submits approve_with_feedback with text", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("4");
    await wait();
    stdin.write("be concise");
    await wait();
    stdin.write("\r"); // Enter
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "approve_with_feedback",
      feedback: "be concise",
    });
  });

  it("paste in feedback mode inserts full pasted text at cursor", async () => {
    const dispatch = makeDispatch();
    const { stdin, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={dispatch} />
    );
    activeUnmount = unmount;
    stdin.write("3");                                    // enter feedback mode
    await wait();
    stdin.write("\x1b[200~pasted feedback\x1b[201~");   // bracketed-paste sequence
    await wait();
    stdin.write("\r");                                   // submit
    await wait();
    expect(mockResolvePlanApproval).toHaveBeenCalledWith({
      planId: "plan-modal-001",
      runId: "run-modal-001",
      decision: "feedback",
      feedback: "pasted feedback",
    });
  });
});

// Phase 2a: scopeNotes rendering
describe("PlanReadyModal — scopeNotes", () => {
  it("renders 'Scope:' label and notes when scopeNotes is present on proposal", () => {
    const proposal = { ...PROPOSAL, scopeNotes: "Auth module 80% done in src/auth.ts" };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Scope:");
    expect(frame).toContain("Auth module 80% done");
  });

  it("does not render 'Scope:' when scopeNotes is absent", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Scope:");
  });

  it("truncates scopeNotes to 200 chars in render", () => {
    const longNotes = "x".repeat(300);
    const proposal = { ...PROPOSAL, scopeNotes: longNotes };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    // Ink wraps text across lines — count total x chars to verify cap
    const xCount = (frame.match(/x/g) ?? []).length;
    expect(xCount).toBe(200); // .slice(0, 200) applied — exactly 200 rendered
  });
});

// PlanReady projection: scopeSummary rendering. Required field — always
// present, unlike scopeNotes, so no absent/present branch to test, only the
// truncation-marker guard.
describe("PlanReadyModal — scopeSummary", () => {
  it("does not render 'Summary:' when scopeSummary is empty", () => {
    const proposal = { ...PROPOSAL, scopeSummary: "" };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Summary:");
  });

  it("renders 'Summary:' label and the scopeSummary text", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Summary:");
    expect(frame).toContain("Add a login feature end to end.");
  });

  it("truncates scopeSummary over 200 chars with a trailing … marker", () => {
    const longSummary = "x".repeat(250);
    const proposal = { ...PROPOSAL, scopeSummary: longSummary };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Summary:");
    // Anchored to content+marker as one string, not the bare "…" glyph (which
    // the counted-overflow dialect elsewhere also renders) — flattened across
    // Ink's line-wrap so a mid-string wrap boundary can't break the match.
    expect(flattenContent(frame)).toContain("x".repeat(200) + "…");
  });

  it("does not append … when scopeSummary is under the 200-char cap", () => {
    const shortSummary = "A short, untruncated summary.";
    const proposal = { ...PROPOSAL, scopeSummary: shortSummary };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain(shortSummary); // positive first
    // Scoped to this fixture's own line, not the whole frame — an unrelated
    // overflow line elsewhere must not be able to satisfy this check.
    const line = frame.split("\n").find((l) => l.includes(shortSummary));
    expect(line).toBeDefined();
    expect(stripBoxChars(line!)).not.toContain("…");
  });
});

// PlanReady projection: riskHints rendering. List dialect (counted overflow)
// for the entry count; string dialect (trailing …) for each entry's own
// per-character cap — round-2's "lists get counted overflow, strings get a
// trailing …" split applied within a single field.
describe("PlanReadyModal — riskHints", () => {
  it("does not render 'Risks:' when riskHints is empty", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Risks:");
  });

  it("renders up to 5 risk hints and a counted overflow line for more", () => {
    const proposal = {
      ...PROPOSAL,
      riskHints: ["Risk A", "Risk B", "Risk C", "Risk D", "Risk E", "Risk F", "Risk G"],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Risks:");
    expect(frame).toContain("Risk A");
    expect(frame).toContain("Risk E");
    expect(frame).not.toContain("Risk F");
    // Full counter text, not the bare glyph.
    expect(frame).toContain("+2 more risk(s)");
  });

  it("does not render an overflow line when riskHints is under the 5-entry cap", () => {
    const proposal = { ...PROPOSAL, riskHints: ["Risk A", "Risk B", "Risk C"] };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Risk A"); // positive first
    expect(frame).not.toContain("more risk(s)");
  });

  it("truncates a riskHints entry over 120 chars with a trailing … marker", () => {
    const longHint = "x".repeat(197); // matches the measured production max (990a051c envelope)
    const proposal = { ...PROPOSAL, riskHints: [longHint] };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Risks:");
    expect(flattenContent(frame)).toContain("x".repeat(120) + "…");
  });

  it("does not append … to a riskHints entry under the 120-char cap", () => {
    const shortHint = "A short, untruncated risk.";
    const proposal = { ...PROPOSAL, riskHints: [shortHint] };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain(shortHint); // positive first
    const line = frame.split("\n").find((l) => l.includes(shortHint));
    expect(line).toBeDefined();
    expect(stripBoxChars(line!)).not.toContain("…");
  });
});

// PlanReady projection: filesLikely widened 3→10, converted from an inline
// ", …" ellipsis to the counted-overflow list dialect (matching riskHints/
// steps) — a separate overflow line, not a suffix on the same line.
describe("PlanReadyModal — filesLikely", () => {
  it("renders up to 10 files and a counted overflow line for more", () => {
    const proposal = {
      ...PROPOSAL,
      steps: [{
        title: "Refactor",
        description: "",
        filesLikely: Array.from({ length: 11 }, (_, i) => `src/f${i + 1}.ts`),
      }],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/f1.ts");
    expect(frame).toContain("src/f10.ts");
    expect(frame).not.toContain("src/f11.ts");
    // Full counter text, not the bare glyph.
    expect(frame).toContain("+1 more file(s)");
  });

  it("does not render an overflow line when filesLikely is under the 10-file cap", () => {
    const proposal = {
      ...PROPOSAL,
      steps: [{ title: "Small step", description: "", filesLikely: ["src/a.ts", "src/b.ts"] }],
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/a.ts"); // positive first
    expect(frame).not.toContain("more file(s)");
  });
});

// PlanReady projection: steps widened 6→8 via STEPS_MAX, backing both the
// slice and its comparison so a future edit can't move one without the other.
describe("PlanReadyModal — steps (STEPS_MAX)", () => {
  it("renders all 8 steps at the cap", () => {
    const proposal = {
      ...PROPOSAL,
      steps: Array.from({ length: 8 }, (_, i) => ({
        title: `Step ${i + 1}`, description: "", filesLikely: [],
      })),
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Step 1");
    expect(frame).toContain("Step 8");
    expect(frame).not.toContain("more step(s)");
  });

  it("renders 8 steps and a counted overflow line for a 9th (hand-built — exceeds the schema's .max(8), exercises only the modal's own defensive slice)", () => {
    const proposal = {
      ...PROPOSAL,
      steps: Array.from({ length: 9 }, (_, i) => ({
        title: `Step ${i + 1}`, description: "", filesLikely: [],
      })),
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Step 8");
    expect(frame).not.toContain("Step 9");
    // Full counter text, not the bare glyph.
    expect(frame).toContain("+1 more step(s)");
  });

  it("does not render an overflow line when steps is under the 8-step cap", () => {
    const proposal = {
      ...PROPOSAL,
      steps: Array.from({ length: 4 }, (_, i) => ({
        title: `Step ${i + 1}`, description: "", filesLikely: [],
      })),
    };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Step 1"); // positive first
    expect(frame).not.toContain("more step(s)");
  });
});

// A replan can produce a stepless plan carrying noChangeReason/cannotVerifyReason
// (none of E8a/E8b/the forceSteps safety net in dispatch.ts re-run after a
// replan). The modal must show the reason, not just an empty step list.
describe("PlanReadyModal — stepless plan with a stated reason", () => {
  const STEPLESS_PROPOSAL = {
    ...PROPOSAL,
    steps: [],
  };

  it("renders 'No changes needed:' and the reason text when noChangeReason is set", () => {
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: "Build already exits 0 — the asserted bug does not reproduce." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No changes needed:");
    expect(frame).toContain("Build already exits 0");
    expect(frame).not.toContain("Could not verify:");
  });

  it("renders 'Could not verify:' and the reason text when cannotVerifyReason is set", () => {
    const proposal = { ...STEPLESS_PROPOSAL, cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Could not verify:");
    expect(frame).toContain("Reproduce command was blocked");
    expect(frame).not.toContain("No changes needed:");
  });

  it("renders neither reason label on a normal multi-step plan", () => {
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={PROPOSAL} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("No changes needed:");
    expect(frame).not.toContain("Could not verify:");
  });

  it("truncates the reason text to 200 chars", () => {
    const longReason = "x".repeat(300);
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: longReason };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    const xCount = (frame.match(/x/g) ?? []).length;
    expect(xCount).toBe(200);
  });

  it("still renders all four action keys — the reason changes visibility, not approval semantics", () => {
    const proposal = { ...STEPLESS_PROPOSAL, noChangeReason: "Verified clean." };
    const { lastFrame, unmount } = render(
      <PlanReadyModal proposal={proposal} dispatch={makeDispatch()} />
    );
    activeUnmount = unmount;
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
    expect(frame).toContain("[3]");
    expect(frame).toContain("[4]");
  });

  it("does not break the footer at 60 or 80 columns", () => {
    const proposal = { ...STEPLESS_PROPOSAL, cannotVerifyReason: "Reproduce command was blocked — could not confirm the premise." };
    for (const columns of [60, 80]) {
      const { lastFrame, unmount } = renderPlanReadyModalAt(proposal, makeDispatch(), columns);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Could not verify:");
      expect(frame).toContain("[1]");
      expect(frame).toContain("[4]");
      unmount();
    }
  });
});

// Height-budget pins — validate the pure estimator functions
// (estimateWrappedLines, estimatePlanContentLines) against the real
// renderer, and measure the constants a future budget mechanism will need
// (chrome, footer, sibling reservation). Nothing here is wired into the
// component's render yet: NO_CUTS is the only cutState value used, there is
// no tier walk, no cut state applied to the render, and no attribution line.
describe("PlanReadyModal — height-budget pins", () => {
  describe("estimateWrappedLines — direct unit test", () => {
    it("returns 0 for an empty string", () => {
      expect(estimateWrappedLines("", 10)).toBe(0);
    });

    it("returns 1 for text that fits within the width", () => {
      expect(estimateWrappedLines("hello", 10)).toBe(1);
    });

    it("splits on an embedded \\n as a hard break", () => {
      expect(estimateWrappedLines("a\nb", 10)).toBe(2);
    });

    it("counts the blank line between two \\n as its own row", () => {
      expect(estimateWrappedLines("a\n\nb", 10)).toBe(3);
    });

    it("word-wraps at a space boundary, not mid-word", () => {
      // "aaaaa bbbbb" (11 chars) at width 6: "aaaaa" fits (5 <= 6); adding
      // " bbbbb" would make 11 > 6, so the whole word moves to line 2.
      expect(estimateWrappedLines("aaaaa bbbbb", 6)).toBe(2);
    });

    it("hard-breaks a single word longer than the width", () => {
      expect(estimateWrappedLines("x".repeat(25), 10)).toBe(Math.ceil(25 / 10));
    });

    it("fits exactly at the width boundary without wrapping (> not >=)", () => {
      // "abcd edcba": lineLen after "abcd" is 4; adding " edcba" (1+5) makes
      // nextLen exactly 10 — equal to width, not over it, so it must stay on
      // one line. A >= mutation here would wrap it to 2 lines instead.
      expect(estimateWrappedLines("abcd edcba", 10)).toBe(1);
    });
  });

  // Shared by pin 1 and pin 3 so the margin formula reads pin 1's own
  // measured value rather than a second hardcoded literal that could drift.
  function measureChromeAndFooter(columns: number): { chromeLines: number; footerLines: number; totalLines: number } {
    const degenerateProposal = {
      planId: "p", runId: "r",
      objective: "", scopeSummary: "", riskHints: [] as string[], steps: [],
    };
    const { lastFrame, unmount } = renderPlanReadyModalAt(degenerateProposal, makeDispatch(), columns);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    unmount();
    // Footer's content is known text (the action-key hints) — identify its
    // lines by that content, not a fixed position, then derive chrome by
    // subtracting the measured footer from the total.
    const footerStart = lines.findIndex((l) => l.includes("[1]"));
    if (footerStart === -1) {
      throw new Error(`could not locate footer start in degenerate frame at columns=${columns}`);
    }
    let footerEnd = footerStart;
    for (let i = footerStart + 1; i < lines.length; i++) {
      if (stripBoxChars(lines[i]).trim() === "") break; // blank padding row — footer ended
      footerEnd = i;
    }
    const footerLines = footerEnd - footerStart + 1;
    const totalLines = lines.length;
    return { chromeLines: totalLines - footerLines, footerLines, totalLines };
  }

  // Measured once: chrome is 9 at both 60 and 80 cols (column-independent —
  // confirms the assumption several other design choices already relied
  // on); footer is 3 at 60, 2 at 80 (restacks narrower). FRAME_CHROME_LINES
  // in planModalLineBudget.ts is pinned to 9 from this measurement.
  // (FRAME_CHROME_LINES/FOOTER_LINES_NORMAL are declared once, module-level,
  // above — shared with the acceptance grid further down.)

  describe("pin 1 — chrome + footer (degenerate fixture)", () => {
    it("measures footer and chrome directly, both widths, conservative relation", () => {
      const at60 = measureChromeAndFooter(60);
      const at80 = measureChromeAndFooter(80);
      // eslint-disable-next-line no-console
      console.log("PIN1_MEASURED", JSON.stringify({ at60, at80 }));

      // Chrome itself is column-independent — if this ever fails, that's a
      // broken premise several other design choices already assume, not a
      // pin to patch by making the function column-aware unilaterally.
      expect(at80.chromeLines).toBe(at60.chromeLines);

      // Conservative relation: the fixed constant never under-reserves at
      // any tested width, and is exact (not idly padded) at the narrowest.
      expect(at60.totalLines).toBeLessThanOrEqual(FRAME_CHROME_LINES + FOOTER_LINES_NORMAL);
      expect(at60.totalLines).toBe(FRAME_CHROME_LINES + FOOTER_LINES_NORMAL);
      expect(at80.totalLines).toBeLessThanOrEqual(FRAME_CHROME_LINES + FOOTER_LINES_NORMAL);
    });
  });

  describe("pin 2 — per-section overhead (indented vs flat width)", () => {
    it("increment over the empty-proposal baseline matches title + filesLikely at width 49/69, not 54/74", () => {
      // Joined filesLikely string is 51 chars — fits within flat 54 (a buggy
      // flat-width estimate would predict no wrap) but not within the
      // indented 49 (marginLeft=5) — the gap this pin exists to catch.
      const files = ["src/a-file-name-here.ts", "src/another-file-name.ts"];
      const filesText = `(${files.join(", ")})`;
      expect(filesText.length).toBe(51);

      const baseline = { planId: "p", runId: "r", objective: "", scopeSummary: "", riskHints: [] as string[], steps: [] };
      const oneSection = {
        ...baseline,
        steps: [{ title: "T", description: "", filesLikely: files }],
      };

      for (const columns of [60, 80] as const) {
        const { lastFrame: baseFrame, unmount: u1 } = renderPlanReadyModalAt(baseline, makeDispatch(), columns);
        const baseLines = (baseFrame() ?? "").split("\n").length;
        u1();
        const { lastFrame: oneFrame, unmount: u2 } = renderPlanReadyModalAt(oneSection, makeDispatch(), columns);
        const oneLines = (oneFrame() ?? "").split("\n").length;
        u2();

        const indentedWidth = columns - 6 - 5;
        const expectedIncrement =
          estimateWrappedLines("T", indentedWidth) + estimateWrappedLines(filesText, indentedWidth);
        expect(oneLines - baseLines).toBe(expectedIncrement);
      }
    });
  });

  describe("pin 3 — estimatePlanContentLines aggregate vs the real renderer", () => {
    it("margin against actualTotalLines equals pin 1's own measured over-reservation, per width", () => {
      // Word-shaped tokens (long enough to wrap several lines) + a token
      // straddling the 54-col boundary at 60 cols + an embedded \n + a step
      // title that wraps at the row-sibling-reduced width (49, not the raw
      // 54) + several surviving sections (objective, summary, risks, two
      // steps) so label+spacer summing is exercised across more than one.
      const wordyLine1 = "aaaaa bbbbbbbbbb ccccccc dddddddddddd eeee ffffffffff ggggg hhhhhhhhhh";
      const wordyLine2 = "iiiii jjjjjjjjjj kkkkk";
      const fixture = {
        planId: "p", runId: "r",
        objective: "Objective text for the estimator pin",
        scopeSummary: `${wordyLine1}\n${wordyLine2}`,
        riskHints: ["risk one here", "risk two here"],
        steps: [
          { title: "Short title", description: "", filesLikely: [] },
          {
            title: "A title long enough that it should wrap across more than one rendered line at these widths for sure",
            description: "",
            filesLikely: [],
          },
        ],
      };

      for (const columns of [60, 80] as const) {
        const { lastFrame, unmount } = renderPlanReadyModalAt(fixture, makeDispatch(), columns);
        const actualTotalLines = (lastFrame() ?? "").split("\n").length;
        unmount();

        const estimate = estimatePlanContentLines(fixture, columns, NO_CUTS);
        const margin = estimate - (actualTotalLines - (FRAME_CHROME_LINES + FOOTER_LINES_NORMAL));
        const expectedOverReservation =
          (FRAME_CHROME_LINES + FOOTER_LINES_NORMAL) - measureChromeAndFooter(columns).totalLines;

        // eslint-disable-next-line no-console
        console.log(`PIN3 columns=${columns} actualTotalLines=${actualTotalLines} estimate=${estimate} margin=${margin}`);
        expect(margin).toBe(expectedOverReservation);
        // At 60 (the narrowest tested width) pin 1's own relation is exact,
        // so expectedOverReservation — and therefore this margin — reduces
        // to precisely 0; asserted here rather than as a separate fixture,
        // since a fixture too short to straddle the indented-width boundary
        // would pass this regardless of whether the width bug exists at all.
        if (columns === 60) expect(margin).toBe(0);
      }
    });
  });

  describe("pin 4 — SIBLING_LINES (real Composer + StatusBar)", () => {
    it("measures total lines at 60 and 80 columns", () => {
      // StatusBar.tsx reads process.stdout.columns directly (not via
      // useStdout()), so Ink's injected mock stdout never reaches it — in
      // this (non-TTY) test environment that property is undefined, and
      // StatusBar silently falls back to its own hardcoded 80 regardless of
      // the width under test. Stub the real property for the duration of
      // each render so the separator is actually computed for that width,
      // restoring it after — otherwise this measurement is an artifact of
      // whatever terminal happens to run the suite, not a real one.
      const originalColumns = process.stdout.columns;
      const measured: Record<number, number> = {};
      try {
        for (const columns of [60, 80] as const) {
          process.stdout.columns = columns;
          let lastFrame: string | undefined;
          const stdout = Object.assign(new EventEmitter(), {
            columns,
            rows: 40,
            write: (frame: string) => { lastFrame = frame; return true; },
          });
          const instance = inkRender(
            <StoreProvider initialValues={{ model: "test-model", capUsd: 10 }}>
              <>
                <Composer onSubmit={vi.fn()} onExit={() => {}} />
                <StatusBar />
              </>
            </StoreProvider>,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { stdout: stdout as any, stdin: new MockStdin() as any, debug: true, exitOnCtrlC: false, patchConsole: false },
          );
          measured[columns] = (lastFrame ?? "").split("\n").length;
          instance.unmount();
        }
      } finally {
        process.stdout.columns = originalColumns;
      }
      // eslint-disable-next-line no-console
      console.log("PIN4_MEASURED", JSON.stringify(measured));
      // SIBLING_LINES itself is declared once, module-level, above (shared
      // with the acceptance grid) — assert the measurement against it here.
      const measuredMax = Math.max(measured[60], measured[80]);
      expect(measuredMax).toBe(SIBLING_LINES); // JSX-derived estimate (Composer 1 + StatusBar 4) confirmed
      expect(measured[60]).toBeLessThanOrEqual(SIBLING_LINES);
      expect(measured[80]).toBeLessThanOrEqual(SIBLING_LINES);
    });
  });
});

// Tier-walk pass — four tiers wired into the actual render: descriptions,
// summary, risks, steps. `files` stays deferred (filesLikelyShown fixed at
// FILES_LIKELY_MAX, no branch in the walk or attribution derivation — see
// the design record's addendum for the measured reasoning and the named
// residual band this leaves). Compact chrome (Commit 6) stays out of scope.
describe("PlanReadyModal — tier walk", () => {
  describe("rows-implausible marker", () => {
    it("emits [zone-plan-modal-rows-implausible] with the exact received value, including rows: null", async () => {
      const { unmount } = renderPlanReadyModalAtRows(PROPOSAL, makeDispatch(), 60, null);
      activeUnmount = unmount;
      await wait();
      expect(mockLog).toHaveBeenCalledWith(
        "[zone-plan-modal-rows-implausible]",
        JSON.stringify({ received: null, receivedType: "object" }),
      );
    });

    it("emits once, not once per re-render, for the same invalid rows", async () => {
      const { rerender, unmount } = renderPlanReadyModalAtRows(PROPOSAL, makeDispatch(), 60, NaN);
      activeUnmount = unmount;
      await wait();
      rerender();
      await wait();
      rerender();
      await wait();
      const callsForThisMarker = mockLog.mock.calls.filter(
        (args) => args[0] === "[zone-plan-modal-rows-implausible]",
      );
      expect(callsForThisMarker.length).toBe(1);
    });

    it("does not emit when rows is valid", async () => {
      // rows=22 is still a valid positive integer (so the rows-implausible
      // marker correctly never fires) but drives contentBudget to 3 —
      // confirmed via walkTiers this forces all four tiers to fire without
      // also tripping floorUnmet (rows=20 or lower trips the *other*
      // marker too, which would conflate this test's scope). The
      // attribution line below is therefore a real, positive fact that the
      // budget mechanism actually ran — not a fixture that just happens to
      // fit, which would look identical if the harness's isTTY were silently
      // broken.
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(PROPOSAL, makeDispatch(), 60, 22);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      expect(flattenContent(frame)).toContain("trimmed to fit terminal"); // positive first
      expect(mockLog).not.toHaveBeenCalledWith(
        "[zone-plan-modal-rows-implausible]",
        expect.anything(),
      );
    });
  });

  // Maximal fixture, with a wrapping title (shared with the acceptance grid
  // below) so the estimator's title-wrap honesty is exercised here too.
  const MAXIMAL_PROPOSAL = {
    planId: "p", runId: "r",
    objective: "O".repeat(200),
    steps: Array.from({ length: 8 }, (_, i) => ({
      title: i === 0
        ? "A title long enough that it should wrap across more than one rendered line at these widths for sure"
        : `Step ${i + 1}`,
      description: "D".repeat(200),
      filesLikely: Array.from({ length: 11 }, (_, j) => `src/file${i}_${j}.ts`),
    })),
    riskHints: Array.from({ length: 5 }, (_, i) => `R${i}` + "r".repeat(118)),
    scopeSummary: "S".repeat(200),
  };

  describe("floor-unmet marker", () => {
    it("emits [zone-plan-modal-budget-unmet] with {rows, requiredLines, achievedLines} when even the full cut doesn't fit", async () => {
      // rows=24, columns=60: contentBudget=7, floor content is 8 lines —
      // confirmed via walkTiers directly (design record's addendum: 8 lines
      // on both fixtures at this row/column pair).
      const { unmount } = renderPlanReadyModalAtRows(MAXIMAL_PROPOSAL, makeDispatch(), 60, 24);
      activeUnmount = unmount;
      await wait();
      expect(mockLog).toHaveBeenCalledWith(
        "[zone-plan-modal-budget-unmet]",
        JSON.stringify({ rows: 24, requiredLines: 8, achievedLines: 7 }),
      );
    });

    it("does not emit when the walk fits", async () => {
      // rows=50, columns=60: confirmed via walkTiers directly that all four
      // tiers fire (descriptions, summary, risks, steps) with
      // floorUnmet:false — a real cut, not a fixture that happens to
      // already fit, so the attribution line below is a genuine positive
      // fact that the budget mechanism ran.
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(MAXIMAL_PROPOSAL, makeDispatch(), 60, 50);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      expect(flattenContent(frame)).toContain("trimmed to fit terminal"); // positive first
      expect(mockLog).not.toHaveBeenCalledWith(
        "[zone-plan-modal-budget-unmet]",
        expect.anything(),
      );
    });
  });

  // Two steps, empty descriptions, no scopeSummary — a fixture whose bare
  // NO_CUTS estimate is exactly 11 at 60 columns (confirmed directly). The
  // attribution line's worst-case reservation for this pass's 4 tier names
  // is exactly 2 lines at both 60 and 80 columns (confirmed directly:
  // estimateWrappedLines of the full "descriptions, summary, risks, steps
  // (still taller than your terminal)" text). contentBudget=11 sits exactly
  // at the boundary the earlier, wrong draft would have gotten backwards:
  // bare(11) <= budget(11), so nothing should be cut — but bare + reservation
  // (13) > budget(11), which is what the earlier, wrong version of the
  // walk's entry check would have compared instead, incorrectly starting to
  // cut a proposal that already fit.
  const NO_CUT_FIXTURE = {
    planId: "p", runId: "r",
    objective: "Objective text for the minimality guard fixture, padded a bit more so there is room",
    scopeSummary: "",
    riskHints: ["risk one", "risk two", "risk three", "risk four", "risk five"],
    steps: [
      { title: "Short title one", description: "", filesLikely: [] },
      { title: "Short title two", description: "", filesLikely: [] },
    ],
  };

  describe("free no-cut assertion — the walk's entry condition, not its interior", () => {
    it("cuts nothing when the bare estimate already fits, even though bare+reservation would not", async () => {
      // contentBudget = rows - 9 - 3 - 5 = rows - 17; rows=28 -> budget=11.
      //
      // No positive "budget was active" fact is available here, unlike the
      // rest of this describe block — this test's entire premise is that
      // NOTHING gets cut, so "cutState below NO_CUTS" and "attribution line
      // present" are both false by design, not just unchecked. A stdout mock
      // silently missing isTTY (contentBudget stuck at undefined, cutState
      // stuck at NO_CUTS) would reproduce this exact frame; this test alone
      // cannot tell the two apart. The minimality guard below, same
      // NO_CUT_FIXTURE at rows=27 (one content-line tighter), is the sibling
      // test that actually proves the harness is wired for this fixture
      // family — it DOES cut, and asserts "+4 more risk(s)", a fact a broken
      // mock cannot produce.
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(NO_CUT_FIXTURE, makeDispatch(), 60, 28);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("risk one"); // positive first — nothing cut
      expect(frame).toContain("risk five");
      expect(frame).not.toContain("more risk(s)");
      expect(frame).not.toContain("trimmed to fit terminal");
    });
  });

  describe("minimality guard — the walk doesn't cut more than it takes", () => {
    it("decrements riskHintsShown one at a time rather than jumping to 0", () => {
      // contentBudget=10 at 60 columns: descriptions/summary flip as no-ops
      // (this fixture's own description/scopeSummary are already empty, so
      // flipping them changes nothing), risks lands at riskHintsShown=1 —
      // confirmed directly via walkTiers, not assumed — steps stays
      // untouched (stepsShown remains at its cap, no step dropped).
      //
      // This proves minimality relative to the four tiers actually
      // implemented this pass (descriptions, summary, risks, steps) — not a
      // global minimum across all five possible tiers. `files` isn't in
      // TIER_LIST at all, so a cut that could have been satisfied by
      // trimming a file list instead is not something this guard (or the
      // walk) can find; see the design record's addendum for the named
      // real-plan band (rows 37-39) where that gap actually bites.
      const result = walkTiers(NO_CUT_FIXTURE, 60, 10);
      expect(result.cutState.riskHintsShown).toBe(1);
      expect(result.cutState.stepsShown).toBe(NO_CUTS.stepsShown);
    });

    it("the real render matches: 1 of 5 risk hints shown, others counted, nothing else touched", async () => {
      // rows - 17 = 10 -> rows = 27.
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(NO_CUT_FIXTURE, makeDispatch(), 60, 27);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("risk one"); // positive first — the one surviving hint
      expect(frame).toContain("+4 more risk(s)"); // positive, budget-active fact — before any absence check
      expect(frame).not.toContain("risk two");
      expect(frame).not.toContain("risk five");
      expect(frame).toContain("Short title one"); // steps untouched
      expect(frame).toContain("Short title two");
    });
  });

  describe("negative contentBudget must not corrupt output silently", () => {
    it("lands the walk on its natural floor — all four implemented tiers exhausted, no negative-slice artifact", async () => {
      // rows=10 -> contentBudget = 10 - 9 - 3 - 5 = -7, well under the floor.
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(MAXIMAL_PROPOSAL, makeDispatch(), 60, 10);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      // "Risks:" stays gated on riskHints.length > 0, not on riskHintsShown —
      // the field still exists on the proposal, it's just fully budget-cut,
      // so the label persists with a full "+5 more risk(s)" counter rather
      // than disappearing (same shape as summary/descriptions being absent
      // only when the underlying field itself is absent, not merely cut).
      expect(frame).toContain("Risks:");
      expect(frame).toContain("+5 more risk(s)"); // all 5 hidden, never larger than the array
      expect(frame).toContain("+8 more step(s)"); // stepsShown=0, all 8 fixture steps hidden
      expect(frame).not.toContain("Step 2"); // no step shown at all
      // flattenContent, not raw frame — at 60 columns this attribution line
      // wraps across 2 physical lines, splitting the clause's own text at
      // the wrap boundary.
      // "taller than your terminal)" rather than the full clause including
      // "still" — flattenContent strips whitespace at both ends of every
      // physical line, so a *word*-wrap boundary (unlike a hard character
      // wrap) loses the inter-word space entirely; "still" and "taller" can
      // legitimately land on separate lines here (confirmed at rows=24,
      // columns=80). The closing paren keeps this substring distinctive.
      expect(flattenContent(frame)).toContain("trimmed to fit terminal");
      expect(flattenContent(frame)).toContain("taller than your terminal)");
    });

    it("walkTiers directly: dropSummary true, all three numeric fields at 0, filesLikelyShown untouched at cap", () => {
      const result = walkTiers(MAXIMAL_PROPOSAL, 60, -7);
      expect(result.cutState).toEqual({
        descriptionsShown: 0,
        dropSummary: true,
        riskHintsShown: 0,
        filesLikelyShown: NO_CUTS.filesLikelyShown, // untouched — files stays deferred
        stepsShown: 0,
      });
      expect(result.floorUnmet).toBe(true);
    });
  });

  // rows=24/29 are exactly where the earlier provisional-constant bug lived
  // (design record) — this grid is what would have caught it. Disjunction:
  // either the frame fits within rows − SIBLING_LINES, or the floor-unmet
  // path fired correctly (marker + attribution clause) — an over-tall frame
  // with no acknowledgment is the one outcome never allowed. Which branch
  // each row/column pair takes isn't predicted here; it's read off the
  // actual render and reported.
  describe("acceptance grid", () => {
    it.each([
      [24, 60], [24, 80],
      [29, 60], [29, 80],
      [30, 60], [30, 80],
      [50, 60], [50, 80],
    ] as const)("rows=%d columns=%d: fits, or honestly admits it doesn't", async (rows, columns) => {
      const { lastFrame, unmount } = renderPlanReadyModalAtRows(MAXIMAL_PROPOSAL, makeDispatch(), columns, rows);
      activeUnmount = unmount;
      await wait();
      const frame = lastFrame() ?? "";
      const totalFrameLines = frame.split("\n").length;
      const fits = totalFrameLines <= rows - SIBLING_LINES;
      // flattenContent, not raw frame — the attribution line can wrap
      // across physical lines. Checking for "taller than your terminal)"
      // rather than the full clause: flattenContent strips whitespace at
      // both ends of every physical line, so a *word*-wrap boundary loses
      // the inter-word space entirely — "still" and "taller" can legitimately
      // land on separate lines (confirmed at rows=24/columns=80).
      const floorUnmetFired =
        mockLog.mock.calls.some((args) => args[0] === "[zone-plan-modal-budget-unmet]") &&
        flattenContent(frame).includes("taller than your terminal)");
      // eslint-disable-next-line no-console
      console.log(`GRID rows=${rows} columns=${columns} totalFrameLines=${totalFrameLines} target=${rows - SIBLING_LINES} fits=${fits} floorUnmetFired=${floorUnmetFired}`);
      expect(fits || floorUnmetFired).toBe(true);
    });
  });
});
