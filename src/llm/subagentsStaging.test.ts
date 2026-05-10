import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeStaging } from "./agentLoop.js";
import { executeTool, withStagingTempFlush } from "../tools/toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-subagent-staging-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("subagent staging safety", () => {
  it("records worker writes in the parent stagingFiles map without flushing", async () => {
    const parentStaging = new Map<string, string>();
    const result = await executeTool(
      "write_file",
      {
        filePath: "src/worker-output.ts",
        content: "export const workerOutput = true;\n",
      },
      repoPath,
      undefined,
      {
        runId: "run-1",
        stagingFiles: parentStaging,
      }
    );

    const abs = path.join(repoPath, "src/worker-output.ts");
    expect(result.success).toBe(true);
    expect(parentStaging.get(abs)).toBe("export const workerOutput = true;\n");
    expect(fs.existsSync(abs)).toBe(false);
  });

  it("blocks Task dispatch when the parent has staged writes", async () => {
    const parentStaging = new Map<string, string>();
    parentStaging.set(path.join(repoPath, "src/existing.ts"), "export const x = 1;\n");

    const result = await executeTool(
      "Task",
      {
        subagent_type: "worker",
        description: "Update src/existing.ts",
      },
      repoPath,
      undefined,
      {
        runId: "run-1",
        stagingFiles: parentStaging,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("task_dispatch_blocked_parent_has_staged_writes");
    expect(result.rejectionReason).toBe("parent_staged_writes_present");
  });

  it("flushes worker-staged paths when the parent finalizes staging", async () => {
    const abs = path.join(repoPath, "src/worker-output.ts");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const parentStaging = new Map<string, string>([
      [abs, "export const flushedByParent = true;\n"],
    ]);

    const result = await finalizeStaging({
      stagingFiles: parentStaging,
      repoPath,
      framework: undefined,
      withStagingTempFlush,
    });

    expect(result.flushed).toBe(true);
    expect(result.filesFlushed).toBe(1);
    expect(fs.readFileSync(abs, "utf8")).toBe("export const flushedByParent = true;\n");
  });

  it("keeps worker write_file on staging only until parent flush", async () => {
    const parentStaging = new Map<string, string>();
    const abs = path.join(repoPath, "src/deferred.ts");

    await executeTool(
      "write_file",
      {
        filePath: "src/deferred.ts",
        content: "export const deferred = true;\n",
      },
      repoPath,
      undefined,
      {
        runId: "run-1",
        stagingFiles: parentStaging,
      }
    );

    expect(parentStaging.has(abs)).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
  });
});
