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

  it("the post-save pricing prompt survives the refresh, instead of being reset back to view", async () => {
    // Regression guard: refresh() used to fire bare (not awaited), so its own KEYS_OPEN dispatch
    // landed AFTER KEYS_PRICE_START and silently reset keysEditMode back to "view" on every new
    // gateway. This fails under that bug (reads "view") and passes once refresh() is chained.
    await press([
      { input: "n" }, { input: "g" },
      ...type("lab"), ENTER,
      ...type("http://localhost:4000/v1"), ENTER,
      ...type("sk-lab-key"), ENTER,
    ]);
    expect(currentState.keysEditMode).toBe("price-model-id");
    expect(currentState.keysPriceProvider).toBe("lab");
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

describe("ApiKeysView — the optional pricing sub-flow (item 399)", () => {
  const GATEWAY_ROW = {
    provider: "lab", key: "sk-lab", addedAt: "2026-08-02T00:00:00.000Z",
    baseUrl: "http://localhost:4000/v1",
  };

  function openWith(rows: unknown[]): void {
    currentState = reducer(buildInitialState(), { type: "KEYS_OPEN", list: rows as never });
  }

  /** Drive keys WITHOUT resetting state, so a pre-seeded list survives. */
  async function pressFrom(keys: Array<{ input?: string; key?: Record<string, boolean> }>): Promise<string> {
    let frame = "";
    const { stdin, lastFrame, rerender } = render(React.createElement(ApiKeysView));
    for (const k of keys) {
      if (k.key?.escape) stdin.write("\x1B");
      else if (k.key?.return) stdin.write("\r");
      else if (k.key?.backspace) stdin.write("\x7F");
      else if (k.input) stdin.write(k.input);
      await flush(k.key?.escape ? 60 : 1);
      rerender(React.createElement(ApiKeysView));
      frame = lastFrame() ?? "";
    }
    return frame;
  }

  it("P on a gateway row opens pricing; P on a vendor row does nothing", async () => {
    openWith([GATEWAY_ROW]);
    await pressFrom([{ input: "p" }]);
    expect(currentState.keysEditMode).toBe("price-model-id");
    expect(currentState.keysPriceProvider).toBe("lab");

    openWith([{ provider: "openai", key: "sk-v", addedAt: "2026-08-01T00:00:00.000Z" }]);
    await pressFrom([{ input: "p" }]);
    expect(currentState.keysEditMode).toBe("view");
  });

  it("walks model id -> input -> output -> cache, and saves the declared rates", async () => {
    openWith([GATEWAY_ROW]);
    await pressFrom([
      { input: "p" },
      ...type("openai/gpt-4o-mini"), ENTER,
      ...type("0.15"), ENTER,
      ...type("0.6"), ENTER,
      ...type("0.075"), ENTER,
      ...type("0.3"), ENTER,
    ]);
    expect(setDiskKeyMock).toHaveBeenCalledWith("lab", "sk-lab", {
      baseUrl: "http://localhost:4000/v1",
      pricing: { "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0.3 } },
    });
  });

  it("skipping the cache prompts OMITS those keys rather than writing zeros", async () => {
    openWith([GATEWAY_ROW]);
    await pressFrom([
      { input: "p" },
      ...type("m"), ENTER,
      ...type("1"), ENTER,
      ...type("2"), ENTER,
      ENTER, ENTER,
    ]);
    const extras = setDiskKeyMock.mock.calls[0]![2] as { pricing: Record<string, object> };
    // Absence is the record that the user never declared them — a written 0 could not say that.
    expect(extras.pricing["m"]).toEqual({ input: 1, output: 2 });
  });

  it("merges with the row's existing prices instead of replacing them", async () => {
    openWith([{ ...GATEWAY_ROW, pricing: { "already-priced": { input: 9, output: 9 } } }]);
    await pressFrom([
      { input: "p" },
      ...type("second-model"), ENTER,
      ...type("1"), ENTER,
      ...type("2"), ENTER,
      ENTER, ENTER,
    ]);
    const extras = setDiskKeyMock.mock.calls[0]![2] as { pricing: Record<string, object> };
    expect(Object.keys(extras.pricing).sort()).toEqual(["already-priced", "second-model"]);
  });

  it("rejects a non-numeric rate rather than storing NaN", async () => {
    openWith([GATEWAY_ROW]);
    await pressFrom([
      { input: "p" },
      ...type("m"), ENTER,
      ...type("abc"), ENTER,
    ]);
    // Number("abc") is NaN; storing it would poison every cost this profile ever reports.
    expect(currentState.keysEditMode).toBe("price-input");
    expect(setDiskKeyMock).not.toHaveBeenCalled();
  });

  it("Esc mid-pricing writes nothing and clears the draft", async () => {
    openWith([GATEWAY_ROW]);
    await pressFrom([
      { input: "p" },
      ...type("m"), ENTER,
      ...type("1"), ENTER,
      { key: { escape: true } },
    ]);
    expect(setDiskKeyMock).not.toHaveBeenCalled();
    expect(currentState.keysEditMode).toBe("view");
    expect(currentState.keysPriceModelId).toBe("");
    expect(currentState.keysPriceDraft).toEqual({});
  });

  it("the list says whether a gateway is unpriced, and whether a zero was skipped", async () => {
    openWith([
      GATEWAY_ROW,
      { ...GATEWAY_ROW, provider: "lab2", pricing: { m: { input: 1, output: 2 } } },
      { ...GATEWAY_ROW, provider: "lab3", pricing: { m: { input: 1, output: 2, cache_read: 0, cache_write: 0 } } },
    ]);
    const { lastFrame } = render(React.createElement(ApiKeysView));
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/unpriced/);
    expect(frame).toMatch(/cache buckets SKIPPED/);
    expect(frame).toMatch(/all buckets declared/);
  });
});
