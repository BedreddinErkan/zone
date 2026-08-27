import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ApiKeysView } from "./ApiKeysView.js";
import { reducer, buildInitialState } from "../store-core.js";
import type { StoreState, StoreAction } from "../store-core.js";

/**
 * `/keys` had NO behavioural test of any kind before this file — no component test, and no reducer
 * test for a single `KEYS_*` action. That absence was a licence to change the view freely and also
 * the reason nothing would have caught a regression in it, so the gateway flow arrives with pins
 * rather than relying on the gap it was written into.
 */

const setDiskKeyMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadDiskKeysMock = vi.hoisted(() => vi.fn(async () => ({ version: 1, keys: [] })));

vi.mock("../../../api/diskKeys.js", () => ({
  setDiskKey: setDiskKeyMock,
  loadDiskKeys: loadDiskKeysMock,
  removeDiskKey: vi.fn(async () => undefined),
  maskKey: (k: string) => `${k.slice(0, 3)}***`,
}));

let currentState: StoreState;
const dispatchSpy = vi.fn((a: StoreAction) => { currentState = reducer(currentState, a); });

vi.mock("../store.js", () => ({
  useStore: () => ({ state: currentState, dispatch: dispatchSpy }),
}));

beforeEach(() => {
  currentState = buildInitialState();
  setDiskKeyMock.mockClear();
  dispatchSpy.mockClear();
});

const flush = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the REAL reducer through the view's own key handler, one keypress at a time.
 *
 * Each call starts from a fresh state, so a sequence is self-contained: two `press` calls in one
 * test would otherwise chain, and the second one's `n`/`g` land in the first one's text buffer.
 * The await between writes is what lets Ink's input parser deliver a lone Esc.
 */
async function press(keys: Array<{ input?: string; key?: Record<string, boolean> }>): Promise<string> {
  currentState = buildInitialState();
  let frame = "";
  const { stdin, lastFrame, rerender } = render(React.createElement(ApiKeysView));
  for (const k of keys) {
    if (k.key?.escape) stdin.write("\x1B");
    else if (k.key?.return) stdin.write("\r");
    else if (k.key?.backspace) stdin.write("\x7F");
    else if (k.input) stdin.write(k.input);
    // A lone Esc needs longer than the other keys: `usePaste` is active in this view, and a
    // bracketed paste also begins with \x1B, so the parser holds the byte back until enough time
    // has passed to rule that out. At a 1ms flush the Esc had not been delivered yet and the mode
    // assertion read the pre-Esc state.
    await flush(k.key?.escape ? 60 : 1);
    rerender(React.createElement(ApiKeysView));
    frame = lastFrame() ?? "";
  }
  return frame;
}

const type = (s: string) => [...s].map((ch) => ({ input: ch }));
const ENTER = { key: { return: true } };

describe("ApiKeysView — harness floor", () => {
  it("renders the empty list, proving the mocked store actually drives the view", async () => {
    // A frame that only ever showed chrome would satisfy every absence check below for the wrong
    // reason. This asserts one string only a working store->view path can produce.
    const { lastFrame } = render(React.createElement(ApiKeysView));
    expect(lastFrame()).toMatch(/No keys\. N to add one\./);
  });
});

describe("ApiKeysView — the vendor flow is unchanged", () => {
  it("[A] goes straight to the key field in one hop, with no gateway steps", async () => {
    await press([{ input: "n" }, { input: "a" }]);
    expect(currentState.keysEditMode).toBe("input");
    expect(currentState.keysEditProvider).toBe("anthropic");
    expect(currentState.keysDraftBaseUrl).toBe("");
  });

  it("[O] saves with NO extras argument — a vendor row keeps its original three fields", async () => {
    await press([{ input: "n" }, { input: "o" }, ...type("sk-openai-123"), ENTER]);
    expect(setDiskKeyMock).toHaveBeenCalledWith("openai", "sk-openai-123", undefined);
  });
});

