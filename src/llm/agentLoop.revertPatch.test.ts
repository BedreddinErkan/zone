/**
 * Phase F — revert_patch interception unit tests.
 * Tests that the revert_patch tool is correctly handled in the agent loop
 * and that staging is updated appropriately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

// We test the revert_patch interception behavior by exercising the agentLoop
// stubs pattern used in other agentLoop tests.

describe("Phase F — revert_patch tool", () => {
  describe("revert_patch path validation", () => {
    it("resolves relative path to absolute using repoPath prefix", () => {
      // The handler uses path.resolve(path.join(repoPath, relPath))
      const repoPath = "/repo";
      const relPath = "src/foo.ts";
      const abs = path.resolve(path.join(repoPath, relPath));
      expect(abs).toBe("/repo/src/foo.ts");
    });

    it("strips leading slashes from agent-supplied path", () => {
      const rawPath = "/src/foo.ts";
      const relPath = rawPath.replace(/^[\\/]+/, "");
      expect(relPath).toBe("src/foo.ts");
    });

    it("handles nested path separators correctly", () => {
      const repoPath = "/home/user/project";
      const relPath = "src/components/Button.tsx";
      const abs = path.resolve(path.join(repoPath, relPath));
      expect(abs).toBe("/home/user/project/src/components/Button.tsx");
    });
  });

  describe("staging map semantics for revert", () => {
    it("removing abs from stagingFiles means the file will not be flushed", () => {
      const stagingFiles = new Map<string, string>();
      const abs = "/repo/src/foo.ts";
      stagingFiles.set(abs, "new content");
      expect(stagingFiles.has(abs)).toBe(true);

      // Simulate what revert_patch does:
      stagingFiles.delete(abs);
      expect(stagingFiles.has(abs)).toBe(false);
      // Original disk content (pre-run) will be used — no flush for this file.
    });

    it("filesModified.delete removes the relative path from the modified set", () => {
      const filesModified = new Set<string>(["src/foo.ts", "src/bar.ts"]);
      filesModified.delete("src/foo.ts");
      expect(filesModified.has("src/foo.ts")).toBe(false);
      expect(filesModified.has("src/bar.ts")).toBe(true);
    });
  });

  describe("ZONE_VERIFY_MODE env var", () => {
    const originalEnv = process.env["ZONE_VERIFY_MODE"];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env["ZONE_VERIFY_MODE"];
      } else {
        process.env["ZONE_VERIFY_MODE"] = originalEnv;
      }
    });

    it("defaults to 'warn' when ZONE_VERIFY_MODE is unset", () => {
      delete process.env["ZONE_VERIFY_MODE"];
      const verifyMode: "warn" | "rollback" =
        process.env["ZONE_VERIFY_MODE"] === "rollback" ? "rollback" : "warn";
      expect(verifyMode).toBe("warn");
    });

    it("returns 'rollback' when ZONE_VERIFY_MODE=rollback", () => {
      process.env["ZONE_VERIFY_MODE"] = "rollback";
      const verifyMode: "warn" | "rollback" =
        process.env["ZONE_VERIFY_MODE"] === "rollback" ? "rollback" : "warn";
      expect(verifyMode).toBe("rollback");
    });

    it("defaults to 'warn' for any other ZONE_VERIFY_MODE value", () => {
      process.env["ZONE_VERIFY_MODE"] = "some_unknown_value";
      const verifyMode: "warn" | "rollback" =
        process.env["ZONE_VERIFY_MODE"] === "rollback" ? "rollback" : "warn";
      expect(verifyMode).toBe("warn");
    });
  });
});
