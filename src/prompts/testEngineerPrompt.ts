import type { TestEngineerContext } from "../roles/testEngineerContext.js";
import { detectTestComplexity } from "../roles/detectTestComplexity.js";
import { buildFinalPrompt } from "./buildFinalPrompt.js";

export function buildTestEngineerPrompt(input: {
  task: string;
  context: TestEngineerContext;
  pageObjectContents: Array<{ path: string; content: string }>;
  stepDefinitionContents: Array<{ path: string; content: string }>;
  featureContents: Array<{ path: string; content: string }>;
  existingTestContents: Array<{ path: string; content: string }>;
}): string {
  const {
    task,
    context,
    pageObjectContents,
    stepDefinitionContents,
    featureContents,
    existingTestContents,
  } = input;
  const { framework, outputPaths } = context;
  const { complexity, hints, suggestedPatterns } = detectTestComplexity(input.task);

  const pageObjectSection =
    pageObjectContents.length > 0
      ? pageObjectContents
          .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no page objects found)";

  const pageObjectHints =
    pageObjectContents.length > 0
      ? pageObjectContents.map((f) => `- ${f.path}`).join("\n")
      : "(no page object usage hints found)";

  const stepDefinitionSection =
    stepDefinitionContents.length > 0
      ? stepDefinitionContents
          .map((f) => `FILE: ${f.path}\n\`\`\`java\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no existing step definition examples found)";

  const featureSection =
    featureContents.length > 0
      ? featureContents
          .map((f) => `FILE: ${f.path}\n\`\`\`gherkin\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no existing feature file examples found)";

  const existingTestSection =
    existingTestContents.length > 0
      ? existingTestContents
          .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no existing tests found)";

  const rulesSection = context.outputRules.map((r) => `- ${r}`).join("\n");
  const locationSection = context.fileLocationRules.map((r) => `- ${r}`).join("\n");

  const outputSection =
    framework.framework === "cucumber_java"
      ? `Feature file: ${outputPaths.featureFile}
Step definitions: ${outputPaths.stepDefinition}`
      : `Test file: ${outputPaths.testFile}`;

  const isCucumberJava = framework.framework === "cucumber_java";

  const outputFormat = isCucumberJava
    ? `{
  "featureFile": {
    "path": "${outputPaths.featureFile ?? outputPaths.testFile}",
    "content": "full gherkin content"
  },
  "stepDefinitionFile": {
    "path": "${outputPaths.stepDefinition ?? ""}",
    "content": "full java step definition content"
  },
  "summary": "what this test does",
  "warnings": ["any risks or missing methods"],
  "confidence": 0
}`
    : `{
  "testFile": {
    "path": "${outputPaths.testFile}",
    "content": "full file content"
  },
  "summary": "what this test does",
  "warnings": ["any risks or missing methods"],
  "confidence": 0
}`;

  const contextPayload = `
${context.promptRole}

Your job is to write a complete, runnable test for the given task.
You must follow the exact framework, language, and patterns detected in this repository.
You must NEVER invent new methods - always use what already exists in the page objects.

=== DETECTED FRAMEWORK ===
${context.frameworkSummary}

=== OUTPUT RULES ===
${rulesSection}

=== COMPLEXITY GUIDANCE ===
Detected complexity: ${complexity}
Hints: ${hints.join(", ") || "none"}
Suggested patterns: ${suggestedPatterns.join(", ") || "none"}

Framework-specific complexity instructions:
- If complexity is "data_driven" and framework is pytest/selenium_python: MUST use @pytest.mark.parametrize with at least 2 data rows
- If complexity is "data_driven" and framework is cucumber_java: MUST use Scenario Outline with Examples table containing at least 2 rows
- If complexity is "data_driven" and framework is playwright_ts/playwright_js: MUST use test.each() or a data array with forEach
- If complexity is "e2e": Chain multiple page objects, add assertions at each major step
- If complexity is "negative": Include at least one test case for the failure/error scenario
- If complexity is "multi_scenario": Write multiple separate test functions or scenarios

=== FILE LOCATION RULES ===
${locationSection}

=== EXISTING PAGE OBJECTS ===
${pageObjectSection}

=== PAGE OBJECT USAGE HINTS ===
${pageObjectHints}

=== EXISTING STEP DEFINITION EXAMPLES ===
${stepDefinitionSection}

=== EXISTING FEATURE FILE EXAMPLES ===
${featureSection}

=== EXISTING TEST EXAMPLES ===
${existingTestSection}

=== OUTPUT REQUIREMENTS ===
${outputSection}

=== CRITICAL RULES ===
1. Use ONLY the exact method names found in the page objects above.
2. Compose step definitions from existing page object methods instead of inventing new convenience methods.
3. NEVER call a convenience method such as "searchRoundTripFlight(...)" unless that exact method exists in the provided page objects.
4. NEVER use placeholder URLs or placeholder data such as "http://example.com", "https://example.com", or fake cities/dates when repository-style phrasing examples exist.
5. When repository examples use "Scenario Outline" with an "Examples:" table, you MUST use the same pattern for parameterized search tasks unless a concrete repository-specific reason prevents it.
6. If repository-specific phrasing exists in the provided examples, do NOT fall back to generic phrasing.
7. Each generated step definition method body must map closely to one or a small number of real page object method calls.
8. Do NOT collapse multiple UI actions into a single invented abstraction, helper, or convenience step.
9. Reuse existing feature phrasing, step annotations, package names, imports, and page object usage patterns when examples are provided.
10. NEVER create new WebDriver or browser instances - use existing page objects.
11. If a required method does not exist in the page objects, add it to warnings with the missing method names clearly listed.
12. Avoid placeholder comments or TODO-style filler unless the repository examples already use that exact pattern.
13. Follow the exact import/package structure of the existing files.
14. For Cucumber Java: write both feature file AND step definitions.
15. confidence field: 0-100 based on how well page objects cover the task.
16. Return raw JSON only - no markdown, no code fences, no explanations.

=== OUTPUT FORMAT ===
Return JSON only:
${outputFormat}
`.trim();

  return buildFinalPrompt({
    role: "test_engineer",
    task,
    detectedFramework: framework.framework,
    context: contextPayload,
  });
}
