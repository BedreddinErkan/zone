import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { loadDiskTrust, addDiskTrustPrefix, removeDiskTrustPrefix, diskTrustPrefixes } from "./diskTrust.js";

describe("diskTrust", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "zone-trust-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it("loadDiskTrust returns empty when file missing", async () => {
    expect(await loadDiskTrust(tmp)).toEqual({ version: 1, trustedPrefixes: [] });
  });

  it("addDiskTrustPrefix persists prefix", async () => {
    await addDiskTrustPrefix(tmp, "find", "user");
    const store = await loadDiskTrust(tmp);
    expect(store.trustedPrefixes).toHaveLength(1);
    expect(store.trustedPrefixes[0].prefix).toBe("find");
    expect(store.trustedPrefixes[0].addedBy).toBe("user");
    expect(store.trustedPrefixes[0].addedAt).toMatch(/^\d{4}-/);
  });

  it("addDiskTrustPrefix deduplicates same prefix", async () => {
    await addDiskTrustPrefix(tmp, "ls");
    await addDiskTrustPrefix(tmp, "ls");
    expect((await loadDiskTrust(tmp)).trustedPrefixes).toHaveLength(1);
  });

  it("diskTrustPrefixes extracts prefix strings", async () => {
    await addDiskTrustPrefix(tmp, "find");
    await addDiskTrustPrefix(tmp, "grep");
    expect(diskTrustPrefixes(await loadDiskTrust(tmp))).toEqual(["find", "grep"]);
  });

  it("removeDiskTrustPrefix removes named prefix", async () => {
    await addDiskTrustPrefix(tmp, "find");
    await addDiskTrustPrefix(tmp, "ls");
    await removeDiskTrustPrefix(tmp, "find");
    const store = await loadDiskTrust(tmp);
    expect(store.trustedPrefixes).toHaveLength(1);
    expect(store.trustedPrefixes[0].prefix).toBe("ls");
  });

  it("removeDiskTrustPrefix is no-op for missing prefix", async () => {
    await addDiskTrustPrefix(tmp, "find");
    await removeDiskTrustPrefix(tmp, "nonexistent");
    expect((await loadDiskTrust(tmp)).trustedPrefixes).toHaveLength(1);
  });

  it("loadDiskTrust returns empty on corrupt file", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(tmp, ".zone"), { recursive: true });
    await writeFile(join(tmp, ".zone/trust.json"), '{"version":99}', "utf-8");
    expect(await loadDiskTrust(tmp)).toEqual({ version: 1, trustedPrefixes: [] });
  });
});
