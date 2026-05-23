import { parseTaskIntent } from "./taskIntentParser.js";
import { selectRelevantBlocks } from "./selectRelevantBlocks.js";
import { analyzePatchRisk } from "./patchRiskAnalyzer.js";
import { validateSuggestedArchitecture } from "./validateSuggestedArchitecture.js";
import { loadSchemaSnapshot } from "../repo/loadSchemaSnapshot.js";
import { analyzeProjectPatterns } from "../repo/analyzeProjectPatterns.js";
import { detectResourceStorage } from "./detectResourceStorage.js";
import { buildSchemaAwareContext } from "./buildSchemaAwareContext.js";

export function buildTaskKeywords(task: string, extra: string[] = []): string[] {
  return Array.from(
    new Set(
      task
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .filter(Boolean)
        .concat(extra.filter(Boolean))
    )
  );
}

export function buildContextBlocksFromFiles(
  files: Array<{ path: string; content: string }>,
  keywords: string[]
) {
  return files.flatMap((file) =>
    selectRelevantBlocks({
      filePath: file.path,
      content: file.content,
      keywords,
      maxBlocks: 3
    })
  );
}

export async function buildExecutionContext(input: {
  projectRoot: string;
  task: string;
  candidateFiles: Array<{ path: string; content: string }>;
  suggestedFiles: string[];
  patchPreview?: string;
}) {
  const intent = parseTaskIntent(input.task);

  const keywords = buildTaskKeywords(input.task, [
    intent.parentResource ?? "",
    intent.nestedResource ?? "",
    ...intent.paramHints
  ]);

  const contextBlocks = buildContextBlocksFromFiles(input.candidateFiles, keywords);

  const architectureValidation = validateSuggestedArchitecture(
    intent,
    input.suggestedFiles
  );

  const patchRisk = input.patchPreview
    ? analyzePatchRisk(intent, input.patchPreview)
    : { warnings: [], isHighRisk: false };

  const schemaSnapshot = await loadSchemaSnapshot(input.projectRoot);

  const projectPatternAnalysis = analyzeProjectPatterns(input.candidateFiles);

  const resourceStorageInsight = intent.parentResource
    ? detectResourceStorage({
        parentResource: intent.parentResource,
        nestedResource: intent.nestedResource,
        files: input.candidateFiles,
        schema: schemaSnapshot
      })
    : null;

  const schemaAwareContext = buildSchemaAwareContext({
    intent,
    schema: schemaSnapshot,
    projectPatterns: projectPatternAnalysis,
    storageInsight: resourceStorageInsight
  });

  return {
    intent,
    keywords,
    contextBlocks,
    architectureWarnings: architectureValidation.warnings,
    patchRiskWarnings: patchRisk.warnings,
    isHighRisk: patchRisk.isHighRisk,

    schemaSnapshot,
    projectPatternAnalysis,
    resourceStorageInsight,
    schemaAwareSummary: schemaAwareContext.summaryLines
  };
}