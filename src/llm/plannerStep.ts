import { z } from "zod";
import { createLLMClient } from "./factory.js";
import { getModelName } from "./openaiClient.js";
import { getRequestContext } from "./openaiContext.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import { buildDependencyGraph, type DependencyGraph } from "../repo/buildDependencyGraph.js";
import { getRelatedFiles, type RelatedFile } from "../repo/getRelatedFiles.js";
import path from "node:path";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { extractFunctionRanges } from "../ast/extractFunctionRange.js";
import { tryParseJsonRobust } from "./tryParseJsonRobust.js";

const plannerOutputSchema = z.object({
  filesToEdit: z.array(z.string()),
  changeDescription: z.string(),
  strategy: z.string(),
});

export type PlannerStepOutput = {
  filesToEdit: string[];
  changeDescription: string;
  strategy: string;
  relatedFiles: RelatedFile[];
  dependencyWarnings: string[];
  /** Extra text injected into patch planning notes. */
  dependencyContextForPrompt: string;
};

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

function buildDependencyArtifacts(
  targets: string[],
  related: RelatedFile[],
  graph: DependencyGraph
): { warnings: string[]; prompt: string } {
  const warnings: string[] = [];
  const lines: string[] = [];
  for (const r of related) {
    lines.push(`- ${r.filePath} (${r.relationship}, score ${r.score})`);
  }
  const tset = new Set(targets.map(posix));
  for (const t of targets) {
    const tp = posix(t);
    const n = graph.nodes.get(tp);
    if (!n) continue;
    for (const by of n.importedBy) {
      if (!tset.has(posix(by))) {
        warnings.push(`${by} imports ${tp} — changes may affect dependent code.`);
      }
    }
    for (const imp of n.imports) {
      if (tset.has(posix(imp))) {
        warnings.push(`${tp} imports ${imp} — coupled files in edit set.`);
      }
    }
  }
  const prompt =
    lines.length > 0
      ? [
          "Related files that may be affected:",
          ...lines,
          "Consider these files when making changes.",
        ].join("\n")
      : "";
  return { warnings: [...new Set(warnings)].slice(0, 8), prompt };
}

