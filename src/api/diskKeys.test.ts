import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { loadDiskKeys, setDiskKey, removeDiskKey, maskKey, _setKeysFilePathForTest } from "./diskKeys.js";

describe("diskKeys", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-keys-"));
    // Both paths must be overridden: legacy defaults to process.cwd()/.zone/keys.json
    // (diskKeys.ts's migration fallback), which in this tree is a real, live BYOK
    // keys file — leaving it unset leaks real keys into these tests.
    _setKeysFilePathForTest(join(tmp, "keys.json"), join(tmp, "legacy.json"));
  });
  afterEach(async () => {
    _setKeysFilePathForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadDiskKeys returns empty when file missing", async () => {
    expect(await loadDiskKeys()).toEqual({ version: 1, keys: [] });
  });

  it("setDiskKey adds a new key", async () => {
    await setDiskKey("anthropic", "sk-ant-test123456789");
    const store = await loadDiskKeys();
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].provider).toBe("anthropic");
    expect(store.keys[0].key).toBe("sk-ant-test123456789");
    expect(store.keys[0].addedAt).toMatch(/^\d{4}-/);
  });

  it("setDiskKey overwrites existing key for same provider", async () => {
    await setDiskKey("anthropic", "sk-ant-first00000000");
    await setDiskKey("anthropic", "sk-ant-second0000000");
    const store = await loadDiskKeys();
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].key).toBe("sk-ant-second0000000");
  });

  // --- Gateway rows (step 5). Additive: no version bump, and a vendor row is byte-unchanged. ---

  it("a vendor row still writes exactly three fields when no extras are passed", async () => {
    await setDiskKey("anthropic", "sk-ant-test123456789");
    const [row] = (await loadDiskKeys()).keys;
    // The optional fields are spread conditionally rather than assigned undefined, so they are
    // genuinely absent from the row and not merely undefined on it.
    expect(Object.keys(row!).sort()).toEqual(["addedAt", "key", "provider"]);
  });

  it("a gateway row carries its base URL and protocol alongside the key", async () => {
    await setDiskKey("lab", "sk-lab-key0000000000", { baseUrl: "http://localhost:4000/v1", protocol: "openai-chat" });
    const [row] = (await loadDiskKeys()).keys;
    expect(row!.provider).toBe("lab");
    expect(row!.baseUrl).toBe("http://localhost:4000/v1");
    expect(row!.protocol).toBe("openai-chat");
  });

  it("the file's schema version is UNCHANGED — the widening is in the field, not the version", async () => {
    await setDiskKey("lab", "sk-lab-key0000000000", { baseUrl: "http://localhost:4000/v1" });
    // A bump is what would make older Zone binaries read the store as empty, silently.
    expect((await loadDiskKeys()).version).toBe(1);
  });

  it("a gateway and BOTH vendor keys coexist — identity is the row key, not the vendor", async () => {
    await setDiskKey("anthropic", "sk-ant-test123456789");
    await setDiskKey("openai", "sk-openai-test123456");
    await setDiskKey("lab", "sk-lab-key0000000000", { baseUrl: "http://localhost:4000/v1" });
    const store = await loadDiskKeys();
    expect(store.keys).toHaveLength(3);
    expect(store.keys.map(k => k.provider).sort()).toEqual(["anthropic", "lab", "openai"]);
  });

  it("one row per identity still holds for a gateway id", async () => {
    await setDiskKey("lab", "sk-lab-first00000000", { baseUrl: "http://a/v1" });
    await setDiskKey("lab", "sk-lab-second0000000", { baseUrl: "http://b/v1" });
    const store = await loadDiskKeys();
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0]!.key).toBe("sk-lab-second0000000");
    expect(store.keys[0]!.baseUrl).toBe("http://b/v1");
  });

  // --- Declared pricing (step: the USD cap on a gateway) ---

  it("a priced gateway row round-trips its rates", async () => {
    await setDiskKey("lab", "sk-lab-key0000000000", {
      baseUrl: "http://localhost:4000/v1",
      pricing: { "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 } },
    });
    const [row] = (await loadDiskKeys()).keys;
    expect(row!.pricing!["openai/gpt-4o-mini"]).toEqual({
      input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0,
    });
  });

  it("a SKIPPED cache bucket is absent on disk; a TYPED zero is present as 0", async () => {
    // The whole point of the distinction: both price at $0, but only one of them is a statement
    // about the endpoint. Absence is the record that the user never declared it.
    await setDiskKey("lab", "sk-lab-key0000000000", {
      baseUrl: "http://x/v1",
      pricing: { "m": { input: 1, output: 2, cache_write: 0 } },
    });
    const entry = (await loadDiskKeys()).keys[0]!.pricing!["m"]!;
    expect("cache_write" in entry).toBe(true);
    expect(entry.cache_write).toBe(0);
    expect("cache_read" in entry).toBe(false);
  });

  it("an empty pricing map is not written at all", async () => {
    await setDiskKey("lab", "sk-lab-key0000000000", { baseUrl: "http://x/v1", pricing: {} });
    expect((await loadDiskKeys()).keys[0]!.pricing).toBeUndefined();
  });

  it("removeDiskKey removes the named provider", async () => {
    await setDiskKey("anthropic", "sk-ant-test123456789");
    await setDiskKey("openai", "sk-openai-test123456");
    await removeDiskKey("anthropic");
    const store = await loadDiskKeys();
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].provider).toBe("openai");
  });

  it("setDiskKey rejects key with non-ASCII characters", async () => {
    await expect(setDiskKey("anthropic", "sk-ant—bad")).rejects.toThrow(/non-ASCII character at byte/);
  });

  it("setDiskKey rejects placeholder key starting with '<'", async () => {
    await expect(setDiskKey("anthropic", "<your key here>")).rejects.toThrow(/placeholder/);
  });

  it("maskKey masks middle of long keys", () => {
    expect(maskKey("sk-ant-api03XXXAAAA")).toBe("sk-ant-***AAAA");
    expect(maskKey("short")).toBe("***");
  });
});

