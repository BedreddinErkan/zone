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
    expect(frame).toContain("main");
    expect(frame).toContain("byok");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("claude-sonnet-4-6");
    expect(frame).toContain("cap $30");
  });

  it("renders the 6x4 half-block logo", () => {
    const frame = renderWithBoot(FULL_BOOT);
    // Each logo row uses half-block characters
    expect(frame).toContain("█▀▀▀▀█");
    expect(frame).toContain("█  ▄▀█");
    expect(frame).toContain("█▄▀  █");
    expect(frame).toContain("█▄▄▄▄█");
  });

  it("does NOT render interaction hints (those live in Composer chrome)", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).not.toContain("shift+tab");
    expect(frame).not.toContain("/help commands");
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

  it("strips markdown emphasis (** and `) from whatsNew lines", () => {
    const boot = { ...FULL_BOOT, whatsNew: [
      "- Added **bold feature** with `code_ref` support",
    ]};
    const frame = renderWithBoot(boot);
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`");
    expect(frame).toContain("Added bold feature with code_ref support");
  });

  it("truncates long whatsNew lines to width-8 with ellipsis", () => {
    const longLine = "- " + "x".repeat(200);
    const boot = { ...FULL_BOOT, whatsNew: [longLine] };
    const frame = renderWithBoot(boot);
    // Must contain ellipsis character
    expect(frame).toContain("\u2026");
    // Must not contain the full 200-char string
    expect(frame).not.toContain("x".repeat(200));
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

  it("shows (resumed) marker when isResumed is true", () => {
    const boot = { ...FULL_BOOT, isResumed: true };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("(resumed)");
  });

  it("no (resumed) marker for fresh sessions", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).not.toContain("(resumed)");
  });

  it("renders without boot data (no WelcomeFrame shown)", () => {
    const { lastFrame, unmount } = render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <Transcript />
      </StoreProvider>
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("welcome back");
    expect(frame).not.toContain("█▀▀▀▀█");
    unmount();
  });

  it("renders separator rule", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("─");
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
