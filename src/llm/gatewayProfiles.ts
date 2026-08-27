import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiskApiKey, DiskKeysFile } from "../api/diskKeys.js";
import type { PricingRef, ProviderProfile, WireProtocol } from "./providerProfile.js";
import type { ModelRates } from "../usage/pricing.js";

/**
 * Build `ProviderProfile`s from the BYOK key store — the step that makes a gateway profile
 * AUTHORABLE rather than merely expressible.
 *
 * Steps 3 and 4 of `docs/gateway-support-investigation.md`'s recommendation built the profile record
 * and its capability/pricing layer, and item 392 recorded the remaining gap plainly: "No
 * configuration file or environment variable can define a profile yet, so the seam is programmatic."
 * This module is that configuration path, and the key store is the file, because a gateway's key and
 * its identity are the same secret and splitting them across two files would let them disagree.
 *
 * WHY THIS IS ITS OWN MODULE, and not a function in one of the two files it joins:
 *   - Not in `api/diskKeys.ts`, because three test files (`dispatch.test.ts`,
 *     `dispatch.resume.test.ts`, `init.test.ts`) mock that module with object-literal factories
 *     that list its exports explicitly. A new export there is a module-init failure in each.
 *   - Not in `llm/providerProfile.ts`, because R1 of that module's own constraint block makes it an
 *     import leaf, and reading a file is not leaf behaviour.
 * Both imports above are type-only and therefore erased, so this module adds no runtime edge in
 * either direction.
 */

/** A row is a gateway iff it carries a base URL. Everything else about it is optional. */
export function isGatewayRow(row: DiskApiKey): boolean {
  return typeof row.baseUrl === "string" && row.baseUrl.trim() !== "";
}

/**
 * Turn a row's declared prices into the profile's inline `pricing.rates` table.
 *
 * Returns `undefined` when the row declares nothing, so an unpriced gateway keeps `pricing`
 * absent and every existing unpriceable behaviour with it.
 *
 * A skipped cache bucket becomes `0` here, because `ModelRates` requires all four and
 * `costFromRates` multiplies each one. The fact that it was SKIPPED rather than declared-zero
 * survives separately in `cacheUnpricedModels` — the arithmetic needs a number, the user needs to
 * know which number they actually chose.
 */
function pricingFromRow(row: DiskApiKey): PricingRef | undefined {
  const declared = row.pricing;
  if (!declared) return undefined;
  const modelIds = Object.keys(declared);
  if (modelIds.length === 0) return undefined;

  const rates: Record<string, ModelRates> = {};
  const cacheUnpricedModels: string[] = [];
  for (const id of modelIds) {
    const e = declared[id]!;
    if (e.cache_read === undefined || e.cache_write === undefined) cacheUnpricedModels.push(id);
    rates[id] = {
      input: e.input,
      output: e.output,
      cache_read: e.cache_read ?? 0,
      cache_write: e.cache_write ?? 0,
    };
  }
  return {
    rates,
    ...(cacheUnpricedModels.length > 0 ? { cacheUnpricedModels } : {}),
  };
}

/**
 * The env var a gateway profile's key is looked up under when neither an explicit nor a
 * context-supplied key is available. `factory.ts`'s `resolveApiKeyForProfile` reads
 * `profile.keyRef.envVar` as its last rung, so a gateway needs a name there even though the normal
 * path supplies the key from the store via `CliConfig`.
 *
 * Non-alphanumerics collapse to `_` so an id like `"my-lab"` yields a legal shell identifier.
 */
export function gatewayEnvVar(id: string): string {
  return `ZONE_GATEWAY_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * One profile per gateway row. Pure — the caller supplies the store.
 *
 * `pricing` is present ONLY when the user declared prices for this row, and is otherwise left
 * ABSENT rather than defaulted to a vendor table. Step 3 established the rule and `priceForProfile`
 * enforces it: a profile that cannot price records cost as UNKNOWN, never as `0`. Guessing OpenAI's
 * rates for an arbitrary proxy would produce a confident wrong number, which is worse than an honest
 * missing one, and `warnProfileCannotPriceOnce` says so once per profile at the point of use. That
 * unpriced behaviour is unchanged by the pricing support below — declining to price still means
 * cost unknown, gate inert, warning fired.
 *
 * `capabilities` is likewise left absent: this profile knows its endpoint but not its models'
 * context windows, so every capability lookup falls through to the global table and then to the
 * conservative default — exactly the resolution order step 4 built.
 */
export function gatewayProfilesFrom(store: DiskKeysFile): ProviderProfile[] {
  const out: ProviderProfile[] = [];
  for (const row of store.keys) {
    if (!isGatewayRow(row)) continue;
    const id = row.provider;
    // A gateway may not shadow a built-in: `resolveProfile` would still return the built-in for
    // these two ids, so accepting such a row here would produce a profile that never resolves.
    if (id === "anthropic" || id === "openai") continue;
    const protocol: WireProtocol = row.protocol ?? "openai-chat";
    const pricing = pricingFromRow(row);
    out.push({
      id,
      protocol,
      baseUrl: row.baseUrl,
      // Spread rather than assigned, so an unpriced row has no `pricing` key at all — the shape
      // `priceForProfile` and `warnProfileCannotPriceOnce` both key on.
      ...(pricing ? { pricing } : {}),
      // The PROTOCOL SELECTOR, not the identity — the split this record exists to make. An
      // openai-chat proxy runs the OpenAI adapter and conversion modules regardless of which
      // vendor's models sit behind it.
      adapterProvider: protocol === "anthropic-messages" ? "anthropic" : "openai",
      keyRef: {
        envVar: gatewayEnvVar(id),
        keyExample: "the key your gateway expects",
      },
    });
  }
  return out;
}

let _gatewayKeysPathOverride: string | null = null;

/** For test isolation only — redirect where gateway profiles are read from. */
export function _setGatewayKeysPathForTest(p: string | null): void {
  _gatewayKeysPathOverride = p;
}

/**
 * Read the key store synchronously and build the gateway profiles in it, or `[]` on any problem.
 *
 * Synchronous on purpose: its one caller is `cli/config.ts`'s `loadCliConfig`, which is sync and is
 * called before `applyDiskKeyFallbacks` has run. Making it async would either make `loadCliConfig`
 * async — it has many callers, several synchronous — or force the unrecognized-provider warning to
 * move out of it, and that warning is pinned byte-exact by `config.test.ts` (ledger item 385).
 *
 * Two rules from CLAUDE.md's `~/.zone` test-isolation section apply here verbatim and are the reason
 * this reads the way it does: `homedir()` is resolved AT CALL TIME, because a module-level `const`
 * ignores the suite's `HOME` redirect; and `fs` is a DEFAULT import, because a named `readFileSync`
 * import snapshots the binding and makes the home-guard silently inert.
 *
 * Fails closed to `[]` — a missing, unreadable or malformed store means "no gateways", never a
 * throw. `loadCliConfig` runs on every invocation of the CLI, including ones that never touch a key.
 */
export function readGatewayProfilesSync(): ProviderProfile[] {
  const p = _gatewayKeysPathOverride ?? join(homedir(), ".zone", "keys.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as DiskKeysFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) return [];
    return gatewayProfilesFrom(parsed);
  } catch {
    return [];
  }
}
