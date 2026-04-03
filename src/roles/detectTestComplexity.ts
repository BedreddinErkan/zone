export type TestComplexity =
  | "simple"
  | "data_driven"
  | "e2e"
  | "negative"
  | "multi_scenario";

export interface DetectedComplexity {
  complexity: TestComplexity;
  hints: string[];
  suggestedPatterns: string[];
}

function buildResult(
  complexity: TestComplexity,
  hints: string[],
  suggestedPatterns: string[]
): DetectedComplexity {
  return { complexity, hints, suggestedPatterns };
}

export function detectTestComplexity(task: string): DetectedComplexity {
  if (typeof task !== "string") {
    return buildResult("simple", [], []);
  }

  const normalizedTask = task.toLowerCase();

  const matchesMultiScenario = [
    "all scenarios",
    "all cases",
    "smoke and e2e",
    "positive and negative",
    "multiple scenarios",
  ].some((keyword) => normalizedTask.includes(keyword));

  if (matchesMultiScenario) {
    return buildResult(
      "multi_scenario",
      ["Task requires multiple independent test scenarios"],
      ["multiple test functions", "multiple scenarios"]
    );
  }

  const matchesE2e = [
    "end to end",
    "end-to-end",
    "e2e",
    "complete flow",
    "full flow",
    "purchase flow",
    "checkout flow",
    "booking flow",
    "from login to",
  ].some((keyword) => normalizedTask.includes(keyword));

  if (matchesE2e) {
    return buildResult(
      "e2e",
      ["Task requires chaining multiple page objects and steps"],
      ["multiple page objects", "step-by-step chain", "beforeEach login"]
    );
  }

  const matchesDataDriven = [
    "multiple users",
    "multiple cases",
    "parametrize",
    "data driven",
    "data-driven",
    "different users",
    "various",
    "all users",
    "each user",
    "for each",
  ].some((keyword) => normalizedTask.includes(keyword));

  if (matchesDataDriven) {
    return buildResult(
      "data_driven",
      ["Task requires multiple test cases with different inputs"],
      [
        "@pytest.mark.parametrize",
        "Scenario Outline",
        "Examples table",
        "test.each",
        "forEach",
      ]
    );
  }

  const matchesNegative = [
    "invalid",
    "error",
    "fail",
    "locked",
    "wrong password",
    "edge case",
    "negative",
    "should not",
    "should fail",
    "unauthorized",
  ].some((keyword) => normalizedTask.includes(keyword));

  if (matchesNegative) {
    return buildResult(
      "negative",
      ["Task requires testing failure scenarios"],
      ["assert error message", "assert url unchanged"]
    );
  }

  return buildResult("simple", ["Single focused test case"], ["single test function"]);
}
