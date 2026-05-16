/**
 * Phase AS.0 — revisionApprovals state machine tests.
 * Mirrors planApprovals.test.ts in structure.
 */

import { describe, expect, it } from "vitest";
import {
  requestRevisionApproval,
  resolveRevisionApproval,
  rejectPendingRevisionsForRun,
  type RevisionProposal,
} from "./revisionApprovals.js";

const PROPOSAL: RevisionProposal = {
  runId: "run-rev-001",
  type: "under_scope",
  reason: "Found auth middleware missing from plan.",
  originalPlan: "Update UserController only.",
  revisedPlanSummary: "Update UserController + auth middleware.",
  missingFiles: ["src/middleware/auth.ts"],
};

function makeEmit() {
  const events: unknown[] = [];
  return {
    emit: (evt: unknown) => { events.push(evt); },
    events,
  };
}

describe("requestRevisionApproval + resolveRevisionApproval", () => {
  it("emits scope_revision_proposed event with revisionId", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve(); // flush microtasks
    expect(events).toHaveLength(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt["type"]).toBe("scope_revision_proposed");
    expect(typeof evt["revisionId"]).toBe("string");
    expect(evt["runId"]).toBe("run-rev-001");
    expect(evt["revisionType"]).toBe("under_scope");

    // clean up
    const rid = evt["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: "run-rev-001", decision: "reject" });
    await p;
  });

  it("resolves with 'approve' when approve decision is submitted", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: "run-rev-001", decision: "approve" });
    const result = await p;
    expect(result.decision).toBe("approve");
    expect(result.revisionId).toBe(rid);
  });

  it("resolves with 'reject' when reject decision is submitted", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: "run-rev-001", decision: "reject" });
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("returns ok:false for unknown revisionId", () => {
    const r = resolveRevisionApproval({ revisionId: "nonexistent", runId: "run-x", decision: "approve" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("unknown_revision_id");
  });

  it("returns ok:false for run_id_mismatch", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    const r = resolveRevisionApproval({ revisionId: rid, runId: "wrong-run", decision: "approve" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("run_id_mismatch");
    // clean up
    resolveRevisionApproval({ revisionId: rid, runId: "run-rev-001", decision: "reject" });
    await p;
  });
});

describe("Phase Y.1.1 — autoApprove bypass", () => {
  it("resolves immediately with 'approve' and no SSE emission when autoApprove=true", async () => {
    const { emit, events } = makeEmit();
    const result = await requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: true });
    expect(result.decision).toBe("approve");
    expect(typeof result.revisionId).toBe("string");
    expect(events).toHaveLength(0);
  });

  it("autoApprove=false falls through to normal SSE path", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, autoApprove: false });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: PROPOSAL.runId, decision: "approve" });
    const result = await p;
    expect(result.decision).toBe("approve");
  });

  it("autoApprove=undefined falls through to normal SSE path", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any });
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: PROPOSAL.runId, decision: "reject" });
    await p;
  });
});

describe("Phase Y.1.2 — timeout decision", () => {
  it("resolves with 'timeout' when timeoutMs elapses without approval", async () => {
    const { emit } = makeEmit();
    const result = await requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, timeoutMs: 30 });
    expect(result.decision).toBe("timeout");
    expect(typeof result.revisionId).toBe("string");
  });

  it("abort signal resolves with 'reject' (not 'timeout')", async () => {
    const { emit } = makeEmit();
    const ctrl = new AbortController();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, timeoutMs: 10_000, abortSignal: ctrl.signal });
    ctrl.abort();
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("explicit client reject resolves with 'reject' (not 'timeout')", async () => {
    const { emit, events } = makeEmit();
    const p = requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, timeoutMs: 10_000 });
    await Promise.resolve();
    const rid = (events[0] as Record<string, unknown>)["revisionId"] as string;
    resolveRevisionApproval({ revisionId: rid, runId: PROPOSAL.runId, decision: "reject" });
    const result = await p;
    expect(result.decision).toBe("reject");
  });

  it("already-aborted signal resolves immediately with 'reject'", async () => {
    const { emit } = makeEmit();
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await requestRevisionApproval({ proposal: PROPOSAL, emit: emit as any, abortSignal: ctrl.signal });
    expect(result.decision).toBe("reject");
  });
});

describe("rejectPendingRevisionsForRun", () => {
  it("rejects all pending revisions for a run and returns count", async () => {
    const { emit: emit1 } = makeEmit();
    const { emit: emit2 } = makeEmit();
    const p1 = requestRevisionApproval({ proposal: { ...PROPOSAL, runId: "run-cancel-001" }, emit: emit1 as any });
    const p2 = requestRevisionApproval({ proposal: { ...PROPOSAL, runId: "run-cancel-001" }, emit: emit2 as any });
    await Promise.resolve();

    const count = rejectPendingRevisionsForRun("run-cancel-001");
    expect(count).toBe(2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.decision).toBe("reject");
    expect(r2.decision).toBe("reject");
  });

  it("returns 0 for a run with no pending revisions", () => {
    expect(rejectPendingRevisionsForRun("no-such-run")).toBe(0);
  });
});
