/**
 * Pure unit tests for isContinueIntent.
 *
 * Kept separate from index.interruptedTurn.test.ts so the module-level
 * vi.mock("../../core/conversationFilesystemStore.js") in that file does not
 * interfere with tests that need no mock at all (mirrors the
 * scopeGuard.rg-unavailable.test.ts isolation pattern).
 */

import { describe, it, expect } from "vitest";
import { isContinueIntent } from "./index.js";

describe("isContinueIntent — expected FALSE (cost gate)", () => {
  const falseInputs = [
    "show me the output",
    "give me the response",
    "show me the coverage report",
    "show me the test output",
    "continue implementing authentication",
    "proceed with the analysis",
    "go on",
    "fix the build",
    "add a new feature",
  ];
  for (const input of falseInputs) {
    it(`"${input}" → false`, () => {
      expect(isContinueIntent(input)).toBe(false);
    });
  }
});

describe("isContinueIntent — expected TRUE (continuation detected)", () => {
  const trueInputs = [
    "continue the findings report from section 3, no new investigation",
    "give me sections 4-6",
    "show me the rest of the output",
    "continue with the report",
    "proceed with the report",
    "show me the rest of the response",
    "continue from your previous report",
    "give me sections 1 and 2",
    "show me what you produced",
  ];
  for (const input of trueInputs) {
    it(`"${input}" → true`, () => {
      expect(isContinueIntent(input)).toBe(true);
    });
  }
});
