import { readFile } from "node:fs/promises";
import path from "node:path";
import { debugLog } from "../utils/logger.js";
import {
  extractResponsesApiOutputText,
  getModelName,
} from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import { scanRepo } from "../repo/scanRepo.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { isIrrelevantDeveloperContextPath } from "../core/runLlmPatchFlow.js";
import { embedText } from "../embeddings/embedFile.js";
import {
  getEmbeddingCountForRepo,
  matchSimilarFiles,
} from "../embeddings/embeddingsRepository.js";
import { indexRepoFiles } from "../embeddings/indexRepository.js";
import { renderChatMarkdownToHtml } from "./renderChatMarkdown.js";

export type ZoneChatContextFile = {
  path: string;
  content: string;
};

export type ZoneChatResponseResult = {
  responseText: string;
  responseHtml: string;
  contextFiles: string[];
};

type BuildChatContextResult = {
  contextFiles: ZoneChatContextFile[];
};

function buildChatPrompt(input: {
  task: string;
  repoPath: string;
  contextFiles: ZoneChatContextFile[];
}): string {
  const contextText =
    input.contextFiles.length > 0
      ? input.contextFiles
          .map(
            (file) =>
              `FILE: ${file.path}\n${String(file.content || "").slice(0, 12000)}`
          )
          .join("\n\n")
      : "(no matching context files found)";

  return [
    "You are Zone, an AI coding assistant. The user is asking a question or having a discussion about their codebase. Respond with a clear, helpful prose answer.",
    "",
    "- Reference specific files and functions when relevant",
    "- Cite line numbers if useful",
    "- Don't generate code patches unless explicitly requested",
    "- Be concise but thorough",
    "- Format with markdown (headings, code blocks for snippets, lists)",
    "",
    `Repo path: ${input.repoPath}`,
    "",
    `User task:\n${input.task}`,
    "",
    `Codebase context:\n${contextText}`,
  ].join("\n");
}

async function buildChatContext(
  task: string,
  repoPath: string,
  lastChangedFiles?: string[]
): Promise<BuildChatContextResult> {
  const files = await scanRepo(repoPath);
  const developerContextFiles = files.filter(
    (file) => !isIrrelevantDeveloperContextPath(file.path)
  );

  const repoPathLooksLocal =
    typeof repoPath === "string" &&
    repoPath.length > 0 &&
    !repoPath.startsWith("/hosted") &&
    !repoPath.startsWith("/tmp/zone-hosted");

  let semanticScores: Map<string, number> | undefined;
  if (repoPathLooksLocal && developerContextFiles.length > 0) {
    try {
      const embeddableFiles = (
        await Promise.all(
          developerContextFiles.map(async (file) => ({
            path: file.path,
            content: await readFile(String(file.absolutePath), "utf8").catch(() => ""),
          }))
        )
      ).filter((file) => file.content.length > 0);

      const existingEmbeddingCount = await getEmbeddingCountForRepo(repoPath);
      if (existingEmbeddingCount === 0) {
        await indexRepoFiles({
          repoPath,
          files: embeddableFiles,
        });
      } else {
        void indexRepoFiles({
          repoPath,
          files: embeddableFiles,
        }).catch((error) => {
          console.warn(
            "[zone-embed-bg-error]",
            error instanceof Error ? error.message : String(error)
          );
        });
      }

      const queryEmbedding = await embedText(task);
      const matches =
        queryEmbedding === null
          ? []
          : await matchSimilarFiles({
              repoPath,
              queryEmbedding,
              matchCount: 30,
            });
      if (queryEmbedding === null) {
        debugLog("[zone-chat-debug]", {
          stage: "semantic_skipped",
          reason: "no_query_embedding",
        });
      }
      semanticScores = new Map(
        matches
          .filter(
            (match) =>
              typeof match.filePath === "string" &&
              match.filePath.trim().length > 0 &&
              Number.isFinite(match.similarity)
          )
          .map((match) => [match.filePath, match.similarity])
      );

      debugLog("[zone-chat-debug]", {
        stage: "semantic_context_ready",
        repoPath,
        semanticScoresSize: semanticScores.size,
        topMatches: matches.slice(0, 5),
      });
    } catch (error) {
      console.warn(
        "[zone-embed-bg-error]",
        error instanceof Error ? error.message : String(error)
      );
      semanticScores = undefined;
    }
  }

  const readContentForRanker = async (relPath: string): Promise<string | null> => {
    try {
      return await readFile(path.join(repoPath, relPath), "utf8");
    } catch {
      return null;
    }
  };
  const ranked = await rankRelevantFiles({
    task,
    files: developerContextFiles,
    semanticScores,
    lastChangedFiles,
    readContent: readContentForRanker,
  });
  const topFiles = ranked.slice(0, 5);
  const contents =
    topFiles.length > 0
      ? await readProjectFiles(topFiles.map((file) => file.absolutePath))
      : {};

  const contextFiles = topFiles.map((file) => ({
    path: file.path,
    content: contents[file.absolutePath] ?? "",
  }));

  debugLog("[zone-chat-debug]", {
    stage: "context_ranked",
    repoPath,
    contextFiles: contextFiles.map((file) => file.path),
  });

  return { contextFiles };
}

