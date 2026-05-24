import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { loadDiskKeys, setDiskKey, removeDiskKey, maskKey } from "./diskKeys.js";

describe("diskKeys", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "zone-keys-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it("loadDiskKeys returns empty when file missing", async () => {
    expect(await loadDiskKeys(tmp)).toEqual({ version: 1, keys: [] });
  });

  it("setDiskKey adds a new key", async () => {
    await setDiskKey(tmp, "anthropic", "sk-ant-test123456789");
    const store = await loadDiskKeys(tmp);
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].provider).toBe("anthropic");
    expect(store.keys[0].key).toBe("sk-ant-test123456789");
    expect(store.keys[0].addedAt).toMatch(/^\d{4}-/);
  });

  it("setDiskKey overwrites existing key for same provider", async () => {
    await setDiskKey(tmp, "anthropic", "sk-ant-first00000000");
    await setDiskKey(tmp, "anthropic", "sk-ant-second0000000");
    const store = await loadDiskKeys(tmp);
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].key).toBe("sk-ant-second0000000");
  });

  it("removeDiskKey removes the named provider", async () => {
    await setDiskKey(tmp, "anthropic", "sk-ant-test123456789");
    await setDiskKey(tmp, "openai", "sk-openai-test123456");
    await removeDiskKey(tmp, "anthropic");
    const store = await loadDiskKeys(tmp);
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].provider).toBe("openai");
  });

  it("maskKey masks middle of long keys", () => {
    expect(maskKey("sk-ant-api03XXXAAAA")).toBe("sk-ant-***AAAA");
    expect(maskKey("short")).toBe("***");
  });
});
