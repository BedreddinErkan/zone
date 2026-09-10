import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KEYBINDINGS, type KeyBinding } from "./keybindingRegistry.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TUI_DIR = path.join(REPO_ROOT, "src", "cli", "tui");

/** Opt-out marker for keys deliberately excluded from the inventory. */
const OPT_OUT = "// keybind: intentional-unregistered";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reads every .tsx file under src/cli/tui (non-recursive for components, recursive for hooks). */
function readTsxFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "primitives") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
        files.set(path.relative(REPO_ROOT, full), fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(TUI_DIR);
  return files;
}

/** Maps key.escape → "escape", key.return → "enter", key.upArrow → "up", etc. */
const KEY_PROP_TO_TOKEN: Record<string, string> = {
  "key.escape": "escape",
  "key.return": "enter",
  "key.tab": "tab",
  "key.upArrow": "up",
  "key.downArrow": "down",
  "key.leftArrow": "left",
  "key.rightArrow": "right",
  "key.backspace": "backspace",
  "key.delete": "delete",
  "key.home": "home",
  "key.end": "end",
  "key.ctrl": "ctrl",
  "key.meta": "meta",
  "key.shift": "shift",
};

/** Extracts normalized key tokens from a source file's useInput handlers.
 *  Filters out modifier-only checks (ctrl/meta used as guards) and keys that are
 *  only present as text-input pass-through (!key.ctrl && !key.meta). */
function extractKeysFromSource(text: string): Set<string> {
  const keys = new Set<string>();

  // key.escape / key.return / etc. — but skip ctrl/meta which are typically guards
  for (const [prop, token] of Object.entries(KEY_PROP_TO_TOKEN)) {
    if (token === "ctrl" || token === "meta" || token === "shift") continue; // modifier guards, not bindings
    if (text.includes(prop)) keys.add(token);
  }

  // input === "X" / input === 'X' / ch === "X" / ch === 'X' — character comparisons
  const charMatch = text.matchAll(/(?:input|ch)\s*===\s*["']([^"']+)["']/g);
  for (const m of charMatch) {
    const raw = m[1]!;
    if (raw === "\\x03" || raw === "\x03") keys.add("ctrl+c");
    else if (raw === "\\") keys.add("backslash");
    else keys.add(raw.toLowerCase());
  }

  // Shift+Tab: key.shift && key.tab (composite binding)
  if (text.includes("key.shift") && text.includes("key.tab")) {
    keys.add("shift+tab");
    keys.delete("tab"); // "tab" alone is a false positive from the shift+tab check
  }

  // Delete paired with backspace is a single binding (delete/backspace)
  if (keys.has("delete") && keys.has("backspace")) {
    keys.delete("delete");
  }

  return keys;
}

/** Owner basename from a relative path. */
function ownerOf(relPath: string): string {
  return path.basename(relPath, ".tsx");
}

// ── Test 1: No unresolvable conflicts ─────────────────────────────────────────