describe("diskKeys — migration from legacy .zone/keys.json", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-keys-migrate-"));
    // home path = tmp/home.json; legacy path = tmp/legacy.json
    _setKeysFilePathForTest(join(tmp, "home.json"), join(tmp, "legacy.json"));
  });

  afterEach(async () => {
    _setKeysFilePathForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  it("migrates legacy keys to home path on first load", async () => {
    const legacyStore = { version: 1 as const, keys: [{ provider: "anthropic" as const, key: "qq-migrated0000", addedAt: "2026-01-01T00:00:00.000Z" }] };
    await writeFile(join(tmp, "legacy.json"), JSON.stringify(legacyStore, null, 2), "utf-8");

    const result = await loadDiskKeys();
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].key).toBe("qq-migrated0000");

    // home path now has the key
    const homeStore = await loadDiskKeys();
    expect(homeStore.keys[0].key).toBe("qq-migrated0000");
  });

  it("migration is idempotent — second load reads from home, not legacy", async () => {
    const legacyStore = { version: 1 as const, keys: [{ provider: "openai" as const, key: "sk-openai-migrate0", addedAt: "2026-01-01T00:00:00.000Z" }] };
    await writeFile(join(tmp, "legacy.json"), JSON.stringify(legacyStore, null, 2), "utf-8");

    await loadDiskKeys(); // first: migrates
    // Overwrite home with a different value to confirm second load uses home
    await setDiskKey("openai", "sk-openai-updated0");
    const second = await loadDiskKeys();
    expect(second.keys[0].key).toBe("sk-openai-updated0");
  });

  it("returns empty when no home and no legacy file exist", async () => {
    expect(await loadDiskKeys()).toEqual({ version: 1, keys: [] });
  });

  it("skips corrupt legacy file without throwing", async () => {
    await mkdir(join(tmp, "zone-corrupt"), { recursive: true });
    await writeFile(join(tmp, "legacy.json"), "not valid json", "utf-8");
    expect(await loadDiskKeys()).toEqual({ version: 1, keys: [] });
  });
});
