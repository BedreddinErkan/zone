import { describe, it, expect } from "vitest";
import {
  requestTrustApproval,
  resolveTrustApproval,
  rejectPendingTrustForRun,
} from "./trustApprovals.js";

const NO_EMIT = (): void => {};

describe("requestTrustApproval / resolveTrustApproval round-trip", () => {
  it("resolves true when resolved with ok=true", async () => {
    const runId = "test-run-resolve-true";
    const promise = requestTrustApproval({
      runId,
      projectPath: "/some/project",
      emit: NO_EMIT,
    });
    const result = resolveTrustApproval(runId, true);
    expect(result.ok).toBe(true);
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when resolved with ok=false", async () => {
    const runId = "test-run-resolve-false";
    const promise = requestTrustApproval({
      runId,
      projectPath: "/some/project",
      emit: NO_EMIT,
    });
    const result = resolveTrustApproval(runId, false);
    expect(result.ok).toBe(true);
    await expect(promise).resolves.toBe(false);
  });

  it("returns unknown_run_id when no pending approval exists", () => {
    const result = resolveTrustApproval("nonexistent-run", true);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("unknown_run_id");
  });
});

describe("emit callback is called with correct shape", () => {
  it("emits trust_approval_required with correct fields", async () => {
    const runId = "test-run-emit";
    const projectPath = "/my/project";
    let emitted: unknown = null;
    const promise = requestTrustApproval({
      runId,
      projectPath,
      emit: (evt) => { emitted = evt; },
    });
    resolveTrustApproval(runId, false);
    await promise;
    expect(emitted).toMatchObject({
      type: "trust_approval_required",
      runId,
      projectPath,
      approvalId: runId,
    });
  });
});

describe("rejectPendingTrustForRun", () => {
  it("resolves pending approval as false and returns count 1", async () => {
    const runId = "test-run-reject";
    const promise = requestTrustApproval({
      runId,
      projectPath: "/some/project",
      emit: NO_EMIT,
    });
    const count = rejectPendingTrustForRun(runId);
    expect(count).toBe(1);
    await expect(promise).resolves.toBe(false);
  });

  it("returns 0 when no pending approval for that run", () => {
    expect(rejectPendingTrustForRun("nonexistent-run")).toBe(0);
  });
});

describe("abortSignal integration", () => {
  it("resolves false when abortSignal fires before emit", async () => {
    const runId = "test-run-abort";
    const ac = new AbortController();
    ac.abort();
    const result = await requestTrustApproval({
      runId,
      projectPath: "/some/project",
      emit: NO_EMIT,
      abortSignal: ac.signal,
    });
    expect(result).toBe(false);
  });
});
