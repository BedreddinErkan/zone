import path from "node:path";
import type {
  PlannedFileChange,
  ValidatedSuggestedFile
} from "../types/agent.js";
import type { RepoFile } from "../types/project.js";

function normalize(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function findExactMatch(
  files: RepoFile[],
  suggestedPath: string
): RepoFile | undefined {
  const normalizedSuggested = normalize(suggestedPath);
  return files.find((file) => normalize(file.path) === normalizedSuggested);
}

function findLooseMatch(
  files: RepoFile[],
  suggestedPath: string
): RepoFile | undefined {
  const normalizedSuggested = normalize(suggestedPath);
  const suggestedBaseName = path.basename(normalizedSuggested);

  let match = files.find(
    (file) => path.basename(normalize(file.path)) === suggestedBaseName
  );

  if (match) {
    return match;
  }

  const simplifiedSuggested = normalizedSuggested
    .replace("/controllers/", "/")
    .replace("/routes/", "/")
    .replace("/services/", "/");

  match = files.find((file) => {
    const candidate = normalize(file.path)
      .replace("/controllers/", "/")
      .replace("/routes/", "/")
      .replace("/services/", "/");

    return candidate === simplifiedSuggested;
  });

  return match;
}

export function validateSuggestedFiles(
  suggestedFiles: PlannedFileChange[],
  repoFiles: RepoFile[]
): ValidatedSuggestedFile[] {
  return suggestedFiles.map((item) => {
    const exactMatch = findExactMatch(repoFiles, item.path);

    if (exactMatch) {
      return {
        originalPath: item.path,
        resolvedPath: exactMatch.path,
        action: item.action,
        reason: item.reason,
        status: "verified"
      };
    }

    const looseMatch = findLooseMatch(repoFiles, item.path);

    if (looseMatch) {
      return {
        originalPath: item.path,
        resolvedPath: looseMatch.path,
        action: item.action,
        reason: item.reason,
        status: "corrected"
      };
    }

    return {
      originalPath: item.path,
      resolvedPath: null,
      action: item.action,
      reason: item.reason,
      status: "missing"
    };
  });
}