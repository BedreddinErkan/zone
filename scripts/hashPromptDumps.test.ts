import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDumps, groupByHash, report } from "./hashPromptDumps.js";

const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_CAPTURES = path.join(REPO_ROOT, ".zone/audits/notice-regression-arm");

function writeDump(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

describe("loadDumps / groupByHash — the pooling partition, not just per-file hashes", () => {
  it("two byte-identical dumps land in one group", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice-armB-T7-100.txt", "SAME PROMPT");
    writeDump(dir, "system-prompt-with-notice-armB-T7-200.txt", "SAME PROMPT");
    const groups = groupByHash(loadDumps(dir));
    expect(groups.length).toBe(1);
    expect(groups[0]!.runTags).toEqual(["armB-T7-100", "armB-T7-200"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a one-byte difference splits into two groups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice-armB-T7-100.txt", "PROMPT A");
    writeDump(dir, "system-prompt-with-notice-armB-T7-200.txt", "PROMPT B");
    const groups = groupByHash(loadDumps(dir));
    expect(groups.length).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores files outside the with-notice naming shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice-armB-T7-100.txt", "X");
    writeDump(dir, "system-prompt-no-notice-armB-T7-100.txt", "should not be counted");
    writeDump(dir, "armB-T7-100.json", "should not be counted");
    expect(loadDumps(dir).length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an untagged single-file dump is reported, not dropped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice.txt", "single-task convenience dump");
    const dumps = loadDumps(dir);
    expect(dumps.length).toBe(1);
    expect(dumps[0]!.runTag).toBe("(untagged)");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("report — names groups, not just a count, so a bare number is never unattributed", () => {
  it("a single-group directory says so explicitly and carries no pooling warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice-armB-T1-1.txt", "P");
    writeDump(dir, "system-prompt-with-notice-armB-T2-2.txt", "P");
    const text = report(dir);
    expect(text).toContain("1 distinct prompt");
    expect(text).not.toContain("may NOT be pooled");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a two-group directory names the pooling consequence and lists both groups' run tags", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashdumps-"));
    writeDump(dir, "system-prompt-with-notice-pre-1.txt", "PRE");
    writeDump(dir, "system-prompt-with-notice-post-2.txt", "POST");
    const text = report(dir);
    expect(text).toContain("2 distinct prompts");
    expect(text).toContain("may NOT be pooled");
    expect(text).toContain("pre-1");
    expect(text).toContain("post-2");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("against the real captures — reproduces item 157's own hand-run sha256sum check", () => {
  const exists = fs.existsSync(REAL_CAPTURES);

  it.runIf(exists)("the T7 with-notice dumps split into exactly two groups: 4 pre-fix, 3 post-fix", () => {
    const dumps = loadDumps(REAL_CAPTURES).filter((d) => d.runTag.includes("T7"));
    const groups = groupByHash(dumps);
    expect(groups.length).toBe(2);
    const sizes = groups.map((g) => g.runTags.length).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 4]);
  });

  it.runIf(exists)("the post-fix group's hash matches item 157's own recorded prefix", () => {
    const dumps = loadDumps(REAL_CAPTURES).filter((d) => d.runTag.includes("T7"));
    const groups = groupByHash(dumps);
    const postFix = groups.find((g) => g.runTags.length === 3);
    // Recorded in docs/deferred-work.md item 157/251 as 14c3e5b3e3ea9f60...
    expect(postFix!.hash.startsWith("14c3e5b3e3ea9f60")).toBe(true);
  });
});
