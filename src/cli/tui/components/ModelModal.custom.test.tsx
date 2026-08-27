import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ModelModal } from "./ModelModal.js";
import { reducer, buildInitialState } from "../store-core.js";
import type { StoreState, StoreAction } from "../store-core.js";

/**
 * Free-text model entry, and specifically the THREE gateway counts.
 *
 * The one-gateway path is the one an implementation naturally gets right and the only one an
 * inference-based design would have tested, so zero and many are pinned here as first-class cases
 * rather than left to fall out of it. What each must do:
 *   zero  — refuse and say why, writing nothing
 *   one   — apply, having DISPLAYED the routing before the user pressed Enter
 *   many  — ask; never pick silently
 */

const saveDiskModelMock = vi.hoisted(() => vi.fn());
vi.mock("../../../api/diskModel.js", () => ({ saveDiskModel: saveDiskModelMock }));

let currentState: StoreState;
const dispatchSpy = vi.fn((a: StoreAction) => { currentState = reducer(currentState, a); });
vi.mock("../store.js", () => ({ useStore: () => ({ state: currentState, dispatch: dispatchSpy }) }));

function start(gatewayIds: string[]): void {
  currentState = reducer(
    buildInitialState({ gatewayIds, providersWithKey: ["anthropic", ...gatewayIds] }),
    { type: "MODEL_MODAL_OPEN" }
  );
}

beforeEach(() => {
  saveDiskModelMock.mockClear();
  dispatchSpy.mockClear();
  start([]);
});

const flush = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function press(keys: Array<{ input?: string; key?: Record<string, boolean> }>): Promise<string> {
  let frame = "";
  const { stdin, lastFrame, rerender } = render(React.createElement(ModelModal, { dispatch: dispatchSpy }));
  for (const k of keys) {
    if (k.key?.escape) stdin.write("\x1B");
    else if (k.key?.return) stdin.write("\r");
    else if (k.key?.backspace) stdin.write("\x7F");
    else if (k.key?.downArrow) stdin.write("\x1B[B");
    else if (k.key?.upArrow) stdin.write("\x1B[A");
    else if (k.input) stdin.write(k.input);
    // A lone Esc needs longer than the rest: a bracketed paste also begins with \x1B, so the
    // parser holds the byte back until enough time has passed to rule that out. Arrow keys are
    // complete sequences and parse immediately.
    await flush(k.key?.escape ? 60 : 1);
    rerender(React.createElement(ModelModal, { dispatch: dispatchSpy }));
    frame = lastFrame() ?? "";
  }
  return frame;
}

const type = (s: string) => [...s].map((ch) => ({ input: ch }));
const ENTER = { key: { return: true } };
const CUSTOM = { input: "c" };

describe("ModelModal — harness floor", () => {
  it("renders catalog rows normally, so an absent custom field would be visible here first", async () => {
    const { lastFrame } = render(React.createElement(ModelModal, { dispatch: dispatchSpy }));
    expect(lastFrame()).toMatch(/Anthropic/);
    expect(lastFrame()).toMatch(/C — enter a custom model id/);
  });

  it("C enters the free-text field and Esc leaves it without writing anything", async () => {
    start(["lab"]);
    await press([CUSTOM, ...type("openai/gpt-4o-mini"), { key: { escape: true } }]);
    expect(currentState.modelCustomMode).toBe("none");
    expect(currentState.modelCustomInput).toBe("");
    expect(saveDiskModelMock).not.toHaveBeenCalled();
  });
});

