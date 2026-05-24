import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendMemory,
  deleteMemoryEntry,
  formatMemoryForPrompt,
  MEMORY_MAX_ENTRIES,
  readMemory,
  type MemoryEntry,
} from "../projectMemory.js";

const INIT_BLOCK = "<!-- ZONE_INIT_BEGIN -->\n## Project\nZone.\n<!-- ZONE_INIT_END -->";

let tempRepo: string;

beforeEach(() => {
  tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "zone-memory-test-"));
});

afterEach(() => {
  fs.rmSync(tempRepo, { recursive: true, force: true });
});

describe("readMemory", () => {
  it("returns [] when the file does not exist", async () => {
    const entries = await readMemory(tempRepo);
    expect(entries).toEqual([]);
  });

  it("returns [] for a file with only the header", async () => {
    const dir = path.join(tempRepo, ".zone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "memory.md"),
      "# Zone Project Memory\n\n<!-- comment -->\n"
    );
    const entries = await readMemory(tempRepo);
    expect(entries).toEqual([]);
  });

  it("parses bullet entries and ignores other lines", async () => {
    const dir = path.join(tempRepo, ".zone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "memory.md"),
      [
        "# Zone Project Memory",
        "",
        "- [2026-05-07] Use shadcn/ui",
        "stray text",
        "- [2026-05-06] Tests live in __tests__/",
      ].join("\n")
    );
    const entries = await readMemory(tempRepo);
    expect(entries.map((e) => e.text)).toEqual([
      "Use shadcn/ui",
      "Tests live in __tests__/",
    ]);
    expect(entries[0]!.date).toBe("2026-05-07");
  });
});

describe("appendMemory", () => {
  it("creates .zone/memory.md with header on first append", async () => {
    await appendMemory(tempRepo, "First entry");
    const filePath = path.join(tempRepo, ".zone", "memory.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("# Zone Project Memory");
    expect(raw).toContain("Auto-managed by Zone");
    expect(raw).toMatch(/- \[\d{4}-\d{2}-\d{2}\] First entry/);
  });

  it("FIFO-evicts oldest entries past the cap", async () => {
    for (let i = 0; i < MEMORY_MAX_ENTRIES + 5; i++) {
      await appendMemory(tempRepo, `entry ${i}`);
    }
    const entries = await readMemory(tempRepo);
    expect(entries).toHaveLength(MEMORY_MAX_ENTRIES);
    // First five (entry 0..4) should be evicted.
    expect(entries[0]!.text).toBe("entry 5");
    expect(entries[entries.length - 1]!.text).toBe(
      `entry ${MEMORY_MAX_ENTRIES + 4}`
    );
  });

  it("rejects empty entries", async () => {
    await expect(appendMemory(tempRepo, "   ")).rejects.toThrow();
  });
});

describe("deleteMemoryEntry", () => {
  it("removes the entry at the given index and leaves others intact", async () => {
    await appendMemory(tempRepo, "alpha");
    await appendMemory(tempRepo, "beta");
    await appendMemory(tempRepo, "gamma");

    const ok = await deleteMemoryEntry(tempRepo, 1);
    expect(ok).toBe(true);

    const remaining = await readMemory(tempRepo);
    expect(remaining.map((e) => e.text)).toEqual(["alpha", "gamma"]);
  });

  it("returns false for out-of-range index", async () => {
    await appendMemory(tempRepo, "only");
    const ok = await deleteMemoryEntry(tempRepo, 5);
    expect(ok).toBe(false);
    const remaining = await readMemory(tempRepo);
    expect(remaining.map((e) => e.text)).toEqual(["only"]);
  });
});

describe("appendMemory preserves ZONE_INIT block", () => {
  it("preserves ZONE_INIT block written by /init across appendMemory rewrites", async () => {
    const dir = path.join(tempRepo, ".zone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.md"), INIT_BLOCK + "\n", "utf-8");

    await appendMemory(tempRepo, "first lesson learned");

    const raw = fs.readFileSync(path.join(dir, "memory.md"), "utf-8");
    expect(raw).toContain("<!-- ZONE_INIT_BEGIN -->");
    expect(raw).toContain("## Project");
    expect(raw).toContain("<!-- ZONE_INIT_END -->");
    expect(raw).toContain("- [");
    expect(raw).toContain("first lesson learned");
  });
});

describe("formatMemoryForPrompt", () => {
  it("returns empty string for no entries", () => {
    expect(formatMemoryForPrompt([])).toBe("");
  });

  it("renders a markdown block with the entries", () => {
    const entries: MemoryEntry[] = [
      { date: "2026-05-07", text: "Use shadcn/ui", raw: "- [2026-05-07] Use shadcn/ui" },
      { date: "2026-05-06", text: "Tests live in __tests__/", raw: "- [2026-05-06] Tests live in __tests__/" },
    ];
    const out = formatMemoryForPrompt(entries);
    expect(out).toContain("## Project Memory");
    expect(out).toContain("- Use shadcn/ui");
    expect(out).toContain("- Tests live in __tests__/");
    // No date prefix in the prompt — we only need the convention text.
    expect(out).not.toContain("[2026-");
  });
});
