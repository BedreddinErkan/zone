/**
 * MODEL_MODAL_OPEN seeds the cursor onto the model in use.
 *
 * Before this it set only `modalView`, leaving `modelSelectedIndex` at its initial 0 — so /model
 * opened on the first row while the model actually in use sat elsewhere in the list. This asserts
 * the reducer, not the helper: modelPickerList.test.ts covers the arithmetic, and a reducer that
 * computed the right index and then failed to store it would pass there and fail here.
 */

import { describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store-core.js";
import { USER_FACING_MODELS } from "../../llm/modelRegistry.js";

function openModal(over: Parameters<typeof buildInitialState>[0]) {
  return reducer(buildInitialState(over), { type: "MODEL_MODAL_OPEN" });
}

describe("harness floor", () => {
  it("the initial index really is 0, so a passing seed assertion below is not vacuous", () => {
    expect(buildInitialState({ model: "", capUsd: 10 }).modelSelectedIndex).toBe(0);
  });

  it("the default model is NOT at row 0 — otherwise every seek assertion would pass by accident", () => {
    // The exact defect the seed fixes, and the reason a test written against row 0 proves nothing.
    expect(USER_FACING_MODELS[0]?.id).not.toBe("claude-sonnet-4-6");
  });
});

describe("opening /model puts the cursor on the model in use", () => {
  it("seeds the current model's row when settings name one", () => {
    const s = openModal({
      model: "", capUsd: 10,
      modelSettings: { version: 2, model: "claude-haiku-4-5", provider: "anthropic", updatedAt: "x" },
    });
    expect(s.modalView).toBe("model");
    expect(USER_FACING_MODELS[s.modelSelectedIndex]?.id).toBe("claude-haiku-4-5");
  });

  it("falls back to the default model when settings are absent", () => {
    const s = openModal({ model: "", capUsd: 10 });
    expect(USER_FACING_MODELS[s.modelSelectedIndex]?.id).toBe("claude-sonnet-4-6");
  });

  it("indexes the FILTERED rows when a provider is hidden", () => {
    // anthropic-only key: every openai row is gone. The current model is anthropic, so its index
    // is unchanged here — the composition case where it is NOT lives in modelPickerList.test.ts.
    const s = openModal({
      model: "", capUsd: 10, providersWithKey: ["anthropic"],
      modelSettings: { version: 2, model: "claude-haiku-4-5", provider: "anthropic", updatedAt: "x" },
    });
    const rows = USER_FACING_MODELS.filter((m) => m.provider === "anthropic");
    expect(rows[s.modelSelectedIndex]?.id).toBe("claude-haiku-4-5");
  });

  it("negative control — an unknown model id seeds 0 instead of throwing or seeking wrongly", () => {
    const s = openModal({
      model: "", capUsd: 10,
      modelSettings: { version: 2, model: "some-custom-model", provider: "anthropic", updatedAt: "x" },
    });
    expect(s.modelSelectedIndex).toBe(0);
  });
});
