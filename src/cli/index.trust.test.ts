import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { parseTrustFlag } from "./config.js";

function makeTrustAwareProgram(): Command {
  const p = new Command();
  p.exitOverride(); // throw CommanderError instead of process.exit on unknown options
  p.option("--trust", "Trust this project for this run");
  p.option("--no-trust", "Force-deny trust for this run"); // distinct dest → options.noTrust
  return p;
}

describe("Commander recognition — --trust/--no-trust must not be unknown options", () => {
  it("--trust is recognized without unknown-option error", () => {
    expect(() => makeTrustAwareProgram().parse(["--trust"], { from: "user" })).not.toThrow();
  });

  it("--no-trust is recognized without unknown-option error", () => {
    expect(() => makeTrustAwareProgram().parse(["--no-trust"], { from: "user" })).not.toThrow();
  });
});

describe("parseTrustFlag — three-state argv parsing", () => {
  it("NEITHER flag → undefined (gate is not bypassed by default)", () => {
    expect(parseTrustFlag(["node", "zone", "fix bug"])).toBeUndefined();
    expect(parseTrustFlag(["node", "zone"])).toBeUndefined();
    expect(parseTrustFlag([])).toBeUndefined();
  });

  it("--trust → true", () => {
    expect(parseTrustFlag(["node", "zone", "--trust"])).toBe(true);
    expect(parseTrustFlag(["node", "zone", "--trust", "fix bug"])).toBe(true);
  });

  it("--no-trust → false", () => {
    expect(parseTrustFlag(["node", "zone", "--no-trust"])).toBe(false);
    expect(parseTrustFlag(["node", "zone", "--no-trust", "fix bug"])).toBe(false);
  });

  it("both --trust and --no-trust → false (--no-trust wins)", () => {
    expect(parseTrustFlag(["node", "zone", "--trust", "--no-trust"])).toBe(false);
    expect(parseTrustFlag(["node", "zone", "--no-trust", "--trust"])).toBe(false);
  });

  it("unrelated flags do not influence trust", () => {
    expect(parseTrustFlag(["node", "zone", "--verbose", "--quiet"])).toBeUndefined();
    expect(parseTrustFlag(["node", "zone", "--yes", "--no-revision"])).toBeUndefined();
  });
});
