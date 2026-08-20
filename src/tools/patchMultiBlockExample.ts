/**
 * The worked multi-block --- FIND --- / --- REPLACE --- example, shared verbatim between the
 * apply_patch tool description (patch.description in toolDefinitions.ts) and the marker-imbalance
 * rejection message (toolExecutor.ts). The text already proved itself in the rejection message —
 * 11 of 13 recorded marker-imbalance incidents were the exact shape this example heads off — so
 * it is extracted here rather than re-authored, and both call sites import it instead of each
 * carrying their own copy that can silently diverge.
 *
 * No leading whitespace on either marker line: agentLoop.prompts.test.ts's column-0 sweep
 * requires every block-shaped `--- FIND ---`/`--- REPLACE ---` line across the whole prompt
 * surface to start at column 0.
 */
export const PATCH_MULTI_BLOCK_EXAMPLE =
  "--- FIND ---\n" +
  "<first region from file>\n" +
  "--- REPLACE ---\n" +
  "<replacement for first region>\n" +
  "--- FIND ---\n" +
  "<second region from file>\n" +
  "--- REPLACE ---\n" +
  "<replacement for second region>\n\n" +
  "Each block does ONE local substitution. Do not collapse two unrelated edits into one block.";