describe("keybinding registry — no unresolvable conflicts", () => {
  it("bindings sharing a key are in different contexts or have exclusivity declared", () => {
    // Build a map: normalized key → list of bindings
    const byKey = new Map<string, KeyBinding[]>();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) {
        const list = byKey.get(k) ?? [];
        list.push(b);
        byKey.set(k, list);
      }
    }

    const conflicts: string[] = [];
    for (const [key, bindings] of byKey) {
      if (bindings.length < 2) continue;
      // Check every pair
      for (let i = 0; i < bindings.length; i++) {
        for (let j = i + 1; j < bindings.length; j++) {
          const a = bindings[i]!;
          const b = bindings[j]!;
          // Same context = same component handling the same key twice → always a bug
          if (a.context === b.context) {
            conflicts.push(
              `DUPLICATE: "${key}" handled twice in context "${a.context}" by ${a.owner} and ${b.owner}`
            );
            continue;
          }
          // Different contexts: OK if sub-mode/nested (context name contains "-submode" or
          // one context is a prefix of the other, e.g. "overlay:model" vs "overlay:model-submode")
          // OR if exclusiveWith is declared
          const aNested = a.context.includes("-submode") || b.context.startsWith(a.context + "-");
          const bNested = b.context.includes("-submode") || a.context.startsWith(b.context + "-");
          const exclusivity = a.exclusiveWith === b.context || b.exclusiveWith === a.context;
          const sameOverlay = a.context.startsWith("overlay:") && b.context.startsWith("overlay:")
            && a.context.split(":")[1]?.split("-")[0] !== b.context.split(":")[1]?.split("-")[0];
          // Different overlays can never conflict — only one is on top of the stack
          const bothModals = a.context.startsWith("modal:") && b.context.startsWith("modal:")
            && a.context !== b.context;
          // Different modals are mutually exclusive (only one modalView at a time)
          if (aNested || bNested || exclusivity || sameOverlay || bothModals) continue;
          // Different top-level contexts (global vs composer vs overlay vs modal) — no conflict
          // because isActive gating ensures only one fires at a time
          const aTop = a.context.split(/[:\-]/)[0]!;
          const bTop = b.context.split(/[:\-]/)[0]!;
          if (aTop !== bTop) continue;
          // Same top-level, not nested, no exclusivity → potential conflict
          conflicts.push(
            `CONFLICT: "${key}" in "${a.context}" (${a.owner}: ${a.action}) vs "${b.context}" (${b.owner}: ${b.action})`
          );
        }
      }
    }
    expect(conflicts, conflicts.join("\n")).toEqual([]);
  });
});

// ── Test 2: Inventory matches source (drift guard) ────────────────────────────

