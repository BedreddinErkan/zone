/**
 * Loop detection must not fire on a red-green convergence cycle.
 *
 * The detector terminates at 4 identical hashes inside an 8-call window. Before
 * workspace state was part of call identity, `npm test` repeated after each fix
 * hashed identically every time, so test → fix → test → fix → test → fix → test
 * hit TERMINATE on the 4th test run — killing a run that was converging.
 */
import { describe, it, expect } from "vitest";
import {
  createDetectorState,
  recordAndDetect,
  hashToolCall,
  hashStagingState,
  TERMINATE_THRESHOLD,
  WARN_THRESHOLD,
} from "./loopDetector.js";

const TEST_CMD = { command: "npm test" };

describe("loop detector — workspace-aware call identity", () => {
  it("survives test → fix → test → fix → test → fix → test", () => {
    const state = createDetectorState();
    const staging = new Map<string, string>();
    const statuses: string[] = [];

    // Four `npm test` runs, each separated by a real edit to staged content.
    for (let round = 0; round < 4; round++) {
      statuses.push(
        recordAndDetect(state, hashToolCall("run_command", TEST_CMD, hashStagingState(staging))).status
      );
      // The fix: staged content changes before the next verification run.
      staging.set("/repo/src/token.ts", `export const isExpired = (t) => t.exp * 1000 < Date.now(); // v${round}`);
    }

    expect(statuses).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("still terminates when the same command repeats with no workspace change", () => {
    const state = createDetectorState();
    const staging = new Map<string, string>([["/repo/src/a.ts", "unchanged"]]);
    const statuses: string[] = [];

    for (let i = 0; i < TERMINATE_THRESHOLD; i++) {
      statuses.push(
        recordAndDetect(state, hashToolCall("run_command", TEST_CMD, hashStagingState(staging))).status
      );
    }

    expect(statuses[WARN_THRESHOLD - 1]).toBe("warn");
    expect(statuses[TERMINATE_THRESHOLD - 1]).toBe("terminate");
  });

  it("a pure read loop with no writes is still caught (staging never changes)", () => {
    const state = createDetectorState();
    const staging = new Map<string, string>();
    let last = "ok";
    for (let i = 0; i < TERMINATE_THRESHOLD; i++) {
      last = recordAndDetect(
        state,
        hashToolCall("read_file", { filePath: "src/index.ts" }, hashStagingState(staging))
      ).status;
    }
    expect(last).toBe("terminate");
  });

  it("reverting to previously staged content re-collides — thrash is not disguised as progress", () => {
    const state = createDetectorState();
    const staging = new Map<string, string>();
    const hashes: string[] = [];

    hashes.push(hashToolCall("run_command", TEST_CMD, hashStagingState(staging)));
    staging.set("/repo/src/a.ts", "attempt-1");
    hashes.push(hashToolCall("run_command", TEST_CMD, hashStagingState(staging)));
    staging.delete("/repo/src/a.ts"); // undo — workspace is byte-identical to the start
    hashes.push(hashToolCall("run_command", TEST_CMD, hashStagingState(staging)));

    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(recordAndDetect(state, hashes[0]).status).toBe("ok");
  });
});

describe("hashStagingState", () => {
  it("is insertion-order independent but content sensitive", () => {
    const a = new Map([["x", "1"], ["y", "2"]]);
    const b = new Map([["y", "2"], ["x", "1"]]);
    const c = new Map([["x", "1"], ["y", "3"]]);
    expect(hashStagingState(a)).toBe(hashStagingState(b));
    expect(hashStagingState(a)).not.toBe(hashStagingState(c));
  });

  it("undefined and empty staging agree", () => {
    expect(hashStagingState(undefined)).toBe(hashStagingState(new Map()));
  });
});

describe("hashToolCall", () => {
  it("omitting workspaceState reproduces the pre-workspace identity", () => {
    expect(hashToolCall("run_command", TEST_CMD)).toBe(`run_command:${JSON.stringify(TEST_CMD)}`);
  });

  it("same args + different workspace ⇒ different identity", () => {
    const empty = hashStagingState(new Map());
    const dirty = hashStagingState(new Map([["/repo/a.ts", "edited"]]));
    expect(hashToolCall("run_command", TEST_CMD, empty)).not.toBe(
      hashToolCall("run_command", TEST_CMD, dirty)
    );
  });
});
