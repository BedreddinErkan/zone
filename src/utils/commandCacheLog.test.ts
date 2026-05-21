import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  writeCacheLog,
  flushCommandCacheLogForTest,
  clearCommandCacheLogForTest,
} from "./commandCacheLog.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cache-log-"));
  clearCommandCacheLogForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function logFilePath(): string {
  return path.join(tmpDir, ".zone", "logs", `command-cache-${todayDate()}.jsonl`);
}

describe("writeCacheLog", () => {
  it("T.1: creates .zone/logs/ dir and writes a valid JSONL line for a cache-hit marker", async () => {
    const payload = { runId: "r1", command: "npm test", fingerprint: "abc123", prevDurationMs: 500, cumulativeHits: 1 };
    writeCacheLog(tmpDir, "[zone-command-cache-hit]", payload);
    await flushCommandCacheLogForTest();

    const raw = fs.readFileSync(logFilePath(), "utf8").trim();
    const parsed = JSON.parse(raw);
    expect(parsed.marker).toBe("[zone-command-cache-hit]");
    expect(parsed.payload).toEqual(payload);
    expect(typeof parsed.timestamp).toBe("string");
    expect(new Date(parsed.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("T.2: appends separate lines for hit and miss markers in the same file", async () => {
    writeCacheLog(tmpDir, "[zone-command-cache-hit]", { runId: "r2", command: "npm test", fingerprint: "f1", prevDurationMs: 300, cumulativeHits: 1 });
    writeCacheLog(tmpDir, "[zone-command-cache-miss]", { runId: "r2", command: "npm run build", fingerprint: "f2", durationMs: 4200, cumulativeMisses: 1 });
    await flushCommandCacheLogForTest();

    const lines = fs.readFileSync(logFilePath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).marker).toBe("[zone-command-cache-hit]");
    expect(JSON.parse(lines[1]).marker).toBe("[zone-command-cache-miss]");
  });

  it("T.3: silently ignores unknown markers and writes nothing", async () => {
    writeCacheLog(tmpDir, "[zone-some-other-event]", { foo: "bar" });
    await flushCommandCacheLogForTest();

    expect(fs.existsSync(logFilePath())).toBe(false);
  });
});