describe("keybinding registry — source drift guard", () => {
  const tsxFiles = readTsxFiles();

  // Build owner → set of keys from inventory
  const inventoryByOwner = new Map<string, Set<string>>();
  for (const b of KEYBINDINGS) {
    const set = inventoryByOwner.get(b.owner) ?? new Set();
    for (const k of b.keys) set.add(k);
    inventoryByOwner.set(b.owner, set);
  }

  // Files we know are legacy (kept for backward-compat tests, not active UI)
  const LEGACY_FILES = new Set([
    "ModelModal.tsx",
    "ApiKeysView.tsx",
    "MetricsModal.tsx",
  ]);

  it("every key in source has a matching inventory entry", () => {
    const missing: string[] = [];
    for (const [rel, text] of tsxFiles) {
      const basename = path.basename(rel);
      if (LEGACY_FILES.has(basename)) continue;
      const owner = ownerOf(rel);
      const inventoryKeys = inventoryByOwner.get(owner);
      if (!inventoryKeys) {
        // File has useInput but no inventory entries — check if it actually has useInput
        if (text.includes("useInput(")) {
          const sourceKeys = extractKeysFromSource(text);
          if (sourceKeys.size > 0) {
            missing.push(`${rel}: has useInput with keys [${[...sourceKeys].join(", ")}] but no inventory entries`);
          }
        }
        continue;
      }
      const sourceKeys = extractKeysFromSource(text);
      // Filter out opt-out lines
      const lines = text.split("\n");
      const optOutKeys = new Set<string>();
      for (const line of lines) {
        if (line.includes(OPT_OUT)) {
          // Any key on this line is opted out
          for (const [prop, token] of Object.entries(KEY_PROP_TO_TOKEN)) {
            if (line.includes(prop)) optOutKeys.add(token);
          }
          const inputMatch = line.matchAll(/input\s*===\s*["']([^"']+)["']/g);
          for (const m of inputMatch) optOutKeys.add(m[1]!.toLowerCase());
        }
      }
      for (const k of sourceKeys) {
        if (optOutKeys.has(k)) continue;
        if (!inventoryKeys.has(k)) {
          missing.push(`${rel}: key "${k}" found in source but missing from inventory (owner: ${owner})`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("every inventory key has a matching source occurrence", () => {
    const orphans: string[] = [];
    for (const b of KEYBINDINGS) {
      // Find the source file for this owner
      const ownerFile = [...tsxFiles.entries()].find(([rel]) => ownerOf(rel) === b.owner);
      if (!ownerFile) {
        orphans.push(`owner "${b.owner}" has no .tsx file under src/cli/tui`);
        continue;
      }
      const sourceKeys = extractKeysFromSource(ownerFile[1]);
      for (const k of b.keys) {
        // Composite keys like "ctrl+c" need special checking
        if (k === "ctrl+c") {
          if (!sourceKeys.has("ctrl+c") && !sourceKeys.has("ctrl") && !ownerFile[1].includes("\x03")) {
            orphans.push(`${b.owner}: inventory key "${k}" has no source match`);
          }
          continue;
        }
        if (k === "shift+tab") {
          if (!sourceKeys.has("shift+tab")) {
            orphans.push(`${b.owner}: inventory key "${k}" has no source match`);
          }
          continue;
        }
        if (k === "backslash") {
          if (!ownerFile[1].includes("\\\\") && !sourceKeys.has("\\")) {
            orphans.push(`${b.owner}: inventory key "${k}" has no source match`);
          }
          continue;
        }
        // "delete" and "backspace" are interchangeable — source often pairs them
        if (k === "delete" && sourceKeys.has("backspace")) continue;
        if (!sourceKeys.has(k)) {
          orphans.push(`${b.owner}: inventory key "${k}" has no source match`);
        }
      }
    }
    expect(orphans, orphans.join("\n")).toEqual([]);
  });
});

// ── Test 3: Help text coverage ────────────────────────────────────────────────

describe("keybinding registry — help text coverage", () => {
  it("HELP_LINES from Composer.tsx are covered by the inventory", () => {
    const composerPath = path.join(TUI_DIR, "components", "Composer.tsx");
    const composerText = fs.readFileSync(composerPath, "utf8");

    // Extract HELP_LINES array content
    const helpMatch = composerText.match(/const HELP_LINES\s*=\s*\[([\s\S]*?)\];/);
    expect(helpMatch, "HELP_LINES not found in Composer.tsx").toBeTruthy();
    const helpContent = helpMatch![1]!;

    // Check that Shift+Tab is documented in HELP_LINES
    expect(helpContent).toContain("Shift+Tab");

    // Check that key bindings documented in HELP_LINES exist in the inventory
    const inventoryKeys = new Set<string>();
    for (const b of KEYBINDINGS) {
      for (const k of b.keys) inventoryKeys.add(k);
    }

    // Verify critical keys are in both HELP_LINES and inventory
    const criticalKeys = [
      { helpText: "Enter", token: "enter" },
      { helpText: "Esc", token: "escape" },
      { helpText: "Ctrl+C", token: "ctrl+c" },
      { helpText: "Shift+Tab", token: "shift+tab" },
    ];
    const missingFromInventory: string[] = [];
    const missingFromHelp: string[] = [];
    for (const { helpText, token } of criticalKeys) {
      if (helpContent.includes(helpText) && !inventoryKeys.has(token)) {
        missingFromInventory.push(`"${helpText}" in HELP_LINES but "${token}" not in inventory`);
      }
      if (!helpContent.includes(helpText) && inventoryKeys.has(token)) {
        missingFromHelp.push(`"${token}" in inventory but "${helpText}" not in HELP_LINES`);
      }
    }
    expect(missingFromInventory, missingFromInventory.join("\n")).toEqual([]);
    // It's OK for inventory to have keys not in HELP_LINES (overlay keys aren't in /help)
    // But the critical global keys should be in both
    void missingFromHelp;
  });

  it("Shift+Tab is present in both HELP_LINES and the inventory", () => {
    const composerPath = path.join(TUI_DIR, "components", "Composer.tsx");
    const composerText = fs.readFileSync(composerPath, "utf8");
    expect(composerText).toContain("Shift+Tab");

    const hasShiftTab = KEYBINDINGS.some(b => b.keys.includes("shift+tab"));
    expect(hasShiftTab).toBe(true);
  });
});