describe("ModelModal — free-text entry with ZERO gateways", () => {
  it("warns in the field before Enter is ever pressed", async () => {
    start([]);
    const frame = await press([CUSTOM, ...type("openai/gpt-4o-mini")]);
    expect(frame).toMatch(/no gateway configured/);
    expect(frame).toMatch(/\[G\]ateway/);
  });

  it("REFUSES on Enter and writes nothing", async () => {
    start([]);
    await press([CUSTOM, ...type("openai/gpt-4o-mini"), ENTER]);
    // Saving it would be actively harmful, not merely useless: with no gateway to serve it,
    // getModelName substitutes the vendor's standard-tier default and the run silently uses a
    // model the user did not choose.
    expect(saveDiskModelMock).not.toHaveBeenCalled();
    expect(currentState.modelSettings).toBeNull();
    expect(currentState.modelCustomMode).toBe("none");
  });

  it("says WHY it refused rather than failing silently", async () => {
    start([]);
    await press([CUSTOM, ...type("openai/gpt-4o-mini"), ENTER]);
    const toasts = dispatchSpy.mock.calls
      .map(([a]) => a)
      .filter((a): a is Extract<StoreAction, { type: "TOAST_PUSH" }> => a.type === "TOAST_PUSH");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.entry.level).toBe("error");
    expect(toasts[0]!.entry.message).toMatch(/No gateway configured/);
    expect(toasts[0]!.entry.message).toMatch(/\/keys/);
  });
});

describe("ModelModal — free-text entry with EXACTLY ONE gateway", () => {
  it("DISPLAYS the routing before Enter — inference shown, not silent", async () => {
    start(["lab"]);
    const frame = await press([CUSTOM, ...type("openai/gpt-4o-mini")]);
    expect(frame).toMatch(/→ via lab/);
  });

  it("applies the typed id against that gateway", async () => {
    start(["lab"]);
    await press([CUSTOM, ...type("openai/gpt-4o-mini"), ENTER]);
    expect(saveDiskModelMock).toHaveBeenCalledTimes(1);
    const settings = saveDiskModelMock.mock.calls[0]![1] as { model: string; provider: string; version: number };
    expect(settings.model).toBe("openai/gpt-4o-mini");
    expect(settings.provider).toBe("lab");
    // Widened field, unchanged schema — the version bump is what would silently reset every other
    // setting on an older binary, so it must stay at 2.
    expect(settings.version).toBe(2);
    expect(currentState.modelSettings?.model).toBe("openai/gpt-4o-mini");
  });

  it("an empty id cancels instead of applying", async () => {
    start(["lab"]);
    await press([CUSTOM, ...type("   "), ENTER]);
    expect(saveDiskModelMock).not.toHaveBeenCalled();
    expect(currentState.modelCustomMode).toBe("none");
  });
});

describe("ModelModal — free-text entry with TWO OR MORE gateways", () => {
  it("does NOT pick one silently — it asks", async () => {
    start(["lab", "corp"]);
    await press([CUSTOM, ...type("openai/gpt-4o-mini"), ENTER]);
    expect(saveDiskModelMock).not.toHaveBeenCalled();
    expect(currentState.modelCustomMode).toBe("pick-gateway");
  });

  it("says so in the field beforehand too", async () => {
    start(["lab", "corp"]);
    const frame = await press([CUSTOM, ...type("openai/gpt-4o-mini")]);
    expect(frame).toMatch(/2 gateways configured/);
    expect(frame).not.toMatch(/→ via/);
  });

  it("lists every gateway and routes through the one chosen", async () => {
    start(["lab", "corp"]);
    const frame = await press([CUSTOM, ...type("m1"), ENTER]);
    expect(frame).toMatch(/which gateway/i);
    expect(frame).toMatch(/lab/);
    expect(frame).toMatch(/corp/);

    start(["lab", "corp"]);
    await press([CUSTOM, ...type("m1"), ENTER, { key: { downArrow: true } }, ENTER]);
    const settings = saveDiskModelMock.mock.calls[0]![1] as { provider: string; model: string };
    // The SECOND one, reached by navigating — proof the choice is the user's and not index 0
    // returned by default.
    expect(settings.provider).toBe("corp");
    expect(settings.model).toBe("m1");
  });

  it("Esc from the picker abandons without writing", async () => {
    start(["lab", "corp"]);
    await press([CUSTOM, ...type("m1"), ENTER, { key: { escape: true } }]);
    expect(saveDiskModelMock).not.toHaveBeenCalled();
    expect(currentState.modelCustomMode).toBe("none");
  });
});
