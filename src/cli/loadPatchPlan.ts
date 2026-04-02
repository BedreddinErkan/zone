import path from "node:path";
import { readFileSync } from "node:fs";

import type { PatchPlan } from "../apply/patchPlan.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertValidPatchPlan(value: unknown): asserts value is PatchPlan {
  if (!isObject(value)) {
    throw new Error("Patch plan must be a JSON object.");
  }

  if (!("patches" in value) || !Array.isArray(value.patches)) {
    throw new Error('Patch plan must include a "patches" array.');
  }

  for (const [index, patch] of value.patches.entries()) {
    if (!isObject(patch)) {
      throw new Error(`Patch plan patch at index ${index} must be an object.`);
    }

    if (typeof patch.filePath !== "string" || patch.filePath.trim().length === 0) {
      throw new Error(`Patch plan patch at index ${index} must include a valid filePath.`);
    }

    if (typeof patch.nextContent !== "string") {
      throw new Error(`Patch plan patch at index ${index} must include nextContent as a string.`);
    }
  }
}

export function loadPatchPlan(filePath: string): PatchPlan {
  const resolvedPath = path.resolve(filePath);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read patch plan: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse patch plan JSON: ${message}`);
  }

  assertValidPatchPlan(parsed);
  return parsed;
}