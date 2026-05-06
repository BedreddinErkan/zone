/**
 * Manual fixture test for scanRepo against modern JS framework layouts
 * (Next.js App Router, Remix, SvelteKit, Astro, Vite).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runScanRepoModernFrameworkManual.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { scanRepo } = await import("../../../dist/repo/scanRepo.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

function writeFile(rel: string, body: string, root: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "zone-scanrepo-modern-"));

try {
  // Next.js App Router layout
  writeFile("app/page.tsx", "export default function Page(){return null;}\n", fixture);
  writeFile("app/layout.tsx", "export default function L(){return null;}\n", fixture);
  writeFile("lib/env.ts", "export const X = 1;\n", fixture);
  writeFile("lib/utils.ts", "export const Y = 2;\n", fixture);
  writeFile("components/Header.tsx", "export const H=()=>null;\n", fixture);
  writeFile("hooks/useUser.ts", "export const useUser=()=>null;\n", fixture);
  writeFile("middleware.ts", "export const config={};\n", fixture);
  writeFile("next.config.ts", "export default {};\n", fixture);
  writeFile("proxy.ts", "export const x=1;\n", fixture);
  writeFile("eslint.config.mjs", "export default [];\n", fixture);
  writeFile("postcss.config.mjs", "export default {};\n", fixture);
  writeFile("package.json", "{\"name\":\"x\"}\n", fixture);
  writeFile("README.md", "# fixture\n", fixture);
  writeFile("styles/globals.css", "body{}\n", fixture);
  writeFile("src/legacy.ts", "export const z=1;\n", fixture);  // existing-layout regression
  writeFile("public/index.html", "<!doctype html><html></html>\n", fixture);

  // Should be skipped
  writeFile("node_modules/junk/should-be-skipped.ts", "export const skip=1;\n", fixture);
  writeFile(".next/cache/should-be-skipped.ts", "export const skip=2;\n", fixture);
  writeFile("dist/should-be-skipped.ts", "export const skip=3;\n", fixture);
  writeFile(".turbo/should-be-skipped.ts", "export const skip=4;\n", fixture);
  writeFile("out/should-be-skipped.ts", "export const skip=5;\n", fixture);

  const result: Array<{ path: string }> = await scanRepo(fixture);
  const paths = new Set(result.map((f) => f.path));

  // 1. app/page.tsx in result
  check("app/page.tsx included", paths.has("app/page.tsx"), [...paths].sort());

  // 2. lib/env.ts in result
  check("lib/env.ts included", paths.has("lib/env.ts"), [...paths].sort());

  // 3. components/Header.tsx in result
  check("components/Header.tsx included", paths.has("components/Header.tsx"), [...paths].sort());

  // 4. middleware.ts (root) in result
  check("middleware.ts (root) included", paths.has("middleware.ts"), [...paths].sort());

  // 5. next.config.ts (root) in result
  check("next.config.ts (root) included", paths.has("next.config.ts"), [...paths].sort());

  // 6. eslint.config.mjs (root) in result
  check("eslint.config.mjs (root) included", paths.has("eslint.config.mjs"), [...paths].sort());

  // 7. package.json in result (existing behavior)
  check("package.json included", paths.has("package.json"), [...paths].sort());

  // 8. src/legacy.ts in result (existing layout regression check)
  check("src/legacy.ts included (existing layout)", paths.has("src/legacy.ts"), [...paths].sort());

  // 9. node_modules excluded
  check(
    "node_modules/junk/should-be-skipped.ts NOT included",
    !paths.has("node_modules/junk/should-be-skipped.ts"),
    [...paths].sort()
  );

  // 10. .next excluded
  check(
    ".next/cache/should-be-skipped.ts NOT included",
    !paths.has(".next/cache/should-be-skipped.ts"),
    [...paths].sort()
  );

  // 11. .turbo excluded
  check(
    ".turbo/should-be-skipped.ts NOT included",
    !paths.has(".turbo/should-be-skipped.ts"),
    [...paths].sort()
  );

  // 12. out/ excluded
  check(
    "out/should-be-skipped.ts NOT included",
    !paths.has("out/should-be-skipped.ts"),
    [...paths].sort()
  );
} finally {
  try {
    fs.rmSync(fixture, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[scan-repo-modern-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
