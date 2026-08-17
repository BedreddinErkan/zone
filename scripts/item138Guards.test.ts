import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Item 138 — four scripts run their work at module scope, protected only by exporting
 * nothing. These tests import each one directly and assert nothing fires. Three of the four
 * read a real provider API key if their guard fails, and this machine has real keys
 * configured (~/.zone/keys.json) — so ANTHROPIC_API_KEY/OPENAI_API_KEY are explicitly cleared
 * for the duration, on top of vitest's own HOME redirection (zoneTestHome()), so a broken
 * guard can only ever throw "no API key found" here, never reach a network call.
 */

let savedAnthropicKey: string | undefined;
let savedOpenAiKey: string | undefined;

beforeAll(() => {
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
});

type Case = {
  file: string;
  readsApiKey: boolean;
};

const CASES: Case[] = [
  { file: "dedupe-cache-probe.mjs", readsApiKey: true },
  { file: "openai-cache-probe.mjs", readsApiKey: true },
  { file: "output-composition.mjs", readsApiKey: false },
  { file: "thinking-probe.mjs", readsApiKey: true },
];

describe("item 138 — importing a guarded script fires nothing", () => {
  for (const { file, readsApiKey } of CASES) {
    it(`${file}: import produces zero console output and no API-key error`, async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let thrown: unknown;
      try {
        // dedupe-cache-probe.mjs's own static imports point at dist/ modules deleted at
        // 1b64739a — that throw is pre-existing, unrelated to this guard, and tolerated here
        // by design: whatever happens, this test only cares whether THIS file's own guarded
        // logic ran, not whether its unrelated dist dependency still resolves.
        await import(path.join(__dirname, file));
      } catch (err) {
        thrown = err;
      }

      // A broken guard's main() runs as a fire-and-forget `.catch(...)` chain — the import()
      // above can resolve before that chain settles, so an assertion taken immediately can
      // pass even though the chain fires moments later (caught live: an inverted guard on
      // output-composition.mjs slipped past this exact assertion on the first draft of this
      // test, surfacing only as a vitest "unhandled rejection" warning instead of a failure
      // here). Give it a tick to settle before reading the spies.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Zero calls, not "no banner substring": under the isolated test HOME, main() can fail
      // before reaching its own banner line (readdirSync on a missing ~/.zone/sessions throws
      // uncaught, straight to the outer .catch's "Fatal:" line) — caught live, a banner-
      // substring check missed exactly this path even though main() had genuinely run. Any
      // output at all, of any shape, is the leak; a correctly guarded import produces none.
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      if (readsApiKey && thrown instanceof Error) {
        expect(thrown.message).not.toMatch(/API key/i);
      }
    });
  }
});

// ─── output-composition.mjs via subprocess — real invocation, the one script safe to run ──────

const OUTPUT_COMPOSITION_PATH = path.join(__dirname, "output-composition.mjs");

describe("output-composition.mjs — subprocess, direct invocation still works", () => {
  it("produces real, non-empty stdout when invoked directly (guards the 'guard never fires' mutation)", () => {
    // output-composition.mjs reads ~/.zone/sessions/*.json — a fake HOME with a minimal, valid
    // session fixture keeps this hermetic (portable to CI, not dependent on this machine's real
    // session history), the same reason checkBuildStaleness.test.ts builds its own fixture trees
    // rather than pointing at the real repo.
    const fakeHome = mkdtempSync(path.join(tmpdir(), "zone-item138-guard-"));
    try {
      const sessDir = path.join(fakeHome, ".zone", "sessions");
      mkdirSync(sessDir, { recursive: true });
      writeFileSync(
        path.join(sessDir, "fake-session.json"),
        JSON.stringify({
          model: "claude-sonnet-4-6",
          startedAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:05:00.000Z",
          transcript: [{ kind: "assistant_final", text: "done" }],
        }),
        "utf8"
      );

      const result = spawnSync(process.execPath, [OUTPUT_COMPOSITION_PATH], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("output-composition");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
