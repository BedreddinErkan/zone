import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { runAgent } from "../core/runAgent.js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import { runTestEngineerFlow } from "../roles/runTestEngineerFlow.js";
import { runDataAnalystFlow } from "../roles/runDataAnalystFlow.js";
import type { Response } from "express";
import { c, colorize } from "../cli/colors.js";

export const app = express();
const PORT = process.env.PORT || 3000;
const progressStreams = new Map<string, Set<Response>>();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function emitProgress(runId: string | undefined, stage: string): void {
  if (!runId) return;
  const listeners = progressStreams.get(runId);
  if (!listeners) return;

  const payload = `data: ${JSON.stringify({ stage })}\n\n`;
  for (const res of listeners) {
    res.write(payload);
  }
}

app.get("/api/progress", (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : "";
  if (!runId) {
    res.status(400).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ stage: "Connected" })}\n\n`);

  const listeners = progressStreams.get(runId) ?? new Set<Response>();
  listeners.add(res);
  progressStreams.set(runId, listeners);

  req.on("close", () => {
    const current = progressStreams.get(runId);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) {
      progressStreams.delete(runId);
    }
  });
});

app.post("/api/analyze", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runAgent({ task, role: "developer" });
  res.json({
    decision: result.decision,
    risk: result.risk,
    confidence: result.confidence,
  });
});

app.post("/api/patch", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runLlmPatchFlow({ task, repoPath });
  res.json(result);
});

app.post("/api/dry-run", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runLlmPatchFlow({ task, repoPath, dryRun: true });
  if (!result.ok) {
    res.status(500).json(result);
    return;
  }

  res.json({
    ok: true,
    fileDiffs: result.fileDiffs ?? [],
    patchPreview: result.patchPreview,
    warnings: result.warnings,
    patchResults: result.patchResults,
  });
});

app.post("/api/apply", async (req, res) => {
  const { patches, repoPath } = req.body;
  const result = await applyLlmPatches(patches, repoPath);
  res.json(result);
});

app.post("/api/test-engineer", async (req, res) => {
  const { task, repoPath, runId } = req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
  try {
    const result = await runTestEngineerFlow({
      task,
      repoPath,
      onProgress: (stage) => emitProgress(runId, stage),
    });
    res.json(result);
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.post("/api/data-analyst", async (req, res) => {
  const { task, repoPath, runId } = req.body;
  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }
  try {
    const result = await runDataAnalystFlow({
      task,
      repoPath,
      onProgress: (stage) => emitProgress(runId, stage),
    });
    res.json(result);
  } catch (err) {
    emitProgress(runId, "Ready");
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

app.use(express.static("src/ui"));

export async function startServer(port = 3000): Promise<void> {
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(
        colorize(`Zone UI running on http://localhost:${port}`, c.green, c.bold)
      );
      console.log(colorize("Press Ctrl+C to stop", c.dim, c.gray));
      resolve();
    });
  });
}

if (
  process.env.VITEST !== "true" &&
  process.env.ZONE_SERVER_MANUAL_START !== "1"
) {
  void startServer(Number(PORT));
}
