import path from "node:path";

export function resolveTargetPath(inputPath?: string): string {
  if (!inputPath || inputPath.trim() === "") {
    return process.cwd();
  }

  return path.resolve(inputPath);
}