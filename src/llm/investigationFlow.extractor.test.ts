/**
 * Step C — extractPhase1Findings unit tests.
 * Validates JSON block extraction from Phase 1 INVESTIGATION_OUTPUT_FORMAT output.
 */

import { describe, expect, it } from "vitest";
import { extractPhase1Findings } from "./investigationFlow.js";

describe("extractPhase1Findings", () => {
  it("parses a well-formed JSON block at the end of the summary", () => {
    const summary = `
The auth middleware is missing from the admin router.

\`\`\`json
{
  "rootCause": "admin router has no authMiddleware",
  "fixInstruction": "Add authMiddleware to router.use('/admin', ...)",
  "filesToEdit": ["src/routes/admin.ts"],
  "evidence": "src/routes/admin.ts:14",
  "complete": true
}
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.rootCause).toBe("admin router has no authMiddleware");
    expect(result.fixInstruction).toBe("Add authMiddleware to router.use('/admin', ...)");
    expect(result.filesToEdit).toEqual(["src/routes/admin.ts"]);
    expect(result.evidence).toBe("src/routes/admin.ts:14");
  });

  it("returns empty object when no JSON block is present", () => {
    const summary = "Phase 1 found that the file src/foo.ts needs updating. No structured output.";
    expect(extractPhase1Findings(summary)).toEqual({});
  });

  it("returns empty object on invalid JSON inside the block", () => {
    const summary = `
Some prose.
\`\`\`json
{ "rootCause": "broken json", "fixInstruction":
\`\`\``;
    expect(extractPhase1Findings(summary)).toEqual({});
  });

  it("takes the last JSON block when multiple are present", () => {
    const summary = `
\`\`\`json
{ "rootCause": "first block — should be ignored" }
\`\`\`

More prose.

\`\`\`json
{ "rootCause": "correct last block", "fixInstruction": "do the right thing", "filesToEdit": [], "evidence": "none", "complete": true }
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.rootCause).toBe("correct last block");
    expect(result.fixInstruction).toBe("do the right thing");
  });

  it("omits fields not present in the JSON block", () => {
    const summary = `
\`\`\`json
{ "rootCause": "only rootCause set", "complete": true }
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.rootCause).toBe("only rootCause set");
    expect(result.fixInstruction).toBeUndefined();
    expect(result.filesToEdit).toBeUndefined();
    expect(result.evidence).toBeUndefined();
  });

  it("returns empty object when JSON parses to a non-object (e.g. array or null)", () => {
    const summary = `
\`\`\`json
["not", "an", "object"]
\`\`\``;
    expect(extractPhase1Findings(summary)).toEqual({});
  });

  it("parses complete: false and preserves the investigate-further fixInstruction", () => {
    const summary = `
Insufficient evidence found in the iteration budget.

\`\`\`json
{
  "rootCause": "could not locate the failing call site",
  "fixInstruction": "investigate further: search for callers of parseToken in src/auth",
  "filesToEdit": [],
  "evidence": "src/auth/token.ts:12",
  "complete": false
}
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.rootCause).toBe("could not locate the failing call site");
    expect(result.fixInstruction).toBe("investigate further: search for callers of parseToken in src/auth");
    expect(result.complete).toBe(false);
  });

  it("does not reject complete: false — extractor accepts any boolean", () => {
    const summary = `
\`\`\`json
{ "rootCause": "partial", "fixInstruction": "investigate further: check X", "filesToEdit": [], "evidence": "none", "complete": false }
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.complete).toBe(false);
    expect(result.rootCause).toBe("partial");
  });

  it("Phase F: parses plan field when present", () => {
    const summary = `
Findings prose.

\`\`\`json
{
  "rootCause": "missing middleware",
  "fixInstruction": "add auth to router",
  "filesToEdit": ["src/router.ts"],
  "evidence": "src/router.ts:10",
  "complete": true,
  "plan": {
    "objective": "Add authentication middleware to admin router",
    "steps": [
      { "description": "Read router and auth middleware", "subagentEligible": false },
      { "description": "Patch router.ts to add authMiddleware", "subagentEligible": false }
    ],
    "riskHints": ["May break existing unauthenticated routes"]
  }
}
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.plan).toBeDefined();
    expect(result.plan!.objective).toBe("Add authentication middleware to admin router");
    expect(result.plan!.steps).toHaveLength(2);
    expect(result.plan!.steps[0]!.description).toBe("Read router and auth middleware");
    expect(result.plan!.riskHints).toEqual(["May break existing unauthenticated routes"]);
  });

  it("Phase F: plan absent — returns undefined plan field", () => {
    const summary = `
\`\`\`json
{ "rootCause": "no plan here", "fixInstruction": "fix it", "filesToEdit": [], "evidence": "none", "complete": true }
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.plan).toBeUndefined();
  });

  it("Phase F: malformed plan (missing required fields) — returns undefined plan", () => {
    const summary = `
\`\`\`json
{
  "rootCause": "some issue",
  "fixInstruction": "fix",
  "complete": true,
  "plan": { "objective": "missing steps field" }
}
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.plan).toBeUndefined();
  });

  it("Phase F: plan with subagentEligible:true preserved", () => {
    const summary = `
\`\`\`json
{
  "rootCause": "fanout",
  "fixInstruction": "rename across 8 files",
  "complete": true,
  "plan": {
    "objective": "Rename foo to bar",
    "steps": [{ "description": "Rename in 8 files", "subagentEligible": true, "subagentType": "worker" }],
    "riskHints": []
  }
}
\`\`\``;
    const result = extractPhase1Findings(summary);
    expect(result.plan!.steps[0]!.subagentEligible).toBe(true);
    expect(result.plan!.steps[0]!.subagentType).toBe("worker");
  });
});
