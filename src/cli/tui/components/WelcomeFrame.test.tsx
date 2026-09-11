import { describe, it, expect, vi, afterEach } from "vitest";
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
};

function renderWithBoot(boot: BootData): string {
  const { lastFrame, unmount } = render(
    <StoreProvider initialValues={{ model: "test-model", capUsd: 10, initialBoot: boot }}>
      <Transcript />
    </StoreProvider>
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("WelcomeFrame", () => {
  it("renders logo, personalized line, and thin rule", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("█▀▀▀▀█");
    expect(frame).toContain("zone");
    expect(frame).toContain("v2.3.0");
    expect(frame).toContain("welcome back Ada Lovelace");
    expect(frame).toContain("zone");
    expect(frame).toContain("main");
    expect(frame).toContain("─");
  });

  it("renders all 4 logo rows", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).toContain("█▀▀▀▀█");
    expect(frame).toContain("█  ▄▀█");
    expect(frame).toContain("█▄▀  █");
    expect(frame).toContain("█▄▄▄▄█");
  });

  it("does NOT render a context line (model/provider/cap/keySource)", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).not.toContain("byok");
    expect(frame).not.toContain("gateway");
    expect(frame).not.toContain("anthropic");
    expect(frame).not.toContain("cap $");
  });

  it("does NOT render whatsNew bullets", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).not.toContain("MCP servers");
    expect(frame).not.toContain("Destructive");
  });

  it("does NOT render interaction hints (those live in Composer chrome)", () => {
    const frame = renderWithBoot(FULL_BOOT);
    expect(frame).not.toContain("shift+tab");
    expect(frame).not.toContain("/help");
  });

  it("thin rule is the last line of the frame (no content after it)", () => {
    const frame = renderWithBoot(FULL_BOOT);
    const lines = frame.split("\n").filter((l) => l.trim());
    const ruleIdx = lines.findIndex((l) => l.includes("─") && l.length > 10);
    // Rule must exist
    expect(ruleIdx).toBeGreaterThan(-1);
    // Nothing meaningful after the rule within the WelcomeFrame
    // (transcript content comes after, but the frame itself ends at the rule)
    const welcomeLines = lines.slice(0, ruleIdx + 1);
    expect(welcomeLines[welcomeLines.length - 1]).toContain("─");
  });

  it("shows (resumed) marker when isResumed is true", () => {
    const boot: BootData = { ...FULL_BOOT, isResumed: true };
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
});

describe("WelcomeFrame — fallbacks", () => {
  it("fallback user 'operator' renders correctly", () => {
    const boot: BootData = { ...FULL_BOOT, user: "operator" };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("welcome back operator");
  });

  it("fallback branch '-' when branch is empty", () => {
    const boot: BootData = { ...FULL_BOOT, branch: "-" };
    const frame = renderWithBoot(boot);
    expect(frame).toContain("· -");
  });
});

describe("Identity chain — _resolveUser", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  // Import the function dynamically to get the exported test seam
  async function resolveUser(): Promise<string> {
    const mod = await import("../index.js");
    return mod._resolveUser();
  }

  it("ZONE_USER env var wins over everything", async () => {
    process.env.ZONE_USER = "env-user";
    expect(await resolveUser()).toBe("env-user");
  });

  it("ZONE_USER is trimmed", async () => {
    process.env.ZONE_USER = "  trimmed-user  ";
    expect(await resolveUser()).toBe("trimmed-user");
  });

  it("empty ZONE_USER falls through to git config", async () => {
    delete process.env.ZONE_USER;
    // git config is available on this system — the result should be non-empty
    const user = await resolveUser();
    expect(user).not.toBe("");
    expect(user).not.toBe("operator");
  });

  it("all steps failing yields 'operator'", async () => {
    delete process.env.ZONE_USER;
    // Break git by clearing PATH — execFileSync("git", ...) will throw ENOENT
    const origPath = process.env.PATH;
    process.env.PATH = "";
    // Mock os.userInfo to throw (simulates os failure)
    const osMod = await import("node:os");
    const origUserInfo = osMod.default.userInfo;
    vi.spyOn(osMod.default, "userInfo").mockImplementation(() => {
      throw new Error("os failure");
    });
    try {
      expect(await resolveUser()).toBe("operator");
    } finally {
      process.env.PATH = origPath;
      vi.restoreAllMocks();
    }
  });

  it("git failure falls through to os.userInfo()", async () => {
    delete process.env.ZONE_USER;
    // Break git by clearing PATH — execFileSync("git", ...) will throw ENOENT
    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      // os.userInfo() should succeed and return the real OS username
      const user = await resolveUser();
      expect(user).not.toBe("operator");
      expect(user).not.toBe("");
    } finally {
      process.env.PATH = origPath;
    }
  });
});
