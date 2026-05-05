import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDependencyGraph } from "../../../dist/repo/buildDependencyGraph.js";
import {
  expandAlias,
  parseTsconfigPaths,
} from "../../../dist/repo/parseTsconfigPaths.js";
import { executeTool } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  const result = { label, pass, details };
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return result;
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function listFilesRelative(dir) {
  const results = [];
  function walk(current, base) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else {
        results.push(path.relative(base, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(dir, dir);
  return results;
}

function makeTempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupAliasRepo() {
  const repoPath = makeTempRepo("zone-path-alias-");
  writeFile(repoPath, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      paths: {
        "@/*": ["./*"],
      },
    },
  }, null, 2));
  writeFile(repoPath, "lib/env.ts", [
    "export const isClerkConfigured = true;",
    "",
  ].join("\n"));
  writeFile(repoPath, "app/page.tsx", [
    "import { isClerkConfigured } from '@/lib/env';",
    "export const pageReady = isClerkConfigured;",
    "",
  ].join("\n"));
  writeFile(repoPath, "app/dashboard/page.tsx", [
    "import { isClerkConfigured } from '@/lib/env';",
    "export const dashboardReady = isClerkConfigured;",
    "",
  ].join("\n"));
  writeFile(repoPath, "proxy.ts", [
    "import { isClerkConfigured } from '@/lib/env';",
    "export const proxyReady = isClerkConfigured;",
    "",
  ].join("\n"));
  return repoPath;
}

