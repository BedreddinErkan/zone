import "dotenv/config";
import express from "express";
import cors from "cors";
import { runAgent } from "../core/runAgent.js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import bodyParser from "body-parser";
import { runTestEngineerFlow } from "../roles/runTestEngineerFlow.js";

const app = express();
const PORT = process.env.PORT || 3000;


app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post("/api/analyze", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runAgent({ task });
  res.json({
    decision: result.decision,
    risk: result.risk,
    confidence: result.confidence
  });
});
app.use((req, res, next) => {
  express.json()(req, res, (err) => {
    if (err) return next(err);
    next();
  });
});
app.post("/api/patch", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runLlmPatchFlow({ task, repoPath });
  res.json(result);
});
app.post("/api/patch", async (req, res) => {
  const { task, repoPath } = req.body;
  const result = await runLlmPatchFlow({ task, repoPath });
  res.json(result);
});
app.post("/api/apply", async (req, res) => {
  const { patches, repoPath } = req.body;
  const result = await applyLlmPatches(patches, repoPath);
  res.json(result);
});

app.use(express.static("src/ui"));
app.post("/api/test-engineer", async (req, res) => {
  const { task, repoPath } = req.body;

  if (!task || !repoPath) {
    res.status(400).json({ ok: false, reason: "task and repoPath are required" });
    return;
  }

  try {
    const result = await runTestEngineerFlow({ task, repoPath });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error",
    });
  }
});
app.listen(PORT, () => {
  console.log(`Zone API running on http://localhost:${PORT}`);
});
