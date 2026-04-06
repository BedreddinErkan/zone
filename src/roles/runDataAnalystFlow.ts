import { scanRepo } from "../repo/scanRepo.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";
import { computeFileDiff, type DiffLine } from "../core/runLlmPatchFlow.js";
import { validateTestOutput } from "./testOutputValidator.js";
import { buildDataAnalystContext } from "./dataAnalystContext.js";
import {
  detectDataSchema,
  type DetectedDataSchema,
} from "./detectDataSchema.js";
import { buildDataAnalystPrompt } from "../prompts/dataAnalystPrompt.js";
import type { RepoFile } from "../types/project.js";

export type DataAnalystFlowResult =
  | {
      ok: true;
      dialect: string;
      migrationFormat: string;
      confidence: number;
      summary: string;
      warnings: string[];
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      fileDiffs: Array<{
        filePath: string;
        addedLines: number;
        removedLines: number;
        diff: DiffLine[];
      }>;
      preview: string;
    }
  | {
      ok: false;
      reason: string;
      dialect?: string;
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
  dialect: string,
  migrationFormat: string
): string {
  const lines: string[] = ["=== DATA ANALYST PREVIEW ==="];
  lines.push(`Dialect: ${dialect}`);
  lines.push(`Migration format: ${migrationFormat}`);
  lines.push(`Summary: ${result["summary"] as string}`);
  const warnings = result["warnings"] as string[];
  if (warnings?.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  lines.push("");
  lines.push("Files to create:");
  if (result["migrationFile"]) {
    const file = result["migrationFile"] as { path: string };
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n");
}

function buildApplyPatches(
  result: Record<string, unknown>
): Array<{ filePath: string; fullContent: string }> {
  const patches: Array<{ filePath: string; fullContent: string }> = [];
  if (result["migrationFile"]) {
    const file = result["migrationFile"] as { path: string; content: string };
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

type HostedDataAnalystContextInput = {
  availableFiles: Array<{
    path: string;
    category: RepoFile["category"];
    extension: string;
  }>;
  schema: DetectedDataSchema;
  existingSqlContents: Array<{ path: string; content: string }>;
};

export async function runDataAnalystFlow(input: {
  task: string;
  repoPath: string;
  onProgress?: (stage: string) => void;
  hostedContext?: HostedDataAnalystContextInput;
}): Promise<DataAnalystFlowResult> {
  let allFiles: RepoFile[];
  try {
    input.onProgress?.("Scanning repo...");
    allFiles = input.hostedContext
      ? input.hostedContext.availableFiles.map((file) => ({
          path: file.path,
          absolutePath: file.path,
          extension: file.extension,
          category: file.category,
        }))
      : await scanRepo(input.repoPath);
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

  let schema;
  try {
    input.onProgress?.("Detecting schema...");
    schema = input.hostedContext?.schema ?? detectDataSchema(allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `detectDataSchema failed: ${err instanceof Error ? err.stack : String(err)}`,
    };
  }

  let context;
  try {
    context = buildDataAnalystContext(input.task, schema, allFiles);
  } catch (err) {
    return {
      ok: false,
      reason: `buildDataAnalystContext failed: ${err instanceof Error ? err.stack : String(err)}`,
      dialect: schema.dialect,
    };
  }

  const existingSqlContents = input.hostedContext
    ? input.hostedContext.existingSqlContents
    : await readExampleContents(context.existingSqlFiles, allFiles, 3);

  input.onProgress?.("Building prompt...");
  const prompt = buildDataAnalystPrompt({
    task: input.task,
    context,
    existingSqlContents,
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
      dialect: schema.dialect,
    };
  }

  const applyPatches = buildApplyPatches(parsed);
  const originalContentByPath = new Map(existingSqlContents.map((file) => [file.path, file.content] as const));
  const preview = buildPreview(parsed, schema.dialect, schema.migrationFormat);
  const confidence =
    typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
  const summary =
    typeof parsed["summary"] === "string"
      ? parsed["summary"]
      : "Migration generated successfully.";
  const warnings = Array.isArray(parsed["warnings"])
    ? (parsed["warnings"] as string[])
    : [];

  const migrationPatch = applyPatches[0];
  input.onProgress?.("Validating output...");
  const validation = validateTestOutput({
    framework: "unknown",
    sqlContent: migrationPatch?.fullContent,
    sqlDialect: schema.dialect,
  });

  if (validation.decision === "blocked") {
    return {
      ok: false,
      reason:
        `SQL validation blocked: ${validation.summary}\n` +
        validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `  - ${issue.message}`)
          .join("\n"),
      dialect: schema.dialect,
    };
  }

  const validationWarnings = validation.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => `[${issue.code}] ${issue.message}`);

  const detectionWarnings =
    schema.dialect === "unknown"
      ? ["Schema dialect could not be confidently detected; review SQL carefully."]
      : [];
  const fileDiffs = applyPatches.map((patch) => {
    const originalContent = originalContentByPath.get(patch.filePath) ?? "";
    const diff = computeFileDiff(originalContent, patch.fullContent);
    return {
      filePath: patch.filePath,
      addedLines: diff.filter((line) => line.type === "added").length,
      removedLines: diff.filter((line) => line.type === "removed").length,
      diff,
    };
  });

  input.onProgress?.("Ready");
  return {
    ok: true,
    dialect: schema.dialect,
    migrationFormat: schema.migrationFormat,
    confidence,
    summary,
    warnings: [...detectionWarnings, ...warnings, ...validationWarnings],
    applyPatches,
    fileDiffs,
    preview,
  };
}
