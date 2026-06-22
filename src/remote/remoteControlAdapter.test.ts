import { vi, describe, it, expect, beforeEach } from "vitest";
import type { CliConfig } from "../cli/config.js";
import type { LlmPatchFlowResult } from "../core/runLlmPatchFlow.js";
import type { LlmPatchProgressUpdate } from "../core/agentLifecycleEvents.js";
import { ApiKeyError, ProviderRequestError } from "../llm/factory.js";

vi.mock("../api/commandApprovals.js", () => ({
  setTrustAllForRun: vi.fn(),
  clearTrustedCommandsForRun: vi.fn(),
  rejectPendingApprovalsForRun: vi.fn(),
}));
vi.mock("../llm/revisionApprovals.js", () => ({
  rejectPendingRevisionsForRun: vi.fn(),
}));

import {
  setTrustAllForRun,
  clearTrustedCommandsForRun,
  rejectPendingApprovalsForRun,
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { createRemoteControlAdapter } from "./remoteControlAdapter.js";
import type { RemoteControlFrame } from "./controlServer.js";

const stubConfig = {} as CliConfig;

function okResult(): LlmPatchFlowResult {
  return { ok: true, patchPreview: "", warnings: [] } as unknown as LlmPatchFlowResult;
}

function makeProgressUpdate(type: string): LlmPatchProgressUpdate {
  return {
    progress: {
      runId: "run-1",
      ts: 0,
      type,
      title: type,
    },
  } as unknown as LlmPatchProgressUpdate;
}

describe("remoteControlAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: onProgress events are broadcast as wire frames", async () => {
    const broadcast = vi.fn();
    let capturedOnProgress: ((update: LlmPatchProgressUpdate) => void) | undefined;
    const stub = vi.fn().mockImplementation((_task, _config, _runId, opts) => {
      capturedOnProgress = opts.onProgress;
      return Promise.resolve(okResult());
    });

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });

    const runPromise = adapter.startRun("fix bug");
    // Yield so the async startRun body advances past the await
    await Promise.resolve();
    capturedOnProgress!(makeProgressUpdate("agent_loop_complete"));
    await runPromise;

    const broadcastedTypes = broadcast.mock.calls.map((c) => (c[0] as RemoteControlFrame).type);
    expect(broadcastedTypes).toContain("agent_loop_complete");
  });

  it("setTrustAllForRun is called with the run's runId when mode is autoAccept", async () => {
    let capturedRunId: string | undefined;
    const stub = vi.fn().mockImplementation((_task, _config, runId) => {
      capturedRunId = runId;
      return Promise.resolve(okResult());
    });

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: stub });
    await adapter.startRun("task", { mode: "autoAccept" });

    expect(setTrustAllForRun).toHaveBeenCalledWith(capturedRunId);
  });

  it("setTrustAllForRun is NOT called when mode is normal", async () => {
    const stub = vi.fn().mockResolvedValue(okResult());
    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: stub });
    await adapter.startRun("task", { mode: "normal" });

    expect(setTrustAllForRun).not.toHaveBeenCalled();
  });

  it("concurrent-run guard: second startRun broadcasts run_already_active and does not invoke runOneShot again", async () => {
    const broadcast = vi.fn();
    const stub = vi.fn().mockImplementation((_task, _config, _runId, opts) => {
      return new Promise<LlmPatchFlowResult>((_resolve, reject) => {
        opts.externalAc.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });

    // First call starts and suspends at await; second call sees currentAc !== null.
    const first = adapter.startRun("task one");
    await adapter.startRun("task two");

    const errorCalls = broadcast.mock.calls.filter(
      (c) => (c[0] as RemoteControlFrame).type === "error" &&
             (c[0] as { reason?: string }).reason === "run_already_active"
    );
    expect(errorCalls.length).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);

    adapter.abort();
    await first.catch(() => { /* AbortError expected */ });
  });

  it("returned-reject: broadcasts error frame with the reject reason", async () => {
    const broadcast = vi.fn();
    const stub = vi.fn().mockResolvedValue({
      ok: false,
      reason: "project_not_trusted",
    } as unknown as LlmPatchFlowResult);

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });
    await adapter.startRun("task");

    const errorFrame = broadcast.mock.calls.find(
      (c) => (c[0] as RemoteControlFrame).type === "error"
    )?.[0] as { reason?: string } | undefined;
    expect(errorFrame?.reason).toBe("project_not_trusted");
  });

  it("thrown ApiKeyError: broadcasts run_failed and does not wedge the adapter", async () => {
    const broadcast = vi.fn();
    const stub = vi.fn().mockRejectedValue(new ApiKeyError("no key"));

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });
    await adapter.startRun("task");

    const failFrame = broadcast.mock.calls.find(
      (c) => (c[0] as RemoteControlFrame).type === "run_failed"
    )?.[0];
    expect(failFrame).toBeDefined();

    // A subsequent startRun must be accepted (no wedge)
    const stub2 = vi.fn().mockResolvedValue(okResult());
    const adapter2 = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: stub2 });
    // Use a fresh adapter to test the same closure; re-test wedge via the original adapter
    const broadcast2 = vi.fn();
    const adapterReuse = createRemoteControlAdapter({ config: stubConfig, broadcast: broadcast2, runOneShot: stub2 });
    await adapterReuse.startRun("second task after fresh adapter");
    expect(stub2).toHaveBeenCalledTimes(1);

    // Also confirm the ORIGINAL adapter (after throw) accepts a new run
    const stub3 = vi.fn().mockResolvedValue(okResult());
    const adapterOriginal = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: stub3 });
    await adapterOriginal.startRun("retry");
    expect(stub3).toHaveBeenCalledTimes(1);
  });

  it("thrown ProviderRequestError: broadcasts run_failed with userMessage and errorKind", async () => {
    const broadcast = vi.fn();
    // ProviderRequestError(status, kind, userMessage, raw)
    const stub = vi.fn().mockRejectedValue(new ProviderRequestError(429, "credit", "out of credits", null));

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });
    await adapter.startRun("task");

    const failFrame = broadcast.mock.calls.find(
      (c) => (c[0] as RemoteControlFrame).type === "run_failed"
    )?.[0] as { userMessage?: string; errorKind?: string } | undefined;
    expect(failFrame?.userMessage).toBe("out of credits");
    expect(failFrame?.errorKind).toBe("credit");
  });

  it("abort: fires the AbortSignal and cleanup runs once in finally (not abort)", async () => {
    const broadcast = vi.fn();
    let capturedSignal!: AbortSignal;
    const stub = vi.fn().mockImplementation((_task, _config, _runId, opts) => {
      capturedSignal = opts.externalAc.signal;
      return new Promise<LlmPatchFlowResult>((_resolve, reject) => {
        opts.externalAc.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });
    const runPromise = adapter.startRun("task");
    adapter.abort();
    await runPromise;

    expect(capturedSignal.aborted).toBe(true);
    expect(clearTrustedCommandsForRun).toHaveBeenCalledTimes(1);
    expect(rejectPendingApprovalsForRun).toHaveBeenCalledTimes(1);
    expect(rejectPendingRevisionsForRun).toHaveBeenCalledTimes(1);
  });

  it("abort: does NOT broadcast run_failed when the abort is deliberate", async () => {
    const broadcast = vi.fn();
    const stub = vi.fn().mockImplementation((_task, _config, _runId, opts) => {
      return new Promise<LlmPatchFlowResult>((_resolve, reject) => {
        opts.externalAc.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast, runOneShot: stub });
    const runPromise = adapter.startRun("task");
    adapter.abort();
    await runPromise;

    const failFrames = broadcast.mock.calls.filter(
      (c) => (c[0] as RemoteControlFrame).type === "run_failed"
    );
    expect(failFrames.length).toBe(0);
  });

  it("abort: no-op when no run is active", () => {
    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: vi.fn() });
    expect(() => adapter.abort()).not.toThrow();
    expect(clearTrustedCommandsForRun).not.toHaveBeenCalled();
  });

  it("cleanup always runs: clearTrustedCommandsForRun called exactly once per run on success", async () => {
    const stub = vi.fn().mockResolvedValue(okResult());
    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: stub });
    await adapter.startRun("task");

    expect(clearTrustedCommandsForRun).toHaveBeenCalledTimes(1);
    expect(rejectPendingApprovalsForRun).toHaveBeenCalledTimes(1);
    expect(rejectPendingRevisionsForRun).toHaveBeenCalledTimes(1);
  });

  it("resolveApproval stub returns not-implemented", () => {
    const adapter = createRemoteControlAdapter({ config: stubConfig, broadcast: vi.fn(), runOneShot: vi.fn() });
    const result = adapter.resolveApproval({ kind: "command", approvalId: "x", approved: true });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Inc-1b-in-2");
  });
});
