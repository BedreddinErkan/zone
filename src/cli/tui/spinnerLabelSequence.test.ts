/**
 * Spinner label sequence — the property is WHICH LABEL STOOD WHEN, not that a render happened.
 *
 * Rendering was established not to be the defect: there is no `React.memo` anywhere in the TUI,
 * `Spinner.tsx` reads full state through a plain `useContext`, and the provider hands down a fresh
 * object each render, so a label change reaches the screen immediately. Every defect on this
 * surface is a missing or wrong DISPATCH, which is what these assertions read.
 *
 * Driven through the reducer directly: the sequence of `state.spinner` values across a dispatch
 * order that mirrors a real run. No provider call is involved — and note that no run was possible
 * for this pass at all, so these are mock-level assertions, not run-verified behaviour.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { reducer, buildInitialState, type StoreState, type StoreAction } from "./store.js";
import { eventToActions, SPINNER_LABEL_STARTING } from "./hooks/eventToActions.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";
import { FINAL_REPORT_SPINNER_LABEL } from "../../core/agentLifecycleEvents.js";

function evt(type: string, extra: Record<string, unknown> = {}): ZoneStructuredProgressEvent {
  return { runId: "r1", ts: 1, type, ...extra } as unknown as ZoneStructuredProgressEvent;
}

/** Feeds events through the real mapper into the real reducer, recording the label after each. */
function labelSequence(events: ZoneStructuredProgressEvent[]): (string | null)[] {
  let state: StoreState = buildInitialState({ model: "m", capUsd: 10 });
  const seq: (string | null)[] = [];
  for (const e of events) {
    const { actions } = eventToActions(e, { trustedPrefixes: [], mode: "normal" });
    for (const a of actions as StoreAction[]) state = reducer(state, a);
    seq.push(state.spinner ? state.spinner.label : null);
  }
  return seq;
}

describe("agent_loop_start honours the title its producer sends", () => {
  it("uses evt.title, so the specific label survives instead of being replaced by the constant", () => {
    // The real producers send these: runLlmPatchFlow.ts and investigationFlow.ts respectively.
    expect(labelSequence([evt("agent_loop_start", { title: "Starting agent tool loop" })]))
      .toEqual(["Starting agent tool loop"]);
    expect(labelSequence([evt("agent_loop_start", { title: "Starting investigation" })]))
      .toEqual(["Starting investigation"]);
  });

  it("falls back to the constant only when the producer sends no title", () => {
    expect(labelSequence([evt("agent_loop_start")])).toEqual([SPINNER_LABEL_STARTING]);
  });

  it("the fallback constant is the literal 'Starting…' — pinned, not derived from itself", () => {
    // The assertion above compares the result against the very constant under test, so it holds
    // for ANY value and cannot observe the constant changing. A mutation to "MUTATED" passed all
    // ten tests in this file. This is the same self-referential shape a prior pass corrected in
    // the tail-cap assertion; the fix is the same — one fixed literal, independent of the subject.
    expect(SPINNER_LABEL_STARTING).toBe("Starting…");
  });

  it("negative control — a title on an event that does NOT feed the spinner leaves it untouched", () => {
    // patch_rejected carries a title and maps to ERROR_LINE. If the mapper were routing titles to
    // the spinner indiscriminately, this would show a label instead of null.
    expect(labelSequence([evt("patch_rejected", { title: "Patch rejected" })])).toEqual([null]);
  });
});

describe("the final-report wait is labelled", () => {
  it("final_report_started puts the shared label on the spinner", () => {
    const seq = labelSequence([
      evt("agent_loop_start", { title: "Starting agent tool loop" }),
      evt("final_report_started", { title: FINAL_REPORT_SPINNER_LABEL }),
    ]);
    expect(seq).toEqual(["Starting agent tool loop", FINAL_REPORT_SPINNER_LABEL]);
  });

  it("negative control — the label is not invented when the producer omits a title", () => {
    // Guards against the arm hardcoding a label of its own, which would make the producer's
    // constant decorative and let the two drift.
    expect(labelSequence([evt("final_report_started")])).toEqual([""]);
  });
});

