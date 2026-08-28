import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCliConfig, applyDiskKeyFallbacks, keyForConfig, keyEnvVarForConfig, validateCliConfig, applyProviderSelection } from "./config.js";
import { _setGatewayKeysPathForTest } from "../llm/gatewayProfiles.js";
import { loadDiskKeys } from "../api/diskKeys.js";
import type { DiskKeysFile } from "../api/diskKeys.js";

vi.mock("../api/diskKeys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/diskKeys.js")>()),
  loadDiskKeys: vi.fn(async () => ({ version: 1, keys: [] })),
}));

/**
 * A gateway becoming the ACTIVE provider, end to end from the key store.
 *
 * `cli/config.ts` is where the two halves meet: the profile is resolved once here and threaded as an
 * object, and `cfg.provider` stays two-valued so no adapter path or ternary downstream has to learn
 * a third value. These tests pin that split, plus the one thing that must NOT change — item 385's
 * unrecognized-provider warning still firing for a value that names neither a built-in nor a
 * configured gateway.
 */

const LAB: DiskKeysFile["keys"][number] = {
  provider: "lab",
  key: "sk-lab-key",
  addedAt: "2026-08-02T00:00:00.000Z",
  baseUrl: "http://localhost:4000/v1",
};
const VENDOR_OPENAI: DiskKeysFile["keys"][number] = {
  provider: "openai", key: "sk-vendor-openai", addedAt: "2026-08-01T00:00:00.000Z",
};

let warnSpy: ReturnType<typeof vi.spyOn>;
// Every loadCliConfig call passes `repo: tmpDir`. Without it the loader reads THIS repo's real
// .zone/model.json, whose model pins the provider back to anthropic and quietly defeats the
// fixture — a measurement taken on the working tree describing no other machine.
let tmpDir: string;

function writeStore(...keys: DiskKeysFile["keys"]): void {
  const p = path.join(tmpDir, "keys.json");
  fs.writeFileSync(p, JSON.stringify({ version: 1, keys }), "utf-8");
  _setGatewayKeysPathForTest(p);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-gwcfg-"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [] });
});

afterEach(() => {
  _setGatewayKeysPathForTest(null);
  warnSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadCliConfig — resolving a gateway", () => {
  it("HARNESS FLOOR: with no store written, 'lab' is still an unrecognized provider", () => {
    // Without this, every assertion below could pass against a resolver that accepted any string.
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(cfg.profile).toBeUndefined();
    expect(cfg.provider).toBe("anthropic");
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/provider "lab" is not recognized/);
  });

  it("resolves a configured gateway to a profile, with NO warning", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(cfg.profile?.id).toBe("lab");
    expect(cfg.profile?.baseUrl).toBe("http://localhost:4000/v1");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps cfg.provider two-valued — the PROTOCOL selector, not the identity", () => {
    writeStore(LAB);
    // This is what lets every existing adapter branch and provider ternary keep working untouched:
    // an openai-chat proxy runs the OpenAI adapter, whichever vendor's models sit behind it.
    expect(loadCliConfig({ repo: tmpDir, provider: "lab" }, {}).provider).toBe("openai");
    writeStore({ ...LAB, protocol: "anthropic-messages" });
    expect(loadCliConfig({ repo: tmpDir, provider: "lab" }, {}).provider).toBe("anthropic");
  });

  it("still warns for a value that names neither a built-in nor a gateway (item 385)", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "not-configured" }, {});
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.profile).toBeUndefined();
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/provider "not-configured" is not recognized/);
  });

  it("leaves the two built-ins with no profile at all", () => {
    writeStore(LAB);
    expect(loadCliConfig({ repo: tmpDir, provider: "anthropic" }, {}).profile).toBeUndefined();
    expect(loadCliConfig({ repo: tmpDir, provider: "openai" }, {}).profile).toBeUndefined();
  });

  it("a gateway outranks the model->provider pin, so a proxy may serve a catalog id", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab", model: "claude-sonnet-4-6" }, {});
    // Letting the pin win here would send the call to Anthropic direct — the same "badge says one
    // thing, loop runs another" failure the pin exists to prevent, pointed the other way.
    expect(cfg.profile?.id).toBe("lab");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("carries an off-catalog model id through untouched", () => {
    writeStore(LAB);
    expect(loadCliConfig({ repo: tmpDir, provider: "lab", model: "openai/gpt-4o-mini" }, {}).model).toBe("openai/gpt-4o-mini");
  });
});

describe("keys — a gateway and a vendor coexist without shadowing", () => {
  it("fills the gateway key from its own identity, leaving the vendor fields alone", async () => {
    writeStore(LAB, VENDOR_OPENAI);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [LAB, VENDOR_OPENAI] });
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    cfg.openaiApiKey = undefined;
    await applyDiskKeyFallbacks(cfg);
    expect(cfg.profileApiKey).toBe("sk-lab-key");
    // The vendor key is still filled independently — one does not consume the other's slot.
    expect(cfg.openaiApiKey).toBe("sk-vendor-openai");
  });

  it("keyForConfig picks the profile's key, not the protocol selector's vendor key", async () => {
    writeStore(LAB, VENDOR_OPENAI);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [LAB, VENDOR_OPENAI] });
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    await applyDiskKeyFallbacks(cfg);
    // cfg.provider is "openai" here, so the old two-valued ternary would have returned the VENDOR
    // key and billed the wrong account against the wrong endpoint.
    expect(cfg.provider).toBe("openai");
    expect(keyForConfig(cfg)).toBe("sk-lab-key");
  });

  it("keyForConfig is unchanged for the built-ins", async () => {
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [VENDOR_OPENAI] });
    const cfg = loadCliConfig({ repo: tmpDir, provider: "openai" }, {});
    cfg.openaiApiKey = undefined;
    await applyDiskKeyFallbacks(cfg);
    expect(keyForConfig(cfg)).toBe("sk-vendor-openai");
  });

  it("names the gateway, not a vendor env var, when its key is missing", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(keyEnvVarForConfig(cfg)).toBe("ZONE_GATEWAY_KEY_LAB");
    // Pointing a gateway user at OPENAI_API_KEY would send them looking for a key they do not need.
    expect(() => validateCliConfig(cfg)).toThrow(/provider "lab"/);
    expect(() => validateCliConfig(cfg)).toThrow(/ZONE_GATEWAY_KEY_LAB/);
  });
});

