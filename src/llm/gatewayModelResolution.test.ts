import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModelName } from "./openaiClient.js";
import { supportsVision } from "./modelRegistry.js";
import { gatewayProfilesFrom } from "./gatewayProfiles.js";
import { ANTHROPIC_PROFILE, OPENAI_PROFILE, capabilitiesFor } from "./providerProfile.js";
import type { DiskKeysFile } from "../api/diskKeys.js";

/**
 * The measured blocker, pinned in both directions.
 *
 * `getModelName`'s `isValidModelId` check answers "is this id in Zone's catalog". Zone's catalog
 * describes the two VENDORS, so for a gateway the answer is not the question being asked: an id it
 * has never heard of is UNKNOWN, not INVALID. Before this branch existed, the LiteLLM lab proxy's
 * own `openai/gpt-4o-mini` resolved to `gpt-4o-mini` under provider "openai" and to
 * `claude-haiku-4-5` under "anthropic" — a silent substitution that made free-text model entry
 * worse than useless, because the run would quietly use a model the user had not chosen.
 */

const GATEWAY_MODEL = "openai/gpt-4o-mini";

function gateway(id = "lab", protocol?: "openai-chat" | "anthropic-messages") {
  const store: DiskKeysFile = {
    version: 1,
    keys: [{ provider: id, key: "sk-x", addedAt: "2026-08-01T00:00:00.000Z", baseUrl: "http://localhost:4000/v1", ...(protocol ? { protocol } : {}) }],
  };
  return gatewayProfilesFrom(store)[0]!;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { warnSpy.mockRestore(); });

describe("getModelName — the catalog gate, without a profile", () => {
  it("NEGATIVE CONTROL: an off-catalog id is still substituted, loudly, when no profile is given", () => {
    // This is the measured pre-existing behaviour. If it ever stops holding, the tests below prove
    // nothing, because the gateway branch would no longer be what makes the difference.
    expect(getModelName("standard", "openai", { standard: GATEWAY_MODEL })).toBe("gpt-4o-mini");
    expect(getModelName("standard", "anthropic", { standard: GATEWAY_MODEL })).toBe("claude-haiku-4-5");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/is not valid for provider/);
  });

  it("a BUILT-IN profile changes nothing — it is not a blanket bypass", () => {
    expect(getModelName("standard", "openai", { standard: GATEWAY_MODEL }, OPENAI_PROFILE)).toBe("gpt-4o-mini");
    expect(getModelName("standard", "anthropic", { standard: GATEWAY_MODEL }, ANTHROPIC_PROFILE)).toBe("claude-haiku-4-5");
  });
});

describe("getModelName — with a gateway profile", () => {
  it("passes the id through verbatim instead of substituting a vendor default", () => {
    expect(getModelName("standard", "openai", { standard: GATEWAY_MODEL }, gateway())).toBe(GATEWAY_MODEL);
  });

  it("passes through at the high tier too, reading that tier's own override", () => {
    expect(getModelName("high", "openai", { high: "gw/big", standard: "gw/small" }, gateway())).toBe("gw/big");
  });

  it("does so regardless of which adapter the gateway's protocol selects", () => {
    // The substitution differed by provider, so a fix that only covered the openai arm would look
    // correct against the common case and fail on an anthropic-messages proxy.
    expect(getModelName("standard", "anthropic", { standard: GATEWAY_MODEL }, gateway("lab", "anthropic-messages"))).toBe(GATEWAY_MODEL);
  });

  it("emits NO substitution warning, because nothing was substituted", () => {
    getModelName("standard", "openai", { standard: GATEWAY_MODEL }, gateway());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still falls back when the override names no model at all", () => {
    // The bypass is about an id the catalog does not know — not about skipping the override rules.
    expect(getModelName("standard", "openai", {}, gateway())).toBe("gpt-4o-mini");
    expect(getModelName("standard", "openai", undefined, gateway())).toBe("gpt-4o-mini");
  });
});

describe("supportsVision — the flip and its escape hatch land together (item 394)", () => {
  it("an unknown model no longer claims support by default", () => {
    // It used to return true here, and since the catalog declares the field on zero entries that
    // made the function a constant: true for every possible input, guard included.
    expect(supportsVision("some-model-no-catalog-knows")).toBe(false);
  });

  it("a catalog model is unaffected — the flip only moved the UNKNOWN case", () => {
    expect(supportsVision("claude-sonnet-4-6")).toBe(true);
  });

  it("a profile CAN declare support, which is what makes the flip safe rather than a regression", () => {
    // Without this half, flipping the default would block image sends for exactly the gateway and
    // unlisted-model users a provider profile exists to serve, with no way for them to say otherwise.
    const profile = { ...gateway(), capabilities: { models: { [GATEWAY_MODEL]: { supportsVision: true } } } };
    expect(supportsVision(GATEWAY_MODEL, capabilitiesFor(profile, GATEWAY_MODEL))).toBe(true);
  });

  it("a profile can also declare the absence of support explicitly", () => {
    const profile = { ...gateway(), capabilities: { default: { supportsVision: false } } };
    expect(supportsVision("claude-sonnet-4-6", capabilitiesFor(profile, "claude-sonnet-4-6"))).toBe(false);
  });

  it("a profile that declares nothing falls through to the catalog, not to the override", () => {
    expect(supportsVision("claude-sonnet-4-6", capabilitiesFor(gateway(), "claude-sonnet-4-6"))).toBe(true);
    expect(supportsVision("unlisted", capabilitiesFor(gateway(), "unlisted"))).toBe(false);
  });
});
