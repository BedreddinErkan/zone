import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gatewayProfilesFrom,
  gatewayEnvVar,
  isGatewayRow,
  readGatewayProfilesSync,
  _setGatewayKeysPathForTest,
} from "./gatewayProfiles.js";
import { priceForProfile } from "./providerProfile.js";
import type { DiskKeysFile } from "../api/diskKeys.js";

function store(...keys: DiskKeysFile["keys"]): DiskKeysFile {
  return { version: 1, keys };
}

const VENDOR = { provider: "openai", key: "sk-vendor", addedAt: "2026-08-01T00:00:00.000Z" };
const LAB = {
  provider: "lab",
  key: "sk-lab",
  addedAt: "2026-08-02T00:00:00.000Z",
  baseUrl: "http://localhost:4000/v1",
};

afterEach(() => {
  _setGatewayKeysPathForTest(null);
});

describe("gatewayProfiles — what makes a row a gateway", () => {
  it("a base URL is what promotes a row, and nothing else is", () => {
    expect(isGatewayRow(LAB)).toBe(true);
    expect(isGatewayRow(VENDOR)).toBe(false);
    // Present-but-blank is not a base URL. Without this the field's mere presence would promote a
    // row whose URL the user cleared, and it would resolve to a profile that cannot be reached.
    expect(isGatewayRow({ ...VENDOR, baseUrl: "   " })).toBe(false);
  });

  it("a vendor row is left alone — a gateway and both vendor keys coexist in one file", () => {
    const profiles = gatewayProfilesFrom(store(VENDOR, LAB));
    expect(profiles.map((p) => p.id)).toEqual(["lab"]);
  });

  it("refuses to build a profile that shadows a built-in id", () => {
    // `resolveProviderProfile` checks gateways first, but `resolveProfile` would still return the
    // built-in for these two names — so such a row could never resolve and must not look like it can.
    const profiles = gatewayProfilesFrom(
      store({ ...LAB, provider: "anthropic" }, { ...LAB, provider: "openai" })
    );
    expect(profiles).toEqual([]);
  });
});

describe("gatewayProfiles — the record it produces", () => {
  it("defaults to the openai-chat protocol and derives the adapter from it", () => {
    const [p] = gatewayProfilesFrom(store(LAB));
    expect(p?.id).toBe("lab");
    expect(p?.protocol).toBe("openai-chat");
    expect(p?.baseUrl).toBe("http://localhost:4000/v1");
    // The PROTOCOL SELECTOR, not the identity — an openai-chat proxy runs the OpenAI adapter
    // whichever vendor's models sit behind it.
    expect(p?.adapterProvider).toBe("openai");
  });

  it("an anthropic-messages gateway selects the Anthropic adapter instead", () => {
    const [p] = gatewayProfilesFrom(store({ ...LAB, protocol: "anthropic-messages" }));
    expect(p?.protocol).toBe("anthropic-messages");
    expect(p?.adapterProvider).toBe("anthropic");
  });

  it("names an env var derived from the id, legal as a shell identifier", () => {
    expect(gatewayEnvVar("lab")).toBe("ZONE_GATEWAY_KEY_LAB");
    expect(gatewayEnvVar("my-lab.2")).toBe("ZONE_GATEWAY_KEY_MY_LAB_2");
    const [p] = gatewayProfilesFrom(store(LAB));
    expect(p?.keyRef.envVar).toBe("ZONE_GATEWAY_KEY_LAB");
  });

  it("declares NO pricing, so cost is recorded as unknown rather than as zero", () => {
    const [p] = gatewayProfilesFrom(store(LAB));
    expect(p?.pricing).toBeUndefined();
    // The distinction that matters: an unpriceable run must not read as a free one, or it slips
    // past every dollar gate looking like $0.00 of real spend.
    const priced = priceForProfile(p!, "openai/gpt-4o-mini", {
      input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0,
    });
    expect(priced.known).toBe(false);
    expect(priced).not.toHaveProperty("usd");
  });

  it("declares no capabilities, so every lookup falls through to the global tables", () => {
    const [p] = gatewayProfilesFrom(store(LAB));
    expect(p?.capabilities).toBeUndefined();
  });
});

describe("readGatewayProfilesSync — reads the real store, fails closed", () => {
  function writeStore(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-gwprofiles-"));
    const p = path.join(dir, "keys.json");
    fs.writeFileSync(p, contents, "utf-8");
    return p;
  }

  it("HARNESS FLOOR: reads a real file from disk before any absence is asserted", () => {
    // Without this, every "returns []" case below passes just as well against a redirect that
    // never resolves, and the absence assertions would prove nothing.
    _setGatewayKeysPathForTest(writeStore(JSON.stringify(store(VENDOR, LAB))));
    expect(readGatewayProfilesSync().map((p) => p.id)).toEqual(["lab"]);
  });

  it("returns [] when the file does not exist", () => {
    _setGatewayKeysPathForTest(path.join(os.tmpdir(), "zone-gwprofiles-absent", "keys.json"));
    expect(readGatewayProfilesSync()).toEqual([]);
  });

  it("returns [] on malformed JSON rather than throwing", () => {
    _setGatewayKeysPathForTest(writeStore("{ not json"));
    expect(() => readGatewayProfilesSync()).not.toThrow();
    expect(readGatewayProfilesSync()).toEqual([]);
  });

  it("returns [] on an unexpected schema version", () => {
    _setGatewayKeysPathForTest(writeStore(JSON.stringify({ version: 2, keys: [LAB] })));
    expect(readGatewayProfilesSync()).toEqual([]);
  });
});