// Everything above drives the CONSUMER: it builds the event by hand and pushes it through the
// mapper. That cannot observe whether the producer emits anything at all — deleting the emission
// from runLlmPatchFlow.ts left all of those assertions passing. The link has to be read from the
// producer's own source, which is the same gap a prior pass found when a type literal asserted
// nowhere survived the entire suite.
describe("the final-report emission exists at the producer, not just in the consumer's imagination", () => {
  const FLOW = path.join(process.cwd(), "src", "core", "runLlmPatchFlow.ts");

  it("runLlmPatchFlow emits final_report_started immediately before awaiting generateFinalRunReport", () => {
    const src = fs.readFileSync(FLOW, "utf8");
    // Anchored on the EMISSION, not on the call. There are twelve `await generateFinalRunReport(`
    // sites in this file; anchoring on the call made indexOf pick the first one (an early-exit
    // path) rather than the agent-loop one this emission guards, and the test failed on a clean
    // tree for a reason that had nothing to do with the property.
    const emit = src.indexOf('type: "final_report_started"');
    expect(emit, "final_report_started is not emitted anywhere in runLlmPatchFlow").toBeGreaterThanOrEqual(0);

    const window = src.slice(emit, emit + 900);
    expect(window).toContain("FINAL_REPORT_SPINNER_LABEL");
    expect(window).toContain("await generateFinalRunReport(");
  });

  it("the consumer maps that exact type onto the spinner", () => {
    const hook = fs.readFileSync(
      path.join(process.cwd(), "src", "cli", "tui", "hooks", "eventToActions.ts"), "utf8");
    expect(hook).toContain('case "final_report_started":');
  });

  it("negative control — the window search discriminates: it does not match an unrelated call", () => {
    const src = fs.readFileSync(FLOW, "utf8");
    const emit = src.indexOf('type: "final_report_started"');
    const window = src.slice(emit, emit + 900);
    // If the window were large enough to swallow arbitrary code, this would also "pass".
    expect(window).not.toContain("await classifyTask(");
  });

  it("the shared label constant is the literal it is expected to be — pinned independently", () => {
    expect(FINAL_REPORT_SPINNER_LABEL).toBe("Writing the run report…");
  });
});

describe("a mid-run transient label hands the spinner back, it does not stop it", () => {
  it("compaction: start -> compacting -> resumed to the ORIGINAL label, never null and never a generic constant", () => {
    const seq = labelSequence([
      evt("agent_loop_start", { title: "Starting agent tool loop" }),
      evt("compaction_started", { count: 1 }),
      evt("compaction_status", { count: 1, tokensBefore: 5, tokensAfter: 2, savedTokens: 3 }),
    ]);
    expect(seq[0]).toBe("Starting agent tool loop");
    expect(seq[1]).toBe("Compacting context…");
    // The crux: resumed to what was standing, not stopped (null) and not a shared constant.
    // Restoring a specific label with a vaguer one is the same defect as discarding evt.title.
    expect(seq[2]).toBe("Starting agent tool loop");
  });

  it("compaction_overflow_warning also resumes rather than stopping", () => {
    const seq = labelSequence([
      evt("agent_loop_start", { title: "Starting agent tool loop" }),
      evt("compaction_overflow_warning"),
    ]);
    expect(seq[1]).toBe("Starting agent tool loop");
  });

  it("compaction_exhausted DOES stop — it is terminal, and that stop is correct", () => {
    // Negative control that was inside the proposed defect class. agentLoop.ts emits this from a
    // catch and returns synthesizeCompactionExhaustedExit immediately, so the run is over: leaving
    // no spinner is right, and "nothing restarts it" is not evidence of a defect here.
    const seq = labelSequence([
      evt("agent_loop_start", { title: "Starting agent tool loop" }),
      evt("compaction_exhausted", { message: "context exhausted" }),
    ]);
    expect(seq[1]).toBeNull();
  });

  it("SPINNER_RESUME on a run that never started leaves the spinner stopped rather than inventing one", () => {
    const s0 = buildInitialState({ model: "m", capUsd: 10 });
    expect(reducer(s0, { type: "SPINNER_RESUME" }).spinner).toBeNull();
  });

  it("SPINNER_UPDATE does not become the resume target — only SPINNER_START sets the base", () => {
    let s = buildInitialState({ model: "m", capUsd: 10 });
    s = reducer(s, { type: "SPINNER_START", label: "Base" });
    s = reducer(s, { type: "SPINNER_UPDATE", label: "Transient" });
    s = reducer(s, { type: "SPINNER_RESUME" });
    expect(s.spinner?.label).toBe("Base");
  });
});
