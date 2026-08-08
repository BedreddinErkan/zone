import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProjectStructure } from "./detectProjectStructure.js";
import type { RepoFile } from "../types/project.js";

// The detector reads package.json off disk, so fixtures build a real directory rather
// than mocking the read — a mock would pin the mock, not the detector.
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Writes `files` (relative path -> contents) into a fresh temp dir and returns the
 *  RepoFile[] the scanner would hand the detector for them. */
function fixture(files: Record<string, string>): RepoFile[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zone-detect-"));
  tempRoots.push(root);
  const repoFiles: RepoFile[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    repoFiles.push({
      path: rel,
      absolutePath: abs,
      extension: path.extname(rel).replace(".", "").toLowerCase(),
      category: "unknown",
    });
  }
  return repoFiles;
}

/** This repository's own shape: ESM, a declared bin, TypeScript, an Ink terminal UI —
 *  and therefore react as a real production dependency, with no react-dom. */
const THIS_REPO_SHAPE = {
  "package.json": JSON.stringify({
    name: "zone-ai-agent",
    type: "module",
    bin: { zone: "./dist/cli/index.js" },
    dependencies: { react: "^19.2.0", ink: "^7.0.3", commander: "^12.0.0" },
  }),
  "tsconfig.json": "{}",
  "src/cli/tui/App.tsx": "export const App = () => null;",
  "src/cli/index.ts": "export {};",
};

describe("detectProjectStructure — this repository's own shape", () => {
  it("names the runtime, the language, and the command-line nature", () => {
    const notes = detectProjectStructure(fixture(THIS_REPO_SHAPE)).notes;
    expect(notes).toContain("Node.js project (ESM)");
    expect(notes).toContain("TypeScript");
    expect(notes.join(" ")).toContain("Command-line tool");
  });

  // Split from the block above deliberately, not for tidiness. The runner stops a block
  // at its first throwing assertion, so a presence check failing would leave this one
  // unrun — and the two guard opposite mutations (breaking a detection vs. loosening the
  // frontend one back to the .tsx extension). In one block those two would be
  // indistinguishable; split, each kills exactly one.
  it("regression guard: does not claim a React frontend for an Ink terminal UI", () => {
    // react IS declared here, via ink, and 68 .tsx files exist in the real repository —
    // the two signals the old detection keyed on. react-dom is what separates a browser
    // frontend from a terminal one, and it is absent.
    expect(detectProjectStructure(fixture(THIS_REPO_SHAPE)).notes).not.toContain("React frontend");
  });
});

describe("detectProjectStructure — other project shapes", () => {
  it("still reports a React frontend when react-dom is declared", () => {
    const notes = detectProjectStructure(
      fixture({
        "package.json": JSON.stringify({
          name: "web",
          dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
        }),
        "src/App.jsx": "export default () => null;",
      })
    ).notes;
    expect(notes).toContain("React frontend");
  });

  it("fabricates nothing when no signal is recognizable", () => {
    const notes = detectProjectStructure(
      fixture({ "README.md": "# notes", "data/values.csv": "a,b\n1,2\n" })
    ).notes;
    expect(notes).toEqual([]);
  });
});

describe("detectProjectStructure — note budget", () => {
  /** Matches seven candidate notes: Node.js, TypeScript, command-line tool, React
   *  frontend, Ink terminal UI, Express backend, client/server split. */
  const OVER_CAP = {
    "package.json": JSON.stringify({
      name: "everything",
      type: "module",
      bin: { everything: "./cli.js" },
      dependencies: { react: "1", "react-dom": "1", ink: "1", express: "1" },
    }),
    "tsconfig.json": "{}",
    "client/index.tsx": "export {};",
    "server/index.ts": "export {};",
  };

  it("caps the note count and drops the least discriminating notes first", () => {
    const notes = detectProjectStructure(fixture(OVER_CAP)).notes;
    expect(notes).toHaveLength(5);
    expect(notes).not.toContain("Client/server split");
  });

  it("orders notes runtime and language first, project kind next, frameworks last", () => {
    expect(detectProjectStructure(fixture(OVER_CAP)).notes).toEqual([
      "Node.js project (ESM)",
      "TypeScript",
      "Command-line tool (declares a bin entry)",
      "React frontend",
      "Ink terminal UI",
    ]);
  });
});
