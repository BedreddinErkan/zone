"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChatResponse = getChatResponse;
exports.getChatResponseWithContext = getChatResponseWithContext;
const promises_1 = require("node:fs/promises");
const openaiClient_js_1 = require("./openaiClient.js");
const scanRepo_js_1 = require("../repo/scanRepo.js");
const rankRelevantFiles_js_1 = require("../repo/rankRelevantFiles.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const embedFile_js_1 = require("../embeddings/embedFile.js");
const embeddingsRepository_js_1 = require("../embeddings/embeddingsRepository.js");
const indexRepository_js_1 = require("../embeddings/indexRepository.js");
const renderChatMarkdown_js_1 = require("./renderChatMarkdown.js");
function buildChatPrompt(input) {
    const contextText = input.contextFiles.length > 0
        ? input.contextFiles
            .map((file) => `FILE: ${file.path}\n${String(file.content || "").slice(0, 12000)}`)
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
async function buildChatContext(task, repoPath) {
    const files = await (0, scanRepo_js_1.scanRepo)(repoPath);
    const developerContextFiles = files.filter((file) => !(0, runLlmPatchFlow_js_1.isIrrelevantDeveloperContextPath)(file.path));
    const repoPathLooksLocal = typeof repoPath === "string" &&
        repoPath.length > 0 &&
        !repoPath.startsWith("/hosted") &&
        !repoPath.startsWith("/tmp/zone-hosted");
    let semanticScores;
    if (repoPathLooksLocal && developerContextFiles.length > 0) {
        try {
            const embeddableFiles = (await Promise.all(developerContextFiles.map(async (file) => ({
                path: file.path,
                content: await (0, promises_1.readFile)(String(file.absolutePath), "utf8").catch(() => ""),
            })))).filter((file) => file.content.length > 0);
            const existingEmbeddingCount = await (0, embeddingsRepository_js_1.getEmbeddingCountForRepo)(repoPath);
            if (existingEmbeddingCount === 0) {
                await (0, indexRepository_js_1.indexRepoFiles)({
                    repoPath,
                    files: embeddableFiles,
                });
            }
            else {
                void (0, indexRepository_js_1.indexRepoFiles)({
                    repoPath,
                    files: embeddableFiles,
                }).catch((error) => {
                    console.warn("[zone-embed-bg-error]", error instanceof Error ? error.message : String(error));
                });
            }
            const queryEmbedding = await (0, embedFile_js_1.embedText)(task);
            const matches = await (0, embeddingsRepository_js_1.matchSimilarFiles)({
                repoPath,
                queryEmbedding,
                matchCount: 30,
            });
            semanticScores = new Map(matches
                .filter((match) => typeof match.filePath === "string" &&
                match.filePath.trim().length > 0 &&
                Number.isFinite(match.similarity))
                .map((match) => [match.filePath, match.similarity]));
            console.log("[zone-chat-debug]", {
                stage: "semantic_context_ready",
                repoPath,
                semanticScoresSize: semanticScores.size,
                topMatches: matches.slice(0, 5),
            });
        }
        catch (error) {
            console.warn("[zone-embed-bg-error]", error instanceof Error ? error.message : String(error));
            semanticScores = undefined;
        }
    }
    const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
        task,
        files: developerContextFiles,
        semanticScores,
    });
    const topFiles = ranked.slice(0, 5);
    const contents = topFiles.length > 0
        ? await (0, readProjectFiles_js_1.readProjectFiles)(topFiles.map((file) => file.absolutePath))
        : {};
    const contextFiles = topFiles.map((file) => ({
        path: file.path,
        content: contents[file.absolutePath] ?? "",
    }));
    console.log("[zone-chat-debug]", {
        stage: "context_ranked",
        repoPath,
        contextFiles: contextFiles.map((file) => file.path),
    });
    return { contextFiles };
}
async function streamChatText(input) {
    const client = (0, openaiClient_js_1.createOpenAIClient)();
    const model = (0, openaiClient_js_1.getModelName)("high");
    const streamFn = client.responses.stream;
    if (typeof streamFn === "function") {
        const runner = client.responses.stream({
            model,
            temperature: 0.2,
            input: input.prompt,
        });
        let fullResponse = "";
        for await (const event of runner) {
            if (event?.type === "response.output_text.delta" &&
                typeof event.delta === "string" &&
                event.delta.length > 0) {
                fullResponse += event.delta;
                await input.onChunk?.(event.delta);
            }
        }
        const response = await runner.finalResponse();
        const extraction = (0, openaiClient_js_1.extractResponsesApiOutputText)(response);
        return extraction.ok ? extraction.text.trim() || fullResponse.trim() : fullResponse.trim();
    }
    const response = await client.responses.create({
        model,
        temperature: 0.2,
        input: input.prompt,
    });
    const extraction = (0, openaiClient_js_1.extractResponsesApiOutputText)(response);
    const text = extraction.ok ? extraction.text.trim() : "";
    if (text) {
        await input.onChunk?.(text);
    }
    return text;
}
async function getChatResponse(task, repoPath, _userId) {
    const result = await getChatResponseWithContext({
        task,
        repoPath,
    });
    return result.responseText;
}
async function getChatResponseWithContext(input) {
    const normalizedTask = typeof input.task === "string" ? input.task.trim() : "";
    const normalizedRepoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
    if (!normalizedRepoPath || normalizedRepoPath.length < 5) {
        throw new Error("Invalid repoPath");
    }
    if (!normalizedTask) {
        return {
            responseText: "Ask me a question about your codebase.",
            responseHtml: (0, renderChatMarkdown_js_1.renderChatMarkdownToHtml)("Ask me a question about your codebase."),
            contextFiles: [],
        };
    }
    const { contextFiles } = await buildChatContext(normalizedTask, normalizedRepoPath);
    const prompt = buildChatPrompt({
        task: normalizedTask,
        repoPath: normalizedRepoPath,
        contextFiles,
    });
    console.log("[zone-chat-debug]", {
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
        responseHtml: (0, renderChatMarkdown_js_1.renderChatMarkdownToHtml)(responseText),
        contextFiles: contextFiles.map((file) => file.path),
    };
}
//# sourceMappingURL=chatResponse.js.map