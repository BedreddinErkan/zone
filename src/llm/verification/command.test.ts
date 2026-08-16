/**
 * Finding 2: the inline tsc verification must be project-aware. A bare
 * `tsc --noEmit` at a monorepo root resolves no inputs (prints its usage
 * banner) and `@/...` path aliases never resolve. selectVerificationCommand
 * now targets the nearest tsconfig.json via `-p <tsconfig>`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTsconfigProject, selectVerificationCommand, resolveAllTsconfigProjects } from "./command.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-tsc-"));
});
afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function write(rel: string, content = "{}"): string {
  const abs = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("resolveTsconfigProject", () => {
  it("finds the nearest tsconfig to a staged file in a monorepo", () => {
    write("apps/web/tsconfig.json");
    const staged = write("apps/web/app/page.tsx", "export default 1;");
    expect(resolveTsconfigProject(repoPath, new Map([[staged, "x"]]))).toBe(
      path.join(repoPath, "apps/web/tsconfig.json"),
    );
  });

  it("returns null when no tsconfig exists anywhere up to repo root", () => {
    const staged = write("apps/web/app/page.tsx", "x");
    expect(resolveTsconfigProject(repoPath, new Map([[staged, "x"]]))).toBeNull();
  });

  it("prefers the repo-root tsconfig when staged files span packages", () => {
    write("tsconfig.json");
    write("apps/web/tsconfig.json");
    write("apps/api/tsconfig.json");
    const a = write("apps/web/a.ts", "x");
    const b = write("apps/api/b.ts", "x");
    expect(resolveTsconfigProject(repoPath, new Map([[a, "x"], [b, "x"]]))).toBe(
      path.join(repoPath, "tsconfig.json"),
    );
  });

  it("falls back to repoPath/tsconfig.json when there are no staged files", () => {
    write("tsconfig.json");
    expect(resolveTsconfigProject(repoPath)).toBe(path.join(repoPath, "tsconfig.json"));
  });
});

describe("selectVerificationCommand — project-aware tsc", () => {
  it("emits `-p <nearest tsconfig>` for typescript with context", () => {
    write("apps/web/tsconfig.json");
    const staged = write("apps/web/app/page.tsx", "x");
    expect(
      selectVerificationCommand({ language: "typescript" }, {
        repoPath,
        stagingFiles: new Map([[staged, "x"]]),
      }),
    ).toEqual({
      command: "npx tsc --noEmit -p apps/web/tsconfig.json",
      timeoutMs: 60000,
      label: "tsc",
    });
  });

  it("falls back to the bare command without context (backward compat)", () => {
    expect(selectVerificationCommand({ language: "typescript" })).toEqual({
      command: "npx tsc --noEmit",
      timeoutMs: 60000,
      label: "tsc",
    });
  });

  it("falls back to the bare command when no tsconfig resolves", () => {
    const staged = write("a.ts", "x");
    expect(
      selectVerificationCommand({ language: "typescript" }, {
        repoPath,
        stagingFiles: new Map([[staged, "x"]]),
      })?.command,
    ).toBe("npx tsc --noEmit");
  });

  it("leaves the test-framework command unchanged", () => {
    expect(
      selectVerificationCommand({ language: "javascript", testCommand: "npm test" }, { repoPath }),
    ).toEqual({ command: "npm test", timeoutMs: 90000, label: "test" });
  });

  it("python's test-framework command is unchanged (regression pin)", () => {
    expect(
      selectVerificationCommand({ language: "python", testCommand: "pytest" }, { repoPath }),
    ).toEqual({ command: "pytest", timeoutMs: 90000, label: "test" });
  });
});

// Widened this pass: derived from the detector's own testCommand rather than a second
// hardcoded language list, so a future detectFramework addition is consumed automatically.
describe("selectVerificationCommand — cross-ecosystem, derived from testCommand alone", () => {
  it("rust: cargo test is selected", () => {
    expect(
      selectVerificationCommand({ language: "rust", testCommand: "cargo test" }, { repoPath }),
    ).toEqual({ command: "cargo test", timeoutMs: 90000, label: "test" });
  });

  it("go: go test ./... is selected", () => {
    expect(
      selectVerificationCommand({ language: "go", testCommand: "go test ./..." }, { repoPath }),
    ).toEqual({ command: "go test ./...", timeoutMs: 90000, label: "test" });
  });

  it("java (maven): mvn test is selected", () => {
    expect(
      selectVerificationCommand({ language: "java", testCommand: "mvn test" }, { repoPath }),
    ).toEqual({ command: "mvn test", timeoutMs: 90000, label: "test" });
  });

  it("java (gradle): gradle test is selected", () => {
    expect(
      selectVerificationCommand({ language: "java", testCommand: "gradle test" }, { repoPath }),
    ).toEqual({ command: "gradle test", timeoutMs: 90000, label: "test" });
  });

  it("ruby: bundle exec rspec is selected", () => {
    expect(
      selectVerificationCommand({ language: "ruby", testCommand: "bundle exec rspec" }, { repoPath }),
    ).toEqual({ command: "bundle exec rspec", timeoutMs: 90000, label: "test" });
  });

  it("a language with no testCommand (php's actual shape today) returns null", () => {
    expect(selectVerificationCommand({ language: "php", testCommand: "" }, { repoPath })).toBeNull();
  });

  it("no framework at all returns null, unchanged", () => {
    expect(selectVerificationCommand(undefined, { repoPath })).toBeNull();
  });
});

describe("resolveAllTsconfigProjects", () => {
  it("returns both tsconfigs when staged files span two packages", () => {
    write("apps/web/tsconfig.json");
    write("packages/db/tsconfig.json");
    const a = write("apps/web/src/index.ts", "x");
    const b = write("packages/db/src/model.ts", "x");
    const result = resolveAllTsconfigProjects(repoPath, new Map([[a, "x"], [b, "x"]]));
    expect(result).toHaveLength(2);
    expect(result).toContain(path.join(repoPath, "apps/web/tsconfig.json"));
    expect(result).toContain(path.join(repoPath, "packages/db/tsconfig.json"));
  });

  it("returns a single-element array when files share one tsconfig via walk-up", () => {
    write("apps/web/tsconfig.json");
    const a = write("apps/web/src/a.ts", "x");
    const b = write("apps/web/src/b.ts", "x");
    expect(resolveAllTsconfigProjects(repoPath, new Map([[a, "x"], [b, "x"]]))).toEqual([
      path.join(repoPath, "apps/web/tsconfig.json"),
    ]);
  });

  it("returns empty array when no tsconfig exists", () => {
    const a = write("apps/web/src/index.ts", "x");
    expect(resolveAllTsconfigProjects(repoPath, new Map([[a, "x"]]))).toEqual([]);
  });

  it("includes root tsconfig as one of the entries when a package also has one", () => {
    write("tsconfig.json");
    write("apps/web/tsconfig.json");
    const a = write("apps/web/src/a.ts", "x");
    const b = write("src/root.ts", "x");
    const result = resolveAllTsconfigProjects(repoPath, new Map([[a, "x"], [b, "x"]]));
    expect(result).toHaveLength(2);
    expect(result).toContain(path.join(repoPath, "tsconfig.json"));
    expect(result).toContain(path.join(repoPath, "apps/web/tsconfig.json"));
  });
});