async function streamChatText(input: {
  prompt: string;
  onChunk?: (delta: string) => void | Promise<void>;
}): Promise<string> {
  const client = createLLMClient();
  const ctx = getRequestContext();
  const model = getModelName("high", client.provider, ctx?.modelOverride);

  try {
    const stream = await client.createChatCompletionStream({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: input.prompt }],
      stream: true,
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        fullResponse += delta;
        await input.onChunk?.(delta);
      }
    }
    return fullResponse.trim();
  } catch {
    // Fallback to non-streaming on any streaming failure.
    const response = await client.createChatCompletion({
      model,
      temperature: 0.2,
      messages: [{ role: "user", content: input.prompt }],
    });
    const extraction = extractResponsesApiOutputText(response);
    const text = extraction.ok ? extraction.text.trim() : "";
    if (text) {
      await input.onChunk?.(text);
    }
    return text;
  }
}

export async function getChatResponse(
  task: string,
  repoPath: string,
  _userId: string
): Promise<string> {
  const result = await getChatResponseWithContext({
    task,
    repoPath,
  });
  return result.responseText;
}

export async function getChatResponseWithContext(input: {
  task: string;
  repoPath: string;
  onChunk?: (delta: string) => void | Promise<void>;
  lastChangedFiles?: string[];
}): Promise<ZoneChatResponseResult> {
  const normalizedTask = typeof input.task === "string" ? input.task.trim() : "";
  const normalizedRepoPath =
    typeof input.repoPath === "string" ? input.repoPath.trim() : "";

  if (!normalizedRepoPath || normalizedRepoPath.length < 5) {
    throw new Error("Invalid repoPath");
  }
  if (!normalizedTask) {
    return {
      responseText: "Ask me a question about your codebase.",
      responseHtml: renderChatMarkdownToHtml("Ask me a question about your codebase."),
      contextFiles: [],
    };
  }

  const { contextFiles } = await buildChatContext(
    normalizedTask,
    normalizedRepoPath,
    input.lastChangedFiles
  );
  const prompt = buildChatPrompt({
    task: normalizedTask,
    repoPath: normalizedRepoPath,
    contextFiles,
  });

  debugLog("[zone-chat-debug]", {
    stage: "prompt_ready",
    repoPath: normalizedRepoPath,
    taskPreview: normalizedTask.slice(0, 120),
    contextFiles: contextFiles.map((file) => file.path),
  });

  const responseText = await streamChatText({
    prompt,
    onChunk: input.onChunk,
  });

  return {
    responseText,
    responseHtml: renderChatMarkdownToHtml(responseText),
    contextFiles: contextFiles.map((file) => file.path),
  };
}
