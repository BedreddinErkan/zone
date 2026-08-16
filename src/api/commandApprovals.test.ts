import { beforeEach, describe, it, expect } from "vitest";
import {
  addTrustedCommand,
  clearTrustAllForRun,
  clearTrustedCommandsForRun,
  isCommandTrusted,
  isTrustAllForRun,
  isSafeCommand,
  isInvestigationSafeCommand,
  getSafeCommandCategory,
  requestCommandApproval,
  resolveCommandApproval,
  setTrustAllForRun,
  rejectPendingApprovalsForRun,
} from "./commandApprovals";

describe("isSafeCommand", () => {
  it("returns true for safe exact match", () => {
    expect(isSafeCommand("ls")).toBe(true);
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("npm test")).toBe(true);
  });

  it("returns true for safe prefix + args", () => {
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("cat package.json")).toBe(true);
    expect(isSafeCommand("npm run build")).toBe(true);
    expect(isSafeCommand("git diff HEAD~1")).toBe(true);
    expect(isSafeCommand("tsc --noEmit -p tsconfig.json")).toBe(true);
    expect(isSafeCommand("pnpm test --reporter=verbose")).toBe(true);
    expect(isSafeCommand("pnpm run build --no-frozen-lockfile")).toBe(true);
  });

  it("returns false for shell chains/pipes/file-redirects/subshell", () => {
    expect(isSafeCommand("ls && rm -rf /")).toBe(false);
    expect(isSafeCommand("cat package.json | grep deps")).toBe(false);
    expect(isSafeCommand("ls; cat /etc/passwd")).toBe(false);
    expect(isSafeCommand("echo `whoami`")).toBe(false);
    expect(isSafeCommand("ls > /tmp/x")).toBe(false);
    expect(isSafeCommand("ls $(whoami)")).toBe(false);
    // pipe after 2>&1 is NOT stripped — only a trailing bare 2>&1/2>/dev/null is safe
    expect(isSafeCommand("npm run build 2>&1 | head")).toBe(false);
    expect(isSafeCommand("npm run build 2>&1 | cat")).toBe(false);
  });

  it("A3: trailing 2>&1 / 2>/dev/null stripped before metachar+prefix check", () => {
    expect(isSafeCommand("npm run build 2>&1")).toBe(true);
    expect(isSafeCommand("npm test 2>/dev/null")).toBe(true);
    // write redirect to real file stays blocked
    expect(isSafeCommand("npm run build > out.txt")).toBe(false);
    // chain operators still blocked even when 2>&1 is present elsewhere
    expect(isSafeCommand("npm run build && echo done 2>&1")).toBe(false);
  });

  it("returns false for unsafe commands", () => {
    expect(isSafeCommand("rm -rf /tmp/foo")).toBe(false);
    expect(isSafeCommand("git push origin main")).toBe(false);
    expect(isSafeCommand("curl https://evil.example.com")).toBe(false);
    expect(isSafeCommand("npm publish")).toBe(false);
    expect(isSafeCommand("sudo apt install foo")).toBe(false);
  });

  it("returns false for empty/whitespace", () => {
    expect(isSafeCommand("")).toBe(false);
    expect(isSafeCommand("   ")).toBe(false);
  });

  it("does not match partial-prefix without trailing space", () => {
    expect(isSafeCommand("lsblk")).toBe(false);
    expect(isSafeCommand("npm runner")).toBe(false);
    expect(isSafeCommand("catalog")).toBe(false);
  });
});

