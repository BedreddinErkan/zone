import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ModelModal } from "./ModelModal.js";
import type { StoreAction } from "../store.js";

vi.mock("../store.js", () => ({
  useStore: () => ({
    state: { modelSelectedIndex: 0, modelSettings: { model: "claude-sonnet-4-6" } },
  }),
}));
vi.mock("../../../api/diskModel.js", () => ({ saveDiskModel: vi.fn() }));

const mockDispatch = vi.fn() as unknown as React.Dispatch<StoreAction>;

function renderAt(cols: number) {
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  return render(React.createElement(ModelModal, { dispatch: mockDispatch }));
}

describe("ModelModal — retention disclosure", () => {
  beforeEach(() => { vi.mocked(mockDispatch).mockReset?.(); });

  it("Sonnet 4.6 — no retention badge in narrow mode", () => {
    const { lastFrame } = renderAt(50);
    const frame = lastFrame() ?? "";
    const sonnetLines = frame.split("\n").filter(l => l.includes("sonnet"));
    expect(sonnetLines.every(l => !l.includes("retention"))).toBe(true);
  });
});
