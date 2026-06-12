import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanRepo } from "./scanRepo.js";

describe("scanRepo — suppressErrors", () => {
  it("returns readable files without throwing when a subdir is chmod-000", async () => {
    if (process.geteuid?.() === 0) return; // root bypasses 000 — skip to avoid vacuous pass

    const dir = mkdtempSync(join(tmpdir(), "zone-scan-test-"));
    const sub = join(dir, "locked");
    mkdirSync(sub);
    // Create a readable .ts file and a locked subdir
    writeFileSync(join(dir, "readable.ts"), "export const x = 1;\n");
    chmodSync(sub, 0o000);
    try {
      const files = await scanRepo(dir);
      // The readable .ts file must be present
      expect(files.some((f) => f.path === "readable.ts")).toBe(true);
      // Must NOT throw even though a subdir is unreadable
    } finally {
      chmodSync(sub, 0o755); // restore so rmSync can clean up
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
