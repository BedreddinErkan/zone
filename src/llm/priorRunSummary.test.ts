/**
 * Phase J.5 — cross-run summary threading.
 *
 * Unit coverage for the pure helpers:
 *   - extractPriorRunSummary(messages) — scans a conversation history
 *     for the most recent {type:"agent_summary"} event
 *   - truncatePriorRunSummary(summary) — 2KB cap with APPLY_ROLLED_BACK
 *     marker preservation
 *
 * Plus integration assertions that runLogging persists agent_summary
 * only on rollback runs and that the agent system prompt documents
 * the PRIOR RUN CONTEXT convention.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRIOR_RUN_SUMMARY_MAX_BYTES,
  buildApplyRolledBackMessage,
  extractPriorRunSummary,
  truncatePriorRunSummary,
} from "./applyRollbackFeedback.js";
import { assembleAgentSystemPrompt } from "./agentLoop.js";

describe("Phase J.5 — extractPriorRunSummary", () => {
  it("returns the text of the most recent agent_summary message", () => {
    const messages = [
      { type: "user", text: "first task", ts: 1 },
      { type: "run", ts: 2, decisionMode: "safe_to_apply" },
      { type: "user", text: "second task", ts: 3 },
      {
        type: "agent_summary",
        ts: 4,
        decisionMode: "rolled_back",
        text:
          "APPLY_ROLLED_BACK\nYour apply_patch on src/foo.ts was rolled back.\n…",
      },
      { type: "run", ts: 5, decisionMode: "rolled_back" },
    ];
    const out = extractPriorRunSummary(messages);
    expect(out.startsWith("APPLY_ROLLED_BACK\n")).toBe(true);
  });

  it("returns the LAST agent_summary when multiple are present", () => {
    const messages = [
      { type: "agent_summary", ts: 1, text: "OLDER\nsomething" },
      { type: "user", text: "...", ts: 2 },
      { type: "agent_summary", ts: 3, text: "APPLY_ROLLED_BACK\nNEWER\n…" },
    ];
    expect(extractPriorRunSummary(messages)).toContain("NEWER");
    expect(extractPriorRunSummary(messages)).not.toContain("OLDER");
  });

  it("returns empty string when no agent_summary exists", () => {
    const messages = [
      { type: "user", text: "task", ts: 1 },
      { type: "run", ts: 2, decisionMode: "safe_to_apply" },
    ];
    expect(extractPriorRunSummary(messages)).toBe("");
  });

  it("returns empty string for empty / malformed input (Supabase missing path)", () => {
    expect(extractPriorRunSummary([])).toBe("");
    expect(extractPriorRunSummary(null)).toBe("");
    expect(extractPriorRunSummary(undefined)).toBe("");
    expect(extractPriorRunSummary("not an array")).toBe("");
    // Garbage entries don't crash:
    expect(extractPriorRunSummary([null, undefined, 0, "x", {}])).toBe("");
  });
});

describe("Phase J.5 — truncatePriorRunSummary", () => {
  it("returns short summaries unchanged", () => {
    const small = "PRIOR RUN — apply succeeded, 2 files changed.";
    expect(truncatePriorRunSummary(small)).toBe(small);
  });

  it("preserves the entire APPLY_ROLLED_BACK marker when it fits within the cap", () => {
    const marker = buildApplyRolledBackMessage({
      filePath: "src/llm/detectIntent.ts",
      errors: [
        {
          code: "TS2305",
          message: "Module has no exported member 'detectFramework'.",
          file: "src/llm/agentLoop.ts",
          line: 42,
          col: 7,
        },
      ],
      restoredFiles: ["src/llm/detectIntent.ts"],
    });
    // Pad with prelude to exceed the cap.
    const padding = "x".repeat(PRIOR_RUN_SUMMARY_MAX_BYTES);
    const summary = padding + "\n\n" + marker;
    const out = truncatePriorRunSummary(summary);
    expect(out.length).toBeLessThanOrEqual(PRIOR_RUN_SUMMARY_MAX_BYTES);
    expect(out).toContain("APPLY_ROLLED_BACK\n");
    expect(out).toContain("TS2305");
    expect(out).toContain("detectFramework");
    // Marker is at offset 0 (after the truncation notice prefix).
    expect(out.indexOf("APPLY_ROLLED_BACK")).toBeLessThan(120);
  });

  it("falls back to last-N-bytes when no marker is present", () => {
    const summary = "no marker here ".repeat(500); // ~7500 chars
    const out = truncatePriorRunSummary(summary);
    expect(out.length).toBeLessThanOrEqual(PRIOR_RUN_SUMMARY_MAX_BYTES);
    expect(out).toContain("truncated");
    expect(out.endsWith("no marker here ")).toBe(true);
  });

  it("returns marker-only when the marker block ALONE exceeds the cap", () => {
    const hugeErrors = Array.from({ length: 50 }, (_, i) => ({
      code: "TS2305",
      message: `Long error message #${i} `.repeat(10),
      file: `src/very-long-path-segment/file-${i}.ts`,
      line: i,
      col: i,
    }));
    const marker = buildApplyRolledBackMessage({
      filePath: "<multiple>",
      errors: hugeErrors,
      restoredFiles: hugeErrors.map((e) => e.file),
    });
    const summary = "prelude\n" + marker;
    expect(marker.length).toBeGreaterThan(PRIOR_RUN_SUMMARY_MAX_BYTES);
    const out = truncatePriorRunSummary(summary);
    expect(out.length).toBeLessThanOrEqual(PRIOR_RUN_SUMMARY_MAX_BYTES);
    expect(out.startsWith("APPLY_ROLLED_BACK\n")).toBe(true);
  });
});

describe("Phase J.5 — end-to-end persistence shape", () => {
  it("round-trips a rollback summary through extract → truncate → injection-ready", () => {
    // Simulate what runLogging stores when a rollback fires.
    const summary =
      "=== AGENT LOOP SUMMARY ===\n" +
      "I attempted to rename detectFramework → identifyFramework.\n\n" +
      buildApplyRolledBackMessage({
        filePath: "src/llm/detectIntent.ts",
        errors: [
          {
            code: "TS2305",
            message: "Module has no exported member 'detectFramework'.",
            file: "src/llm/agentLoop.ts",
            line: 42,
            col: 7,
          },
        ],
        restoredFiles: ["src/llm/detectIntent.ts"],
      });
    const messages = [
      { type: "user", text: "Rename detectFramework", ts: 1 },
      { type: "run", ts: 2, decisionMode: "rolled_back" },
      { type: "agent_summary", ts: 3, decisionMode: "rolled_back", text: summary },
    ];
    const prior = extractPriorRunSummary(messages);
    // Below 2KB so the whole summary survives intact.
    expect(prior).toContain("APPLY_ROLLED_BACK\n");
    expect(prior).toContain("TS2305");
    // Heuristic suggestion line carried through too.
    expect(prior).toContain("Suggested: ");
  });
});

describe("Phase J.5.2 — production runAgentLoop callsites carry priorRunSummary", () => {
  // Structural contract test. The J.5.2 brief was triggered by a misleading
  // diagnostic grep (`grep -B2 -A5 runAgentLoop … | grep priorRunSummary`)
  // that missed the field because it lives in agentLoopBaseInput, defined
  // upstream of the callsites' grep window. This test pins the actual
  // contract — priorRunSummary reaches every USER-FACING runAgentLoop call —
  // regardless of how the code is refactored.
  //
  // Excluded from "user-facing": verifier auto-fix callsites
  // (~lines 9869, 10134) — J.5 intentionally left those alone since they
  // run synthetic sub-flows ("fix this broken test"), not user re-prompts.

  const SRC = readFileSync(
    path.resolve("src/core/runLlmPatchFlow.ts"),
    "utf8",
  );

  it("declares priorRunSummary at function scope (hoisted above the _useAgentLoop branch)", () => {
    expect(SRC).toMatch(/let\s+priorRunSummary\s*=\s*""/);
    // The load helper is the export from applyRollbackFeedback.
    expect(SRC).toContain("extractPriorRunSummary(allMessages)");
  });

  it("agentLoopBaseInput object literal includes priorRunSummary as a field", () => {
    // Find the agentLoopBaseInput literal and assert priorRunSummary is one
    // of its fields. Regex-style: anything between the opener and its
    // closing brace at the same indent that contains the key.
    const start = SRC.indexOf("const agentLoopBaseInput = {");
    expect(start).toBeGreaterThan(-1);
    // Match through to "};\n" at the same scope. Imperfect but adequate —
    // the literal is small and self-contained in this file.
    const end = SRC.indexOf("\n    };\n", start);
    expect(end).toBeGreaterThan(start);
    const literal = SRC.slice(start, end);
    expect(literal).toMatch(/^\s*priorRunSummary,?\s*$/m);
  });

  it("both production runAgentLoop callsites use agentLoopBaseInput (so the field flows through)", () => {
    // The orchestrator step branch spreads it.
    expect(SRC).toMatch(/runAgentLoop\(\s*\{\s*\.\.\.agentLoopBaseInput/);
    // The single-pass branch passes the whole object.
    expect(SRC).toMatch(/loop = await runAgentLoop\(agentLoopBaseInput\)/);
  });

  it("AgentLoopInput type accepts priorRunSummary so the wire compiles", () => {
    const agentLoopSrc = readFileSync(
      path.resolve("src/llm/agentLoop.ts"),
      "utf8",
    );
    expect(agentLoopSrc).toMatch(/priorRunSummary\?:\s*string;/);
  });

  it("server.ts forwards result.patchPreview as agentSummary for /api/patch and /api/dry-run", () => {
    const serverSrc = readFileSync(
      path.resolve("src/api/server.ts"),
      "utf8",
    );
    // Two callsites: /api/patch (routine), /api/dry-run (preview).
    // Both must forward the loop's summary so a rollback gets persisted.
    const forwards = serverSrc.match(/agentSummary:\s*\n?\s*typeof \(result/g);
    expect(forwards).not.toBeNull();
    expect((forwards ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("runLogging.ts persists agent_summary ONLY when decisionMode === 'rolled_back'", () => {
    const runLoggingSrc = readFileSync(
      path.resolve("src/api/runLogging.ts"),
      "utf8",
    );
    // The conditional gate: persist only on rollback, only when text present.
    expect(runLoggingSrc).toMatch(
      /input\.decisionMode\s*===\s*"rolled_back"[\s\S]{0,200}input\.agentSummary/,
    );
    // The persisted event shape.
    expect(runLoggingSrc).toMatch(/type:\s*"agent_summary"/);
  });
});

describe("Phase J.5 — system prompt documents PRIOR RUN CONTEXT", () => {
  it("includes the PRIOR RUN CONTEXT section with the four pillars", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an AI code agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/workspace/project",
    });
    expect(prompt).toContain("PRIOR RUN CONTEXT");
    // (1) Header pattern the agent must recognize at the top of user messages.
    expect(prompt).toContain('"PRIOR RUN CONTEXT — your last attempt in this thread produced this result:"');
    expect(prompt).toContain("END PRIOR RUN CONTEXT.");
    // (2) The APPLY_ROLLED_BACK / VERIFICATION WARNINGS starting-point directive.
    expect(prompt).toMatch(/start from those errors|re-investigate from those specific/);
    // (3) The Suggested: directive.
    expect(prompt).toMatch(/Suggested:.*coordinated multi-file edit/);
    // (4) The combine-the-two directive (Phase F: "prior context = WHERE the problem is").
    expect(prompt).toMatch(/combine.*prior context|prior context.*WHERE/);
  });
});
