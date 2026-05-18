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
});
