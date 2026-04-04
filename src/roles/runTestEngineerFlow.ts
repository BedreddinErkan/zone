import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { detectTestFramework } from "./detectTestFramework.js";
import { buildTestEngineerContext } from "./testEngineerContext.js";
import { buildTestEngineerPrompt } from "../prompts/testEngineerPrompt.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import { checkConfidenceGate } from "../core/confidenceGate.js";
import { validateTestOutput } from "./testOutputValidator.js";
import { detectTestComplexity } from "./detectTestComplexity.js";
import type { TestComplexity } from "./detectTestComplexity.js";
import type { RepoFile } from "../types/project.js";
import type { TestEngineerContextDebug } from "./testEngineerContext.js";

interface TestEngineerDebugInfo {
  selectedRole: "test_engineer";
  promptPipeline: "buildTestEngineerPrompt";
  finalPromptBuilder: "buildFinalPrompt";
  detectedFramework: string;
  frameworkAugmentation:
    | "playwright"
    | "cypress"
    | "selenium"
    | "cucumber"
    | "none";
  contextSelection: TestEngineerContextDebug | null;
  outputPathDecision: {
    finalTestFilePath: string | null;
    finalPathSource:
      | "deterministic_context"
      | "deterministic_context_override"
      | "model_output";
    rawModelTestFilePath: string | null;
    rawModelFeatureFilePath: string | null;
    rawModelStepDefinitionPath: string | null;
    rawModelPathDiffers: boolean;
  };
  suspiciousFilenameFiltering: {
    triggered: boolean;
    generatedSlug: string | null;
    safeSlug: string | null;
  };
  playwrightUrlAssertionGuard: {
    checked: boolean;
    triggered: boolean;
    reason: string | null;
    routeEvidence: string[];
  };
}

export type TestEngineerFlowResult =
  | {
      ok: true;
      framework: string;
      language: string;
      confidence: number;
      decisionMode: "safe_to_apply" | "preview_only";
      summary: string;
      warnings: string[];
      complexity?: TestComplexity;
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      preview: string;
      debug?: TestEngineerDebugInfo;
    }
  | {
      ok: false;
      reason: string;
      framework?: string;
      language?: string;
      confidence?: number;
      decisionMode?: "blocked";
      summary?: string;
      warnings?: string[];
      complexity?: TestComplexity;
      applyPatches?: Array<{ filePath: string; fullContent: string }>;
      preview?: string;
      validationBlocked?: boolean;
      debug?: TestEngineerDebugInfo;
    };

function extractJson(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  throw new Error("No JSON found in model response");
}

