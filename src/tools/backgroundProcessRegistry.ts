import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomBytes } from "node:crypto";

const RING_CAP = 256 * 1024;
const MAX_PER_RUN = 3;
const HANDLE_PREFIX = "bg_";
const KILL_ESCALATE_MS = 2000;
const HANDLE_CHARSET = "abcdefghjkmnpqrstvwxyz23456789";

export type Handle = string;

interface BgProcess {
  handle: Handle;
  label: string | null;
  command: string;
  cwd: string;
  child: ChildProcess;
  ringBuffer: Buffer;
  ringWritten: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  startedAt: number;
  eof: boolean;
}

const registry: Map<string, Map<Handle, BgProcess>> = new Map();

export interface StartInput {
  runId: string;
  command: string;
  cwd: string;
  label?: string | null;
  env?: NodeJS.ProcessEnv;
}
export type StartResult =
  | { success: true; handle: Handle; pid: number | null; message: string }
  | { success: false; error: string };

export interface ReadInput {
  runId: string;
  handle: Handle;
  sinceOffset?: number | null;
  maxBytes?: number | null;
}
export type ReadResult =
  | {
      success: true;
      output: string;
      newOffset: number;
      eof: boolean;
      exitCode: number | null;
      truncated: boolean;
    }
  | { success: false; error: string };

export interface KillInput {
  runId: string;
  handle: Handle;
  signal?: "SIGTERM" | "SIGKILL" | null;
}
export type KillResult =
  | { success: true; exitCode: number | null; message: string }
  | { success: false; error: string };

export interface ListInput {
  runId: string;
}
export interface ListResult {
  success: true;
  processes: Array<{
    handle: Handle;
    label: string | null;
    command: string;
    pid: number | null;
    startedAt: number;
    eof: boolean;
    exitCode: number | null;
    bytesBuffered: number;
  }>;
}

function generateHandle(): Handle {
  const bytes = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i += 1) {
    s += HANDLE_CHARSET[bytes[i] % HANDLE_CHARSET.length];
  }
  return HANDLE_PREFIX + s;
}

function getRunMap(runId: string): Map<Handle, BgProcess> {
  let m = registry.get(runId);
  if (!m) {
    m = new Map();
    registry.set(runId, m);
  }
  return m;
}

function liveCount(runMap: Map<Handle, BgProcess>): number {
  let n = 0;
  for (const p of runMap.values()) {
    if (!p.eof) n += 1;
  }
  return n;
}

// Append `chunk` into `buf` (treated as a ring of length RING_CAP), starting
// at offset `ringWritten % RING_CAP`. Returns the new monotonic ringWritten.
function appendToRing(
  buf: Buffer,
  chunk: Buffer,
  ringWritten: number
): number {
  if (chunk.length === 0) return ringWritten;
  // If chunk is bigger than the ring, only the trailing RING_CAP bytes
  // can possibly be retained.
  let src = chunk;
  let drop = 0;
  if (src.length > RING_CAP) {
    drop = src.length - RING_CAP;
    src = src.subarray(drop);
  }
  const startOffset = ringWritten % RING_CAP;
  const tail = RING_CAP - startOffset;
  if (src.length <= tail) {
    src.copy(buf, startOffset);
  } else {
    src.subarray(0, tail).copy(buf, startOffset);
    src.subarray(tail).copy(buf, 0);
  }
  return ringWritten + drop + src.length;
}

// Read `length` bytes ending at `ringWritten` from `buf`. Caller guarantees
// length <= min(ringWritten, RING_CAP).
function readRingTail(
  buf: Buffer,
  ringWritten: number,
  length: number
): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const startWritten = ringWritten - length;
  const startOffset = startWritten % RING_CAP;
  const tail = RING_CAP - startOffset;
  if (length <= tail) {
    return Buffer.from(buf.subarray(startOffset, startOffset + length));
  }
  const out = Buffer.alloc(length);
  buf.subarray(startOffset).copy(out, 0);
  buf.subarray(0, length - tail).copy(out, tail);
  return out;
}

