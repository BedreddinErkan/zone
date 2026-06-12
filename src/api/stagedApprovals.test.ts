import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  requestStagedApproval,
  resolveStagedApproval,
  rejectPendingStagedForRun,
} from "./stagedApprovals.js";
import type { StagedFile } from "../core/fileDiff.js";

const FAKE_FILES: StagedFile[] = [
  { path: "src/foo.ts", findReplace: "", added: 3, removed: 1 },
];

function makeInput(overrides?: Record<string, unknown>) {
  const emitted: unknown[] = [];
  return {
    runId: "run-1",
    files: FAKE_FILES,
    verificationSummary: "tsc ✓",
    trigger: "natural_completion" as const,
    emit: vi.fn((evt) => { emitted.push(evt); }),
    timeoutMs: 5000,
    emitted,
    ...overrides,
  };
}

describe("requestStagedApproval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("autoApprove:true resolves immediately to approve_all without emission", async () => {
    const input = makeInput({ autoApprove: true });
    const result = await requestStagedApproval(input);
    expect(result.decision).toBe("approve_all");
    expect(input.emit).not.toHaveBeenCalled();
  });

  it("emits staged_diffs_ready_for_approval LAST (synchronous resolvers find entry)", () => {
    const input = makeInput();
    const entries: string[] = [];
    const origEmit = input.emit;
    input.emit = vi.fn((evt) => {
      entries.push("emit");
      origEmit(evt);
    });

    let resolveCount = 0;
    const p = requestStagedApproval(input).then((r) => {
      resolveCount++;
      return r;
    });

    // The emit must happen synchronously after Map.set — so resolveCount should be 0 before emit
    // We test the round-trip by immediately resolving via the approvalId from the emitted event
    const emittedEvt = (input.emit.mock.calls[0]?.[0] as { approvalId: string } | undefined);
    expect(emittedEvt?.approvalId).toBeDefined();
    resolveStagedApproval({
      approvalId: emittedEvt!.approvalId,
      runId: "run-1",
      decision: "approve_all",
    });
    return p.then((r) => {
      expect(r.decision).toBe("approve_all");
    });
  });

  it("resolve with approve_all decision", async () => {
    const input = makeInput();
    const p = requestStagedApproval(input);
    const evt = input.emit.mock.calls[0]?.[0] as { approvalId: string };
    resolveStagedApproval({ approvalId: evt.approvalId, runId: "run-1", decision: "approve_all" });
    const result = await p;
    expect(result.decision).toBe("approve_all");
    expect(result.approvalId).toBe(evt.approvalId);
  });

  it("resolve with refine decision passes feedback", async () => {
    const input = makeInput();
    const p = requestStagedApproval(input);
    const evt = input.emit.mock.calls[0]?.[0] as { approvalId: string };
    resolveStagedApproval({
      approvalId: evt.approvalId,
      runId: "run-1",
      decision: "refine",
      feedback: "please fix the imports",
    });
    const result = await p;
    expect(result.decision).toBe("refine");
    expect(result.feedback).toBe("please fix the imports");
  });

  it("resolve with reject decision", async () => {
    const input = makeInput();
    const p = requestStagedApproval(input);
    const evt = input.emit.mock.calls[0]?.[0] as { approvalId: string };
    resolveStagedApproval({ approvalId: evt.approvalId, runId: "run-1", decision: "reject" });
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("timeout fires after timeoutMs and resolves to timeout decision", async () => {
    const input = makeInput({ timeoutMs: 1000 });
    const p = requestStagedApproval(input);
    vi.advanceTimersByTime(1001);
    const result = await p;
    expect(result.decision).toBe("timeout");
  });

  it("abort signal fires → reject decision", async () => {
    const ac = new AbortController();
    const input = makeInput({ abortSignal: ac.signal });
    const p = requestStagedApproval(input);
    ac.abort();
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("abort signal already aborted → resolves immediately to reject", async () => {
    const ac = new AbortController();
    ac.abort();
    const input = makeInput({ abortSignal: ac.signal });
    const result = await requestStagedApproval(input);
    expect(result.decision).toBe("reject");
  });
});

describe("resolveStagedApproval", () => {
  it("unknown_approval_id returns ok:false", () => {
    const result = resolveStagedApproval({
      approvalId: "nonexistent",
      runId: "run-1",
      decision: "approve_all",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("unknown_approval_id");
  });

  it("run_id_mismatch returns ok:false", async () => {
    const input = makeInput();
    const p = requestStagedApproval(input);
    const evt = input.emit.mock.calls[0]?.[0] as { approvalId: string };
    const result = resolveStagedApproval({
      approvalId: evt.approvalId,
      runId: "wrong-run",
      decision: "approve_all",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("run_id_mismatch");
    // clean up
    resolveStagedApproval({ approvalId: evt.approvalId, runId: "run-1", decision: "reject" });
    await p;
  });
});

describe("rejectPendingStagedForRun", () => {
  it("rejects all pending entries for the matching runId", async () => {
    const input1 = makeInput({ runId: "run-A" });
    const input2 = makeInput({ runId: "run-A" });
    const p1 = requestStagedApproval(input1);
    const p2 = requestStagedApproval(input2);
    const n = rejectPendingStagedForRun("run-A");
    expect(n).toBe(2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.decision).toBe("reject");
    expect(r2.decision).toBe("reject");
  });

  it("does not affect entries for different runId", async () => {
    const inputA = makeInput({ runId: "run-keep" });
    const p = requestStagedApproval(inputA);
    rejectPendingStagedForRun("run-other");
    // run-keep entry is still pending — resolve it manually
    const evt = inputA.emit.mock.calls[0]?.[0] as { approvalId: string };
    resolveStagedApproval({ approvalId: evt.approvalId, runId: "run-keep", decision: "approve_all" });
    const result = await p;
    expect(result.decision).toBe("approve_all");
  });

  it("empty runId returns 0", () => {
    expect(rejectPendingStagedForRun("")).toBe(0);
  });
});