describe("ApiKeysView — the gateway flow", () => {
  it("offers [G] alongside the two vendors", async () => {
    const frame = await press([{ input: "n" }]);
    expect(frame).toMatch(/\[A\]nthropic/);
    expect(frame).toMatch(/\[O\]penAI/);
    expect(frame).toMatch(/\[G\]ateway/);
  });

  it("walks profile id -> base URL -> key, and saves all three together", async () => {
    await press([
      { input: "n" }, { input: "g" },
      ...type("lab"), ENTER,
      ...type("http://localhost:4000/v1"), ENTER,
      ...type("sk-lab-key"), ENTER,
    ]);
    expect(setDiskKeyMock).toHaveBeenCalledWith("lab", "sk-lab-key", {
      baseUrl: "http://localhost:4000/v1",
    });
  });

  it("advances one step at a time — the id step does not accept a URL as its own value", async () => {
    await press([{ input: "n" }, { input: "g" }, ...type("lab")]);
    expect(currentState.keysEditMode).toBe("input-profile-id");
    await press([{ input: "n" }, { input: "g" }, ...type("lab"), ENTER]);
    expect(currentState.keysEditMode).toBe("input-base-url");
    expect(currentState.keysDraftProfileId).toBe("lab");
  });

  it("refuses a blank id and a blank URL, staying on the step instead of advancing", async () => {
    await press([{ input: "n" }, { input: "g" }, ENTER]);
    expect(currentState.keysEditMode).toBe("input-profile-id");
    await press([{ input: "n" }, { input: "g" }, ...type("lab"), ENTER, ENTER]);
    expect(currentState.keysEditMode).toBe("input-base-url");
  });

  it("refuses an id that shadows a built-in, which could never resolve to the gateway", async () => {
    for (const shadow of ["anthropic", "openai"]) {
      await press([{ input: "n" }, { input: "g" }, ...type(shadow), ENTER]);
      expect(currentState.keysEditMode).toBe("input-profile-id");
      expect(currentState.keysDraftProfileId).toBe("");
    }
  });

  it("shows the id and URL in plaintext but masks only the key", async () => {
    const idFrame = await press([{ input: "n" }, { input: "g" }, ...type("lab")]);
    expect(idFrame).toMatch(/lab/);
    expect(idFrame).not.toMatch(/•/);
    const keyFrame = await press([
      { input: "n" }, { input: "g" },
      ...type("lab"), ENTER,
      ...type("http://x/v1"), ENTER,
      ...type("secret"),
    ]);
    expect(keyFrame).toMatch(/••••••/);
    expect(keyFrame).not.toMatch(/secret/);
  });

  it("Esc from a gateway step clears the whole draft, not just the visible buffer", async () => {
    await press([
      { input: "n" }, { input: "g" },
      ...type("lab"), ENTER,
      ...type("http://x/v1"), ENTER,
      { key: { escape: true } },
    ]);
    expect(currentState.keysEditMode).toBe("view");
    expect(currentState.keysDraftProfileId).toBe("");
    expect(currentState.keysDraftBaseUrl).toBe("");
    // Otherwise the next vendor key added in the same session would be written as a gateway row
    // pointing at the abandoned URL.
    expect(currentState.keysEditProvider).toBeNull();
  });
});

describe("ApiKeysView — the list", () => {
  it("marks a gateway row with its endpoint, and leaves a vendor row unmarked", async () => {
    currentState = reducer(buildInitialState(), {
      type: "KEYS_OPEN",
      list: [
        { provider: "openai", key: "sk-vendor", addedAt: "2026-08-01T00:00:00.000Z" },
        { provider: "lab", key: "sk-lab", addedAt: "2026-08-02T00:00:00.000Z", baseUrl: "http://localhost:4000/v1" },
      ],
    });
    const { lastFrame } = render(React.createElement(ApiKeysView));
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/lab .*→ http:\/\/localhost:4000\/v1/);
    expect(frame).toMatch(/openai/);
    const vendorLine = frame.split("\n").find((l) => l.includes("openai"))!;
    expect(vendorLine).not.toMatch(/→/);
  });
});
