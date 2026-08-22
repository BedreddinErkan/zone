#!/usr/bin/env node
// Refuses a push that advances a ref by more than one commit, so every commit that reaches
// the remote gets its own CI run and a bisect always lands on a commit carrying independent
// signal.
//
// This exists because the rule failed once as a rule. A fix commit was created before a
// context-compaction boundary, was still unpushed when the next commit landed, and the
// following `git push` carried both — leaving c4e9238d with zero check-runs while only the
// tip b1364be3 was verified. That hole could not be closed retroactively (docs/deferred-work.md
// item 269 enumerates the five blocked paths), which is the whole argument for a mechanical
// check rather than a remembered one.
//
// Contract, from githooks(5) on this machine: stdin carries one line per ref update,
//   <local-ref> SP <local-object-name> SP <remote-ref> SP <remote-object-name> LF
// A ref being deleted has an all-zeroes <local-object-name>; a ref that does not yet exist on
// the remote has an all-zeroes <remote-object-name>. A non-zero exit aborts the push, and
// anything written to stderr reaches the user.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Object names are all-zeroes as a sentinel. Width differs between SHA-1 (40) and SHA-256
 *  (64), so match the shape rather than a fixed-width literal. */
const ZERO_OID = /^0+$/;

export const OVERRIDE_ENV = "ZONE_ALLOW_MULTI_PUSH";

/** Pure. Splits githooks(5) pre-push stdin into ref updates. Blank lines are ignored;
 *  malformed lines (fewer than four fields) are dropped rather than guessed at. */
export function parseRefUpdates(stdinText) {
  const updates = [];
  for (const rawLine of String(stdinText ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    updates.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return updates;
}

/** Pure. "delete" — the ref is going away, nothing is being added. "create" — the ref does not
 *  exist on the remote yet, so its whole history arrives at once and a one-commit rule would be
 *  nonsense. "update" — the only case this guard has an opinion about. */
export function classifyRefUpdate(update) {
  if (ZERO_OID.test(update.localOid)) return "delete";
  if (ZERO_OID.test(update.remoteOid)) return "create";
  return "update";
}

/** Pure given `countCommits`. Returns one violation per ref advancing by more than one commit.
 *  `countCommits(remoteOid, localOid)` returns the commit count, or null when it cannot be
 *  determined — an unknown count is skipped with a warning rather than blocking the push, since
 *  a guard that refuses on an unrelated git error is worse than the problem it guards. */
export function findMultiCommitPushes(updates, countCommits, warn = () => {}) {
  const violations = [];
  for (const update of updates) {
    if (classifyRefUpdate(update) !== "update") continue;
    const count = countCommits(update.remoteOid, update.localOid);
    if (count === null || !Number.isFinite(count)) {
      warn(
        `[zone-pre-push] could not count commits for ${update.remoteRef} ` +
        `(${update.remoteOid.slice(0, 8)}..${update.localOid.slice(0, 8)}) — not blocking.`
      );
      continue;
    }
    if (count > 1) {
      violations.push({ ref: update.remoteRef, count, remoteOid: update.remoteOid, localOid: update.localOid });
    }
  }
  return violations;
}

/** Pure. The refusal text names the count, because "too many" without a number sends the reader
 *  back to git to find out how bad it is. */
export function formatRefusal(violations) {
  const lines = ["[zone-pre-push] refusing: a push must advance a ref by exactly one commit."];
  for (const v of violations) {
    const plural = v.count === 1 ? "" : "s";
    lines.push(`  ${v.ref} would advance by ${v.count} commit${plural}.`);
  }
  lines.push("");
  lines.push("Push them one at a time so each commit gets its own CI run:");
  for (const v of violations) {
    lines.push(`  git log --oneline ${v.remoteOid.slice(0, 8)}..${v.localOid.slice(0, 8)}   # oldest first`);
    lines.push(`  git push origin <sha>:${v.ref.replace(/^refs\/heads\//, "")}`);
  }
  lines.push("");
  lines.push(`Deliberate exception: ${OVERRIDE_ENV}=1 git push ...`);
  return lines.join("\n");
}

/** Pure given its injected effects. Returns the process exit code. */
export function runPrePush({ stdinText, env = {}, countCommits, stderr = () => {} }) {
  const updates = parseRefUpdates(stdinText);
  const violations = findMultiCommitPushes(updates, countCommits, stderr);
  if (violations.length === 0) return 0;
  if (env[OVERRIDE_ENV] === "1") {
    const total = violations.reduce((sum, v) => sum + v.count, 0);
    stderr(`[zone-pre-push] ${OVERRIDE_ENV}=1 — allowing a push of ${total} commits.`);
    return 0;
  }
  stderr(formatRefusal(violations));
  return 1;
}

/** Effectful. null when the range cannot be resolved — most often because the remote object is
 *  not present locally, which git push will reject on its own anyway. */
export function gitCountCommits(remoteOid, localOid) {
  try {
    const out = execFileSync("git", ["rev-list", "--count", `${remoteOid}..${localOid}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function main() {
  // A TTY stdin means the hook was invoked by hand with nothing piped in; reading fd 0 would
  // block forever. There is nothing to check, so say nothing and allow.
  if (process.stdin.isTTY) return 0;
  let stdinText = "";
  try {
    stdinText = readFileSync(0, "utf8");
  } catch {
    return 0;
  }
  return runPrePush({
    stdinText,
    env: process.env,
    countCommits: gitCountCommits,
    stderr: (msg) => process.stderr.write(`${msg}\n`),
  });
}

// Resolve both sides before comparing rather than the `import.meta.url === `file://${argv[1]}``
// form used by the other scripts/ entry points. Measured: node normalises argv[1] to an absolute
// path, so that form does survive the shim's `scripts/githooks/../prePush.mjs`; what it does not
// survive is a repo path containing a space, where import.meta.url percent-encodes and the string
// compare returns false. A guard that no-ops quietly is the worst outcome available, so this one
// compares decoded paths.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main());
}
