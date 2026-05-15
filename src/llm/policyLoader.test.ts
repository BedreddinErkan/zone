import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrgPolicy } from "./policyLoader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-policy-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePolicyFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("loadOrgPolicy", () => {
  it("absent env → policy null, source: absent", () => {
    expect(loadOrgPolicy(undefined)).toEqual({ ok: true, policy: null, source: "absent" });
    expect(loadOrgPolicy("")).toEqual({ ok: true, policy: null, source: "absent" });
    expect(loadOrgPolicy("   ")).toEqual({ ok: true, policy: null, source: "absent" });
  });

  it("missing file → ok:false reason:missing_file", () => {
    const result = loadOrgPolicy(path.join(tmpDir, "nonexistent.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing_file");
    }
  });

  it("invalid JSON → ok:false reason:parse_error", () => {
    const p = writePolicyFile("bad.json", "{ not valid json }");
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse_error");
    }
  });

  it("valid full policy (all 5 fields) → ok:true with all fields parsed", () => {
    const p = writePolicyFile("full.json", JSON.stringify({
      dailyUsdCap: 50,
      monthlyUsdCap: 1000,
      allowedTiers: ["light", "medium", "complex"],
      maxSubagentCallsCap: 2,
      autoAuditRequired: true,
    }));
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(true);
    if (result.ok && result.policy) {
      expect(result.policy.dailyUsdCap).toBe(50);
      expect(result.policy.monthlyUsdCap).toBe(1000);
      expect(result.policy.allowedTiers).toEqual(["light", "medium", "complex"]);
      expect(result.policy.maxSubagentCallsCap).toBe(2);
      expect(result.policy.autoAuditRequired).toBe(true);
      expect(result.source).toBe("file");
    }
  });

  it("partial policy (only dailyUsdCap) → ok:true with single field", () => {
    const p = writePolicyFile("partial.json", JSON.stringify({ dailyUsdCap: 25 }));
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(true);
    if (result.ok && result.policy) {
      expect(result.policy.dailyUsdCap).toBe(25);
      expect(result.policy.monthlyUsdCap).toBeUndefined();
      expect(result.policy.allowedTiers).toBeUndefined();
    }
  });

  it("negative dailyUsdCap → ok:false schema_invalid", () => {
    const p = writePolicyFile("neg.json", JSON.stringify({ dailyUsdCap: -5 }));
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
      expect(result.detail).toContain("dailyUsdCap");
    }
  });

  it("unknown tier in allowedTiers → ok:false schema_invalid", () => {
    const p = writePolicyFile("tiers.json", JSON.stringify({ allowedTiers: ["light", "ultra"] }));
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_invalid");
      expect(result.detail).toContain("ultra");
    }
  });

  it("empty object → ok:true with empty policy", () => {
    const p = writePolicyFile("empty.json", "{}");
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy).toEqual({});
    }
  });

  it("dailyUsdCap: 0 (unlimited) → ok:true", () => {
    const p = writePolicyFile("zero.json", JSON.stringify({ dailyUsdCap: 0 }));
    const result = loadOrgPolicy(p);
    expect(result.ok).toBe(true);
    if (result.ok && result.policy) {
      expect(result.policy.dailyUsdCap).toBe(0);
    }
  });
});
