import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { StoreProvider } from "../store.js";
import { StatusBar } from "./StatusBar.js";
import type { DiskModelSettings } from "../../../api/diskModel.js";

function renderStatusBar(modelSettings: DiskModelSettings | null) {
  return render(
    <StoreProvider initialValues={{ model: "test-model", capUsd: 10, modelSettings }}>
      <StatusBar />
    </StoreProvider>
  );
}

describe("StatusBar — effort badge", () => {
  it("shows effort when modelSettings.effort is set", () => {
    const { lastFrame, unmount } = renderStatusBar({
      version: 2,
      model: "test-model",
      provider: "anthropic",
      effort: "high",
      updatedAt: new Date().toISOString(),
    });
    expect(lastFrame()).toContain("effort: high");
    unmount();
  });

  it("omits the effort segment when modelSettings.effort is not set (model doesn't support it)", () => {
    const { lastFrame, unmount } = renderStatusBar({
      version: 2,
      model: "test-model",
      provider: "anthropic",
      updatedAt: new Date().toISOString(),
    });
    expect(lastFrame()).not.toContain("effort:");
    unmount();
  });

  it("omits the effort segment when modelSettings itself is null", () => {
    const { lastFrame, unmount } = renderStatusBar(null);
    expect(lastFrame()).not.toContain("effort:");
    unmount();
  });
});
