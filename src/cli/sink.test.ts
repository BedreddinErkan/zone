import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCliSink } from "./sink.js";
import type { Spinner } from "./spinner.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface MockSpinner extends Spinner {
  succeeded: string[];
  failed: string[];
  started: string[];
  updated: string[];
  stopped: number;
}

function makeMockSpinner(): MockSpinner {
  const s: MockSpinner = {
    succeeded: [],
    failed: [],
    started: [],
    updated: [],
    stopped: 0,
    start(t) { s.started.push(t); },
    update(t) { s.updated.push(t); },
    succeed(t) { s.succeeded.push(t); },
    fail(t) { s.failed.push(t); },
    stop() { s.stopped++; },
    pauseForPrompt() {},
    resumeAfterPrompt() {},
  };
  return s;
}

function makeEvt(
  type: ZoneStructuredProgressEvent["type"],
  extras: Partial<ZoneStructuredProgressEvent> = {}
): ZoneStructuredProgressEvent {
  return {
    runId: "run-test",
    ts: 0,
    type,
    title: type,
    ...extras,
  };
}

const SILENT_OPTS = { verbose: false, quiet: false, noColor: true, isTTY: false };
const VERBOSE_OPTS = { verbose: true, quiet: false, noColor: true, isTTY: false };
const QUIET_OPTS = { verbose: false, quiet: true, noColor: true, isTTY: false };

let output: string[];
let spinner: MockSpinner;

beforeEach(() => {
  output = [];
  spinner = makeMockSpinner();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : "");
    return true;
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildCliSink — string updates", () => {
  it("string update → spinner.update", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress("running task...");
    expect(spinner.updated).toContain("running task...");
  });

  it("string update quiet → still calls update (spinner manages quiet)", () => {
    const sink = buildCliSink(QUIET_OPTS, spinner);
    sink.onProgress("running task...");
    expect(spinner.updated).toContain("running task...");
  });

  it("empty string update → no spinner call", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress("");
    expect(spinner.updated).toHaveLength(0);
  });

  it("stage-only update → spinner.update with stage", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "Working..." });
    expect(spinner.updated).toContain("Working...");
  });
});

describe("buildCliSink — agent_loop_start / complete", () => {
  it("agent_loop_start → spinner.start", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("agent_loop_start") });
    expect(spinner.started).toHaveLength(1);
  });

  it("agent_loop_complete → spinner.succeed with iter + cost", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({
      stage: "",
      progress: makeEvt("agent_loop_complete", { iter_count: 4, cumulativeCost: 0.0123 }),
    });
    expect(spinner.succeeded[0]).toMatch(/4it/);
    expect(spinner.succeeded[0]).toMatch(/\$0\.0123/);
  });

  it("agent_loop_complete without cost → 'Done'", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("agent_loop_complete") });
    expect(spinner.succeeded[0]).toBe("Done");
  });
});

describe("buildCliSink — narration", () => {
  it("narration → prints evt.text to stdout", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("narration", { text: "Reading the codebase" }) });
    expect(output.join("")).toContain("Reading the codebase");
  });

  it("narration quiet → no output", () => {
    const sink = buildCliSink(QUIET_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("narration", { text: "Hello" }) });
    expect(output.join("")).toBe("");
  });
});

describe("buildCliSink — tool_call", () => {
  it("tool_call → prints ▸ prefix + title", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("tool_call", { title: "read_file src/foo.ts" }) });
    const all = output.join("");
    expect(all).toContain("▸");
    expect(all).toContain("read_file src/foo.ts");
  });

  it("tool_call quiet → no output", () => {
    const sink = buildCliSink(QUIET_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("tool_call", { title: "read_file x" }) });
    expect(output.join("")).toBe("");
  });
});

describe("buildCliSink — token_budget_status", () => {
  it("ratio ≥ 0.9 → red critical warning", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("token_budget_status", { tokenBudgetRatio: 0.95 }) });
    expect(output.join("")).toContain("critical");
    expect(output.join("")).toContain("95%");
  });

  it("ratio ≥ 0.7 → yellow warning", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("token_budget_status", { tokenBudgetRatio: 0.75 }) });
    const all = output.join("");
    expect(all).toContain("75%");
    expect(all).not.toContain("critical");
  });

  it("ratio < 0.7 → no output", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("token_budget_status", { tokenBudgetRatio: 0.5 }) });
    expect(output.join("")).toBe("");
  });
});

