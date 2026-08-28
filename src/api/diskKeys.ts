import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * A key's identity. The two built-ins are spelled out so they still autocomplete and so a typo in
 * `"anthropic"` is still a type error at the call sites that mean the vendor; `(string & {})` widens
 * the rest of the space for gateway profile ids (step 5 of the gateway recommendation).
 *
 * The constraint that mattered here was never the file's schema version — it was THIS type plus
 * `setDiskKey`'s `findIndex(k => k.provider === provider)`, which makes the identity unique. A
 * gateway id is its own identity, so a gateway key and both vendor keys coexist in one file.
 */
export type ApiKeyProvider = "anthropic" | "openai" | (string & {});

/** The wire protocol a gateway endpoint speaks. Mirrors `llm/providerProfile.ts`'s `WireProtocol`;
 *  spelled inline rather than imported so this module stays a node-builtins-only leaf. */
export type DiskKeyProtocol = "openai-chat" | "anthropic-messages";

export interface DiskApiKey {
  provider: ApiKeyProvider;
  key: string;
  addedAt: string;
  /**
   * Set only on a gateway row, and it is what MAKES the row a gateway: `gatewayProfilesFrom`
   * treats a row with a `baseUrl` as a profile and a row without one as a plain vendor key.
   * Additive — absent on every row an older Zone wrote, and ignored by every older Zone that
   * reads one, because neither loader validates beyond `version === 1`.
   */
  baseUrl?: string;
  /** Defaults to `"openai-chat"` when absent — the protocol every common proxy speaks. */
  protocol?: DiskKeyProtocol;
  /** Free-text display name for the keys list. Never used for resolution. */
  label?: string;
  /**
   * Per-model declared prices, keyed by exact model id. Present only on a gateway row the user has
   * priced; `gatewayProfilesFrom` turns it into the profile's inline `pricing.rates` table, which
   * is what makes `--max-budget-usd` and the daily cap enforceable on a gateway at all.
   */
  pricing?: Record<string, DiskKeyPricing>;
}

export interface DiskKeysFile {
  version: 1;
  keys: DiskApiKey[];
}

/**
 * One model's declared prices, in USD per MILLION tokens — the same units as
 * `PRICING_USD_PER_MTOK`, so the arithmetic is shared rather than re-implemented.
 *
 * These are the USER'S DECLARATION, never Zone's estimate: nothing infers, guesses, or defaults a
 * rate for a gateway, because a confident wrong number is worse than an honest missing one.
 *
 * `cache_read`/`cache_write` being ABSENT is itself the record of a choice — it means the user
 * skipped that bucket at setup, and it will price at $0. That is deliberately distinguishable from
 * a user who TYPED `0`, which stores `0` explicitly. Same arithmetic, two different situations:
 * "I priced cached tokens at nothing because my gateway does not bill them" versus "I never said."
 * Without the distinction a user seeing an unexpectedly low cost has no way to tell which happened.
 */
export interface DiskKeyPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/** The gateway-only fields `setDiskKey` accepts alongside the key itself. */
export interface DiskKeyExtras {
  baseUrl?: string;
  protocol?: DiskKeyProtocol;
  label?: string;
  /** Keyed by EXACT model id, matching how `PricingRef.rates` is looked up. */
  pricing?: Record<string, DiskKeyPricing>;
}

let _keysFilePathOverride: string | null = null;
let _legacyKeysPathOverride: string | null = null;

/** For test isolation only — redirect where keys are stored. */
export function _setKeysFilePathForTest(homePath: string | null, legacyPath: string | null = null): void {
  _keysFilePathOverride = homePath;
  _legacyKeysPathOverride = legacyPath;
}

function keysFilePath(): string {
  return _keysFilePathOverride ?? join(homedir(), ".zone", "keys.json");
}

export async function loadDiskKeys(): Promise<DiskKeysFile> {
  const p = keysFilePath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as DiskKeysFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Migration: move legacy cwd-relative keys to home dir (do not delete old file)
    const legacy = _legacyKeysPathOverride ?? join(process.cwd(), ".zone", "keys.json");
    try {
      const raw = await fs.readFile(legacy, "utf-8");
      const parsed = JSON.parse(raw) as DiskKeysFile;
      if (parsed.version === 1 && Array.isArray(parsed.keys)) {
        await saveDiskKeys(parsed);
        console.log("[zone-keys-migrated] moved .zone/keys.json → ~/.zone/keys.json");
        return parsed;
      }
    } catch { /* not present or corrupt — skip */ }
    return { version: 1, keys: [] };
  }
}

async function saveDiskKeys(store: DiskKeysFile): Promise<void> {
  const p = keysFilePath();
  await fs.mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tmp, p);
  try { await fs.chmod(p, 0o600); } catch { /* Windows/non-POSIX — best effort */ }
}

/**
 * `extras` is optional and defaults to absent — but absent means "no change to this field," not
 * "clear it." A key-only update (`/keys` → `E`) must not demote an existing gateway row to a plain
 * vendor row by dropping `baseUrl`/`protocol`/`label`/`pricing` it already had; every explicitly
 * supplied field still overrides, exactly as before, and the original two-argument call on a row
 * that never had these fields still writes exactly the same three-field row it always did.
 */
export async function setDiskKey(
  provider: ApiKeyProvider,
  key: string,
  extras?: DiskKeyExtras
): Promise<void> {
  if (key.startsWith("<")) {
    throw new Error(`${provider} API key looks like a placeholder ("<…>") — set a real key.`);
  }
  for (let i = 0; i < key.length; i++) {
    const cp = key.charCodeAt(i);
    if (cp < 0x20 || cp > 0x7e) {
      throw new Error(
        `${provider} API key contains a non-ASCII character at byte ${i} ` +
        `(U+${cp.toString(16).toUpperCase().padStart(4, "0")}) — likely a placeholder, not a real key.`
      );
    }
  }
  const store = await loadDiskKeys();
  const idx = store.keys.findIndex(k => k.provider === provider);
  const existing = idx >= 0 ? store.keys[idx] : undefined;
  // Spread the optional fields conditionally rather than assigning `undefined`: a row written with
  // `baseUrl: undefined` serialises to no key at all through JSON.stringify, but an explicit
  // `undefined` would still make `"baseUrl" in entry` true for any in-memory reader. Each field
  // falls back to the row being replaced when `extras` doesn't specify it, so an update that only
  // means to change the key can't silently erase a gateway's identity.
  const entry: DiskApiKey = {
    provider,
    key,
    addedAt: new Date().toISOString(),
    ...((extras?.baseUrl ?? existing?.baseUrl) ? { baseUrl: extras?.baseUrl ?? existing!.baseUrl } : {}),
    ...((extras?.protocol ?? existing?.protocol) ? { protocol: extras?.protocol ?? existing!.protocol } : {}),
    ...((extras?.label ?? existing?.label) ? { label: extras?.label ?? existing!.label } : {}),
    // An empty pricing map is dropped rather than written, so a row the user never priced keeps the
    // exact key set it had before this field existed.
    ...(() => {
      const pricing = extras?.pricing ?? existing?.pricing;
      return pricing && Object.keys(pricing).length > 0 ? { pricing } : {};
    })(),
  };
  if (idx >= 0) store.keys[idx] = entry;
  else store.keys.push(entry);
  await saveDiskKeys(store);
}

export async function removeDiskKey(provider: ApiKeyProvider): Promise<void> {
  const store = await loadDiskKeys();
  store.keys = store.keys.filter(k => k.provider !== provider);
  await saveDiskKeys(store);
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 7)}***${key.slice(-4)}`;
}
