import { describe, expect, it } from "vitest";
import {
  fuzzyFindAndReplace,
  normalizeLineForMatch,
  scoreCandidateMatch,
} from "../runLlmPatchFlow.js";

describe("fuzzy match scoring", () => {
  it("returns score 100 for an exact match block", () => {
    const lines = [
      'const label = "Zone";',
      'const button = "Execute";',
    ].map(normalizeLineForMatch);

    expect(scoreCandidateMatch(lines, lines)).toBe(100);
  });

  it("keeps a high score for indentation-only differences", () => {
    const target = [
      "<body>",
      '  <button class="exec-btn">Execute</button>',
      "</body>",
    ].map(normalizeLineForMatch);
    const candidate = [
      "<body>",
      '\t<button class="exec-btn">Execute</button>',
      "</body>",
    ].map(normalizeLineForMatch);

    expect(scoreCandidateMatch(target, candidate)).toBeGreaterThanOrEqual(85);
  });

  it("keeps a usable score when one variable name is renamed", () => {
    const target = [
      "function saveUser() {",
      "  const userName = input.name;",
      "  return userName;",
      "}",
    ].map(normalizeLineForMatch);
    const candidate = [
      "function saveUser() {",
      "  const accountName = input.name;",
      "  return userName;",
      "}",
    ].map(normalizeLineForMatch);

    expect(scoreCandidateMatch(target, candidate)).toBeGreaterThanOrEqual(75);
  });

  it("returns a low score for a completely different block", () => {
    const target = [
      "<button>Execute</button>",
      "<div>Recent Runs</div>",
    ].map(normalizeLineForMatch);
    const candidate = [
      "CREATE TABLE users (id INTEGER PRIMARY KEY);",
      "INSERT INTO users VALUES (1);",
    ].map(normalizeLineForMatch);

    expect(scoreCandidateMatch(target, candidate)).toBeLessThan(80);
  });

  it("returns success false for an empty FIND block", () => {
    const result = fuzzyFindAndReplace(
      "<body>\n<button>Execute</button>\n</body>",
      "   \n\t  ",
      "<button>Run</button>"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("low_confidence");
      expect(result.score).toBe(0);
    }
  });
});
