import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:util", async () => {
  const actual = await vi.importActual<typeof import("node:util")>("node:util");

  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock)
  };
});

import { getGitChangedFiles } from "./getGitChangedFiles";

describe("getGitChangedFiles", () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
  });

  it("repo root bulunamazsa bos array donmeli", async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("not a git repo"));

    const result = await getGitChangedFiles("C:/projects/smile-agent");

    expect(result).toEqual([]);
  });

  it("base branch varsa diff sonucunu kullanmali ve duplicate dosyalari tekillestirmeli", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        return {
          stdout: "src/a.ts\nsrc/b.ts\nsrc/a.ts\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo");

    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("diff bos ise git status fallback kullanmali", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        return { stdout: "" };
      }

      if (args[0] === "status" && args[1] === "--short") {
        return {
          stdout: " M src/app.ts\n?? src/new-file.ts\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo");

    expect(result).toEqual(["src/app.ts", "src/new-file.ts"]);
  });

  it("base branch bulunamazsa status fallback kullanmali", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (args[0] === "rev-parse" && args[1] === "--verify") {
        throw new Error("branch not found");
      }

      if (args[0] === "status" && args[1] === "--short") {
        return {
          stdout: " M src/index.ts\n?? README.md\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo");

    expect(result).toEqual(["src/index.ts", "README.md"]);
  });

  it("targetPath repo root altindaki bir subfolder ise sadece ilgili dosyalari relative donmeli", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        return {
          stdout: [
            "packages/agent/src/index.ts",
            "packages/agent/src/utils.ts",
            "packages/agent/package.json",
            "packages/web/src/app.tsx",
            "README.md"
          ].join("\n")
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo/packages/agent");

    expect(result).toEqual([
      "src/index.ts",
      "src/utils.ts",
      "package.json"
    ]);
  });

  it("subfolder hedeflenince folderin tam kendisine esit dosyada basename donmeli", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        return {
          stdout: "packages/agent\npackages/agent/src/main.ts\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo/packages/agent");

    expect(result).toEqual(["agent", "src/main.ts"]);
  });

  it("windows pathlerini normalize etmeli", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "C:\\repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        return {
          stdout: "src\\foo.ts\nsrc\\bar.ts\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("C:\\repo");

    expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("diff hata verirse status fallback kullanmali", async () => {
    execFileAsyncMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/repo\n" };
      }

      if (
        args[0] === "rev-parse" &&
        args[1] === "--verify" &&
        args[2] === "origin/main"
      ) {
        return { stdout: "ok\n" };
      }

      if (
        args[0] === "diff" &&
        args[1] === "--name-only" &&
        args[2] === "origin/main...HEAD"
      ) {
        throw new Error("diff failed");
      }

      if (args[0] === "status" && args[1] === "--short") {
        return {
          stdout: " M src/fallback.ts\n"
        };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const result = await getGitChangedFiles("/repo");

    expect(result).toEqual(["src/fallback.ts"]);
  });
});