export async function plannerStep(input: {
  task: string;
  rankedFilePaths: string[];
  repoSummary: string;
  framework?: ProjectFramework;
  repoPath?: string;
  /** Relative repo paths (e.g. from scanRepo) for dependency analysis. */
  allRepoFilePaths?: string[];
  /** Optional conversation history (unknown JSON objects), last N messages. */
  conversationHistory?: unknown[];
  /** Synchronous hint from UI (preferred when present). */
  lastChangedFiles?: string[];
  /** Recently added function names (synchronous hint from UI). */
  lastAddedFunctions?: string[];
}): Promise<PlannerStepOutput | null> {
  const client = createLLMClient();
  const fwLine = input.framework
    ? `Project type: ${input.framework.framework} (${input.framework.language})\nTest command: ${input.framework.testCommand}`
    : "";

  // Multi-turn memory: only include recent user turns, compactly.
  const hist = Array.isArray(input.conversationHistory) ? input.conversationHistory : [];
  const fallbackLastChanged =
    Array.isArray(input.lastChangedFiles)
      ? input.lastChangedFiles.filter((x) => typeof x === "string" && x.trim()).slice(0, 3)
      : [];
  const hasAnyChangedFilesInHistory = hist.some(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as { type?: unknown }).type === "user" &&
      Array.isArray((m as { changedFiles?: unknown }).changedFiles) &&
      ((m as { changedFiles?: unknown[] }).changedFiles || []).length > 0
  );
  const userTurns = hist
    .filter((m) => m && typeof m === "object" && (m as { type?: unknown }).type === "user")
    .slice(-5)
    .map((t, idx, arr) => {
      const anyT = t as { text?: unknown; task?: unknown; changedFiles?: unknown };
      const raw = String((anyT.text ?? anyT.task ?? "") || "").trim();
      const clipped = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      const changedFilesRaw = Array.isArray(anyT.changedFiles)
        ? (anyT.changedFiles as unknown[])
            .filter((x) => typeof x === "string" && x.trim())
            .slice(0, 3)
            .map((x) => String(x).trim())
        : [];
      const isMostRecent = idx === arr.length - 1;
      const useFallback =
        isMostRecent &&
        changedFilesRaw.length === 0 &&
        fallbackLastChanged.length > 0 &&
        !hasAnyChangedFilesInHistory;
      const effectiveChanged = useFallback ? fallbackLastChanged : changedFilesRaw;
      const changedLine = effectiveChanged.length > 0
        ? `→ Changed: ${effectiveChanged.join(", ")}`
        : "";
      return { text: clipped, changedLine };
    })
    .filter((s) => !!s.text);
  const historyBlock =
    userTurns.length > 0
      ? [
          `CONVERSATION HISTORY (last ${userTurns.length} turns):`,
          ...userTurns.flatMap((t, i) =>
            t.changedLine
              ? [`[${i + 1}] User: ${t.text}`, `    ${t.changedLine}`]
              : [`[${i + 1}] User: ${t.text}`]
          ),
          ...(Array.isArray(input.lastAddedFunctions) && input.lastAddedFunctions.length > 0
            ? [
                "",
                `→ Recently added function(s): ${input.lastAddedFunctions
                  .filter((x) => typeof x === "string" && x.trim())
                  .slice(0, 5)
                  .join(", ")}`,
                `When user says "the function you just added", they likely mean: ${input.lastAddedFunctions
                  .filter((x) => typeof x === "string" && x.trim())
                  .slice(0, 1)
                  .join(", ")}`,
              ]
            : []),
          "",
          "Use this context to understand references like “the previous change”, “fix what you did”, etc.",
          "",
        ].join("\n")
      : "";

  const prompt = [
    ...(historyBlock ? [historyBlock] : []),
    "You are a code-change planner for a patch execution agent.",
    "You only see file paths (no file contents). Choose the minimal set of files to edit.",
    "",
    "Return ONLY valid JSON with this exact shape:",
    `{ "filesToEdit": string[], "changeDescription": string, "strategy": string }`,
    "",
    "Rules:",
    "- filesToEdit MUST be a subset of rankedFilePaths (do not invent paths).",
    "- Prefer 1-3 files if possible.",
    "- Keep changeDescription and strategy concise (1-3 sentences each).",
    "",
    ...(fwLine ? [fwLine, ""] : []),
    `Repo summary:\n${input.repoSummary}`,
    "",
    `Task:\n${input.task}`,
    "",
    "rankedFilePaths:",
    ...input.rankedFilePaths.map((p) => `- ${p}`),
  ].join("\n");

  async function requestPlannerOutput(promptText: string): Promise<string> {
    const ctx = getRequestContext();
    const response = await client.createChatCompletion({
      model: getModelName("standard", client.provider, ctx?.modelOverride),
      temperature: 0,
      messages: [{ role: "user", content: promptText }],
    });

    return String(response.choices[0]?.message?.content ?? "").trim();
  }

  let raw = await requestPlannerOutput(prompt);
  let parsed = await tryParseJsonRobust(raw);

  if (parsed == null) {
    console.warn("[zone-plan-parse-error] failed to parse plan JSON", {
      rawLength: raw.length,
      rawPreview: raw.slice(0, 300),
      attempt: 1,
    });

    raw = await requestPlannerOutput(
      `${prompt}\n\nIMPORTANT: Return ONLY valid JSON, no trailing commas, no markdown code fences.`
    );
    parsed = await tryParseJsonRobust(raw);
  }

  if (parsed == null) {
    console.warn("[zone-plan-parse-error] failed to parse plan JSON", {
      rawLength: raw.length,
      rawPreview: raw.slice(0, 300),
      attempt: 2,
    });
    return null;
  }

  const validated = plannerOutputSchema.safeParse(parsed);
  if (!validated.success) return null;

  const allowed = new Set(input.rankedFilePaths);
  const filesToEdit = validated.data.filesToEdit.filter((p) => allowed.has(p));
  if (filesToEdit.length === 0) return null;

  let relatedFiles: RelatedFile[] = [];
  let dependencyWarnings: string[] = [];
  let dependencyContextForPrompt = "";

  console.log("[zone-dep-graph-start]", {
    repoPath: !!input.repoPath,
    filesCount: input.rankedFilePaths?.length,
  });

  if (
    typeof input.repoPath === "string" &&
    input.repoPath.length > 0 &&
    Array.isArray(input.allRepoFilePaths) &&
    input.allRepoFilePaths.length > 0
  ) {
    try {
      const graph = await buildDependencyGraph(input.repoPath, input.allRepoFilePaths);
      relatedFiles = getRelatedFiles(filesToEdit, graph, 8);
      console.log("[zone-dep-graph]", {
        targetFiles: filesToEdit,
        relatedCount: relatedFiles.length,
        related: relatedFiles.map((f) => f.filePath + ":" + f.relationship),
      });
      const art = buildDependencyArtifacts(filesToEdit, relatedFiles, graph);
      dependencyWarnings = art.warnings;
      dependencyContextForPrompt = art.prompt;
    } catch (err) {
      console.log(
        "[zone-dep-graph-error]",
        err instanceof Error ? err.message : String(err)
      );
      relatedFiles = [];
      dependencyWarnings = [];
      dependencyContextForPrompt = "";
    }
  }

  if (typeof input.repoPath === "string" && input.repoPath.length > 0) {
    try {
      const absPaths = filesToEdit.map((p) => path.join(input.repoPath as string, p));
      const contentMap = await readProjectFiles(absPaths, { maxFiles: absPaths.length, maxCharsPerFile: 12000 });
      const symbolLines: string[] = [];
      for (let i = 0; i < filesToEdit.length; i += 1) {
        const rel = filesToEdit[i] ?? "";
        const abs = absPaths[i] ?? "";
        const content = contentMap[abs] ?? "";
        if (!content) continue;
        const res = extractFunctionRanges(content, rel);
        if (res.ok && res.functions.length > 0) {
          const names = res.functions.map((f) => f.name).slice(0, 30);
          symbolLines.push(`File ${rel} exports: ${names.join(", ")}`);
        }
      }
      if (symbolLines.length > 0) {
        dependencyContextForPrompt = [
          dependencyContextForPrompt,
          dependencyContextForPrompt ? "" : "",
          "AVAILABLE SYMBOLS (function scan):",
          ...symbolLines,
        ]
          .filter(Boolean)
          .join("\n");
      }
    } catch (err) {
      console.log(
        "[zone-ast-scan-error]",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    filesToEdit,
    changeDescription: validated.data.changeDescription,
    strategy: validated.data.strategy,
    relatedFiles,
    dependencyWarnings,
    dependencyContextForPrompt,
  };
}