describe("getSafeCommandCategory", () => {
  it("returns build for build commands", () => {
    expect(getSafeCommandCategory("npm run build")).toBe("build");
    expect(getSafeCommandCategory("tsc --noEmit -p tsconfig.json")).toBe("build");
    expect(getSafeCommandCategory("pnpm build")).toBe("build");
    expect(getSafeCommandCategory("pnpm run build")).toBe("build");
    expect(getSafeCommandCategory("pnpm build --filter=pkg")).toBe("build");
  });

  it("returns test for test commands", () => {
    expect(getSafeCommandCategory("npm test")).toBe("test");
    expect(getSafeCommandCategory("yarn test --watch=false")).toBe("test");
    expect(getSafeCommandCategory("pnpm test")).toBe("test");
    expect(getSafeCommandCategory("pnpm run test")).toBe("test");
    expect(getSafeCommandCategory("pnpm test --reporter=verbose")).toBe("test");
  });

  it("returns null for pnpm commands outside build/test allowlist", () => {
    expect(getSafeCommandCategory("pnpm install")).toBeNull();
    expect(getSafeCommandCategory("pnpm dlx x")).toBeNull();
    expect(getSafeCommandCategory("pnpm add react")).toBeNull();
  });

  it("returns readonly for readonly commands", () => {
    expect(getSafeCommandCategory("ls -la")).toBe("readonly");
    expect(getSafeCommandCategory("node --version")).toBe("readonly");
  });

  it("returns git for safe git commands", () => {
    expect(getSafeCommandCategory("git status")).toBe("git");
    expect(getSafeCommandCategory("git diff HEAD~1")).toBe("git");
    expect(getSafeCommandCategory("git show HEAD~1")).toBe("git");
    expect(getSafeCommandCategory("git blame src/foo.ts -L 1,20")).toBe("git");
    expect(getSafeCommandCategory("git rev-parse HEAD")).toBe("git");
    expect(getSafeCommandCategory("git rev-parse --short HEAD")).toBe("git");
  });

  it("returns null for unsafe or unmatched commands", () => {
    expect(getSafeCommandCategory("git push origin main")).toBeNull();
    expect(getSafeCommandCategory("git commit -m 'msg'")).toBeNull();
    expect(getSafeCommandCategory("ls && rm -rf /")).toBeNull();
    expect(getSafeCommandCategory("   ")).toBeNull();
  });

  describe("BYOK2 sensitive-path blocking", () => {
    it("blocks cat .env", () => {
      expect(getSafeCommandCategory("cat .env")).toBeNull();
    });

    it("blocks head .env", () => {
      expect(getSafeCommandCategory("head .env")).toBeNull();
    });

    it("blocks cat .env.local", () => {
      expect(getSafeCommandCategory("cat .env.local")).toBeNull();
    });

    it("blocks cat .env.production", () => {
      expect(getSafeCommandCategory("cat .env.production")).toBeNull();
    });

    it("does NOT block cat .env.example", () => {
      expect(getSafeCommandCategory("cat .env.example")).toBe("readonly");
    });

    it("does NOT block cat src/main.ts (regression)", () => {
      expect(getSafeCommandCategory("cat src/main.ts")).toBe("readonly");
    });

    it("does NOT block cat package.json (regression)", () => {
      expect(getSafeCommandCategory("cat package.json")).toBe("readonly");
    });
  });
});

describe("requestCommandApproval", () => {
  it("auto-approves safe commands and emits a transparency event", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "run_123",
      command: "ls -la",
      emit: (evt) => events.push(evt),
    });

    expect(result.approved).toBe(true);
    expect(result.approvalId).toBeTruthy();
    expect(events).toEqual([
      {
        type: "command_auto_approved",
        runId: "run_123",
        command: "ls -la",
        approvalId: result.approvalId,
      },
    ]);
  });

  it("resolves immediately when emit handler synchronously resolves (sync-bus regression)", async () => {
    const events: unknown[] = [];
    const promise = requestCommandApproval({
      runId: "sync-bus-run",
      command: "find . -type f | sort",
      emit: (evt) => {
        events.push(evt);
        if (evt.type === "command_approval_required") {
          resolveCommandApproval({ approvalId: evt.approvalId, approved: false, runId: evt.runId });
        }
      },
    });
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("keeps unsafe commands on the explicit approval path", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "run_123",
      command: "git push origin main",
      emit: (evt) => events.push(evt),
      timeoutMs: 1,
    });

    expect(result.approved).toBe(false);
    // Item 194: the 1ms timeout used to keep this test fast now genuinely fires and is
    // observed, so this test — which awaits full resolution — also exercises that path and
    // sees both events. The prompt-required event this test targets is still the first one.
    expect(events).toEqual([
      {
        type: "command_approval_required",
        runId: "run_123",
        command: "git push origin main",
        approvalId: result.approvalId,
      },
      {
        type: "command_denied_timeout",
        runId: "run_123",
        command: "git push origin main",
        approvalId: result.approvalId,
        reason: "approval_timeout",
      },
    ]);
  });
});

