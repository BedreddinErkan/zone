import { buildEmbedInput, embedText, hashFileContent } from "./embedFile.js";
import {
  deleteEmbeddingsForFiles,
  getAllEmbeddingsForRepo,
  upsertEmbedding,
} from "./embeddingsRepository.js";

type RepoFileInput = {
  path: string;
  content: string;
};

type IndexRepoFilesArgs = {
  repoPath: string;
  files: RepoFileInput[];
  onProgress?: (done: number, total: number) => void;
};

const EMBED_CONCURRENCY = 2;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function indexRepoFiles(args: IndexRepoFilesArgs): Promise<{
  embedded: number;
  cacheHits: number;
  deleted: number;
}> {
  const startedAt = Date.now();
  const files = Array.isArray(args.files) ? args.files : [];

  console.log("[zone-embed-index-start]", {
    repoPath: args.repoPath,
    fileCount: files.length,
  });

  const storedEmbeddings = await getAllEmbeddingsForRepo(args.repoPath);
  const storedByPath = new Map(
    storedEmbeddings.map((item) => [item.filePath, item.fileHash])
  );
  const currentPaths = new Set(files.map((file) => file.path));
  const deletedPaths = storedEmbeddings
    .filter((item) => !currentPaths.has(item.filePath))
    .map((item) => item.filePath);

  if (deletedPaths.length > 0) {
    await deleteEmbeddingsForFiles(args.repoPath, deletedPaths);
  }

  let embedded = 0;
  let cacheHits = 0;
  let done = 0;

  const processableFiles = files.map((file) => ({
    ...file,
    fileHash: hashFileContent(file.content),
  }));

  const chunks = chunkArray(processableFiles, EMBED_CONCURRENCY);
  for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += 1) {
    const chunk = chunks[batchIndex] ?? [];
    const batchStartedAt = Date.now();
    console.log("[zone-embed-batch-start]", {
      batchIndex,
      batchSize: chunk.length,
      fileNames: chunk.map((file) => file.path),
    });
    let batchSucceeded = 0;
    let batchFailed = 0;
    await Promise.all(
      chunk.map(async (file) => {
        const previousHash = storedByPath.get(file.path);
        if (previousHash && previousHash === file.fileHash) {
          cacheHits += 1;
          batchSucceeded += 1;
          done += 1;
          args.onProgress?.(done, files.length);
          console.log("[zone-embed-index-progress]", {
            done,
            total: files.length,
            lastFile: file.path,
            mode: "cache_hit",
          });
          return;
        }

        try {
          const embedding = await embedText(buildEmbedInput(file.path, file.content));
          if (embedding === null) {
            console.log("[zone-embed-index-progress]", {
              done: done + 1,
              total: files.length,
              lastFile: file.path,
              mode: "skipped_no_embedding_support",
            });
            return;
          }
          await upsertEmbedding({
            repoPath: args.repoPath,
            filePath: file.path,
            fileHash: file.fileHash,
            contentPreview: String(file.content || "").slice(0, 500),
            embedding,
          });
          embedded += 1;
          batchSucceeded += 1;
          console.log("[zone-embed-index-progress]", {
            done: done + 1,
            total: files.length,
            lastFile: file.path,
            mode: "embedded",
          });
        } catch (error) {
          batchFailed += 1;
          const errorRecord = error as
            | {
                message?: unknown;
                code?: unknown;
              }
            | null
            | undefined;
          const message =
            typeof errorRecord?.message === "string" && errorRecord.message.trim()
              ? errorRecord.message
              : String(error);
          if (message.includes("timed out")) {
            console.error("[zone-embed-timeout]", {
              filePath: file.path,
              stage: "indexRepoFiles",
              error: message,
            });
          }
          console.error("[zone-embed-error]", {
            filePath: file.path,
            error: message,
            code: errorRecord?.code,
            raw: JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
          });
        } finally {
          done += 1;
          args.onProgress?.(done, files.length);
        }
      })
    );
    console.log("[zone-embed-batch-end]", {
      batchIndex,
      succeeded: batchSucceeded,
      failed: batchFailed,
      elapsedMs: Date.now() - batchStartedAt,
    });
  }

  console.log("[zone-embed-index-done]", {
    embedded,
    cacheHits,
    deleted: deletedPaths.length,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    embedded,
    cacheHits,
    deleted: deletedPaths.length,
  };
}
