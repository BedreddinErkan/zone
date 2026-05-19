import type { TaskTier } from "./taskClassifier.js";

export type AuditMode = "auto" | "always" | "on_demand";

export const DEFAULT_AUDIT_MODE: AuditMode = "auto";

export interface ShouldRunAuditParams {
  tier: TaskTier;
  auditMode: AuditMode;
  /** Future: API param override — when true, forces audit regardless of mode/tier. */
  explicitRequest?: boolean;
}

export interface ShouldRunAuditResult {
  shouldRun: boolean;
  reason: string;
}

export function shouldRunAudit(params: ShouldRunAuditParams): ShouldRunAuditResult {
  const { tier, auditMode, explicitRequest } = params;

  if (explicitRequest) {
    return { shouldRun: true, reason: "explicit user request" };
  }

  switch (auditMode) {
    case "always":
      return { shouldRun: true, reason: "auditMode=always" };
    case "on_demand":
      return { shouldRun: false, reason: "auditMode=on_demand, no explicit request" };
    case "auto":
      if (tier === "simple") {
        return { shouldRun: false, reason: "auditMode=auto + tier=simple" };
      }
      return { shouldRun: true, reason: `auditMode=auto + tier=${tier}` };
  }
}
