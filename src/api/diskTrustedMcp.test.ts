import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { isMcpTrusted, recordMcpTrust, _setTrustedMcpPathForTest } from "./diskTrustedMcp.js";

describe("diskTrustedMcp", () => {
  let tmp: string;
  let trustFile: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-trusted-mcp-"));
    trustFile = join(tmp, "trusted-mcp.json");
    _setTrustedMcpPathForTest(trustFile);
  });

  afterEach(async () => {
    _setTrustedMcpPathForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  // T-TRUST-UNKNOWN
  it("returns false for an unknown project+hash pair", () => {
    expect(isMcpTrusted("/some/project", "abc123")).toBe(false);
  });

  // T-TRUST-APPROVE
  it("returns true after recordMcpTrust for the same project+hash", () => {
    const project = "/home/user/myproject";
    const hash = "deadbeef".repeat(8);
    recordMcpTrust(project, hash);
    expect(isMcpTrusted(project, hash)).toBe(true);
  });

  it("returns false for a different hash after approval", () => {
    const project = "/home/user/myproject";
    const hash1 = "aaaa".repeat(16);
    const hash2 = "bbbb".repeat(16);
    recordMcpTrust(project, hash1);
    expect(isMcpTrusted(project, hash2)).toBe(false);
  });

  // T-TRUST-CHANGED
  it("updates to the latest hash when called again", () => {
    const project = "/home/user/myproject";
    const hash1 = "aaaa".repeat(16);
    const hash2 = "bbbb".repeat(16);
    recordMcpTrust(project, hash1);
    recordMcpTrust(project, hash2);
    expect(isMcpTrusted(project, hash1)).toBe(false);
    expect(isMcpTrusted(project, hash2)).toBe(true);
  });

  it("persists trust across separate load calls", () => {
    const project = "/home/user/persist-test";
    const hash = "cccc".repeat(16);
    recordMcpTrust(project, hash);
    // Second call reloads from disk
    expect(isMcpTrusted(project, hash)).toBe(true);
  });

  it("is project-path-scoped (different project, same hash = false)", () => {
    const hash = "dddd".repeat(16);
    recordMcpTrust("/project/a", hash);
    expect(isMcpTrusted("/project/b", hash)).toBe(false);
  });
});
