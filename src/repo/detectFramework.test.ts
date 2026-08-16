/**
 * No dedicated test file existed for detectFramework.ts before this pass (confirmed by
 * both `find` and `git grep` — it was only ever imported as a dependency by other test
 * files, never tested directly). Created to pin the Ruby classification fix: Gemfile was
 * read into the cosmetic configFiles list but never turned into a language, the same
 * defect class as the verification consumer this pass also widens, one step earlier.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFramework } from "./detectFramework.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-detect-framework-"));
});
afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("detectFramework — Ruby classification", () => {
  it("a Gemfile naming rspec is classified ruby with bundle exec rspec as the test command", async () => {
    write("Gemfile", 'source "https://rubygems.org"\ngem "rspec"\n');
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("ruby");
    expect(fw.testCommand).toBe("bundle exec rspec");
    expect(fw.hasTests).toBe(true);
  });

  it("a Gemfile with no rspec is still classified ruby, with no guessed test command", async () => {
    write("Gemfile", 'source "https://rubygems.org"\ngem "rails"\n');
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("ruby");
    expect(fw.testCommand).toBe("");
    expect(fw.hasTests).toBe(false);
  });

  it("Gemfile is read into configFiles regardless of classification outcome", async () => {
    write("Gemfile", 'source "https://rubygems.org"\n');
    const fw = await detectFramework(repoPath);
    expect(fw.configFiles).toContain("Gemfile");
  });

  it("no Gemfile: not classified ruby", async () => {
    write("README.md", "hello\n");
    const fw = await detectFramework(repoPath);
    expect(fw.language).not.toBe("ruby");
  });
});

describe("detectFramework — cross-ecosystem test command computation (regression pins for this pass's consumer)", () => {
  it("rust: Cargo.toml yields cargo test", async () => {
    write("Cargo.toml", '[package]\nname = "x"\n');
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("rust");
    expect(fw.testCommand).toBe("cargo test");
  });

  it("go: go.mod yields go test ./...", async () => {
    write("go.mod", "module x\ngo 1.22\n");
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("go");
    expect(fw.testCommand).toBe("go test ./...");
  });

  it("java (maven): pom.xml yields mvn test", async () => {
    write("pom.xml", "<project></project>\n");
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("java");
    expect(fw.testCommand).toBe("mvn test");
  });

  it("java (gradle): build.gradle yields gradle test", async () => {
    write("build.gradle", "apply plugin: 'java'\n");
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("java");
    expect(fw.testCommand).toBe("gradle test");
  });

  it("no manifest at all: language unknown, empty test command", async () => {
    write("README.md", "hello\n");
    const fw = await detectFramework(repoPath);
    expect(fw.language).toBe("unknown");
    expect(fw.testCommand).toBe("");
  });
});
