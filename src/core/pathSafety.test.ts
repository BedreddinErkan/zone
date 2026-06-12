import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { classifyPath, SYSTEM_ROOTS } from "./pathSafety.js";

describe("classifyPath — system roots (exact match)", () => {
  for (const root of SYSTEM_ROOTS) {
    it(`"${root}" → "system"`, () => {
      expect(classifyPath(root)).toBe("system");
    });
  }
});

describe("classifyPath — system descendants are 'normal'", () => {
  it("/usr/local → normal", () => expect(classifyPath("/usr/local")).toBe("normal"));
  it("/usr/local/app → normal", () => expect(classifyPath("/usr/local/app")).toBe("normal"));
  it("/var/www/site → normal", () => expect(classifyPath("/var/www/site")).toBe("normal"));
  it("/etc/nginx/conf.d → normal", () => expect(classifyPath("/etc/nginx/conf.d")).toBe("normal"));
  it("/opt/myapp → normal", () => expect(classifyPath("/opt/myapp")).toBe("normal"));
});

describe("classifyPath — home_root", () => {
  it("os.homedir() exact → home_root", () => {
    expect(classifyPath(homedir())).toBe("home_root");
  });

  it("home subdir → normal", () => {
    expect(classifyPath(join(homedir(), "projects"))).toBe("normal");
    expect(classifyPath(join(homedir(), "projects", "myapp"))).toBe("normal");
  });
});

describe("classifyPath — normal paths", () => {
  it("/tmp/something → normal", () => expect(classifyPath("/tmp/something")).toBe("normal"));

  it("arbitrary tmp dir → normal", () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-ps-test-"));
    try {
      expect(classifyPath(dir)).toBe("normal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyPath — symlink canonicalization", () => {
  it("symlink to /tmp subdir → normal", () => {
    const target = mkdtempSync(join(tmpdir(), "zone-ps-target-"));
    const link = join(tmpdir(), `zone-ps-link-${Date.now()}`);
    try {
      symlinkSync(target, link);
      expect(classifyPath(link)).toBe("normal");
    } finally {
      try { rmSync(link); } catch { /* ignore */ }
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("symlink to /usr → system", () => {
    // Only run on systems where /usr exists and /tmp is writable
    const link = join(tmpdir(), `zone-ps-usr-link-${Date.now()}`);
    try {
      symlinkSync("/usr", link);
      expect(classifyPath(link)).toBe("system");
      rmSync(link);
    } catch {
      // Skip if /usr doesn't exist or symlink creation fails (CI environment)
    }
  });
});