async function main() {
  const checks = [];
  const cleanupRoots = [];

  try {
    const aliasRepo = setupAliasRepo();
    cleanupRoots.push(aliasRepo);
    const aliasConfig = parseTsconfigPaths(aliasRepo);

    checks.push(check(
      "parseTsconfigPaths basic",
      !!aliasConfig &&
        aliasConfig.paths.has("@/*") &&
        JSON.stringify(aliasConfig.paths.get("@/*")) === JSON.stringify(["./*"]) &&
        path.resolve(aliasConfig.baseUrl) === path.resolve(aliasRepo),
      aliasConfig && {
        baseUrl: aliasConfig.baseUrl,
        paths: Object.fromEntries(aliasConfig.paths),
      }
    ));

    checks.push(check(
      "expandAlias basic",
      !!aliasConfig &&
        JSON.stringify(expandAlias("@/lib/env", aliasConfig)) === JSON.stringify(["lib/env"]) &&
        JSON.stringify(expandAlias("react", aliasConfig)) === JSON.stringify([]),
      aliasConfig && {
        alias: expandAlias("@/lib/env", aliasConfig),
        react: expandAlias("react", aliasConfig),
      }
    ));

    const multiRepo = makeTempRepo("zone-path-alias-multi-");
    cleanupRoots.push(multiRepo);
    writeFile(multiRepo, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        paths: {
          "shared/*": ["./packages/a/*", "./packages/b/*"],
        },
      },
    }, null, 2));
    const multiConfig = parseTsconfigPaths(multiRepo);
    checks.push(check(
      "expandAlias multi-target",
      !!multiConfig &&
        JSON.stringify(expandAlias("shared/env", multiConfig)) ===
          JSON.stringify(["packages/a/env", "packages/b/env"]),
      multiConfig && expandAlias("shared/env", multiConfig)
    ));

    const exactRepo = makeTempRepo("zone-path-alias-exact-");
    cleanupRoots.push(exactRepo);
    writeFile(exactRepo, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        paths: {
          constants: ["./lib/constants.ts"],
        },
      },
    }, null, 2));
    const exactConfig = parseTsconfigPaths(exactRepo);
    checks.push(check(
      "expandAlias exact",
      !!exactConfig &&
        JSON.stringify(expandAlias("constants", exactConfig)) ===
          JSON.stringify(["lib/constants.ts"]) &&
        JSON.stringify(expandAlias("constants/foo", exactConfig)) === JSON.stringify([]),
      exactConfig && {
        exact: expandAlias("constants", exactConfig),
        nested: expandAlias("constants/foo", exactConfig),
      }
    ));

    const aliasGraph = await buildDependencyGraph(aliasRepo, listFilesRelative(aliasRepo));
    const envNode = aliasGraph.nodes.get("lib/env.ts");
    const expectedImporters = ["app/page.tsx", "app/dashboard/page.tsx", "proxy.ts"];
    checks.push(check(
      "buildDependencyGraph with aliases",
      !!envNode && expectedImporters.every((importer) => envNode.importedBy.includes(importer)),
      envNode && { importedBy: envNode.importedBy }
    ));

    const pageNode = aliasGraph.nodes.get("app/page.tsx");
    const pageSymbols = pageNode?.importedSymbolsBySource.get("lib/env.ts") ?? [];
    checks.push(check(
      "symbol propagation through alias",
      pageSymbols.some((symbol) => symbol.name === "isClerkConfigured"),
      pageSymbols
    ));

    const noConfigRepo = makeTempRepo("zone-path-alias-none-");
    cleanupRoots.push(noConfigRepo);
    writeFile(noConfigRepo, "lib/env.ts", "export const isClerkConfigured = true;\n");
    writeFile(noConfigRepo, "app/page.tsx", [
      "import { isClerkConfigured } from '@/lib/env';",
      "export const pageReady = isClerkConfigured;",
      "",
    ].join("\n"));
    const noConfigGraph = await buildDependencyGraph(noConfigRepo, listFilesRelative(noConfigRepo));
    checks.push(check(
      "no tsconfig case",
      (noConfigGraph.nodes.get("lib/env.ts")?.importedBy ?? []).length === 0,
      noConfigGraph.nodes.get("lib/env.ts")?.importedBy
    ));

    const commentsRepo = makeTempRepo("zone-path-alias-comments-");
    cleanupRoots.push(commentsRepo);
    writeFile(commentsRepo, "tsconfig.json", [
      "{",
      "  // line comment",
      "  \"compilerOptions\": {",
      "    /* block comment */",
      "    \"paths\": { \"@/*\": [\"./*\"] }",
      "  }",
      "}",
      "",
    ].join("\n"));
    const commentsConfig = parseTsconfigPaths(commentsRepo);
    checks.push(check(
      "comment-stripped tsconfig",
      !!commentsConfig &&
        JSON.stringify(expandAlias("@/lib/env", commentsConfig)) === JSON.stringify(["lib/env"]),
      commentsConfig && expandAlias("@/lib/env", commentsConfig)
    ));

    const baseUrlRepo = makeTempRepo("zone-path-alias-baseurl-");
    cleanupRoots.push(baseUrlRepo);
    writeFile(baseUrlRepo, "tsconfig.json", JSON.stringify({
      compilerOptions: {
        baseUrl: "./src",
      },
    }, null, 2));
    writeFile(baseUrlRepo, "src/lib/env.ts", "export const value = 1;\n");
    writeFile(baseUrlRepo, "src/app/page.tsx", [
      "import { value } from 'lib/env';",
      "export const pageValue = value;",
      "",
    ].join("\n"));
    const baseUrlGraph = await buildDependencyGraph(baseUrlRepo, listFilesRelative(baseUrlRepo));
    checks.push(check(
      "baseUrl-only no paths",
      (baseUrlGraph.nodes.get("src/lib/env.ts")?.importedBy ?? []).includes("src/app/page.tsx"),
      baseUrlGraph.nodes.get("src/lib/env.ts")?.importedBy
    ));

    const originalLog = console.log;
    const toolLogs = [];
    console.log = (...args) => {
      toolLogs.push(args.join(" "));
      originalLog(...args);
    };
    let refs;
    try {
      refs = await executeTool(
        "find_references",
        { sourceFile: "lib/env.ts", symbolName: "isClerkConfigured" },
        aliasRepo
      );
    } finally {
      console.log = originalLog;
    }
    const consumerLog = toolLogs.find((line) => line.includes("[zone-tool-find-references]")) ?? "";
    checks.push(check(
      "find_references end-to-end with alias",
      refs?.success === true &&
        refs.output.includes("Found 3 file(s)") &&
        expectedImporters.every((importer) => refs.output.includes(importer)) &&
        consumerLog.includes("\"consumerCount\":3"),
      { output: refs?.output, consumerLog }
    ));
  } finally {
    for (const root of cleanupRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (_) {
        // best-effort cleanup
      }
    }
  }

  const failed = checks.filter((item) => !item.pass);
  console.log(`[path-alias-test] PASSED ${checks.length - failed.length}/10 assertions`);

  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const failedCheck of failed) {
      console.log(
        "  FAIL:",
        failedCheck.label,
        failedCheck.details !== undefined ? JSON.stringify(failedCheck.details) : ""
      );
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Unexpected error in path alias test runner:", err);
  process.exitCode = 1;
});
