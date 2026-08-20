import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeModelId } from "./modelIdNormalize.js";

describe("normalizeModelId — both provider snapshot spellings", () => {
  it("strips the Anthropic spelling (-YYYYMMDD)", () => {
    expect(normalizeModelId("claude-sonnet-4-6-20260219")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("strips the OpenAI spelling (-YYYY-MM-DD) — the arm modelRegistry's copy was missing", () => {
    expect(normalizeModelId("gpt-5.5-2026-04-23")).toBe("gpt-5.5");
    expect(normalizeModelId("gpt-5.4-mini-2026-03-17")).toBe("gpt-5.4-mini");
  });

  it("is a no-op for undated ids", () => {
    expect(normalizeModelId("gpt-5.4-nano")).toBe("gpt-5.4-nano");
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeModelId("gpt-4o")).toBe("gpt-4o");
  });

  it("over-matches deliberately: impossible dates and bare digit runs are stripped, not validated", () => {
    // Documented in the module comment as the safe direction — a lookup miss falls back to a
    // default, whereas a stricter pattern would reject a spelling the provider is free to invent.
    expect(normalizeModelId("weird-9999-99-99")).toBe("weird");
    expect(normalizeModelId("x-12345678")).toBe("x");
  });

  it("both patterns are anchored — a snapshot date mid-id is not a suffix and is left alone", () => {
    // Added after a mutation that removed the `$` anchor survived the whole suite: without the
    // anchor these patterns match a date SUBSTRING, so a suffixed variant silently loses its
    // middle rather than staying whole. Nothing else in the corpus has a date mid-id, which is
    // exactly why the survivor was invisible.
    expect(normalizeModelId("gpt-5.5-2026-04-23-preview")).toBe("gpt-5.5-2026-04-23-preview");
    expect(normalizeModelId("claude-sonnet-4-6-20260219-beta")).toBe("claude-sonnet-4-6-20260219-beta");
  });

  it("applies both arms independently — neither shadows the other", () => {
    // Zero overlap between the two patterns is what makes replacement order irrelevant. A
    // mutation reversing them is expected to SURVIVE and is inert by construction, so this
    // asserts the property directly rather than relying on a mutation to reveal it.
    const reversed = (id: string) => id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
    for (const id of [
      "claude-sonnet-4-6-20260219",
      "gpt-5.5-2026-04-23",
      "gpt-5.4-nano",
      "weird-9999-99-99",
      "x-12345678",
      "gpt-4o",
    ]) {
      expect(reversed(id), `order must not matter for ${id}`).toBe(normalizeModelId(id));
    }
  });
});

/**
 * The single-source property this module exists to create.
 *
 * Without this block the extraction is a one-time cleanup: nothing stops a future edit from
 * reintroducing a local copy, and because a copy would be behaviourally identical, every
 * behavioural test above would still pass. That is precisely how the two implementations diverged
 * in the first place — one grew the OpenAI arm and the other did not, and no instrument noticed
 * for as long as they happened to agree on the ids being exercised.
 *
 * Scans tracked sources for the two suffix patterns and asserts they appear in exactly one
 * implementation file. Self-excluded (this file necessarily contains the patterns, in the
 * order-independence assertion above) — the same self-exclusion markerAttribution.ts already
 * needs for its own tree scan, and for the same reason.
 */
describe("single-source: exactly one model-id normalizer implementation", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const IMPLEMENTATION = "src/llm/modelIdNormalize.ts";
  const SELF_EXCLUDED = new Set([IMPLEMENTATION, "src/llm/modelIdNormalize.test.ts"]);

  /** Either provider's snapshot-suffix strip, as it would appear in source text. */
  const SUFFIX_STRIP = /replace\(\s*\/-\\d\{8\}\$\/|replace\(\s*\/-\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//;

  function trackedSources(): string[] {
    const out = execFileSync("git", ["ls-files", "-z", "src", "scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.split("\0").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  }

  it("no tracked source outside the implementation strips a snapshot suffix itself", () => {
    const offenders = trackedSources()
      .filter((rel) => !SELF_EXCLUDED.has(rel))
      .filter((rel) => {
        const abs = path.join(REPO_ROOT, rel);
        let text: string;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          return false; // deleted-but-staged; not this test's concern
        }
        return SUFFIX_STRIP.test(text);
      });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A second model-id normalizer has appeared in: ${offenders.join(", ")}. ` +
          `Import normalizeModelId from ${IMPLEMENTATION} instead — a local copy is ` +
          `behaviourally identical until it silently diverges, which is what this guards.`
    ).toEqual([]);
  });

  it("the implementation file itself still carries both arms — the scan is not vacuous", () => {
    // Without this, deleting both patterns from the implementation would make the assertion
    // above pass for the wrong reason.
    const text = fs.readFileSync(path.join(REPO_ROOT, IMPLEMENTATION), "utf8");
    expect(text).toMatch(/-\\d\{8\}\$/);
    expect(text).toMatch(/-\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  });
});