describe("trustedCommands per-runId", () => {
  beforeEach(() => {
    clearTrustedCommandsForRun("run-1");
    clearTrustedCommandsForRun("run-2");
  });

  it("starts empty", () => {
    expect(isCommandTrusted("run-1", "npm publish")).toBe(false);
  });

  it("addTrustedCommand makes it trusted", () => {
    addTrustedCommand("run-1", "npm publish");
    expect(isCommandTrusted("run-1", "npm publish")).toBe(true);
  });

  it("scope is per-runId", () => {
    addTrustedCommand("run-1", "curl example.com");
    expect(isCommandTrusted("run-1", "curl example.com")).toBe(true);
    expect(isCommandTrusted("run-2", "curl example.com")).toBe(false);
  });

  it("requires exact match (no prefix)", () => {
    addTrustedCommand("run-1", "npm publish");
    expect(isCommandTrusted("run-1", "npm publish")).toBe(true);
    expect(isCommandTrusted("run-1", "npm publish foo")).toBe(false);
    expect(isCommandTrusted("run-1", "npm publish-tool")).toBe(false);
  });

  it("clearTrustedCommandsForRun removes all and returns count", () => {
    addTrustedCommand("run-1", "cmd1");
    addTrustedCommand("run-1", "cmd2");
    expect(clearTrustedCommandsForRun("run-1")).toBe(2);
    expect(isCommandTrusted("run-1", "cmd1")).toBe(false);
    expect(clearTrustedCommandsForRun("run-1")).toBe(0);
  });

  it("ignores empty inputs", () => {
    addTrustedCommand("", "cmd");
    addTrustedCommand("run-1", "");
    expect(isCommandTrusted("", "cmd")).toBe(false);
    expect(isCommandTrusted("run-1", "")).toBe(false);
  });
});

describe("trust-all per-runId", () => {
  beforeEach(() => {
    clearTrustedCommandsForRun("run-1");
    clearTrustedCommandsForRun("run-2");
  });

  it("starts disabled", () => {
    expect(isTrustAllForRun("run-1")).toBe(false);
  });

  it("trusts any command after setTrustAllForRun", () => {
    setTrustAllForRun("run-1");
    expect(isTrustAllForRun("run-1")).toBe(true);
    expect(isCommandTrusted("run-1", "anything")).toBe(true);
  });

  it("clearTrustedCommandsForRun clears trust-all state", () => {
    setTrustAllForRun("run-1");
    expect(isCommandTrusted("run-1", "anything")).toBe(true);
    clearTrustedCommandsForRun("run-1");
    expect(isTrustAllForRun("run-1")).toBe(false);
    expect(isCommandTrusted("run-1", "anything")).toBe(false);
  });

  it("clearTrustAllForRun clears only trust-all state", () => {
    setTrustAllForRun("run-1");
    clearTrustAllForRun("run-1");
    expect(isTrustAllForRun("run-1")).toBe(false);
    expect(isCommandTrusted("run-1", "anything")).toBe(false);
  });

  it("does not bleed to another runId", () => {
    setTrustAllForRun("run-1");
    expect(isCommandTrusted("run-1", "npm publish")).toBe(true);
    expect(isCommandTrusted("run-2", "npm publish")).toBe(false);
  });

  it("coexists independently with exact-string trust on another run", () => {
    setTrustAllForRun("run-1");
    addTrustedCommand("run-2", "git push origin main");
    expect(isCommandTrusted("run-1", "npm publish")).toBe(true);
    expect(isCommandTrusted("run-2", "git push origin main")).toBe(true);
    expect(isCommandTrusted("run-2", "npm publish")).toBe(false);
  });
});