export function start(input: StartInput): StartResult {
  const runId = String(input.runId || "").trim();
  if (!runId) return { success: false, error: "runId required" };
  const command = String(input.command || "");
  if (!command) return { success: false, error: "command required" };

  const runMap = getRunMap(runId);
  if (liveCount(runMap) >= MAX_PER_RUN) {
    return {
      success: false,
      error: `max background processes reached (${MAX_PER_RUN}); kill one before starting another`,
    };
  }

  const isWindows = process.platform === "win32";
  const spawnOptions: SpawnOptions = {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWindows
      ? (process.env.ComSpec ?? "cmd.exe")
      : "/bin/sh",
  };
  if (!isWindows) {
    // POSIX: detach so the child becomes its own process group leader.
    // group-kill via process.kill(-pid, sig) walks the whole subtree.
    spawnOptions.detached = true;
  }

  let child: ChildProcess;
  try {
    child = spawn(command, spawnOptions);
  } catch (err) {
    return {
      success: false,
      error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const handle = generateHandle();
  const proc: BgProcess = {
    handle,
    label: input.label ?? null,
    command,
    cwd: input.cwd,
    child,
    ringBuffer: Buffer.alloc(RING_CAP),
    ringWritten: 0,
    exitCode: null,
    exitSignal: null,
    startedAt: Date.now(),
    eof: false,
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    proc.ringWritten = appendToRing(proc.ringBuffer, chunk, proc.ringWritten);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    proc.ringWritten = appendToRing(proc.ringBuffer, chunk, proc.ringWritten);
  });
  child.on("exit", (code, signal) => {
    proc.exitCode = code;
    proc.exitSignal = signal as NodeJS.Signals | null;
    proc.eof = true;
  });
  child.on("error", (err) => {
    const msg = `\n[zone-bg-error] ${err instanceof Error ? err.message : String(err)}\n`;
    proc.ringWritten = appendToRing(
      proc.ringBuffer,
      Buffer.from(msg, "utf8"),
      proc.ringWritten
    );
    proc.eof = true;
  });

  runMap.set(handle, proc);
  return {
    success: true,
    handle,
    pid: typeof child.pid === "number" ? child.pid : null,
    message: `started ${input.label ? `(${input.label}) ` : ""}as ${handle}`,
  };
}

export function read(input: ReadInput): ReadResult {
  const runMap = registry.get(input.runId);
  const proc = runMap?.get(input.handle);
  if (!proc) return { success: false, error: "unknown handle" };

  const cap = Math.min(
    Math.max(1, input.maxBytes ?? 8192),
    65536
  );

  let truncated = false;
  let from: number;
  if (input.sinceOffset == null) {
    from = Math.max(proc.ringWritten - cap, proc.ringWritten - RING_CAP, 0);
  } else if (input.sinceOffset < proc.ringWritten - RING_CAP) {
    truncated = true;
    from = Math.max(proc.ringWritten - cap, proc.ringWritten - RING_CAP, 0);
  } else if (input.sinceOffset >= proc.ringWritten) {
    return {
      success: true,
      output: "",
      newOffset: proc.ringWritten,
      eof: proc.eof,
      exitCode: proc.exitCode,
      truncated: false,
    };
  } else {
    from = input.sinceOffset;
  }

  let length = proc.ringWritten - from;
  if (length > cap) {
    from = proc.ringWritten - cap;
    length = cap;
  }
  if (length > RING_CAP) {
    from = proc.ringWritten - RING_CAP;
    length = RING_CAP;
  }
  const slice = readRingTail(proc.ringBuffer, proc.ringWritten, length);
  return {
    success: true,
    output: slice.toString("utf8"),
    newOffset: proc.ringWritten,
    eof: proc.eof,
    exitCode: proc.exitCode,
    truncated,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForExit(proc: BgProcess, timeoutMs: number): Promise<boolean> {
  if (proc.eof) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await delay(50);
    if (proc.eof) return true;
  }
  return proc.eof;
}

function killProcessTree(proc: BgProcess, signal: NodeJS.Signals): void {
  const pid = proc.child.pid;
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      tk.on("error", () => undefined);
    } catch {
      /* swallow */
    }
    return;
  }
  // POSIX: negative pid = process group.
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH is fine — process group already gone.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        proc.child.kill(signal);
      } catch {
        /* swallow */
      }
    }
  }
}

export async function kill(input: KillInput): Promise<KillResult> {
  const runMap = registry.get(input.runId);
  const proc = runMap?.get(input.handle);
  if (!proc) return { success: false, error: "unknown handle" };
  if (proc.eof) {
    return {
      success: true,
      exitCode: proc.exitCode,
      message: "already exited",
    };
  }
  const sig = (input.signal ?? "SIGTERM") as NodeJS.Signals;
  killProcessTree(proc, sig);
  let reaped = await waitForExit(proc, KILL_ESCALATE_MS);
  if (!reaped && process.platform !== "win32") {
    killProcessTree(proc, "SIGKILL");
    reaped = await waitForExit(proc, KILL_ESCALATE_MS);
  }
  return {
    success: true,
    exitCode: proc.exitCode,
    message: reaped ? "killed" : "kill signal sent (exit not yet observed)",
  };
}

export function list(input: ListInput): ListResult {
  const runMap = registry.get(input.runId);
  const out: ListResult["processes"] = [];
  if (runMap) {
    for (const proc of runMap.values()) {
      out.push({
        handle: proc.handle,
        label: proc.label,
        command: proc.command,
        pid: typeof proc.child.pid === "number" ? proc.child.pid : null,
        startedAt: proc.startedAt,
        eof: proc.eof,
        exitCode: proc.exitCode,
        bytesBuffered: Math.min(proc.ringWritten, RING_CAP),
      });
    }
  }
  return { success: true, processes: out };
}

export async function killAllForRun(
  runId: string
): Promise<{ killed: number }> {
  const runMap = registry.get(runId);
  if (!runMap || runMap.size === 0) return { killed: 0 };
  let killed = 0;
  for (const proc of runMap.values()) {
    if (proc.eof) continue;
    try {
      const r = await kill({ runId, handle: proc.handle, signal: "SIGTERM" });
      if (r.success) killed += 1;
    } catch (err) {
      console.error(
        "[zone-bg-cleanup-error]",
        JSON.stringify({
          runId,
          handle: proc.handle,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
  registry.delete(runId);
  return { killed };
}

export function _resetForTests(): void {
  for (const [runId, runMap] of registry) {
    for (const proc of runMap.values()) {
      if (!proc.eof) {
        try {
          killProcessTree(proc, "SIGKILL");
        } catch {
          /* swallow */
        }
      }
    }
    registry.delete(runId);
  }
}
