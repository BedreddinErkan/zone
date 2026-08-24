/**
 * The CLI sink's spinner must not write to the terminal when the caller supplies its own
 * onProgress (ledger item 352).
 *
 * This file deliberately does NOT mock ./sink.js. Every other dispatch test does
 * (`vi.mock("./sink.js", …)` with a `createSpinner: () => ({ stop: vi.fn() })` stub), which is
 * precisely why the defect had no observer: a stubbed spinner cannot perform the stderr write that
 * is the whole problem. The real sink is used here so the write happens if it is going to.
 *
 * The assertion is on the PROPERTY — that no carriage-return + erase-line reaches stderr across a
 * run — not on the setting that currently produces it. A test asserting "stop() was not called"
 * would pin this one call site and miss the same sequence arriving by any other route.
 *
 * The escape sequence is written out as a literal here rather than imported from sink.ts, so that
 * changing the literal at the source is caught rather than tracked. Three assertions in this series
 * have referenced their own subject; this one does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRunLlmPatchFlow = vi.hoisted(() => vi.fn());

vi.mock("../core/runLlmPatchFlow.js", () => ({
  runLlmPatchFlow: mockRunLlmPatchFlow,
  isChitchat: () => false,
  isVagueDeveloperTask: () => false,
}));
vi.mock("../api/commandApprovals.js", () => ({
  rejectPendingApprovalsForRun: vi.fn().mockReturnValue(0),
  clearTrustedCommandsForRun: vi.fn().mockReturnValue(0),
  setTrustAllForRun: vi.fn(),
}));
vi.mock("../llm/revisionApprovals.js", () => ({
  rejectPendingRevisionsForRun: vi.fn().mockReturnValue(0),
}));
vi.mock("../llm/planApprovals.js", () => ({
  requestPlanApproval: vi.fn(),
  rejectPendingPlansForRun: vi.fn().mockReturnValue(0),
}));
vi.mock("../api/questionApprovals.js", () => ({
  rejectPendingQuestionsForRun: vi.fn().mockReturnValue(0),
}));
vi.mock("../api/stagedApprovals.js", () => ({
  rejectPendingStagedForRun: vi.fn().mockReturnValue(0),
}));

import { runOneShotInner } from "./dispatch.js";

/** The exact chunk sink.ts's clear() emits. Literal on purpose — see the file header. */
const CLEAR_LINE = "\r[K";

const CONFIG = {
  model: "claude-sonnet-4-6",
  provider: "anthropic" as const,
  anthropicApiKey: "sk-ant-test",
  openaiApiKey: undefined,
  dailyUsdCap: 10,
  repoPath: "/tmp/test-repo",
  forceTier: undefined,
  autoApprove: false,
  noRevision: false,
  verbose: false,
  quiet: true,
  noColor: true,
};

let writes: string[];
let restoreWrite: (() => void) | null = null;
let restoreTty: (() => void) | null = null;

function captureStderr(): void {
  writes = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    writes.push(String(chunk));
    return (original as any)(chunk, ...rest);
  };
  restoreWrite = () => { (process.stderr as any).write = original; };
}

/** clear() is gated on isTTY, so a non-TTY test environment would make every assertion vacuous. */
function forceTty(value: boolean): void {
  const had = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY");
  const prev = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
  restoreTty = () => {
    if (had) Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true, writable: true });
    else delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunLlmPatchFlow.mockResolvedValue({ ok: true, decisionMode: "chat", patchPreview: "" });
});

afterEach(() => {
  restoreWrite?.(); restoreWrite = null;
  restoreTty?.(); restoreTty = null;
});

describe("item 352 — the sink spinner does not write to the terminal when the caller owns progress", () => {
  it("HARNESS FLOOR: the capture sees a write it is meant to see", () => {
    // Without this, a broken spy would make every absence assertion below pass vacuously.
    forceTty(true);
    captureStderr();
    process.stderr.write(CLEAR_LINE);
    expect(writes).toContain(CLEAR_LINE);
    // And pin the constant itself by construction, not by comparison with itself: a literal that
    // silently lost its ESC byte would make the absence assertions below match nothing and pass.
    expect(CLEAR_LINE).toBe("\r" + String.fromCharCode(27) + "[K");
    expect(CLEAR_LINE.length).toBe(4);
  });

  it("emits no clear-line to stderr across a run that supplies its own onProgress", async () => {
    forceTty(true);
    captureStderr();

    await runOneShotInner("fix bug", CONFIG, "run-owns-progress", { onProgress: () => {} });

    expect(writes).not.toContain(CLEAR_LINE);
    expect(writes.some((w) => w.includes("[K"))).toBe(false);
  });

  it("negative control — a run WITHOUT onProgress is the headless shape and is not constrained here", async () => {
    // The sink is live on that path and legitimately owns the terminal, so this test asserts only
    // that the run completes. If it asserted absence too, it would be pinning behaviour this entry
    // deliberately leaves alone, and a fix that broke headless would still pass.
    forceTty(true);
    captureStderr();

    const result = await runOneShotInner("fix bug", CONFIG, "run-headless-shape");

    expect(result).toBeDefined();
  });
});