/**
 * The 2.2.0/2.2.1 regression this file's own harness could not have caught: every test above seeds
 * the store BEFORE calling loadCliConfig, so the resolver was only ever exercised on the one
 * ordering where the row already exists. Reproduced live on 2.2.1 — a well-formed row that /keys
 * rendered correctly was invisible to provider resolution, and every task died with a message
 * naming a gateway and a vendor env var in the same sentence.
 */
describe("a gateway row that arrives AFTER the config was resolved (the 2.2.1 report)", () => {
  it("completes the profile on the next run when the row appears mid-session", async () => {
    // Startup: model.json already names "lab" (a prior /model), but the store has no row yet.
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(cfg.profile).toBeUndefined();

    // The user now adds the gateway through /keys. Disk is correct; config is stale.
    writeStore(LAB);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [LAB] });

    // runOneShotInner re-merges disk keys at the top of every run for exactly this reason.
    await applyDiskKeyFallbacks(cfg);

    expect(cfg.profile?.id).toBe("lab");
    expect(cfg.profile?.baseUrl).toBe("http://localhost:4000/v1");
    expect(cfg.provider).toBe("openai");
    expect(keyForConfig(cfg)).toBe("sk-lab-key");
  });

  it("never leaves a gateway id sitting in cfg.provider, which is two-valued", async () => {
    // The live symptom's root: a raw id in `provider` makes keyForConfig read the ANTHROPIC field
    // (because the id !== "openai") and the error name two different providers at once.
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(["anthropic", "openai"]).toContain(cfg.provider);
    writeStore(LAB);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [LAB] });
    await applyDiskKeyFallbacks(cfg);
    expect(["anthropic", "openai"]).toContain(cfg.provider);
  });

  it("an id that is neither a built-in nor a configured gateway still warns and stays valid", async () => {
    // Item 385's warning must keep firing — the fix must not weaken it into accepting any string.
    const cfg = loadCliConfig({ repo: tmpDir, provider: "not-a-thing" }, {});
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/provider "not-a-thing" is not recognized/);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [] });
    await applyDiskKeyFallbacks(cfg);
    expect(cfg.profile).toBeUndefined();
    expect(["anthropic", "openai"]).toContain(cfg.provider);
  });
});

describe("applyProviderSelection — the one place a provider selection is applied", () => {
  it("resolves a gateway id to a profile and keeps cfg.provider two-valued", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir }, {});
    applyProviderSelection(cfg, "lab");
    expect(cfg.profile?.id).toBe("lab");
    expect(cfg.provider).toBe("openai");
    expect(cfg.pendingProfileId).toBeUndefined();
  });

  it("a built-in id clears any active profile", () => {
    writeStore(LAB);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    expect(cfg.profile?.id).toBe("lab");
    applyProviderSelection(cfg, "anthropic");
    expect(cfg.profile).toBeUndefined();
    expect(cfg.provider).toBe("anthropic");
  });

  it("an unresolvable id NEVER seats itself in cfg.provider, and is remembered", () => {
    // The 2.2.1 report's proximate cause was exactly this cast. A raw id here makes keyForConfig
    // read the ANTHROPIC field (id !== "openai") and the error name two providers at once.
    const cfg = loadCliConfig({ repo: tmpDir }, {});
    applyProviderSelection(cfg, "not-a-gateway");
    expect(cfg.provider).not.toBe("not-a-gateway");
    expect(["anthropic", "openai"]).toContain(cfg.provider);
    expect(cfg.pendingProfileId).toBe("not-a-gateway");
  });

  it("re-applying the SAME profile keeps an already-resolved key", async () => {
    // Regression pin: clearing profileApiKey unconditionally wiped the key applyDiskKeyFallbacks
    // had filled one step earlier in runTui's own startup order (937 fills, 944 applies).
    writeStore(LAB);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [LAB] });
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    await applyDiskKeyFallbacks(cfg);
    expect(keyForConfig(cfg)).toBe("sk-lab-key");
    applyProviderSelection(cfg, "lab");
    expect(keyForConfig(cfg)).toBe("sk-lab-key");
  });

  it("switching to a DIFFERENT profile drops the previous profile's key", () => {
    const LAB2 = { provider: "lab2", key: "sk-lab2", addedAt: "2026-08-03T00:00:00.000Z",
                   baseUrl: "http://localhost:5000/v1" };
    writeStore(LAB, LAB2);
    const cfg = loadCliConfig({ repo: tmpDir, provider: "lab" }, {});
    cfg.profileApiKey = "sk-lab-key";
    applyProviderSelection(cfg, "lab2");
    expect(cfg.profile?.id).toBe("lab2");
    expect(cfg.profileApiKey).toBeUndefined();
  });
});
