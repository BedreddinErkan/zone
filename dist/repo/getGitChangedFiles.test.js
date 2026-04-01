"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const execFileAsyncMock = vitest_1.vi.hoisted(() => vitest_1.vi.fn());
vitest_1.vi.mock("node:util", async () => {
    const actual = await vitest_1.vi.importActual("node:util");
    return {
        ...actual,
        promisify: vitest_1.vi.fn(() => execFileAsyncMock)
    };
});
const getGitChangedFiles_1 = require("./getGitChangedFiles");
(0, vitest_1.describe)("getGitChangedFiles", () => {
    (0, vitest_1.beforeEach)(() => {
        execFileAsyncMock.mockReset();
    });
    (0, vitest_1.it)("repo root bulunamazsa bos array donmeli", async () => {
        execFileAsyncMock.mockRejectedValueOnce(new Error("not a git repo"));
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("C:/projects/smile-agent");
        (0, vitest_1.expect)(result).toEqual([]);
    });
    (0, vitest_1.it)("base branch varsa diff sonucunu kullanmali ve duplicate dosyalari tekillestirmeli", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "/repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
                return {
                    stdout: "src/a.ts\nsrc/b.ts\nsrc/a.ts\n"
                };
            }
            throw new Error(`Unexpected git args: ${args.join(" ")}`);
        });
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo");
        (0, vitest_1.expect)(result).toEqual(["src/a.ts", "src/b.ts"]);
    });
    (0, vitest_1.it)("diff bos ise git status fallback kullanmali", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "/repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
                return { stdout: "" };
            }
            if (args[0] === "status" && args[1] === "--short") {
                return {
                    stdout: " M src/app.ts\n?? src/new-file.ts\n"
                };
            }
            throw new Error(`Unexpected git args: ${args.join(" ")}`);
        });
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo");
        (0, vitest_1.expect)(result).toEqual(["src/app.ts", "src/new-file.ts"]);
    });
    (0, vitest_1.it)("base branch bulunamazsa status fallback kullanmali", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
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
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo");
        (0, vitest_1.expect)(result).toEqual(["src/index.ts", "README.md"]);
    });
    (0, vitest_1.it)("targetPath repo root altindaki bir subfolder ise sadece ilgili dosyalari relative donmeli", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "/repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
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
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo/packages/agent");
        (0, vitest_1.expect)(result).toEqual([
            "src/index.ts",
            "src/utils.ts",
            "package.json"
        ]);
    });
    (0, vitest_1.it)("subfolder hedeflenince folderin tam kendisine esit dosyada basename donmeli", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "/repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
                return {
                    stdout: "packages/agent\npackages/agent/src/main.ts\n"
                };
            }
            throw new Error(`Unexpected git args: ${args.join(" ")}`);
        });
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo/packages/agent");
        (0, vitest_1.expect)(result).toEqual(["agent", "src/main.ts"]);
    });
    (0, vitest_1.it)("windows pathlerini normalize etmeli", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "C:\\repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
                return {
                    stdout: "src\\foo.ts\nsrc\\bar.ts\n"
                };
            }
            throw new Error(`Unexpected git args: ${args.join(" ")}`);
        });
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("C:\\repo");
        (0, vitest_1.expect)(result).toEqual(["src/foo.ts", "src/bar.ts"]);
    });
    (0, vitest_1.it)("diff hata verirse status fallback kullanmali", async () => {
        execFileAsyncMock.mockImplementation(async (file, args) => {
            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return { stdout: "/repo\n" };
            }
            if (args[0] === "rev-parse" &&
                args[1] === "--verify" &&
                args[2] === "origin/main") {
                return { stdout: "ok\n" };
            }
            if (args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "origin/main...HEAD") {
                throw new Error("diff failed");
            }
            if (args[0] === "status" && args[1] === "--short") {
                return {
                    stdout: " M src/fallback.ts\n"
                };
            }
            throw new Error(`Unexpected git args: ${args.join(" ")}`);
        });
        const result = await (0, getGitChangedFiles_1.getGitChangedFiles)("/repo");
        (0, vitest_1.expect)(result).toEqual(["src/fallback.ts"]);
    });
});
//# sourceMappingURL=getGitChangedFiles.test.js.map