// src/roles/runTestEngineerFlow.ts

import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { detectTestFramework } from "./detectTestFramework.js";
import { buildTestEngineerContext } from "./testEngineerContext.js";
import { buildTestEngineerPrompt } from "../prompts/testEngineerPrompt.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import { runSelfHealingLoop } from "../core/selfHealingLoop.js";
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
    warnings.forEach((w) => lines.push(`- ${w}`));
  }

  lines.push("");
  lines.push("Files to create:");

  if (result["testFile"]) {
    const f = result["testFile"] as { path: string };
    lines.push(`- ${f.path}`);
  }

  if (result["featureFile"]) {
    const f = result["featureFile"] as { path: string };
    lines.push(`- ${f.path} [feature]`);
  }

  if (result["stepDefinitionFile"]) {
    const f = result["stepDefinitionFile"] as { path: string };
    lines.push(`- ${f.path} [step definitions]`);
  }

  return lines.join("\n");
}

function buildApplyPatches(
  result: Record<string, unknown>
): Array<{ filePath: string; fullContent: string }> {
  const patches: Array<{ filePath: string; fullContent: string }> = [];

  if (result["testFile"]) {
    const f = result["testFile"] as { path: string; content: string };
    if (f.path && f.content) {
      patches.push({ filePath: f.path, fullContent: f.content });
    }
  }

  if (result["featureFile"]) {
    const f = result["featureFile"] as { path: string; content: string };
    if (f.path && f.content) {
      patches.push({ filePath: f.path, fullContent: f.content });
    }
  }

  if (result["stepDefinitionFile"]) {
    const f = result["stepDefinitionFile"] as { path: string; content: string };
    if (f.path && f.content) {
      patches.push({ filePath: f.path, fullContent: f.content });
    }
  }

  return patches;
}

export async function runTestEngineerFlow(input: {
  task: string;
  repoPath: string;
}): Promise<TestEngineerFlowResult> {
  // 1. Scan repo
  let allFiles;
  try {
    allFiles = await scanRepo(input.repoPath);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to scan repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Detect framework
  const framework = detectTestFramework(allFiles);

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

  // 3. Build context
  const context = buildTestEngineerContext(input.task, framework, allFiles);

  // 4. Read page object contents (top 5)
  const pageObjectPaths = context.pageObjectFiles
    .slice(0, 5)
    .map((f) => f.absolutePath)
    .filter((p): p is string => typeof p === "string");

  const pageObjectContentsMap =
    pageObjectPaths.length > 0
      ? await readProjectFiles(pageObjectPaths)
      : {};

  const pageObjectContents = Object.entries(pageObjectContentsMap).map(
    ([absPath, content]) => ({
      path:
        allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
      content,
    })
  );

  // 5. Read existing test contents (top 3)
  const existingTestPaths = context.existingTestFiles
    .slice(0, 3)
    .map((f) => f.absolutePath)
    .filter((p): p is string => typeof p === "string");

  const existingTestContentsMap =
    existingTestPaths.length > 0
      ? await readProjectFiles(existingTestPaths)
      : {};

  const existingTestContents = Object.entries(existingTestContentsMap).map(
    ([absPath, content]) => ({
      path:
        allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
      content,
    })
  );

  // 6. Build prompt
  const prompt = buildTestEngineerPrompt({
    task: input.task,
    context,
    pageObjectContents,
    existingTestContents,
  });

  // 7. Call LLM
  let parsed: Record<string, unknown>;
  try {
    const client = createOpenAIClient();
    const model = getModelName();

    const response = await client.responses.create({
      model,
      input: prompt,
    });

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

  // 8. Build result
  const applyPatches = buildApplyPatches(parsed);
  const preview = buildPreview(parsed, framework.framework);
  const confidence = typeof parsed["confidence"] === "number"
    ? parsed["confidence"]
    : 70;
  const summary = typeof parsed["summary"] === "string"
    ? parsed["summary"]
    : "Test generated successfully.";
  const warnings = Array.isArray(parsed["warnings"])
    ? (parsed["warnings"] as string[])
    : [];
// Self-healing: if confidence is low, pre-emptively check for common errors
if (confidence < 70 && applyPatches.length > 0) {
  console.log("[zone:heal] Low confidence detected — running pre-emptive error check...");

  const exportErrors = applyPatches.filter(p =>
    p.fullContent.includes("export default new ")
  );

  if (exportErrors.length > 0) {
    console.log(`[zone:heal] Found ${exportErrors.length} potential export error(s) — auto-fixing...`);

    const healResult = await runSelfHealingLoop({
      task: input.task,
      repoPath: input.repoPath,
      errorMessage: "export default new ClassName() — instance exported instead of class",
      affectedFiles: exportErrors,
      maxAttempts: 1,
    });

    if (healResult.healed) {
      for (const attempt of healResult.attempts) {
        for (const file of attempt.filesChanged) {
          const patch = applyPatches.find(p => p.filePath === file);
          if (patch) {
            const fixed = exportErrors.find(p => p.filePath === file);
            if (fixed) {
              patch.fullContent = fixed.fullContent.replace(
                /export default new (\w+)\(\)/g,
                "export default $1"
              );
            }
          }
        }
      }
    }
  }
}
  return {
    ok: true,
    framework: framework.framework,
    language: framework.language,
    confidence,
    summary,
    warnings,
    applyPatches,
    preview,
  };
}