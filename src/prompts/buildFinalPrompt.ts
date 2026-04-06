import { buildGlobalPrompt } from "./globalPrompt.js";
import { buildDeveloperRolePrompt } from "./rolePrompts/developerPrompt.js";
import { buildTestEngineerRolePrompt } from "./rolePrompts/testEngineerPrompt.js";
import { buildDataAnalystRolePrompt } from "./rolePrompts/dataAnalystPrompt.js";
import { buildPlaywrightPrompt } from "./frameworkPrompts/playwrightPrompt.js";
import { buildCypressPrompt } from "./frameworkPrompts/cypressPrompt.js";
import { buildSeleniumPrompt } from "./frameworkPrompts/seleniumPrompt.js";
import { buildCucumberPrompt } from "./frameworkPrompts/cucumberPrompt.js";

export type PromptRole = "developer" | "test_engineer" | "data_analyst";

export type PromptFramework =
  | "playwright_ts"
  | "playwright_js"
  | "cypress"
  | "selenium_java"
  | "selenium_python"
  | "junit"
  | "testng"
  | "cucumber_java"
  | "pytest"
  | "unknown";

export interface BuildFinalPromptInput {
  role: PromptRole;
  task: string;
  detectedFramework?: PromptFramework;
  context: string;
}

function buildRolePrompt(role: PromptRole): string {
  switch (role) {
    case "developer":
      return buildDeveloperRolePrompt();
    case "test_engineer":
      return buildTestEngineerRolePrompt();
    case "data_analyst":
      return buildDataAnalystRolePrompt();
  }
}

function buildFrameworkPrompt(
  role: PromptRole,
  framework?: PromptFramework
): string | null {
  if (role !== "test_engineer" || !framework || framework === "unknown") {
    return null;
  }

  switch (framework) {
    case "playwright_ts":
    case "playwright_js":
      return buildPlaywrightPrompt();
    case "cypress":
      return buildCypressPrompt();
    case "selenium_java":
    case "selenium_python":
    case "junit":
    case "testng":
      return buildSeleniumPrompt();
    case "cucumber_java":
      return buildCucumberPrompt();
    default:
      return null;
  }
}

export function buildFinalPrompt(input: BuildFinalPromptInput): string {
  const frameworkPrompt = buildFrameworkPrompt(
    input.role,
    input.detectedFramework
  );

  return [
    buildGlobalPrompt(),
    buildRolePrompt(input.role),
    frameworkPrompt,
    "REPOSITORY / CONTEXT PAYLOAD",
    input.context.trim(),
    "USER TASK",
    input.task,
  ]
    .filter(Boolean)
    .join("\n\n");
}
