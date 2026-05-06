/**
 * Manual test: resolveAgentPath path-duplication fix.
 *
 * Bug origin: smoke 02:37:47 saw an absolute path like
 *   /home/bedo/zone-landing/app/global-error.tsx
 * passed by Sonnet to write_file. The legacy safeRelPath only stripped
 * leading slashes, so path.join(repoPath, ...) duplicated the repo prefix:
 *   /home/bedo/zone-landing/home/bedo/zone-landing/app/global-error.tsx
 *
 * After fix: resolveAgentPath strips the repoPath prefix when the input is
 * absolute and inside the repo, returning a clean relative form that path.join
 * composes correctly.
 *
 * Run with:
 *   node --experimental-strip-types src/tools/__tests__/runToolPathResolutionManual.ts
 */
import path from "node:path";
import { resolveAgentPath } from "../../../dist/tools/toolExecutor.js";

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks = [];
const REPO = "/home/user/repo";

console.log("\n=== resolveAgentPath ===");

// 1. Relative path stays as-is
{
  const got = resolveAgentPath("components/Foo.tsx", REPO);
  checks.push(check(
    "relative path joined correctly",
    got === "components/Foo.tsx" && path.join(REPO, got) === "/home/user/repo/components/Foo.tsx",
    { got, joined: path.join(REPO, got) }
  ));
}

// 2. Absolute path with repoPath prefix → returns just the relative tail
{
  const got = resolveAgentPath("/home/user/repo/app/page.tsx", REPO);
  checks.push(check(
    "absolute path with repoPath prefix — no duplication",
    got === "app/page.tsx" && path.join(REPO, got) === "/home/user/repo/app/page.tsx",
    { got, joined: path.join(REPO, got) }
  ));
}

// 3. Absolute path equal to repoPath → empty
{
  const got = resolveAgentPath("/home/user/repo", REPO);
  checks.push(check(
    "absolute path equal to repoPath",
    got === "" && path.join(REPO, got) === "/home/user/repo",
    { got }
  ));
}

// 4. Absolute path outside repoPath — falls back to leading-slash strip
//    (downstream scope guard / FS lookup will surface it)
{
  const got = resolveAgentPath("/etc/passwd", REPO);
  // Should not contain repoPath prefix; downstream path.join treats as relative under repo.
  checks.push(check(
    "absolute path outside repoPath — does not escape repo via path.join",
    !path.join(REPO, got).startsWith("/etc/passwd") &&
    path.join(REPO, got) === "/home/user/repo/etc/passwd",
    { got, joined: path.join(REPO, got) }
  ));
}

// 5. ./ prefix
{
  const got = resolveAgentPath("./app/layout.tsx", REPO);
  checks.push(check(
    "./relative path joined correctly",
    path.join(REPO, got) === "/home/user/repo/app/layout.tsx",
    { got, joined: path.join(REPO, got) }
  ));
}

// 6. Trailing slash on repoPath
{
  const got = resolveAgentPath("app/page.tsx", "/home/user/repo/");
  checks.push(check(
    "relative path joined correctly when repoPath has trailing slash",
    path.join("/home/user/repo/", got) === "/home/user/repo/app/page.tsx",
    { got, joined: path.join("/home/user/repo/", got) }
  ));
}

// 7. Absolute path with repoPath that has trailing slash
{
  const got = resolveAgentPath("/home/user/repo/app/page.tsx", "/home/user/repo/");
  checks.push(check(
    "absolute path with trailing-slashed repoPath — no duplication",
    got === "app/page.tsx",
    { got }
  ));
}

// 8. Empty input
{
  const got = resolveAgentPath("", REPO);
  checks.push(check(
    "empty input returns empty string",
    got === "",
    { got }
  ));
}

// 9. Leading-slash relative-like path that isn't an absolute repo path
{
  const got = resolveAgentPath("/foo/bar", REPO);
  // Not under repoPath, so legacy strip kicks in
  checks.push(check(
    "absolute path /foo/bar (outside repoPath) treated as relative-ish (no escape)",
    !path.join(REPO, got).startsWith("/foo/bar") &&
    path.join(REPO, got) === "/home/user/repo/foo/bar",
    { got, joined: path.join(REPO, got) }
  ));
}

// 10. The exact smoke-bug case
{
  const got = resolveAgentPath("/home/bedo/zone-landing/app/global-error.tsx", "/home/bedo/zone-landing");
  const joined = path.join("/home/bedo/zone-landing", got);
  checks.push(check(
    "smoke-bug repro: doubled-path scenario produces correct single-prefix path",
    got === "app/global-error.tsx" &&
    joined === "/home/bedo/zone-landing/app/global-error.tsx" &&
    !joined.includes("zone-landing/home/bedo"),
    { got, joined }
  ));
}

// 11. Whitespace tolerance
{
  const got = resolveAgentPath("  components/Foo.tsx  ", REPO);
  checks.push(check(
    "whitespace trimmed",
    got === "components/Foo.tsx",
    { got }
  ));
}

// ── Summary ──────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
console.log("\n=== assert summary ===");
console.log(JSON.stringify(
  { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  null, 2
));
if (failed.length > 0) {
  console.log("\nFailed checks:");
  for (const f of failed) {
    console.log("  FAIL:", f.label, f.details !== undefined ? JSON.stringify(f.details) : "");
  }
  process.exitCode = 1;
}
