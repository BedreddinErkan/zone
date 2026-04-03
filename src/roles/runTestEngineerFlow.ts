import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { detectTestFramework } from "./detectTestFramework.js";
import { buildTestEngineerContext } from "./testEngineerContext.js";
import { buildTestEngineerPrompt } from "../prompts/testEngineerPrompt.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import { checkConfidenceGate } from "../core/confidenceGate.js";
import { validateTestOutput } from "./testOutputValidator.js";
import type { RepoFile } from "../types/project.js";

export type TestEngineerFlowResult =
  | {
      ok: true;
      framework: string;
      language: string;
      confidence: number;
      summary: string;
      warnings: string[];
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      preview: string;
    }
  | {
      ok: false;
      reason: string;
      framework?: string;
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
  framework: string
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
  if (result["testFile"]) {
    const file = result["testFile"] as { path: string };
    lines.push(`- ${file.path}`);
  }
  if (result["featureFile"]) {
    const file = result["featureFile"] as { path: string };
    lines.push(`- ${file.path} [feature]`);
  }
  if (result["stepDefinitionFile"]) {
    const file = result["stepDefinitionFile"] as { path: string };
    lines.push(`- ${file.path} [step definitions]`);
  }
  return lines.join("\n");
}

function buildApplyPatches(
  result: Record<string, unknown>
): Array<{ filePath: string; fullContent: string }> {
  const patches: Array<{ filePath: string; fullContent: string }> = [];

  if (result["testFile"]) {
    const file = result["testFile"] as { path: string; content: string };
    if (file.path && file.content) {
      patches.push({ filePath: file.path, fullContent: file.content });
    }
  }

  if (result["featureFile"]) {
    const file = result["featureFile"] as { path: string; content: string };
    if (file.path && file.content) {
      patches.push({ filePath: file.path, fullContent: file.content });
    }
  }

  if (result["stepDefinitionFile"]) {
    const file = result["stepDefinitionFile"] as {
      path: string;
      content: string;
    };
    if (file.path && file.content) {
      patches.push({ filePath: file.path, fullContent: file.content });
    }
  }

  return patches;
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

export async function runTestEngineerFlow(input: {
  task: string;
  repoPath: string;
}): Promise<TestEngineerFlowResult> {
  let allFiles: RepoFile[];
  try {
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

  const applyPatches = buildApplyPatches(parsed);
  const preview = buildPreview(parsed, framework.framework);
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
  p => p.filePath.endsWith(".spec.ts") || p.filePath.endsWith(".spec.js") || p.filePath.endsWith(".test.ts")
);

const validation = validateTestOutput({
  featureContent: featurePatch?.fullContent,
  stepDefinitionContent: stepPatch?.fullContent,
  testFileContent: testFilePatch?.fullContent,
  pageObjectContents: pageObjectContents,
  framework: framework.framework,
});
if (validation.decision !== "pass" || validation.issues.length > 0) {
  console.log(`[zone:validate] Decision: ${validation.decision}`);
  for (const issue of validation.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}
  if (validation.decision === "blocked") {
    return {
      ok: false,
      reason:
        `Output validation blocked: ${validation.summary}\n` +
        validation.issues
          .filter(i => i.severity === "error")
          .map(i => `  - ${i.message}`)
          .join("\n"),
      framework: framework.framework,
    };
  }

  const validationWarnings = validation.issues
    .filter(i => i.severity === "warning")
    .map(i => `[${i.code}] ${i.message}`);
return {
    ok: true,
    framework: framework.framework,
    language: framework.language,
    confidence,
    summary,
    warnings: [...warnings, ...validationWarnings],
    applyPatches,
    preview,
  };
}