function buildPreview(
  result: Record<string, unknown>,
  framework: string,
  outputPaths: { testFile: string; featureFile?: string; stepDefinition?: string }
): string {
  const lines: string[] = ["=== TEST ENGINEER PREVIEW ==="];
  lines.push(`Framework: ${framework}`);
  lines.push(`Summary: ${result["summary"] as string}`);
  const warnings = result["warnings"] as string[];
  if (warnings?.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  lines.push("");
  lines.push("Files to create:");
  if (outputPaths.testFile) {
    lines.push(`- ${outputPaths.testFile}`);
  }
  if (outputPaths.featureFile) {
    lines.push(`- ${outputPaths.featureFile} [feature]`);
  }
  if (outputPaths.stepDefinition) {
    lines.push(`- ${outputPaths.stepDefinition} [step definitions]`);
  }
  return lines.join("\n");
}

function buildApplyPatches(
  result: Record<string, unknown>,
  outputPaths: { testFile: string; featureFile?: string; stepDefinition?: string }
): Array<{ filePath: string; fullContent: string }> {
  const patches: Array<{ filePath: string; fullContent: string }> = [];

  if (result["testFile"]) {
    const file = result["testFile"] as { path: string; content: string };
    if (outputPaths.testFile && file.content) {
      patches.push({ filePath: outputPaths.testFile, fullContent: file.content });
    }
  }

  if (result["featureFile"]) {
    const file = result["featureFile"] as { path: string; content: string };
    if (outputPaths.featureFile && file.content) {
      patches.push({ filePath: outputPaths.featureFile, fullContent: file.content });
    }
  }

  if (result["stepDefinitionFile"]) {
    const file = result["stepDefinitionFile"] as {
      path: string;
      content: string;
    };
    if (outputPaths.stepDefinition && file.content) {
      patches.push({ filePath: outputPaths.stepDefinition, fullContent: file.content });
    }
  }

  return patches;
}

function resolveFrameworkAugmentation(framework: string): TestEngineerDebugInfo["frameworkAugmentation"] {
  if (framework.startsWith("playwright")) return "playwright";
  if (framework === "cypress") return "cypress";
  if (
    framework === "selenium_java" ||
    framework === "selenium_python" ||
    framework === "junit" ||
    framework === "testng"
  ) {
    return "selenium";
  }
  if (framework === "cucumber_java") return "cucumber";
  return "none";
}

async function readExampleContents(
  files: RepoFile[],
  allFiles: RepoFile[],
  limit: number
): Promise<Array<{ path: string; content: string }>> {
  const examplePaths = files
    .slice(0, limit)
    .map((file) => file.absolutePath)
    .filter((filePath): filePath is string => typeof filePath === "string");

  const contentsMap =
    examplePaths.length > 0 ? await readProjectFiles(examplePaths) : {};

  return Object.entries(contentsMap).map(([absPath, content]) => ({
    path: allFiles.find((file) => file.absolutePath === absPath)?.path ?? absPath,
    content,
  }));
}

function scoreFeatureExampleContent(content: string): number {
  let score = 0;

  if (content.includes("Scenario Outline")) score += 4;
  if (content.includes("Examples:")) score += 4;
  if (/^\s*@/m.test(content)) score += 1;

  return score;
}

function isPreferredCucumberFeaturePath(path: string): boolean {
  return path.startsWith("src/test/resources/features/");
}

async function readFeatureExampleContents(
  files: RepoFile[],
  allFiles: RepoFile[],
  framework: { framework: string }
): Promise<Array<{ path: string; content: string }>> {
  if (framework.framework !== "cucumber_java") {
    return readExampleContents(files, allFiles, 2);
  }

  const inspectedExamples = await readExampleContents(files, allFiles, 4);

  return [...inspectedExamples]
    .sort((a, b) => {
      const scoreDiff =
        scoreFeatureExampleContent(b.content) - scoreFeatureExampleContent(a.content);
      if (scoreDiff !== 0) return scoreDiff;
      const preferredPathDiff =
        Number(isPreferredCucumberFeaturePath(b.path)) -
        Number(isPreferredCucumberFeaturePath(a.path));
      if (preferredPathDiff !== 0) return preferredPathDiff;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 2);
}

function extractRouteEvidence(contents: Array<{ path: string; content: string }>): string[] {
  const evidence = new Set<string>();
  const routePattern =
    /(goto|toHaveURL|visit|navigate(?:To)?)\(\s*(?:await\s+)?(?:(["'`])([^"'`]+)\2|\/([^/\n]+(?:\/[^/\n]+)*)\/[a-z]*)/g;

  for (const entry of contents) {
    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(entry.content)) !== null) {
      const literalRoute = (match[3] ?? match[4] ?? "").trim();
      if (literalRoute.length >= 2 && /[a-z]/i.test(literalRoute)) {
        evidence.add(literalRoute);
      }
    }
  }

  return [...evidence];
}

function findSuspiciousPlaywrightUrlAssertion(
  testFileContent: string,
  routeEvidence: string[]
): string | null {
  const assertions = [...testFileContent.matchAll(/toHaveURL\(\s*([^)]+)\)/g)];
  if (assertions.length === 0) return null;

  for (const assertion of assertions) {
    const rawArgument = assertion[1]?.trim() ?? "";
    const normalizedArgument = rawArgument.toLowerCase();

    if (routeEvidence.length === 0) {
      return "Generated Playwright URL assertion is not grounded in repository route evidence.";
    }

    const isGenericRegex =
      /^\/.*\/[a-z]*$/i.test(rawArgument) &&
      (!/[a-z]{2,}/i.test(rawArgument.replace(/tohaveurl/gi, "")) ||
        normalizedArgument.includes("/.*\\/#/") ||
        normalizedArgument.includes("/.*\\/?#/") ||
        normalizedArgument.includes("/.*\\/$/"));

    if (isGenericRegex) {
      return "Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.";
    }

    const matchesEvidence = routeEvidence.some((route) =>
      normalizedArgument.includes(route.toLowerCase())
    );
    if (!matchesEvidence) {
      return "Generated Playwright URL assertion does not match any repository-evidenced route.";
    }
  }

  return null;
}

function buildValidationBlockedResult(input: {
  framework: string;
  language: string;
  reason: string;
  confidence: number;
  summary: string;
  warnings: string[];
  complexity?: TestComplexity;
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  preview: string;
  debug: TestEngineerDebugInfo;
}): TestEngineerFlowResult {
  return {
    ok: false,
    framework: input.framework,
    language: input.language,
    reason: input.reason,
    confidence: Math.min(input.confidence, 35),
    decisionMode: "blocked",
    summary: input.summary,
    warnings: input.warnings,
    complexity: input.complexity,
    applyPatches: input.applyPatches,
    preview: input.preview,
    validationBlocked: true,
    debug: input.debug,
  };
}

export async function runTestEngineerFlow(input: {
  task: string;
  repoPath: string;
  onProgress?: (stage: string) => void;
}): Promise<TestEngineerFlowResult> {
  let allFiles: RepoFile[];
  try {
    input.onProgress?.("Scanning repo...");
    allFiles = await scanRepo(input.repoPath);
    if (!Array.isArray(allFiles)) {
      return {
        ok: false,
        reason: `scanRepo returned unexpected type: ${typeof allFiles}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to scan repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let framework;
  try {
    input.onProgress?.("Detecting framework...");
    framework = detectTestFramework(allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `detectTestFramework failed: ${err instanceof Error ? err.stack : String(err)}`,
    };
  }

  if (framework.framework === "unknown") {
    return {
      ok: false,
      reason:
        "Could not detect a test framework in this repository. " +
        "Supported frameworks: Playwright (TS/JS), Cypress, Cucumber+Java, " +
        "Selenium (Java/Python), TestNG, pytest.",
      framework: "unknown",
    };
  }

  let context;
  try {
    context = buildTestEngineerContext(input.task, framework, allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `buildTestEngineerContext failed: ${err instanceof Error ? err.stack : String(err)}`,
    };
  }

  const debug: TestEngineerDebugInfo = {
    selectedRole: "test_engineer",
    promptPipeline: "buildTestEngineerPrompt",
    finalPromptBuilder: "buildFinalPrompt",
    detectedFramework: framework.framework,
    frameworkAugmentation: resolveFrameworkAugmentation(framework.framework),
    contextSelection: context.debug ?? null,
    outputPathDecision: {
      finalTestFilePath: context.outputPaths.testFile ?? null,
      finalPathSource: "deterministic_context",
      rawModelTestFilePath: null,
      rawModelFeatureFilePath: null,
      rawModelStepDefinitionPath: null,
      rawModelPathDiffers: false,
    },
    suspiciousFilenameFiltering: {
      triggered: Boolean(context.debug?.suspiciousFilenameRejected),
      generatedSlug: context.debug?.generatedSlug ?? null,
      safeSlug: context.debug?.safeSlug ?? null,
    },
    playwrightUrlAssertionGuard: {
      checked: false,
      triggered: false,
      reason: null,
      routeEvidence: [],
    },
  };

  const pageObjectContents = await readExampleContents(
    context.pageObjectFiles,
    allFiles,
    3
  );
  const stepDefinitionContents = await readExampleContents(
    context.stepDefinitionFiles,
    allFiles,
    2
  );
  const featureContents = await readFeatureExampleContents(
    context.featureFiles,
    allFiles,
    framework
  );
  const existingTestContents = await readExampleContents(
    context.existingTestFiles,
    allFiles,
    3
  );

  input.onProgress?.("Building prompt...");
  const prompt = buildTestEngineerPrompt({
    task: input.task,
    context,
    pageObjectContents,
    stepDefinitionContents,
    featureContents,
    existingTestContents,
  });

  let parsed: Record<string, unknown>;
  try {
    input.onProgress?.("Generating patch...");
    const client = createOpenAIClient();
    const model = getModelName();
    const response = await client.responses.create({ model, input: prompt });
    const rawText = response.output_text || "";
    const jsonText = extractJson(rawText);
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      framework: framework.framework,
    };
  }

  const rawModelTestFilePath =
    (parsed["testFile"] as { path?: string } | undefined)?.path ?? null;
  const rawModelFeatureFilePath =
    (parsed["featureFile"] as { path?: string } | undefined)?.path ?? null;
  const rawModelStepDefinitionPath =
    (parsed["stepDefinitionFile"] as { path?: string } | undefined)?.path ?? null;
  debug.outputPathDecision = {
    finalTestFilePath: context.outputPaths.testFile ?? null,
    finalPathSource:
      rawModelTestFilePath && rawModelTestFilePath !== context.outputPaths.testFile
        ? "deterministic_context_override"
        : rawModelTestFilePath
          ? "deterministic_context"
          : "model_output",
    rawModelTestFilePath,
    rawModelFeatureFilePath,
    rawModelStepDefinitionPath,
    rawModelPathDiffers:
      Boolean(rawModelTestFilePath && rawModelTestFilePath !== context.outputPaths.testFile) ||
      Boolean(
        rawModelFeatureFilePath &&
          context.outputPaths.featureFile &&
          rawModelFeatureFilePath !== context.outputPaths.featureFile
      ) ||
      Boolean(
        rawModelStepDefinitionPath &&
          context.outputPaths.stepDefinition &&
          rawModelStepDefinitionPath !== context.outputPaths.stepDefinition
      ),
  };

  const applyPatches = buildApplyPatches(parsed, context.outputPaths);
  const preview = buildPreview(parsed, framework.framework, context.outputPaths);
  const confidence =
    typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
  const summary =
    typeof parsed["summary"] === "string"
      ? parsed["summary"]
      : "Test generated successfully.";
  const warnings = Array.isArray(parsed["warnings"])
    ? (parsed["warnings"] as string[])
    : [];
  const confidenceGate = checkConfidenceGate({
    confidenceScore: confidence,
    role: "test_engineer",
    framework: framework.framework,
    warnings,
  });

  if (!confidenceGate.pass && applyPatches.length > 0) {
    const exportErrors = applyPatches.filter((patch) =>
      patch.fullContent.includes("export default new ")
    );
    for (const patch of exportErrors) {
      patch.fullContent = patch.fullContent.replace(
        /export default new (\w+)\(\)/g,
        "export default $1"
      );
    }
  }
// 9. Validate output
  const featurePatch = applyPatches.find(p => p.filePath.endsWith(".feature"));
  const stepPatch = applyPatches.find(p => p.filePath.endsWith(".java"));

const testFilePatch = applyPatches.find(
  p =>
    p.filePath.endsWith(".spec.ts") ||
    p.filePath.endsWith(".spec.js") ||
    p.filePath.endsWith(".test.ts") ||
    p.filePath.endsWith(".test.js") ||
    p.filePath.endsWith(".cy.ts") ||
    p.filePath.endsWith(".cy.js") ||
    p.filePath.endsWith(".py")
);
const { complexity } = detectTestComplexity(input.task);

input.onProgress?.("Validating output...");
const validation = validateTestOutput({
  featureContent: featurePatch?.fullContent,
  stepDefinitionContent: stepPatch?.fullContent,
  testFileContent: testFilePatch?.fullContent,
  pageObjectContents: pageObjectContents,
  framework: framework.framework,
  complexityHint: complexity,
});
if (validation.decision !== "pass" || validation.issues.length > 0) {
  console.log(`[zone:validate] Decision: ${validation.decision}`);
  for (const issue of validation.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}
  if (
    framework.framework.startsWith("playwright") &&
    testFilePatch?.fullContent
  ) {
    const routeEvidence = extractRouteEvidence([
      ...existingTestContents,
      ...pageObjectContents,
    ]);
    const playwrightUrlAssertionIssue = findSuspiciousPlaywrightUrlAssertion(
      testFilePatch.fullContent,
      routeEvidence
    );

    if (playwrightUrlAssertionIssue) {
      debug.playwrightUrlAssertionGuard = {
        checked: true,
        triggered: true,
        reason: playwrightUrlAssertionIssue,
        routeEvidence,
      };
      return buildValidationBlockedResult({
        framework: framework.framework,
        language: framework.language,
        reason: `Output validation blocked: ${playwrightUrlAssertionIssue}`,
        confidence,
        summary,
        warnings,
        complexity,
        applyPatches,
        preview,
        debug,
      });
    }
    debug.playwrightUrlAssertionGuard = {
      checked: true,
      triggered: false,
      reason: null,
      routeEvidence,
    };
  }
  if (validation.decision === "blocked") {
    return buildValidationBlockedResult({
      framework: framework.framework,
      language: framework.language,
      reason:
        `Output validation blocked: ${validation.summary}\n` +
        validation.issues
          .filter(i => i.severity === "error")
          .map(i => `  - ${i.message}`)
          .join("\n"),
      confidence,
      summary,
      warnings,
      complexity,
      applyPatches,
      preview,
      debug,
    });
  }

  const validationWarnings = validation.issues
    .filter(i => i.severity === "warning")
    .map(i => `[${i.code}] ${i.message}`);
input.onProgress?.("Ready");
return {
    ok: true,
    framework: framework.framework,
    language: framework.language,
    confidence,
    decisionMode: confidence >= 70 ? "safe_to_apply" : "preview_only",
    summary,
    warnings: [...warnings, ...validationWarnings],
    complexity,
    applyPatches,
    preview,
    debug,
  };
}
