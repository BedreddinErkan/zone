/**
 * Manual fixture test for verdict-fix Tur.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/core/__tests__/runVerdictMessageManual.ts
 *
 * Covers two surfaces:
 *  1. Backend command classifier (`src/core/verdictClassifier.ts`) —
 *     classifyVerificationCommand / classifyVerificationOutcome /
 *     collectVerificationCommands.
 *  2. UI banner-override deriver (`deriveVerificationBannerOverride` in
 *     `src/ui/index.html`) — the test re-implements the function inline as a
 *     mirror copy. KEEP THE TWO IN SYNC. The function is intentionally short
 *     so a future refactor can extract it; until then, this guard pins the
 *     contract that "tests_skipped_no_infra + agent ran build" surfaces a
 *     truthful banner instead of the static "No test infrastructure found"
 *     line.
 */
const {
  classifyVerificationCommand,
  classifyVerificationOutcome,
  collectVerificationCommands,
} = await import("../../../dist/core/verdictClassifier.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// ── Backend: classifyVerificationCommand ──────────────────────────────────

check("npm test → test", classifyVerificationCommand("npm test") === "test", classifyVerificationCommand("npm test"));
check("npm run test → test", classifyVerificationCommand("npm run test") === "test", classifyVerificationCommand("npm run test"));
check("pnpm test → test", classifyVerificationCommand("pnpm test") === "test", classifyVerificationCommand("pnpm test"));
check("yarn test → test", classifyVerificationCommand("yarn test") === "test", classifyVerificationCommand("yarn test"));
check("npx vitest → test", classifyVerificationCommand("npx vitest") === "test", classifyVerificationCommand("npx vitest"));
check("vitest run → test", classifyVerificationCommand("vitest run") === "test", classifyVerificationCommand("vitest run"));
check("jest → test", classifyVerificationCommand("jest") === "test", classifyVerificationCommand("jest"));

check("npm run build → build", classifyVerificationCommand("npm run build") === "build", classifyVerificationCommand("npm run build"));
check("pnpm build → build", classifyVerificationCommand("pnpm build") === "build", classifyVerificationCommand("pnpm build"));
check("next build → build", classifyVerificationCommand("next build") === "build", classifyVerificationCommand("next build"));
check("vite build → build", classifyVerificationCommand("vite build") === "build", classifyVerificationCommand("vite build"));

check("tsc → typecheck", classifyVerificationCommand("tsc") === "typecheck", classifyVerificationCommand("tsc"));
check("npx tsc --noEmit → typecheck", classifyVerificationCommand("npx tsc --noEmit") === "typecheck", classifyVerificationCommand("npx tsc --noEmit"));
check("./node_modules/.bin/tsc → typecheck", classifyVerificationCommand("./node_modules/.bin/tsc -p .") === "typecheck", classifyVerificationCommand("./node_modules/.bin/tsc -p ."));

check("ls → null", classifyVerificationCommand("ls") === null, classifyVerificationCommand("ls"));
check("git status → null", classifyVerificationCommand("git status") === null, classifyVerificationCommand("git status"));
check("cat foo.ts → null", classifyVerificationCommand("cat foo.ts") === null, classifyVerificationCommand("cat foo.ts"));
check("empty → null", classifyVerificationCommand("") === null, classifyVerificationCommand(""));

// ── Backend: classifyVerificationOutcome ──────────────────────────────────

check("success=true → passed", classifyVerificationOutcome({ success: true }) === "passed", classifyVerificationOutcome({ success: true }));
check("success=false → failed", classifyVerificationOutcome({ success: false }) === "failed", classifyVerificationOutcome({ success: false }));
check("success undefined → unknown", classifyVerificationOutcome({}) === "unknown", classifyVerificationOutcome({}));
check("null → unknown", classifyVerificationOutcome(null) === "unknown", classifyVerificationOutcome(null));

// ── Backend: collectVerificationCommands ──────────────────────────────────

{
  const log = [
    { tool: "read_file", args: { filePath: "lib/env.ts" }, result: "ok", success: true },
    { tool: "run_command", args: { command: "ls" }, result: "ok", success: true },
    { tool: "run_command", args: { command: "npm run build" }, result: "ok", success: true },
    { tool: "run_command", args: { command: "npx tsc --noEmit" }, result: "ok", success: false },
  ];
  const got = collectVerificationCommands(log);
  const ok =
    got.length === 2 &&
    got[0].command === "npm run build" &&
    got[0].category === "build" &&
    got[0].outcome === "passed" &&
    got[1].command === "npx tsc --noEmit" &&
    got[1].category === "typecheck" &&
    got[1].outcome === "failed";
  check("collect: skips non-run_command + non-verification, classifies rest in order", ok, got);
}

check("collect empty log → []", collectVerificationCommands([]).length === 0, collectVerificationCommands([]));
check("collect null → []", collectVerificationCommands(null as never).length === 0, []);

// ── UI deriver: mirror of src/ui/index.html#deriveVerificationBannerOverride ──
// KEEP IN SYNC with the source. If you change one, change both.

function deriveVerificationBannerOverride(reason: string, verificationCommands: unknown): { cls: string; label: string; note: string } | null {
  const cmds = Array.isArray(verificationCommands) ? verificationCommands : [];
  const eligibleReasons = new Set(["tests_skipped_no_infra", "tests_skipped", "no_verification_attempted", "tests_inconclusive"]);
  if (!eligibleReasons.has(reason)) return null;
  if (cmds.length === 0) return null;
  const lastByCategory = (cat: string) => {
    for (let i = cmds.length - 1; i >= 0; i -= 1) {
      const c = cmds[i] as { category?: string };
      if (c && c.category === cat) return cmds[i] as { category: string; outcome: string };
    }
    return null;
  };
  const lastBuild = lastByCategory("build");
  const lastTypecheck = lastByCategory("typecheck");
  if (lastBuild) {
    if (lastBuild.outcome === "passed") return { cls: "reason-safe", label: "Build passed", note: "Agent ran build verification successfully" };
    if (lastBuild.outcome === "failed") return { cls: "reason-bad", label: "Build failed", note: "Build error reported — review manually" };
    return { cls: "reason-warn", label: "Build attempted", note: "Agent ran build but outcome was unclear" };
  }
  if (lastTypecheck) {
    if (lastTypecheck.outcome === "passed") return { cls: "reason-safe", label: "Typecheck passed", note: "Agent verified via typecheck" };
    if (lastTypecheck.outcome === "failed") return { cls: "reason-bad", label: "Typecheck failed", note: "Review type errors" };
    return { cls: "reason-warn", label: "Typecheck attempted", note: "Agent ran typecheck but outcome was unclear" };
  }
  return null;
}

// 1. tests_passed → no override (defer to existing path)
check(
  "deriver: tests_passed reason → null override",
  deriveVerificationBannerOverride("tests_passed", [{ command: "npm run build", category: "build", outcome: "passed" }]) === null,
  null
);

// 2. tests_failed → no override
check(
  "deriver: tests_failed reason → null override",
  deriveVerificationBannerOverride("tests_failed", [{ command: "npm run build", category: "build", outcome: "failed" }]) === null,
  null
);

// 3. tests_skipped_no_infra + no commands → null (default path)
check(
  "deriver: skipped + empty commands → null",
  deriveVerificationBannerOverride("tests_skipped_no_infra", []) === null,
  null
);

// 4. tests_skipped_no_infra + 1 passed build → Build passed
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npm run build", category: "build", outcome: "passed" },
  ]);
  check("deriver: skipped + 1 passed build → Build passed", got?.label === "Build passed" && got?.cls === "reason-safe", got);
}

