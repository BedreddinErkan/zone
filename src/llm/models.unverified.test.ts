/**
 * The @unverified-probe checklist must stay exactly in sync with
 * UNVERIFIED_MODEL_PARAMS.
 *
 * `rg '@unverified-probe'` is meant to be the re-probe to-do list. That only holds
 * if the markers and the registry agree, so this test fails in both directions:
 * when an entry is added without a marker (or vice versa), and when a probe clears
 * one and the other half is left rotting behind.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  UNVERIFIED_MODEL_PARAMS,
  getMaxOutputTokens,
  warnIfUnverifiedModelParams,
  _resetUnverifiedModelWarningsForTest,
} from "./models.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Files permitted to carry markers. A marker anywhere else would be invisible to
 *  this test, so new locations must be added here deliberately. */
const MARKED_SOURCES = ["models.ts", "modelRegistry.ts"];

const MARKER_RE = /@unverified-probe\(([^)]+)\)/g;

function markedModelIds(): Set<string> {
  const found = new Set<string>();
  for (const file of MARKED_SOURCES) {
    const src = readFileSync(join(HERE, file), "utf8");
    for (const m of src.matchAll(MARKER_RE)) found.add(m[1].trim());
  }
  return found;
}

describe("@unverified-probe markers", () => {
  afterEach(() => {
    _resetUnverifiedModelWarningsForTest();
    vi.restoreAllMocks();
  });

  it("the marker set and UNVERIFIED_MODEL_PARAMS name exactly the same models", () => {
    const marked = [...markedModelIds()].sort();
    const declared = Object.keys(UNVERIFIED_MODEL_PARAMS).sort();
    expect(marked).toEqual(declared);
  });

  it("every declared model names at least one unverified parameter", () => {
    for (const [id, params] of Object.entries(UNVERIFIED_MODEL_PARAMS)) {
      expect(params.length, `${id} declares no unverified parameters`).toBeGreaterThan(0);
    }
  });

  it("each marker carries a reason on the same line or the lines around it", () => {
    // A bare marker is useless six months from now — the reason is what tells the
    // next person whether the blocker still applies.
    for (const file of MARKED_SOURCES) {
      const lines = readFileSync(join(HERE, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("@unverified-probe(")) return;
        const context = lines.slice(i, i + 3).join(" ");
        const afterMarker = context.split(/@unverified-probe\([^)]+\)/)[1] ?? "";
        expect(
          afterMarker.replace(/[^a-z]/gi, "").length,
          `marker in ${file} line ${i + 1} has no reason text`
        ).toBeGreaterThan(20);
      });
    }
  });
});

describe("warnIfUnverifiedModelParams", () => {
  afterEach(() => {
    _resetUnverifiedModelWarningsForTest();
    vi.restoreAllMocks();
  });

  it("warns once per model with the id and the unverified parameter names", () => {
    _resetUnverifiedModelWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [id] = Object.keys(UNVERIFIED_MODEL_PARAMS);

    warnIfUnverifiedModelParams(id);
    warnIfUnverifiedModelParams(id);

    expect(warn).toHaveBeenCalledTimes(1);
    const [marker, payload] = warn.mock.calls[0] as [string, string];
    expect(marker).toBe("[zone-unverified-model-params]");
    const parsed = JSON.parse(payload) as { modelId: string; unverified: string[] };
    expect(parsed.modelId).toBe(id);
    expect(parsed.unverified).toEqual([...UNVERIFIED_MODEL_PARAMS[id]]);
  });

  it("a dated snapshot id resolves to its alias", () => {
    _resetUnverifiedModelWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [id] = Object.keys(UNVERIFIED_MODEL_PARAMS);

    warnIfUnverifiedModelParams(`${id}-20260801`);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse((warn.mock.calls[0] as [string, string])[1]).modelId).toBe(id);
  });

  it("stays silent for a fully verified model", () => {
    _resetUnverifiedModelWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfUnverifiedModelParams("claude-sonnet-5");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fires through getMaxOutputTokens, so any request path triggers it", () => {
    _resetUnverifiedModelWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [id] = Object.keys(UNVERIFIED_MODEL_PARAMS);

    getMaxOutputTokens(id);

    expect(warn).toHaveBeenCalledWith("[zone-unverified-model-params]", expect.any(String));
  });
});
