import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { debugLog } from "../utils/logger.js";

const TABLE_NAME = "zone_file_embeddings";
const UPSERT_TIMEOUT_MS = 30000;

type StoredEmbeddingRow = {
  repo_path: string;
  file_path: string;
  file_hash: string;
  embedding?: unknown;
};

type RepoEmbeddingRow = {
  file_path: string;
  file_hash: string;
};

type MatchSimilarFilesRow = {
  file_path: string;
  similarity: number | string;
};

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export function isEmbeddingBackendAvailable(): boolean {
  return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function vectorToLiteral(values: number[]): string {
  return `[${values.map((value) => Number(value)).join(",")}]`;
}

function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  }

  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const normalized = raw.replace(/^\[/, "").replace(/\]$/, "");
  return normalized
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

export async function getStoredEmbedding(
  repoPath: string,
  filePath: string
): Promise<{ fileHash: string; embedding: number[] } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  debugLog("[zone-embed-repo-debug]", {
    action: "getStoredEmbedding",
    repoPath,
    filePath,
  });

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("repo_path,file_path,file_hash,embedding")
    .eq("repo_path", repoPath)
    .eq("file_path", filePath)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load stored embedding");
  }

  if (!data) return null;
  const row = data as StoredEmbeddingRow;
  return {
    fileHash: row.file_hash,
    embedding: parseVector(row.embedding),
  };
}

export async function upsertEmbedding(args: {
  repoPath: string;
  filePath: string;
  fileHash: string;
  contentPreview: string;
  embedding: number[];
}): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  debugLog("[zone-embed-repo-debug]", {
    action: "upsertEmbedding",
    repoPath: args.repoPath,
    filePath: args.filePath,
    fileHash: args.fileHash,
    embeddingLength: args.embedding.length,
  });

  const startedAt = Date.now();
  debugLog("[zone-embed-upsert-start]", {
    filePath: args.filePath,
    embeddingLength: args.embedding.length,
  });

  const { error } = await Promise.race([
    supabase.from(TABLE_NAME).upsert(
      {
        repo_path: args.repoPath,
        file_path: args.filePath,
        file_hash: args.fileHash,
        content_preview: args.contentPreview,
        embedding: vectorToLiteral(args.embedding),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "repo_path,file_path" }
    ),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Embedding upsert timed out after ${UPSERT_TIMEOUT_MS}ms`));
      }, UPSERT_TIMEOUT_MS);
    }),
  ]);

  debugLog("[zone-embed-upsert-end]", {
    filePath: args.filePath,
    elapsedMs: Date.now() - startedAt,
  });

  if (error) {
    throw new Error(error.message || "Failed to upsert embedding");
  }
}

export async function getAllEmbeddingsForRepo(
  repoPath: string
): Promise<Array<{ filePath: string; fileHash: string }>> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  debugLog("[zone-embed-repo-debug]", {
    action: "getAllEmbeddingsForRepo",
    repoPath,
  });

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("file_path,file_hash")
    .eq("repo_path", repoPath);

  if (error) {
    throw new Error(error.message || "Failed to list repo embeddings");
  }

  return Array.isArray(data)
    ? data.map((row) => ({
        filePath: (row as RepoEmbeddingRow).file_path,
        fileHash: (row as RepoEmbeddingRow).file_hash,
      }))
    : [];
}

export async function getEmbeddingCountForRepo(repoPath: string): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) return 0;

  debugLog("[zone-embed-repo-debug]", {
    action: "getEmbeddingCountForRepo",
    repoPath,
  });

  const { count, error } = await supabase
    .from(TABLE_NAME)
    .select("file_path", { count: "exact", head: true })
    .eq("repo_path", repoPath);

  if (error) {
    throw new Error(error.message || "Failed to count repo embeddings");
  }

  return Number(count || 0);
}

export async function deleteEmbeddingsForFiles(
  repoPath: string,
  filePaths: string[]
): Promise<void> {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  debugLog("[zone-embed-repo-debug]", {
    action: "deleteEmbeddingsForFiles",
    repoPath,
    count: filePaths.length,
  });

  const { error } = await supabase
    .from(TABLE_NAME)
    .delete()
    .eq("repo_path", repoPath)
    .in("file_path", filePaths);

  if (error) {
    throw new Error(error.message || "Failed to delete stale embeddings");
  }
}

export async function matchSimilarFiles(args: {
  repoPath: string;
  queryEmbedding: number[];
  matchCount?: number;
}): Promise<Array<{ filePath: string; similarity: number }>> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const matchCount = Math.max(1, Math.floor(args.matchCount ?? 20));

  debugLog("[zone-embed-repo-debug]", {
    action: "matchSimilarFiles",
    repoPath: args.repoPath,
    matchCount,
    embeddingLength: args.queryEmbedding.length,
  });

  const { data, error } = await supabase.rpc("match_file_embeddings", {
    p_repo_path: args.repoPath,
    p_query_embedding: vectorToLiteral(args.queryEmbedding),
    p_match_count: matchCount,
  });

  if (error) {
    throw new Error(error.message || "Failed to match similar files");
  }

  return Array.isArray(data)
    ? data.map((row) => ({
        filePath: (row as MatchSimilarFilesRow).file_path,
        similarity: Number((row as MatchSimilarFilesRow).similarity),
      }))
    : [];
}