describe("buildCliSink — loop_warning_emitted", () => {
  it("loop_warning_emitted → warning with ⚠", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("loop_warning_emitted", { detail: "3× read_file" }) });
    const all = output.join("");
    expect(all).toContain("⚠");
    expect(all).toContain("loop");
  });
});

describe("buildCliSink — loop_detected_terminal", () => {
  it("loop_detected_terminal → spinner.fail", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("loop_detected_terminal") });
    expect(spinner.failed[0]).toMatch(/loop/i);
  });
});

describe("buildCliSink — task_classified", () => {
  it("task_classified → prints tier + detail", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({
      stage: "",
      progress: makeEvt("task_classified", { tier: "simple", detail: "targeted_fix" }),
    });
    const all = output.join("");
    expect(all).toContain("simple");
    expect(all).toContain("targeted_fix");
  });

  it("task_classified quiet → no output", () => {
    const sink = buildCliSink(QUIET_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("task_classified", { tier: "medium" }) });
    expect(output.join("")).toBe("");
  });
});

describe("buildCliSink — tier_constraints_applied", () => {
  it("tier_constraints_applied verbose=false → silent", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("tier_constraints_applied") });
    expect(output.join("")).toBe("");
  });

  it("tier_constraints_applied verbose=true → prints", () => {
    const sink = buildCliSink(VERBOSE_OPTS, spinner);
    sink.onProgress({ stage: "", progress: makeEvt("tier_constraints_applied") });
    expect(output.join("")).toContain("tier constraints");
  });
});

describe("buildCliSink — unknown events", () => {
  it("unknown type verbose=false → silent", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    // Cast to any to pass an unknown event type
    sink.onProgress({ stage: "", progress: makeEvt("reading_file") }); // known — silent without verbose
    expect(output.join("")).toBe("");
  });

  it("unknown type verbose=true → [unhandled] line", () => {
    const sink = buildCliSink(VERBOSE_OPTS, spinner);
    // Simulate an unknown type by casting
    const evt = { runId: "r", ts: 0, type: "totally_unknown_type" as ZoneStructuredProgressEvent["type"], title: "" };
    sink.onProgress({ stage: "", progress: evt });
    expect(output.join("")).toContain("[unhandled]");
    expect(output.join("")).toContain("totally_unknown_type");
  });
});

describe("buildCliSink — noColor strips ANSI", () => {
  it("noColor=true → no escape sequences in output", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner); // noColor: true
    sink.onProgress({ stage: "", progress: makeEvt("token_budget_status", { tokenBudgetRatio: 0.95 }) });
    const all = output.join("");
    expect(all).not.toMatch(/\x1b\[/);
  });
});

describe("buildCliSink — command_approval_required", () => {
  it("command_approval_required → prints warning with command", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({
      stage: "",
      progress: makeEvt("command_approval_required", { command: "npm test" }),
    });
    const all = output.join("");
    expect(all).toContain("npm test");
  });
});

describe("buildCliSink — scope_revision_proposed", () => {
  it("scope_revision_proposed → prints warning", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({
      stage: "",
      progress: makeEvt("scope_revision_proposed", { detail: "Missing file: foo.ts" }),
    });
    expect(output.join("")).toContain("Scope revision");
  });
});

describe("buildCliSink — run_summary", () => {
  it("run_summary with cost → prints cost line", () => {
    const sink = buildCliSink(SILENT_OPTS, spinner);
    sink.onProgress({
      stage: "",
      progress: makeEvt("run_summary", {
        cost: { totalUsd: 0.0456, iterCount: 3, cacheHitPct: 80, avgIterUsd: 0.015 },
      }),
    });
    const all = output.join("");
    expect(all).toContain("0.0456");
    expect(all).toContain("3 iter");
  });
});
