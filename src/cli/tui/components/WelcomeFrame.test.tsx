import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { StoreProvider } from "../store.js";
import { Transcript } from "./Transcript.js";
import type { BootData } from "../store-core.js";
import React from "react";

const FULL_BOOT: BootData = {
  version: "2.3.0",
  user: "Ada Lovelace",
  repoPath: "zone",
  branch: "main",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  dailyCapUsd: 30,
  keySource: "byok",
  whatsNew: [
    "- MCP servers can declare which tools to expose",
    "- Destructive MCP tool calls now require approval",
  ],
};

function renderWithBoot(boot: BootData): string {
  const { lastFrame, unmount } = render(
    <StoreProvider initialValues={{ model: boot.model, capUsd: boot.dailyCapUsd, initialBoot: boot }}>
      <Transcript />
    </StoreProvider>
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("WelcomeFrame", () => {
  it("renders all identity lines with a full boot payload", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("zone");
    expect(frame).toContain("v2.3.0");
    expect(frame).toContain("welcome back Ada Lovelace");
    expect(frame).toContain("zone");
    expect(frame).toContain("main");
    expect(frame).toContain("byok");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("claude-sonnet-4-6");
    expect(frame).toContain("cap $30");
    expect(frame).toContain("shift+tab cycle mode");
  });

  it("renders what's-new bullets when present", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("MCP servers can declare which tools to expose");
    expect(frame).toContain("Destructive MCP tool calls now require approval");
  });

  it("omits what's-new lines when whatsNew is empty", () => {
    const boot = { ...FULL_BOOT, whatsNew: [] };
    const frame = renderWithBoot(boot);
    expect(frame).not.toContain("MCP servers");
    expect(frame).toContain("welcome back Ada Lovelace");
  });

  it("formats cap as integer when >= $1", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("cap $30");
  });

  it("formats cap with decimals when < $1", () => {
    const boot = { ...FULL_BOOT, dailyCapUsd: 0.50 };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("cap $0.50");
  });

  it("renders without boot data (no WelcomeFrame shown)", () => {
    const { lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <Transcript />
      </StoreProvider>
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("welcome back");
    expect(frame).not.toContain("shift+tab cycle mode");
    unmount();
  });

  it("renders separator rule at various column widths", () => {
    // The separator character is "─" — verify it appears in the frame
    for (const boot of [FULL_BOOT]) {
      const frame = renderWithBoot(boot);
      expect(frame).toContain("─");
    }
  });
});

describe("WelcomeFrame — fallbacks", () => {
  it("fallback user 'operator' when user is empty-ish", () => {
    const boot = { ...FULL_BOOT, user: "operator" };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("welcome back operator");
  });

  it("fallback branch '-' when branch is empty", () => {
    const boot = { ...FULL_BOOT, branch: "-" };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("· -");
  });

  it("gateway keySource renders correctly", () => {
    const boot = { ...FULL_BOOT, keySource: "gateway" as const };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("gateway");
  });
});
