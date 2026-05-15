// Policy loader is pure I/O + validation. Resolution chain integration in next commit.
// Schema future-ready (all 5 fields parsed); K.5 enforces only dailyUsdCap, future fields
// logged as unsupported until Phase M.

import fs from "node:fs";

export type OrgPolicy = {
  dailyUsdCap?: number;
  monthlyUsdCap?: number;
  allowedTiers?: Array<"light" | "medium" | "complex">;
  maxSubagentCallsCap?: number;
  autoAuditRequired?: boolean;
};

export type PolicyLoadResult =
  | { ok: true; policy: OrgPolicy; source: "file"; path: string }
  | { ok: true; policy: null; source: "absent" }
  | { ok: false; reason: "missing_file" | "parse_error" | "schema_invalid"; detail: string };

const VALID_TIERS = new Set(["light", "medium", "complex"]);

function validatePolicy(raw: unknown): { valid: true; policy: OrgPolicy } | { valid: false; detail: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, detail: "policy root must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const policy: OrgPolicy = {};

  if ("dailyUsdCap" in obj) {
    const v = obj["dailyUsdCap"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { valid: false, detail: "dailyUsdCap must be a finite number" };
    }
    if (v < 0) {
      return { valid: false, detail: "dailyUsdCap must be ≥ 0 (use 0 for unlimited)" };
    }
    policy.dailyUsdCap = v;
  }

  if ("monthlyUsdCap" in obj) {
    const v = obj["monthlyUsdCap"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { valid: false, detail: "monthlyUsdCap must be a finite number" };
    }
    if (v < 0) {
      return { valid: false, detail: "monthlyUsdCap must be ≥ 0 (use 0 for unlimited)" };
    }
    policy.monthlyUsdCap = v;
  }

  if ("allowedTiers" in obj) {
    const v = obj["allowedTiers"];
    if (!Array.isArray(v)) {
      return { valid: false, detail: "allowedTiers must be an array" };
    }
    for (const tier of v) {
      if (!VALID_TIERS.has(tier as string)) {
        return { valid: false, detail: `allowedTiers contains unknown tier: "${tier}"` };
      }
    }
    policy.allowedTiers = v as OrgPolicy["allowedTiers"];
  }

  if ("maxSubagentCallsCap" in obj) {
    const v = obj["maxSubagentCallsCap"];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { valid: false, detail: "maxSubagentCallsCap must be a finite number" };
    }
    if (v < 0) {
      return { valid: false, detail: "maxSubagentCallsCap must be ≥ 0" };
    }
    policy.maxSubagentCallsCap = v;
  }

  if ("autoAuditRequired" in obj) {
    const v = obj["autoAuditRequired"];
    if (typeof v !== "boolean") {
      return { valid: false, detail: "autoAuditRequired must be a boolean" };
    }
    policy.autoAuditRequired = v;
  }

  return { valid: true, policy };
}

export function loadOrgPolicy(envValue?: string): PolicyLoadResult {
  if (!envValue || !envValue.trim()) {
    return { ok: true, policy: null, source: "absent" };
  }

  const filePath = envValue.trim();

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "missing_file", detail: `policy file not found: ${filePath}` };
    }
    return { ok: false, reason: "missing_file", detail: `could not read policy file: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "parse_error", detail: `JSON parse error in ${filePath}: ${String(err)}` };
  }

  const result = validatePolicy(parsed);
  if (!result.valid) {
    return { ok: false, reason: "schema_invalid", detail: result.detail };
  }

  return { ok: true, policy: result.policy, source: "file", path: filePath };
}