describe("resolveCommandApproval with trust", () => {
  it("persists command as trusted when approved with trust=true", async () => {
    clearTrustedCommandsForRun("run-trust");
    const events: any[] = [];
    const promise = requestCommandApproval({
      runId: "run-trust",
      command: "git push origin main",
      emit: (e) => events.push(e),
    });
    const required = events.find((e) => e.type === "command_approval_required");
    expect(required).toBeTruthy();
    const r = resolveCommandApproval({
      approvalId: required.approvalId,
      approved: true,
      runId: "run-trust",
      trust: true,
    });
    expect(r.ok).toBe(true);
    const result = await promise;
    expect(result.approved).toBe(true);
    expect(isCommandTrusted("run-trust", "git push origin main")).toBe(true);
    clearTrustedCommandsForRun("run-trust");
  });

  it("does NOT persist when approved without trust", async () => {
    clearTrustedCommandsForRun("run-no-trust");
    const events: any[] = [];
    const promise = requestCommandApproval({
      runId: "run-no-trust",
      command: "git push",
      emit: (e) => events.push(e),
    });
    const required = events.find((e) => e.type === "command_approval_required");
    resolveCommandApproval({
      approvalId: required.approvalId,
      approved: true,
      runId: "run-no-trust",
      trust: false,
    });
    await promise;
    expect(isCommandTrusted("run-no-trust", "git push")).toBe(false);
  });

  it("does NOT persist when rejected (even with trust=true)", async () => {
    clearTrustedCommandsForRun("run-reject");
    const events: any[] = [];
    const promise = requestCommandApproval({
      runId: "run-reject",
      command: "rm -rf /",
      emit: (e) => events.push(e),
    });
    const required = events.find((e) => e.type === "command_approval_required");
    resolveCommandApproval({
      approvalId: required.approvalId,
      approved: false,
      runId: "run-reject",
      trust: true,
    });
    await promise;
    expect(isCommandTrusted("run-reject", "rm -rf /")).toBe(false);
  });
});

describe("requestCommandApproval honors trusted set", () => {
  it("auto-approves trusted command without emitting popup event", async () => {
    clearTrustedCommandsForRun("run-skip");
    addTrustedCommand("run-skip", "git push origin main");
    const events: any[] = [];
    const result = await requestCommandApproval({
      runId: "run-skip",
      command: "git push origin main",
      emit: (e) => events.push(e),
    });
    expect(result.approved).toBe(true);
    expect(events.find((e) => e.type === "command_approval_required")).toBeUndefined();
    expect(events.find((e) => e.type === "command_trusted")).toBeTruthy();
    clearTrustedCommandsForRun("run-skip");
  });
});

