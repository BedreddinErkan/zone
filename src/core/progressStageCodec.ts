import type { AgentLifecycleEvent } from "./agentLifecycleEvents.js";

const PREFIX = "__zlf1__";

export type EncodedProgressStage = {
  displayStage: string;
  lastLifecycle?: AgentLifecycleEvent;
};

/**
 * Stores optional structured lifecycle alongside the human progress string in
 * `developer_patch_jobs.progress_stage` without a schema migration.
 */
export function encodeProgressStage(
  displayStage: string,
  lifecycle?: AgentLifecycleEvent
): string {
  if (!lifecycle) {
    return displayStage;
  }
  return `${PREFIX}${JSON.stringify({ stage: displayStage, lifecycle })}`;
}

export function decodeProgressStage(raw: string | null): EncodedProgressStage {
  if (!raw) {
    return { displayStage: "" };
  }
  if (!raw.startsWith(PREFIX)) {
    return { displayStage: raw };
  }
  try {
    const parsed = JSON.parse(raw.slice(PREFIX.length)) as {
      stage?: string;
      lifecycle?: AgentLifecycleEvent;
    };
    return {
      displayStage: typeof parsed.stage === "string" ? parsed.stage : raw,
      lastLifecycle: parsed.lifecycle,
    };
  } catch {
    return { displayStage: raw };
  }
}
