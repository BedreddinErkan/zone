import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { runAgent } from "../core/runAgent.js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import { runTestEngineerFlow } from "../roles/runTestEngineerFlow.js";
import { runDataAnalystFlow } from "../roles/runDataAnalystFlow.js";
import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import type { Response } from "express";
import { c, colorize } from "../cli/colors.js";

export const app = express();
const PORT = process.env.PORT || 3000;
const progressStreams = new Map<string, Set<Response>>();
const ENHANCE_TASK_SYSTEM_PROMPT =
  "You are a task optimizer for an AI code agent called Zone.\n" +
  "The user has written a vague or incomplete task description.\n" +
  "Rewrite it as a precise, actionable task that includes:\n" +
  "- The specific file or component to modify (if inferable from repo)\n" +
  "- The exact behavior or test scenario\n" +
  "- The framework/pattern already used in the repo\n" +
  "Keep it under 2 sentences. Return only the optimized task text, nothing else.";

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

function selectEnhanceContextFiles(
  role: string,
  files: Array<{ path: string; absolutePath?: string }>
): Array<{ path: string; absolutePath: string }> {
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const roleMatchers: Record<string, (path: string) => boolean> = {
    test_engineer: (filePath) =>
      /\.(spec|test)\.[jt]sx?$/i.test(filePath.replace(/\\/g, "/")),
    developer: (filePath) =>
      /^src\/.*\.ts$/i.test(filePath.replace(/\\/g, "/")),
    data_analyst: (filePath) => {
      const normalized = filePath.replace(/\\/g, "/");
      return normalized.endsWith(".sql") || normalized.includes("/migrations/");
    },
  };

  const match = roleMatchers[role] ?? (() => false);
  return sortedFiles
    .filter(
      (file): file is { path: string; absolutePath: string } =>
        Boolean(file.absolutePath) && match(file.path)
    )
    .slice(0, 3);
}

async function enhanceTask(input: {
  task: string;
  role: string;
  repoPath: string;
}): Promise<string> {
  try {
    const repoFiles = await scanRepo(input.repoPath);
    const contextFiles = selectEnhanceContextFiles(input.role, repoFiles);
    const contents =
      contextFiles.length > 0
        ? await readProjectFiles(contextFiles.map((file) => file.absolutePath))
        : {};

    const repoContext =
      contextFiles.length > 0
        ? contextFiles
            .map((file) => {
              const content = contents[file.absolutePath] ?? "";
              return `FILE: ${file.path}\n${content}`;
            })
            .join("\n\n")
        : "(no matching context files found)";

    const client = createOpenAIClient();
    const model = getModelName();
    const response = await client.responses.create({
      model,
      instructions: ENHANCE_TASK_SYSTEM_PROMPT,
      input:
        `Role: ${input.role}\n` +
        `Repo path: ${input.repoPath}\n` +
        `User task: ${input.task}\n\n` +
        `Relevant repository context:\n${repoContext}`,
    });

    return String(response.output_text || "").trim();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
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

app.post("/api/enhance-task", async (req, res) => {
  const { task, role, repoPath } = req.body;
  if (!task || !role || !repoPath) {
    res
      .status(400)
      .json({ ok: false, reason: "task, role, and repoPath are required" });
    return;
  }

  try {
    const result = await enhanceTask({ task, role, repoPath });
    res
      .type("application/json")
      .send(JSON.stringify({ ok: true, enhancedTask: result }));
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
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