describe("isInvestigationSafeCommand", () => {
  describe("approved — typecheck", () => {
    it("npm run typecheck", () => expect(isInvestigationSafeCommand("npm run typecheck")).toBe(true));
    it("npm run typecheck with args", () => expect(isInvestigationSafeCommand("npm run typecheck --silent")).toBe(true));
    it("npm run type-check", () => expect(isInvestigationSafeCommand("npm run type-check")).toBe(true));
    it("npm run check", () => expect(isInvestigationSafeCommand("npm run check")).toBe(true));
    it("npx tsc --noEmit", () => expect(isInvestigationSafeCommand("npx tsc --noEmit")).toBe(true));
    it("npx tsc --noEmit -p tsconfig.json", () => expect(isInvestigationSafeCommand("npx tsc --noEmit -p tsconfig.json")).toBe(true));
  });

  describe("approved — test runners", () => {
    it("npx vitest run", () => expect(isInvestigationSafeCommand("npx vitest run")).toBe(true));
    it("npx vitest run src/foo.test.ts", () => expect(isInvestigationSafeCommand("npx vitest run src/foo.test.ts")).toBe(true));
    it("npx vitest --run", () => expect(isInvestigationSafeCommand("npx vitest --run")).toBe(true));
    it("vitest run", () => expect(isInvestigationSafeCommand("vitest run")).toBe(true));
    it("npx jest", () => expect(isInvestigationSafeCommand("npx jest")).toBe(true));
    it("npx jest src/foo.test.ts", () => expect(isInvestigationSafeCommand("npx jest src/foo.test.ts")).toBe(true));
    it("pnpm test", () => expect(isInvestigationSafeCommand("pnpm test")).toBe(true));
  });

  describe("approved — lint (check-only)", () => {
    it("npx prettier --check .", () => expect(isInvestigationSafeCommand("npx prettier --check .")).toBe(true));
    it("npx prettier --check src/", () => expect(isInvestigationSafeCommand("npx prettier --check src/")).toBe(true));
  });

  describe("approved — git branch listing", () => {
    it("git branch (bare)", () => expect(isInvestigationSafeCommand("git branch")).toBe(true));
    it("git branch -a", () => expect(isInvestigationSafeCommand("git branch -a")).toBe(true));
    it("git branch -r", () => expect(isInvestigationSafeCommand("git branch -r")).toBe(true));
    it("git branch -v", () => expect(isInvestigationSafeCommand("git branch -v")).toBe(true));
    it("git branch --show-current", () => expect(isInvestigationSafeCommand("git branch --show-current")).toBe(true));
  });

  describe("blocked — not in investigation list", () => {
    it("npm install", () => expect(isInvestigationSafeCommand("npm install")).toBe(false));
    it("npm run lint", () => expect(isInvestigationSafeCommand("npm run lint")).toBe(false));
    it("npx eslint src/ (--fix risk)", () => expect(isInvestigationSafeCommand("npx eslint src/")).toBe(false));
    it("rg pattern (--exec/-x risk)", () => expect(isInvestigationSafeCommand("rg somePattern")).toBe(false));
    it("fd . (--exec risk)", () => expect(isInvestigationSafeCommand("fd .")).toBe(false));
    it("npm run dev", () => expect(isInvestigationSafeCommand("npm run dev")).toBe(false));
    it("npm run start", () => expect(isInvestigationSafeCommand("npm run start")).toBe(false));
    it("npx tsc -p (no --noEmit, writes JS)", () => expect(isInvestigationSafeCommand("npx tsc -p tsconfig.json")).toBe(false));
    it("npx tsc (bare, writes JS)", () => expect(isInvestigationSafeCommand("npx tsc")).toBe(false));
  });

  describe("blocked — metachar guard", () => {
    it("npm run typecheck && echo done", () => expect(isInvestigationSafeCommand("npm run typecheck && echo done")).toBe(false));
    it("npx vitest run | head -20", () => expect(isInvestigationSafeCommand("npx vitest run | head -20")).toBe(false));
  });

  describe("blocked — BYOK2 sensitive path", () => {
    it("cat .env", () => expect(isInvestigationSafeCommand("cat .env")).toBe(false));
    it("npx vitest run .env.test", () => expect(isInvestigationSafeCommand("npx vitest run .env.test")).toBe(false));
  });

  describe("blocked — destructive git branch flags", () => {
    it("git branch -d feature", () => expect(isInvestigationSafeCommand("git branch -d feature")).toBe(false));
    it("git branch -D feature", () => expect(isInvestigationSafeCommand("git branch -D feature")).toBe(false));
    it("git branch -m old new", () => expect(isInvestigationSafeCommand("git branch -m old new")).toBe(false));
    it("git branch --delete feature", () => expect(isInvestigationSafeCommand("git branch --delete feature")).toBe(false));
    it("git branch --move old new", () => expect(isInvestigationSafeCommand("git branch --move old new")).toBe(false));
  });

  describe("empty / edge cases", () => {
    it("empty string", () => expect(isInvestigationSafeCommand("")).toBe(false));
    it("whitespace only", () => expect(isInvestigationSafeCommand("   ")).toBe(false));
  });
});