// 5. tests_skipped_no_infra + 1 failed build → Build failed
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npm run build", category: "build", outcome: "failed" },
  ]);
  check("deriver: skipped + 1 failed build → Build failed", got?.label === "Build failed" && got?.cls === "reason-bad", got);
}

// 6. multiple builds, last passed → Build passed
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npm run build", category: "build", outcome: "failed" },
    { command: "npm run build", category: "build", outcome: "passed" },
  ]);
  check("deriver: multi-build, last passed → Build passed", got?.label === "Build passed", got);
}

// 7. multiple builds, last failed → Build failed
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npm run build", category: "build", outcome: "passed" },
    { command: "npm run build", category: "build", outcome: "failed" },
  ]);
  check("deriver: multi-build, last failed → Build failed", got?.label === "Build failed", got);
}

// 8. only typecheck passed → Typecheck passed
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npx tsc --noEmit", category: "typecheck", outcome: "passed" },
  ]);
  check("deriver: typecheck only, passed → Typecheck passed", got?.label === "Typecheck passed", got);
}

// 9. build passed AND typecheck passed → Build wins
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npx tsc --noEmit", category: "typecheck", outcome: "passed" },
    { command: "npm run build", category: "build", outcome: "passed" },
  ]);
  check("deriver: build + typecheck both passed → Build wins", got?.label === "Build passed", got);
}

// 10. unknown verdict reason (not in eligible set) + commands → null
check(
  "deriver: unknown reason → null override",
  deriveVerificationBannerOverride("verification_failed_staged", [
    { command: "npm run build", category: "build", outcome: "passed" },
  ]) === null,
  null
);

// 11. tests_inconclusive reason eligible
{
  const got = deriveVerificationBannerOverride("tests_inconclusive", [
    { command: "npx tsc --noEmit", category: "typecheck", outcome: "passed" },
  ]);
  check("deriver: tests_inconclusive + typecheck passed → Typecheck passed", got?.label === "Typecheck passed", got);
}

// 12. no_verification_attempted reason eligible
{
  const got = deriveVerificationBannerOverride("no_verification_attempted", [
    { command: "npm run build", category: "build", outcome: "passed" },
  ]);
  check("deriver: no_verification_attempted + build passed → Build passed", got?.label === "Build passed", got);
}

// 13. Build with unknown outcome → "Build attempted" neutral
{
  const got = deriveVerificationBannerOverride("tests_skipped_no_infra", [
    { command: "npm run build", category: "build", outcome: "unknown" },
  ]);
  check("deriver: build outcome unknown → Build attempted (neutral)", got?.label === "Build attempted" && got?.cls === "reason-warn", got);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[verdict-message-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
