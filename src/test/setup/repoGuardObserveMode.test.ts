import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The behavioural proof behind homeGuard.test.ts's own claim that observe mode
 * cannot leave a file behind (ledger item 236's re-verdict, and the pass that
 * fixed it). `ZONE_REPO_GUARD_OBSERVE` is read once at module load in
 * homeGuard.ts, so no in-process toggle can exercise both the enforcing and the
 * observing branch inside one vitest worker — the only way to test the
 * observing branch for real is across a process boundary, which is what this
 * file does.
 *
 * WHAT THIS COVERS: spawns `homeGuard.test.ts`'s own "repo guard" tests as a
 * real subprocess with `ZONE_REPO_GUARD_OBSERVE=1`, then checks the repository
 * tree directly (not the subprocess's own report of itself) for the two paths
 * those tests write to. This is deliberately independent of whether the child
 * process's assertions pass — a self-test asserting its own cleanup ran proves
 * nothing if the guard itself is what is broken; checking the real filesystem
 * from the parent process is the same discipline as `output-composition.mjs`'s
 * own subprocess test in `item138Guards.test.ts`.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: the enforcing (default) branch, which
 * every other test in the suite already exercises continuously; and any write
 * surface other than the two `writeFileSync` targets `homeGuard.test.ts` uses —
 * a new self-test added there with a new target needs its own coverage here or
 * its own try/finally discipline, this file does not generalise past what it
 * spawns.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TARGET_FILE = "src/test/setup/homeGuard.test.ts";
// Three targets, not two: two of the three "repo guard" write-tests share
// __repo_guard_probe__.tmp (they run sequentially, so no race), and the third
// deliberately uses its own name — mutation-tested, not assumed, after the
// shared name let one test's missing cleanup hide behind a sibling's.
const PROBE_ROOT = path.join(REPO_ROOT, "__repo_guard_probe__.tmp");
const PROBE_SRC = path.join(REPO_ROOT, "src", "__repo_guard_probe__.tmp");
const PROBE_NAMED = path.join(REPO_ROOT, "__repo_guard_probe_named__.tmp");
const ALL_PROBES = [PROBE_ROOT, PROBE_SRC, PROBE_NAMED];

function assertProbesAbsent(label: string): void {
  for (const p of ALL_PROBES) {
    expect(fs.existsSync(p), `${label}: ${p} must not exist`).toBe(false);
  }
}

describe("observe mode cannot leave a file in the repository tree (ledger item 236)", () => {
  it("neither probe path exists before this test runs — a precondition, not the finding", () => {
    // If this fails, a prior run (or a different test) already left debris and
    // the check below would be meaningless — it would be asserting absence of
    // something that was never checked to be present in the first place.
    assertProbesAbsent("precondition");
  });

  it("running homeGuard.test.ts's repo-guard tests under ZONE_REPO_GUARD_OBSERVE=1 leaves neither probe path behind", () => {
    // JSON reporter, not the human-readable default: a text reporter's exact
    // spacing/wording is an implementation detail of vitest's own formatting,
    // not a contract this test should depend on. This shape failed once on CI
    // and not on two independent, faithful local reproductions (fresh clone,
    // fresh install, fresh build, same command sequence) — the JSON reporter
    // sidesteps that whole fragility class rather than chasing the exact byte
    // that differed under whatever CI's environment did differently.
    const jsonOut = path.join(os.tmpdir(), `zone-repo-guard-observe-${process.pid}.json`);
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/.bin/vitest",
        "run",
        TARGET_FILE,
        "-t",
        "repo guard",
        "--reporter=json",
        `--outputFile=${jsonOut}`,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ZONE_REPO_GUARD_OBSERVE: "1" },
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    // The invariant under test is file survival, not the child's exit code —
    // stated so a future reader does not "fix" this by making it require
    // status 0, which would be asserting something this file does not claim.
    try {
      assertProbesAbsent("post-observe-mode-run");
    } finally {
      // Best-effort, and genuinely best-effort rather than a formality: THIS
      // outer process is itself normally running under enforce mode, so a
      // guarded unlinkSync on a repo-tree path throws here too — caught and
      // swallowed so a cleanup failure can never replace the real assertion
      // failure above as what the test reports. If the invariant this test
      // exists to prove ever regresses, globalHome.ts's own teardown inventory
      // independently catches and names the same stray file — confirmed by
      // running exactly this regression, not assumed: the mutation that
      // produced this comment surfaced both failures in the same run.
      try {
        for (const p of ALL_PROBES) {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      } catch {
        // Swallowed deliberately — see comment above.
      }
    }

    // Confirms the subprocess actually ran a nonzero set of tests, so a silent
    // "0 tests collected" (a typo in TARGET_FILE, a filter matching nothing)
    // cannot pass by leaving no probe files because nothing ever tried to
    // write one. Reads the structured result file rather than parsing stdout —
    // this is the assertion that regressed to a fragile text-regex once and
    // was replaced, not patched, per the comment above.
    let summary: { numTotalTests?: number } | null = null;
    try {
      summary = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
    } catch (err) {
      throw new Error(
        `expected a JSON reporter result at ${jsonOut}; child exit=${result.status} ` +
          `signal=${result.signal} stderr=${result.stderr}: ${String(err)}`
      );
    } finally {
      if (fs.existsSync(jsonOut)) fs.unlinkSync(jsonOut);
    }
    expect(summary?.numTotalTests ?? 0).toBeGreaterThan(0);
  });
});
