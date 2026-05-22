import { describe, it, expect } from "vitest";
import {
  hashToolCall,
  createDetectorState,
  recordAndDetect,
  WINDOW_SIZE,
} from "./loopDetector.js";

describe("hashToolCall", () => {
  it("produces stable hashes regardless of key order", () => {
    const a = hashToolCall("read_file", { filePath: "a.ts", encoding: "utf8" });
    const b = hashToolCall("read_file", { encoding: "utf8", filePath: "a.ts" });
    expect(a).toBe(b);
  });

  it("handles nested objects and arrays deterministically", () => {
    const a = hashToolCall("apply_patch", {
      filePath: "a.ts",
      blocks: [{ start: 1, end: 5 }, { start: 10, end: 12 }],
      meta: { reason: "fix", flags: { dry: false, force: true } },
    });
    const b = hashToolCall("apply_patch", {
      meta: { flags: { force: true, dry: false }, reason: "fix" },
      blocks: [{ end: 5, start: 1 }, { end: 12, start: 10 }],
      filePath: "a.ts",
    });
    expect(a).toBe(b);
  });

  it("differs across tool names with identical args", () => {
    const a = hashToolCall("read_file", { filePath: "a.ts" });
    const b = hashToolCall("write_file", { filePath: "a.ts" });
    expect(a).not.toBe(b);
  });

  it("differs across args with the same tool", () => {
    const a = hashToolCall("read_file", { filePath: "a.ts" });
    const b = hashToolCall("read_file", { filePath: "b.ts" });
    expect(a).not.toBe(b);
  });

  it("handles null / undefined / primitive args", () => {
    expect(() => hashToolCall("noop", null)).not.toThrow();
    expect(() => hashToolCall("noop", undefined)).not.toThrow();
    expect(() => hashToolCall("noop", 42)).not.toThrow();
    // Same fallback for null and undefined ({}).
    expect(hashToolCall("noop", null)).toBe(hashToolCall("noop", undefined));
  });
});

describe("recordAndDetect", () => {
  it("returns ok for the first two identical calls, warn on the third", () => {
    const state = createDetectorState();
    const h = hashToolCall("read_file", { filePath: "a.ts" });
    expect(recordAndDetect(state, h)).toEqual({ status: "ok", count: 1 });
    expect(recordAndDetect(state, h)).toEqual({ status: "ok", count: 2 });
    expect(recordAndDetect(state, h)).toEqual({ status: "warn", count: 3 });
  });

  it("returns ok at count 4 (between warn and terminate, don't re-warn)", () => {
    const state = createDetectorState();
    const h = hashToolCall("read_file", { filePath: "a.ts" });
    for (let i = 0; i < 3; i += 1) recordAndDetect(state, h); // 1..3
    const fourth = recordAndDetect(state, h);
    expect(fourth).toEqual({ status: "ok", count: 4 });
  });

  it("returns terminate at the fifth identical call", () => {
    const state = createDetectorState();
    const h = hashToolCall("read_file", { filePath: "a.ts" });
    for (let i = 0; i < 4; i += 1) recordAndDetect(state, h);
    expect(recordAndDetect(state, h)).toEqual({ status: "terminate", count: 5 });
  });

  it("sliding window evicts entries beyond WINDOW_SIZE", () => {
    const state = createDetectorState();
    const target = hashToolCall("read_file", { filePath: "a.ts" });
    // Pad the window with unique hashes so target ages out.
    recordAndDetect(state, target);
    for (let i = 0; i < WINDOW_SIZE; i += 1) {
      recordAndDetect(state, hashToolCall("filler", { i }));
    }
    // The first `target` is now outside the window — next target should be count 1.
    const result = recordAndDetect(state, target);
    expect(result.count).toBe(1);
    expect(result.status).toBe("ok");
  });

  it("counts only occurrences within the active window, not across all history", () => {
    const state = createDetectorState();
    const target = hashToolCall("read_file", { filePath: "a.ts" });
    // 8 fillers push everything out.
    for (let i = 0; i < WINDOW_SIZE; i += 1) recordAndDetect(state, hashToolCall("f", { i }));
    expect(recordAndDetect(state, target).count).toBe(1);
  });

  it("mixed sequence A,A,B,A,A → 4th A is warn (count=3 in window)", () => {
    const state = createDetectorState();
    const A = hashToolCall("read_file", { filePath: "a.ts" });
    const B = hashToolCall("read_file", { filePath: "b.ts" });
    expect(recordAndDetect(state, A).status).toBe("ok"); // A=1
    expect(recordAndDetect(state, A).status).toBe("ok"); // A=2
    expect(recordAndDetect(state, B).status).toBe("ok"); // A=2, B=1
    expect(recordAndDetect(state, A).status).toBe("warn"); // A=3, B=1
    const last = recordAndDetect(state, A); // A=4
    expect(last.status).toBe("ok");
    expect(last.count).toBe(4);
  });

  it("createDetectorState returns a fresh, independent state", () => {
    const a = createDetectorState();
    const b = createDetectorState();
    const h = hashToolCall("read_file", { filePath: "a.ts" });
    recordAndDetect(a, h);
    recordAndDetect(a, h);
    recordAndDetect(a, h);
    // b is untouched.
    expect(b.window).toHaveLength(0);
    expect(recordAndDetect(b, h)).toEqual({ status: "ok", count: 1 });
  });

  it("different hashes never trigger warn/terminate", () => {
    const state = createDetectorState();
    for (let i = 0; i < WINDOW_SIZE * 2; i += 1) {
      const result = recordAndDetect(state, hashToolCall("unique", { i }));
      expect(result.status).toBe("ok");
      expect(result.count).toBe(1);
    }
  });

  it("emits terminate even after the warn signal — count rises past TERMINATE_THRESHOLD", () => {
    const state = createDetectorState();
    const h = hashToolCall("read_file", { filePath: "a.ts" });
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      seen.push(recordAndDetect(state, h).status);
    }
    expect(seen).toEqual(["ok", "ok", "warn", "ok", "terminate", "terminate"]);
  });
});
