import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { planFeatureWithLlm } from "../llm/planFeature.js";
import { planPatchPreviewWithLlm } from "../llm/planPatchPreview.js";
import { planFullPatchWithLlm } from "../llm/planFullPatch.js";
import type { TaskIntent } from "./taskIntentParser.js";

export type LlmPatchFlowResult =
  | {
      ok: true;
      patchPreview: string;
      warnings: string[];
      applyPatches: Array<{ filePath: string; fullContent: string }>;
    }
  | { ok: false; reason: string };

/** A fully-populated TaskIntent representing "I don't know what this is". */
const UNKNOWN_INTENT: TaskIntent = {
  rawTask: "",
  normalizedTask: "",
  action: "unknown",
  resourceKind: "unknown",
  scope: "unknown",
  mentionsNestedItem: false,
  destructiveRisk: false,
  routeHints: [],
  paramHints: [],
  warnings: [],
};

export async function runLlmPatchFlow(input: {
  task: string;
  repoPath: string;
}): Promise<LlmPatchFlowResult> {
  // 1. Scan repo
  const allFiles = await scanRepo(input.repoPath);

  // 2. Detect structure
  const structure = detectProjectStructure(allFiles);
  const projectSummary =
    structure.notes.join(" ") || "No project summary available.";

  // 3. Rank relevant files — top 8
  const relevantFiles = rankRelevantFiles({
    task: input.task,
    files: allFiles,
  }).slice(0, 8);

  // 4. Plan feature with LLM
  let llmPlan: Awaited<ReturnType<typeof planFeatureWithLlm>>;
  try {
    llmPlan = await planFeatureWithLlm({
      task: input.task,
      intent: UNKNOWN_INTENT,
      projectSummary,
      projectNotes: structure.notes,
      relevantFiles: relevantFiles.map((f) => ({
        path: f.path,
        category: f.category,
      })),
      schemaAwareSummary: [],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  // 5. Read top 4 suggested files
  const filePaths = llmPlan.suggestedFiles
    .slice(0, 4)
    .map((f) => allFiles.find((rf) => rf.path === f.path)?.absolutePath)
    .filter((p): p is string => typeof p === "string");

  const fileContentsMap = await readProjectFiles(filePaths);

  const fileContexts = Object.entries(fileContentsMap).map(
    ([absPath, content]) => ({
      path: allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
      content,
    })
  );

  // 6. Plan patch preview with LLM
  let patchPlan: Awaited<ReturnType<typeof planPatchPreviewWithLlm>>;
  try {
    patchPlan = await planPatchPreviewWithLlm({
      task: input.task,
      intent: UNKNOWN_INTENT,
      projectSummary,
      projectNotes: structure.notes,
      suggestedFiles: llmPlan.suggestedFiles
        .slice(0, 4)
        .map((f) => ({ path: f.path, action: f.action, reason: f.reason })),
      fileContexts,
      schemaAwareSummary: [],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  // 6b. Generate full file content for modify/create patches
  let applyPatches: Array<{ filePath: string; fullContent: string }> = [];
  try {
    const applyTargets = patchPlan.patches.filter(
      (p) => p.operation === "modify" || p.operation === "create"
    );

    const applyResults = await Promise.all(
      applyTargets.map(async (patch) => {
        const repoFile = allFiles.find((f) => f.path === patch.path);
        const absolutePath = repoFile?.absolutePath;

        const currentContentMap =
          absolutePath !== undefined
            ? await readProjectFiles([absolutePath])
            : {};

        const fileContent =
          absolutePath !== undefined
            ? (currentContentMap[absolutePath] ?? "")
            : "";

// Java ve diğer page object dosyalarını context'e ekle
const pageObjectFiles = allFiles.filter(
  (f) => f.path.endsWith(".java") || f.path.includes("page")
).slice(0, 5);

const pageObjectPaths = pageObjectFiles
  .map((f) => f.absolutePath)
  .filter((p): p is string => typeof p === "string");

const pageObjectContentsMap = pageObjectPaths.length > 0
  ? await readProjectFiles(pageObjectPaths)
  : {};

const pageObjectContext = Object.entries(pageObjectContentsMap)
  .map(([absPath, content]) => {
    const relPath = allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath;
    return `FILE: ${relPath}\n${content}`;
  })
  .join("\n\n");

const fullPatch = await planFullPatchWithLlm({
  task: input.task,
  filePath: patch.path,
  fileContent,
  repoSummary: projectSummary,
  relatedContext: [patch.summary, pageObjectContext].filter(Boolean).join("\n\n"),
});

        return { filePath: fullPatch.filePath, fullContent: fullPatch.fullContent };
      })
    );

    applyPatches = applyResults;
  } catch {
    // step 6b is best-effort — never block the preview result
    applyPatches = [];
  }

  // 7. Build patchPreview string
  const patchPreview = [
    "=== LLM PATCH PREVIEW ===",
    `Summary: ${patchPlan.summary}`,
    "",
    "Patches:",
    ...patchPlan.patches.map(
      (p) =>
        `- ${p.path} [${p.operation}]\n  ${p.summary}\n  Hint: ${p.targetHint}`
    ),
    ...(patchPlan.warnings.length > 0
      ? ["", "Warnings:", ...patchPlan.warnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");

  // 8. Return
  return { ok: true, patchPreview, warnings: patchPlan.warnings, applyPatches };
}