describe("requestCommandApproval — investigationMode:true", () => {
  it("auto-approves investigation-safe command, emits command_auto_approved_investigation", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "inv-run-1",
      command: "npm run typecheck",
      investigationMode: true,
      emit: (e) => events.push(e),
    });
    expect(result.approved).toBe(true);
    expect(events).toEqual([{
      type: "command_auto_approved_investigation",
      runId: "inv-run-1",
      command: "npm run typecheck",
      approvalId: result.approvalId,
    }]);
  });

  it("auto-approves globally-safe command through the existing isSafeCommand path", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "inv-run-2",
      command: "ls -la",
      investigationMode: true,
      emit: (e) => events.push(e),
    });
    expect(result.approved).toBe(true);
    // Falls through the global isSafeCommand path — emits command_auto_approved (not investigation variant)
    expect((events[0] as any)?.type).toBe("command_auto_approved");
  });

  it("denies non-diagnostic command immediately — no pending approval, no prompt event", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "inv-run-3",
      command: "npm install",
      investigationMode: true,
      emit: (e) => events.push(e),
    });
    expect(result.approved).toBe(false);
    // Must NOT emit command_approval_required — no user prompt in investigation
    expect(events.find((e: any) => e.type === "command_approval_required")).toBeUndefined();
  });

  it("denies compound command immediately (metachar guard fires first)", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "inv-run-4",
      command: "npm run typecheck && echo done",
      investigationMode: true,
      emit: (e) => events.push(e),
    });
    // metachar guard makes isSafeCommand AND isInvestigationSafeCommand both return false → immediate deny
    expect(result.approved).toBe(false);
    expect(events.find((e: any) => e.type === "command_approval_required")).toBeUndefined();
  });

  it("without investigationMode, non-safe command goes to normal prompt path", async () => {
    const events: unknown[] = [];
    requestCommandApproval({
      runId: "inv-run-5",
      command: "npm install",
      // investigationMode NOT set
      emit: (e) => events.push(e),
      timeoutMs: 1,
    });
    // Waits for the emit to fire synchronously before checking
    await new Promise((r) => setTimeout(r, 5));
    expect(events.find((e: any) => e.type === "command_approval_required")).toBeTruthy();
  });

  // Item 190: the denial branch previously emitted on no channel at all. These pin the fix —
  // an event matching the two approving branches' own shape, plus a reason the message-render
  // layer (toolExecutor.ts) uses to distinguish this cause from the other four approved:false
  // sites in this module, none of which carry a reason.
  it("denied command emits command_denied_investigation with runId, command, approvalId, and reason", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "inv-run-6",
      command: "git ls-files",
      investigationMode: true,
      emit: (e) => events.push(e),
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("investigation_not_diagnostic");
    expect(events).toEqual([{
      type: "command_denied_investigation",
      runId: "inv-run-6",
      command: "git ls-files",
      approvalId: result.approvalId,
      reason: "investigation_not_diagnostic",
    }]);
  });

  it("negative pin: an auto-approved command never emits command_denied_investigation", async () => {
    for (const command of ["npm run typecheck", "ls -la"]) {
      const events: unknown[] = [];
      const result = await requestCommandApproval({
        runId: "inv-run-7",
        command,
        investigationMode: true,
        emit: (e) => events.push(e),
      });
      expect(result.approved).toBe(true);
      expect(events.find((e: any) => e.type === "command_denied_investigation")).toBeUndefined();
    }
  });
});

