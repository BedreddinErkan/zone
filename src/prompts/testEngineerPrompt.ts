// src/prompts/testEngineerPrompt.ts

import type { TestEngineerContext } from "../roles/testEngineerContext.js";

export function buildTestEngineerPrompt(input: {
  task: string;
  context: TestEngineerContext;
  pageObjectContents: Array<{ path: string; content: string }>;
  existingTestContents: Array<{ path: string; content: string }>;
}): string {
  const { task, context, pageObjectContents, existingTestContents } = input;
  const { framework, promptHints, outputPaths } = context;

  const pageObjectSection =
    pageObjectContents.length > 0
      ? pageObjectContents
          .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no page objects found)";

  const existingTestSection =
    existingTestContents.length > 0
      ? existingTestContents
          .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
          .join("\n\n")
      : "(no existing tests found)";

  const hintsSection = promptHints.map((h) => `- ${h}`).join("\n");

  const outputSection =
    framework.framework === "cucumber_java"
      ? `Feature file: ${outputPaths.featureFile}
Step definitions: ${outputPaths.stepDefinition}`
      : `Test file: ${outputPaths.testFile}`;

  return `
You are an expert test automation engineer.
Your job is to write a complete, runnable test for the given task.
You must follow the exact framework, language, and patterns detected in this repository.
You must never invent new patterns — always follow what already exists.

=== TASK ===
${task}

=== DETECTED FRAMEWORK ===
${context.frameworkSummary}

=== FRAMEWORK RULES ===
${hintsSection}

=== EXISTING PAGE OBJECTS ===
${pageObjectSection}

=== EXISTING TEST EXAMPLES ===
${existingTestSection}

=== OUTPUT REQUIREMENTS ===
${outputSection}

=== STRICT RULES ===
1. Use ONLY the exact method names found in the page objects above.
2. NEVER create new WebDriver or browser instances — use existing page objects.
3. NEVER invent method names that don't exist in the page objects.
4. If a required method does not exist in the page objects, add it to the risks section.
5. Follow the exact import style of the existing tests.
6. Follow the exact package/namespace structure of the existing files.
7. For Cucumber: feature file and step definitions must be separate outputs.
8. For Playwright/Cypress/pytest: return a single test file.
9. Return raw JSON only — no markdown, no code fences.

=== OUTPUT FORMAT ===
Return JSON only with this exact shape:

For Playwright / Cypress / pytest / Selenium:
{
  "testFile": {
    "path": "${outputPaths.testFile}",
    "content": "full file content here"
  },
  "summary": "what this test does",
  "warnings": ["any risks or missing methods"],
  "confidence": 0-100
}

For Cucumber Java (feature + step definitions):
{
  "featureFile": {
    "path": "${outputPaths.featureFile ?? outputPaths.testFile}",
    "content": "full gherkin content here"
  },
  "stepDefinitionFile": {
    "path": "${outputPaths.stepDefinition ?? ""}",
    "content": "full java content here"
  },
  "summary": "what this test does",
  "warnings": ["any risks or missing methods"],
  "confidence": 0-100
}
`.trim();
}