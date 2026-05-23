import { describe, it, expect } from "vitest";
import { classifyTask, clearClassificationCache } from "./taskClassifier.js";
import type { TaskArchetype } from "./taskClassifier.js";

const ARCHETYPE_CORPUS: Array<{
  task: string;
  expected: TaskArchetype;
}> = [
  // simple_add (6)
  { task: "Add a /api/health endpoint to src/api/server.ts that returns { status: 'ok' }", expected: "simple_add" },
  { task: "Create a utility function formatTimestamp(date) in src/utils/format.ts that returns ISO 8601 with timezone", expected: "simple_add" },
  { task: "Add a TypeScript type RunMetadata to src/types/run.ts with fields runId, startedAt, completedAt, archetype", expected: "simple_add" },
  { task: "Add an optional --verbose flag to the CLI in src/cli/index.ts that enables debug logging", expected: "simple_add" },
  { task: "Add a 'Cancel run' button to src/ui/index.html, wired to POST /api/cancel/:runId", expected: "simple_add" },
  { task: "Add a new 'Economy' preset to PRESET_BADGE_LABELS in src/ui/index.html and src/config/presets.ts", expected: "simple_add" },

  // targeted_fix (5)
  { task: "The /api/version response uses readFileSync but doesn't import it — fix the missing import in src/api/server.ts", expected: "targeted_fix" },
  { task: "The classifier in src/llm/taskClassifier.ts returns tier='medium' for tasks with 'rename' keyword — should be 'complex'. Fix the heuristic", expected: "targeted_fix" },
  { task: "The 'Approve scope revision' button doesn't disable while the request is in flight, causing double-clicks. Fix in src/ui/index.html", expected: "targeted_fix" },
  { task: "The Phase J coaching append uses single quotes inside a template string that breaks JSONL logs. Switch to JSON.stringify wrapping in src/llm/agentLoop.ts", expected: "targeted_fix" },
  { task: "The cost dashboard at /api/cost shows 0 for runs with subagent calls — recordingClient isn't capturing subagent costs. Fix in src/llm/recordingClient.ts", expected: "targeted_fix" },

  // refactor (4)
  { task: "Rename pickModel to selectModel across all callers", expected: "refactor" },
  { task: "Replace all process.env['ZONE_DAILY_USD_CAP'] reads with a centralized getDailyUsdCap() function", expected: "refactor" },
  { task: "Extract the duplicate cache_control attachment logic from convertParams.ts and convertStream.ts into a shared helper in src/llm/anthropicAdapter/cacheControlHelpers.ts", expected: "refactor" },
  { task: "Convert all then/catch promise chains in src/api/server.ts to async/await syntax", expected: "refactor" },

  // debug (4)
  { task: "The integration test src/llm/agentLoop.phaseJCoaching.test.ts fails with 'TypeError: cannot read property of undefined'. Find the root cause and fix", expected: "debug" },
  { task: "Zone-bench fixture renameDetectFramework fails on npm test step with exit code 2, no test name reported. Diagnose and fix", expected: "debug" },
  { task: "/api/branches returns 500 when called on a worktree directory. Reproduce and fix", expected: "debug" },
  { task: "Production run 45079eda shows cache_read drop to 3879 at iter 12. Investigate why and fix the cache bust", expected: "debug" },

  // investigation (3)
  { task: "Why does the R.2 shim in contextPruner.ts only prune read_file tool calls and not search_in_files?", expected: "investigation" },
  { task: "How does Phase AS audit decide between 'major' and 'minor' severity?", expected: "investigation" },
  { task: "Walk me through what happens when the daily USD cap is reached mid-run", expected: "investigation" },

  // question (12)
  { task: "What's the difference between Anthropic and OpenAI prompt caching in terms of cost economics?", expected: "question" },
  { task: "Should I use Sonnet or Opus for agentic coding tasks?", expected: "question" },
  { task: "List all TypeScript files in src/llm/", expected: "question" },
  { task: "Show all test files matching **/*.test.ts", expected: "question" },
  { task: "Which files in src/ import from taskClassifier.ts?", expected: "question" },
  { task: "Find all .ts files that export a default function", expected: "question" },
  { task: "How many source files are in src/llm/?", expected: "question" },
  { task: "Enumerate all files that reference ZONE_ARCHETYPE_DISPATCHER", expected: "question" },
  { task: "What files are in src/cli/tui/components/?", expected: "question" },
  { task: "List all test files for the agentLoop module", expected: "question" },
  { task: "Find all *.test.ts files that import from archetypeDispatcher", expected: "question" },
  { task: "Show me which src/ files export a PipelineConfig type", expected: "question" },

  // complex_multi_file (6)
  { task: "Add a 'Replay' feature: users can re-run a previous task with the same inputs. Needs UI button, /api/replay endpoint, run state restoration, telemetry", expected: "complex_multi_file" },
  { task: "Implement project memory snapshots: auto-snapshot .zone/memory.md to .zone/memory-snapshots/<timestamp>.md every 5 runs, with UI restore button", expected: "complex_multi_file" },
  { task: "Add MCP server support so users can plug in external tool servers via Settings UI", expected: "complex_multi_file" },
  { task: "Build a 'Compare runs' UI showing side-by-side diff of two runs' patches, costs, and verdicts", expected: "complex_multi_file" },
  { task: "Implement BYOM.2 multi-key storage: save multiple API keys per provider in Settings, switch between them mid-run gracefully", expected: "complex_multi_file" },
  { task: "Add a stop-words filter to the classifier so framework names ('react', 'express') don't bias tier toward complex", expected: "complex_multi_file" },
];

describe("classifier archetype accuracy", () => {
  it("achieves >=80% on labeled 40-task corpus", async () => {
    clearClassificationCache();

    const results: Array<{
      task: string;
      expected: TaskArchetype;
      actual: TaskArchetype;
      confidence: number;
      correct: boolean;
    }> = [];

    for (const { task, expected } of ARCHETYPE_CORPUS) {
      const classification = await classifyTask(task);
      results.push({
        task,
        expected,
        actual: classification.archetype,
        confidence: classification.archetypeConfidence,
        correct: classification.archetype === expected,
      });
    }

    const correct = results.filter((r) => r.correct).length;
    const accuracy = correct / ARCHETYPE_CORPUS.length;

    const failures = results.filter((r) => !r.correct);
    if (failures.length > 0) {
      console.log(`\n[archetype-accuracy] ${correct}/${ARCHETYPE_CORPUS.length} = ${(accuracy * 100).toFixed(1)}%`);
      console.log("Failures:");
      for (const f of failures) {
        console.log(`  expected=${f.expected} actual=${f.actual} (conf=${f.confidence.toFixed(2)}): ${f.task.slice(0, 80)}`);
      }
    }

    expect(accuracy).toBeGreaterThanOrEqual(0.80);
  }, 120_000);
});