// Item 194: the four causes beyond investigation-deny — a timeout with its own reason and
// observability, and three triggers (both abort flavors plus the run-level sweep) collapsing
// to one shared "run_ending" reason with none of them observed.
describe("requestCommandApproval — timeout and run-ending reasons (item 194)", () => {
  it("timeout resolves with reason 'approval_timeout' and emits command_denied_timeout", async () => {
    const events: unknown[] = [];
    const result = await requestCommandApproval({
      runId: "reason-run-1",
      command: "git push origin main",
      emit: (e) => events.push(e),
      timeoutMs: 1,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("approval_timeout");
    const denyEvent = events.find((e: any) => e.type === "command_denied_timeout");
    expect(denyEvent).toEqual({
      type: "command_denied_timeout",
      runId: "reason-run-1",
      command: "git push origin main",
      approvalId: result.approvalId,
      reason: "approval_timeout",
    });
  });

  it("an already-aborted signal resolves with reason 'run_ending' and emits nothing new", async () => {
    const events: unknown[] = [];
    const ac = new AbortController();
    ac.abort();
    const result = await requestCommandApproval({
      runId: "reason-run-2",
      command: "git push origin main",
      emit: (e) => events.push(e),
      abortSignal: ac.signal,
      timeoutMs: 5000,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("run_ending");
    // An already-aborted signal returns before the promise executor's own trailing
    // command_approval_required emit is ever reached — nothing is emitted at all, pre-existing
    // control flow this pass's reason parameter doesn't change.
    expect(events).toEqual([]);
  });

  it("a signal aborting mid-flight resolves with reason 'run_ending' and emits nothing new", async () => {
    const events: unknown[] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const result = await requestCommandApproval({
      runId: "reason-run-3",
      command: "git push origin main",
      emit: (e) => events.push(e),
      abortSignal: ac.signal,
      timeoutMs: 5000,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("run_ending");
    expect(events.find((e: any) => e.type === "command_denied_timeout")).toBeUndefined();
  });

  it("rejectPendingApprovalsForRun firing mid-flight resolves with reason 'run_ending' and emits nothing new", async () => {
    const events: unknown[] = [];
    const promise = requestCommandApproval({
      runId: "reason-run-4",
      command: "git push origin main",
      emit: (e) => events.push(e),
      timeoutMs: 5000,
    });
    setTimeout(() => rejectPendingApprovalsForRun("reason-run-4"), 5);
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("run_ending");
    expect(events.find((e: any) => e.type === "command_denied_timeout")).toBeUndefined();
  });
});

describe("A3: stripTrailingBenignRedirect — getSafeCommandCategory", () => {
  it("npm run build 2>&1 → category 'build'", () => {
    expect(getSafeCommandCategory("npm run build 2>&1")).toBe("build");
  });

  it("npm test 2>/dev/null → category 'test'", () => {
    expect(getSafeCommandCategory("npm test 2>/dev/null")).toBe("test");
  });

  it("git status 2>&1 → category 'git'", () => {
    expect(getSafeCommandCategory("git status 2>&1")).toBe("git");
  });

  it("npm run build 2>&1 | head → null (pipe not stripped)", () => {
    expect(getSafeCommandCategory("npm run build 2>&1 | head")).toBeNull();
  });

  it("npm run build > out.txt → null (file write redirect stays blocked)", () => {
    expect(getSafeCommandCategory("npm run build > out.txt")).toBeNull();
  });

  it("npm run build && echo done 2>&1 → null (chain operator stays blocked)", () => {
    expect(getSafeCommandCategory("npm run build && echo done 2>&1")).toBeNull();
  });
});

describe("A3: stripTrailingBenignRedirect — isInvestigationSafeCommand", () => {
  it("npx tsc --noEmit 2>&1 → true", () => {
    expect(isInvestigationSafeCommand("npx tsc --noEmit 2>&1")).toBe(true);
  });

  it("npx vitest run src/foo.test.ts 2>&1 → true", () => {
    expect(isInvestigationSafeCommand("npx vitest run src/foo.test.ts 2>&1")).toBe(true);
  });

  it("npm run typecheck 2>/dev/null → true", () => {
    expect(isInvestigationSafeCommand("npm run typecheck 2>/dev/null")).toBe(true);
  });

  it("npx tsc --noEmit 2>&1 | head → false (pipe not stripped)", () => {
    expect(isInvestigationSafeCommand("npx tsc --noEmit 2>&1 | head")).toBe(false);
  });

  it("npx tsc --noEmit > errors.txt → false (file write redirect stays blocked)", () => {
    expect(isInvestigationSafeCommand("npx tsc --noEmit > errors.txt")).toBe(false);
  });
});

// Extended fresh this pass: before this change zero non-JS/TS command auto-approved for build
// or test, confirmed by running getSafeCommandCategory over a cross-ecosystem set.
describe("getSafeCommandCategory — cross-ecosystem build/test additions", () => {
  it.each([
    ["cargo test", "test"],
    ["go test", "test"],
    ["mvn test", "test"],
    ["gradle test", "test"],
    ["./gradlew test", "test"],
    ["dotnet test", "test"],
    ["bundle exec rspec", "test"],
    ["rspec", "test"],
    ["rake test", "test"],
    ["composer test", "test"],
    ["phpunit", "test"],
    ["pytest", "test"],
    ["poetry run pytest", "test"],
    ["uv run pytest", "test"],
    ["cargo check", "build"],
    ["cargo build", "build"],
    ["go build", "build"],
    ["dotnet build", "build"],
  ] as const)("%s -> %s", (command, category) => {
    expect(getSafeCommandCategory(command)).toBe(category);
  });

  // go build was deliberately excluded from the stricter read-only whitelist (writes to the
  // working directory itself, not a dedicated build/cache subdir) but meets this layer's looser
  // guarantee — the agent cannot use it to hide an edit from review either way.
  it("go build (excluded from the read-only whitelist) is still auto-approved for build here", () => {
    expect(getSafeCommandCategory("go build ./...")).toBe("build");
  });

  it.each([
    "tox",
    "bundle install",
    "composer install",
    "dotnet restore",
    "poetry install",
    "make",
    "make test",
    "make check",
  ])("%s (not extended) still needs human approval", (command) => {
    expect(getSafeCommandCategory(command)).toBeNull();
  });

  it.each(["cargo publish", "npm publish", "mvn clean install"])(
    "%s (destructive) still needs human approval after the extension",
    (command) => {
      expect(getSafeCommandCategory(command)).toBeNull();
    }
  );
});
