import { describe, expect, it, vi } from "vitest";

const runAgentLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./agentLoop.js", () => ({
  runAgentLoop: runAgentLoopMock,
}));

import {
  emitDeveloperPatchProgress,
  getRunBuffer,
  registerRunStart,
  routeProgressPayloadForRequestContext,
} from "../core/developerRunProgressSse.js";
import { executeTool } from "../tools/toolExecutor.js";
import { withRequestContext } from "./openaiContext.js";
import { resetSubagentCallCount } from "./subagents.js";

describe("subagent SSE event bridge", () => {
  it("enriches progress payloads with subagent metadata from request context", async () => {
    const payload = await withRequestContext(
      {
        subagentId: "worker-abc123",
        subagentType: "worker",
        parentRunId: "parent-run-1",
      },
      async () =>
        routeProgressPayloadForRequestContext("worker-run-1", {
          stage: "Reading file",
          progress: {
            runId: "worker-run-1",
            ts: 1,
            type: "tool_call",
            title: "[tool] read_file: src/index.ts",
            status: "active",
          },
        })
    );

    expect(payload?.runId).toBe("parent-run-1");
    expect(payload?.payload.progress).toMatchObject({
      runId: "parent-run-1",
      subagentId: "worker-abc123",
      subagentType: "worker",
      parentRunId: "parent-run-1",
    });
  });

  it("routes worker progress events into the parent run buffer", async () => {
    const parentRunId = `parent-${Date.now()}-route`;
    const workerRunId = `worker-${Date.now()}-route`;
    registerRunStart(parentRunId);

    await withRequestContext(
      {
        subagentId: "worker-route",
        subagentType: "worker",
        parentRunId,
      },
      async () => {
        emitDeveloperPatchProgress(workerRunId, {
          stage: "Worker tool call",
          progress: {
            runId: workerRunId,
            ts: Date.now(),
            type: "tool_call",
            title: "[tool] list_files",
            status: "active",
          },
        });
      }
    );

    const parentBuffer = getRunBuffer(parentRunId);
    const workerBuffer = getRunBuffer(workerRunId);
    expect(parentBuffer?.events.at(-1)?.payload.progress).toMatchObject({
      runId: parentRunId,
      subagentId: "worker-route",
      parentRunId,
    });
    expect(workerBuffer).toBeNull();
  });

  it("does not add subagent metadata or reroute for top-level progress", () => {
    const runId = `top-${Date.now()}-compat`;
    registerRunStart(runId);

    emitDeveloperPatchProgress(runId, {
      stage: "Top-level tool call",
      progress: {
        runId,
        ts: Date.now(),
        type: "tool_call",
        title: "[tool] read_file",
        status: "active",
      },
    });

    const progress = getRunBuffer(runId)?.events.at(-1)?.payload.progress;
    expect(progress?.runId).toBe(runId);
    expect(progress?.subagentId).toBeUndefined();
    expect(progress?.parentRunId).toBeUndefined();
  });

  it("emits Task lifecycle events around worker dispatch", async () => {
    const parentRunId = `parent-${Date.now()}-lifecycle`;
    resetSubagentCallCount(parentRunId);
    runAgentLoopMock.mockResolvedValueOnce({
      success: true,
      summary: [
        "SUMMARY: Updated the delegated file.",
        "FILES_MODIFIED: src/example.ts",
        "STATUS: completed",
      ].join("\n"),
      toolCallLog: [],
      filesModified: ["src/example.ts"],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted",
    });
    const events: Array<Record<string, unknown>> = [];

    const result = await executeTool(
      "Task",
      {
        subagent_type: "worker",
        description: "Update src/example.ts with the requested change.",
      },
      process.cwd(),
      undefined,
      {
        runId: parentRunId,
        stagingFiles: new Map(),
        onStructuredEvent: (evt) => events.push(evt as Record<string, unknown>),
      }
    );

    expect(result.success).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "subagent_started",
      "subagent_completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "subagent_started",
      subagentType: "worker",
      parentRunId,
    });
    expect(events[1]).toMatchObject({
      type: "subagent_completed",
      subagentStatus: "completed",
      status: "success",
      parentRunId,
    });
  });
});
