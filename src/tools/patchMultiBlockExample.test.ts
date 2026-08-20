import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATCH_MULTI_BLOCK_EXAMPLE } from "./patchMultiBlockExample.js";
import { ZONE_TOOLS } from "./toolDefinitions.js";

describe("PATCH_MULTI_BLOCK_EXAMPLE — the reused worked example", () => {
  it("is the exact text proven in the marker-imbalance rejection message", () => {
    // Byte-exact against the literal that lived inline in toolExecutor.ts before extraction —
    // confirmed against source directly, not retyped from memory.
    expect(PATCH_MULTI_BLOCK_EXAMPLE).toBe(
      "--- FIND ---\n" +
        "<first region from file>\n" +
        "--- REPLACE ---\n" +
        "<replacement for first region>\n" +
        "--- FIND ---\n" +
        "<second region from file>\n" +
        "--- REPLACE ---\n" +
        "<replacement for second region>\n\n" +
        "Each block does ONE local substitution. Do not collapse two unrelated edits into one block."
    );
  });

  it("carries no leading whitespace on either marker line — required by the column-0 sweep", () => {
    for (const line of PATCH_MULTI_BLOCK_EXAMPLE.split("\n")) {
      if (line.includes("--- FIND ---") || line.includes("--- REPLACE ---")) {
        expect(line, `marker line must start at column 0: ${JSON.stringify(line)}`).toBe(
          line.trimStart()
        );
      }
    }
  });
});

/**
 * The single-source property this module exists to create.
 *
 * Without this block, extracting the example into its own constant is a one-time cleanup:
 * nothing stops a future edit from pasting a reworded copy at one of the two call sites, and a
 * reworded copy is behaviourally indistinguishable to every test in this file (and to
 * toolExecutor.markerBalance.test.ts's own pinned assertion, which only checks for one short
 * fragment). That is exactly how the tool description and the rejection message had already
 * diverged before this pass — one showing a single balanced pair, the other showing the worked
 * multi-block example, describing the same format two different ways. Mirrors the precedent
 * this repo already set for exactly this shape: src/llm/modelIdNormalize.test.ts.
 */
describe("single-source: the worked example is imported, never re-authored, at either call site", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const IMPLEMENTATION = "src/tools/patchMultiBlockExample.ts";
  // markerBalance.test.ts legitimately pins one short fragment of the rejection message's
  // output (an assertion ON the shared constant's effect, not a second copy of it) — excluded
  // for that reason, not because it's exempt from the property being guarded.
  const SELF_EXCLUDED = new Set([
    IMPLEMENTATION,
    "src/tools/patchMultiBlockExample.test.ts",
    "src/tools/toolExecutor.markerBalance.test.ts",
  ]);

  /** A substring distinctive enough that only a re-authored (or pasted) copy would contain it. */
  const DISTINCTIVE_FRAGMENT = "<second region from file>";

  function trackedSources(): string[] {
    const out = execFileSync("git", ["ls-files", "-z", "src", "scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return out.split("\0").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  }

  it("no tracked source outside the implementation contains a second copy of the example", () => {
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
        return text.includes(DISTINCTIVE_FRAGMENT);
      });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A second copy of the worked multi-block example has appeared in: ${offenders.join(", ")}. ` +
          `Import PATCH_MULTI_BLOCK_EXAMPLE from ${IMPLEMENTATION} instead — a re-authored copy is ` +
          `behaviourally identical until it silently diverges, which is what this guards.`
    ).toEqual([]);
  });

  it("the implementation file itself still carries the example — the scan is not vacuous", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, IMPLEMENTATION), "utf8");
    expect(text).toContain(DISTINCTIVE_FRAGMENT);
  });

  it("both call sites import the constant rather than inlining the text", () => {
    const toolExecutor = fs.readFileSync(path.join(REPO_ROOT, "src/tools/toolExecutor.ts"), "utf8");
    const toolDefinitions = fs.readFileSync(
      path.join(REPO_ROOT, "src/tools/toolDefinitions.ts"),
      "utf8"
    );
    expect(toolExecutor).toContain('from "./patchMultiBlockExample.js"');
    expect(toolExecutor).toContain("PATCH_MULTI_BLOCK_EXAMPLE");
    expect(toolDefinitions).toContain('from "./patchMultiBlockExample.js"');
    expect(toolDefinitions).toContain("PATCH_MULTI_BLOCK_EXAMPLE");
  });
});

/**
 * The content check, distinct from the source-text scan above: reads the actual computed
 * ZONE_TOOLS value (not source text) and confirms the example landed in the field it was
 * planned for. An import can be present but unused (e.g. a mutation that deletes only the
 * `+ PATCH_MULTI_BLOCK_EXAMPLE` usage) — that would still satisfy the source-text check above,
 * since the import line itself contains the constant's name; this test reads the rendered
 * field value instead, so a dropped usage fails here even when the import survives.
 */
describe("apply_patch tool schema: patch.description actually contains the example", () => {
  it("the rendered patch.description field, not just the source text, contains the constant's value", () => {
    const applyPatchTool = ZONE_TOOLS.find((t) => t.function.name === "apply_patch");
    const patchDescription = (
      applyPatchTool?.function.parameters as
        | { properties?: { patch?: { description?: string } } }
        | undefined
    )?.properties?.patch?.description;
    expect(patchDescription).toBeDefined();
    expect(patchDescription).toContain(PATCH_MULTI_BLOCK_EXAMPLE);
  });
});
