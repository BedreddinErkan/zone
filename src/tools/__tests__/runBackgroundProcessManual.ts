/**
 * Manual fixture test for backgroundProcessRegistry (Tur 1).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/tools/__tests__/runBackgroundProcessManual.ts
 *
 * Spawns real child processes. Case (g) skips automatically when pgrep
 * is unavailable.
 */
import { execSync } from "node:child_process";

const {
  start,
  read,
  kill,
  list,
  killAllForRun,
  _resetForTests,
} = await import("../../../dist/tools/backgroundProcessRegistry.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`         got: ${JSON.stringify(got)?.slice(0, 400)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  pollMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(pollMs);
  }
  return pred();
}

const REPO_CWD = "/tmp";

let exitCode = 0;
try {
  // ===================================================================
  // a. start → exit → poll returns eof:true
  // ===================================================================
  {
    const runId = "test-a";
    const r = start({
      runId,
      command: "echo hello && exit 0",
      cwd: REPO_CWD,
    });
    check(
      "case a start succeeded",
      r.success === true && typeof (r as { handle: string }).handle === "string",
      r
    );
    if (r.success) {
      const handle = r.handle;
      // Wait for child exit + ring-buffer drain (data events fire async).
      await waitFor(() => {
        const probe = read({ runId, handle, sinceOffset: null, maxBytes: 4096 });
        return probe.success && probe.eof === true && probe.output.includes("hello");
      }, 3000);
      const final = read({ runId, handle, sinceOffset: null, maxBytes: 4096 });
      check(
        "case a output contains 'hello' and eof=true, exitCode=0",
        final.success === true &&
          final.output.includes("hello") &&
          final.eof === true &&
          final.exitCode === 0,
        final
      );
    }
    _resetForTests();
  }

  // ===================================================================
  // b. start long-running → kill → eof
  // ===================================================================
  {
    const runId = "test-b";
    const r = start({
      runId,
      command: "sleep 30",
      cwd: REPO_CWD,
    });
    check("case b started long-running sleep", r.success === true, r);
    if (r.success) {
      const handle = r.handle;
      const k = await kill({ runId, handle, signal: "SIGTERM" });
      check(
        "case b kill returned success",
        k.success === true,
        k
      );
      const reaped = await waitFor(() => {
        const probe = read({ runId, handle, sinceOffset: null, maxBytes: 1024 });
        return probe.success && probe.eof === true;
      }, 3000);
      const final = read({ runId, handle, sinceOffset: null, maxBytes: 1024 });
      check(
        "case b process is eof within 3s of kill",
        reaped && final.success === true && final.eof === true,
        { reaped, final }
      );
    }
    _resetForTests();
  }

  // ===================================================================
  // c. ring buffer overflow — emit ~1 MB, ring keeps last 256 KB
  // ===================================================================
  {
    const runId = "test-c";
    const r = start({
      runId,
      command:
        `node -e "for(let i=0;i<10000;i++) console.log('x'.repeat(99))"`,
      cwd: REPO_CWD,
    });
    check("case c started overflow producer", r.success === true, r);
    if (r.success) {
      const handle = r.handle;
      // Wait for full exit + drain.
      await waitFor(() => {
        const probe = read({ runId, handle, sinceOffset: 0, maxBytes: 1024 });
        return probe.success && probe.eof === true;
      }, 5000);
      // Read with explicit since_offset:0 to assert truncated:true
      // and confirm output never exceeds 65536 (max_bytes cap).
      const cappedRead = read({
        runId,
        handle,
        sinceOffset: 0,
        maxBytes: 65536,
      });
      check(
        "case c read with since_offset=0 returns truncated=true",
        cappedRead.success === true && cappedRead.truncated === true,
        cappedRead
      );
      check(
        "case c output length ≤ 65536 (max_bytes cap honored)",
        cappedRead.success === true && cappedRead.output.length <= 65536,
        { len: cappedRead.success ? cappedRead.output.length : -1 }
      );
      // newOffset should be roughly 1 MB total
      check(
        "case c newOffset reflects ≥ 800k bytes processed",
        cappedRead.success === true && cappedRead.newOffset >= 800_000,
        { newOffset: cappedRead.success ? cappedRead.newOffset : -1 }
      );
    }
    _resetForTests();
  }

  // ===================================================================
  // d. offset-based incremental read
  // ===================================================================
  {
    const runId = "test-d";
    const r = start({
      runId,
      command:
        `node -e "for(let i=0;i<10;i++){process.stdout.write('line '+i+'\\n');}"`,
      cwd: REPO_CWD,
    });
    check("case d started 10-line producer", r.success === true, r);
    if (r.success) {
      const handle = r.handle;
      await waitFor(() => {
        const probe = read({ runId, handle, sinceOffset: null, maxBytes: 4096 });
        return probe.success && probe.eof === true;
      }, 3000);

      const first = read({
        runId,
        handle,
        sinceOffset: null,
        maxBytes: 50,
      });
      check(
        "case d first read returns ≤ 50 bytes with newOffset > 0",
        first.success === true &&
          first.output.length <= 50 &&
          first.newOffset > 0,
        { len: first.success ? first.output.length : -1, ofs: first.success ? first.newOffset : -1 }
      );
      const second = read({
        runId,
        handle,
        sinceOffset: first.success ? first.newOffset : 0,
        maxBytes: 4096,
      });
      check(
        "case d second read at newOffset returns empty output",
        second.success === true && second.output === "",
        second
      );
    }
    _resetForTests();
  }

  // ===================================================================
  // e. concurrency cap — 4th start fails, kill one, retry succeeds
  // ===================================================================
  {
    const runId = "test-e";
    const handles: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = start({ runId, command: "sleep 30", cwd: REPO_CWD });
      if (r.success) handles.push(r.handle);
    }
    check("case e three sleeps started", handles.length === 3, { handles });
    const fourth = start({ runId, command: "sleep 30", cwd: REPO_CWD });
    check(
      "case e 4th start rejected with 'max background processes' error",
      fourth.success === false &&
        /max background processes reached/.test((fourth as { error: string }).error),
      fourth
    );
    if (handles.length > 0) {
      const k = await kill({ runId, handle: handles[0], signal: "SIGKILL" });
      check("case e kill of first slot succeeded", k.success === true, k);
      // Give kernel a beat to mark eof.
      await waitFor(() => {
        const probe = read({
          runId,
          handle: handles[0],
          sinceOffset: null,
          maxBytes: 64,
        });
        return probe.success && probe.eof === true;
      }, 3000);
      const retry = start({ runId, command: "sleep 30", cwd: REPO_CWD });
      check(
        "case e 4th start now succeeds after kill",
        retry.success === true,
        retry
      );
    }
    await killAllForRun(runId);
    _resetForTests();
  }

  // ===================================================================
  // f. killAllForRun isolation — runA bg processes killed; runB intact
  // ===================================================================
  {
    const runA = "test-f-a";
    const runB = "test-f-b";
    const a1 = start({ runId: runA, command: "sleep 30", cwd: REPO_CWD });
    const a2 = start({ runId: runA, command: "sleep 30", cwd: REPO_CWD });
    const b1 = start({ runId: runB, command: "sleep 30", cwd: REPO_CWD });
    check(
      "case f three processes started across two runs",
      a1.success && a2.success && b1.success,
      { a1, a2, b1 }
    );
    const killedA = await killAllForRun(runA);
    check(
      "case f killAllForRun(runA) reports killed=2",
      killedA.killed === 2,
      killedA
    );
    if (b1.success) {
      // runB process should still be alive (eof=false) right after killing runA.
      const bProbe = read({
        runId: runB,
        handle: b1.handle,
        sinceOffset: null,
        maxBytes: 64,
      });
      check(
        "case f runB process unaffected by runA cleanup (eof still false)",
        bProbe.success === true && bProbe.eof === false,
        bProbe
      );
    }
    const killedB = await killAllForRun(runB);
    check(
      "case f killAllForRun(runB) reports killed=1",
      killedB.killed === 1,
      killedB
    );
    _resetForTests();
  }

  // ===================================================================
  // g. group-kill (POSIX only, skip-guarded)
  // ===================================================================
  {
    let pgrepAvailable = false;
    try {
      execSync("pgrep --version", { stdio: "ignore" });
      pgrepAvailable = process.platform !== "win32";
    } catch {
      pgrepAvailable = false;
    }
    if (!pgrepAvailable) {
      console.log("[skip case g] pgrep unavailable on this platform");
    } else {
      const runId = "test-g";
      // Two backgrounded sleeps under one shell. We don't need a tag —
      // pgrep -P <shell_pid> counts direct children of OUR shell only,
      // which isolates us from any unrelated `sleep 60` on the system.
      const r = start({
        runId,
        command: `sh -c "sleep 60 & sleep 60 & wait"`,
        cwd: REPO_CWD,
      });
      check("case g shell-with-children spawned", r.success === true, r);
      const shellPid =
        r.success && (r as { pid: number | null }).pid !== null
          ? (r as { pid: number }).pid
          : null;

      function countShellChildren(): number {
        if (shellPid === null) return -1;
        try {
          const out = execSync(`pgrep -P ${shellPid} 2>/dev/null || true`, {
            encoding: "utf8",
          });
          return out.trim().split("\n").filter(Boolean).length;
        } catch {
          return -1;
        }
      }

      // Wait briefly for the inner sleeps to launch as children of the shell.
      await waitFor(() => countShellChildren() >= 2, 2000);
      const before = countShellChildren();
      check(
        "case g 2 sleep children running under shell before kill",
        before >= 2,
        { before, shellPid }
      );
      if (r.success) {
        await kill({ runId, handle: r.handle, signal: "SIGTERM" });
      }
      // Allow up to 3s for kernel cleanup.
      await waitFor(() => countShellChildren() === 0, 3000);
      const after = countShellChildren();
      check(
        "case g zero shell children after kill (group-kill worked)",
        after === 0,
        { after }
      );
    }
    _resetForTests();
  }

  // ===================================================================
  // h. invalid handle
  // ===================================================================
  {
    const r = read({
      runId: "test-h",
      handle: "bg_nonexistent",
      sinceOffset: null,
      maxBytes: 1024,
    });
    check(
      "case h read on unknown handle returns success:false, error:'unknown handle'",
      r.success === false &&
        /unknown handle/.test((r as { error: string }).error),
      r
    );
    const k = await kill({
      runId: "test-h",
      handle: "bg_nonexistent",
      signal: null,
    });
    check(
      "case h kill on unknown handle also returns 'unknown handle'",
      k.success === false &&
        /unknown handle/.test((k as { error: string }).error),
      k
    );
    const ls = list({ runId: "test-h" });
    check(
      "case h list on empty run returns processes:[]",
      ls.success === true && ls.processes.length === 0,
      ls
    );
    _resetForTests();
  }
} finally {
  _resetForTests();
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[bg-process-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) exitCode = 1;
process.exit(exitCode);
