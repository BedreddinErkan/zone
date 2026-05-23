import { beforeEach, describe, it, expect } from "vitest";
import {
  addTrustedCommand,
  clearTrustAllForRun,
  clearTrustedCommandsForRun,
  isCommandTrusted,
  isTrustAllForRun,
  isSafeCommand,
  getSafeCommandCategory,
  requestCommandApproval,
  resolveCommandApproval,
  setTrustAllForRun,
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
  });

  it("returns false for shell chains/pipes/redirects/subshell", () => {
    expect(isSafeCommand("ls && rm -rf /")).toBe(false);
    expect(isSafeCommand("cat package.json | grep deps")).toBe(false);
    expect(isSafeCommand("ls; cat /etc/passwd")).toBe(false);
    expect(isSafeCommand("echo `whoami`")).toBe(false);
    expect(isSafeCommand("ls > /tmp/x")).toBe(false);
    expect(isSafeCommand("ls $(whoami)")).toBe(false);
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
  });

  it("returns test for test commands", () => {
    expect(getSafeCommandCategory("npm test")).toBe("test");
    expect(getSafeCommandCategory("yarn test --watch=false")).toBe("test");
  });

  it("returns readonly for readonly commands", () => {
    expect(getSafeCommandCategory("ls -la")).toBe("readonly");
    expect(getSafeCommandCategory("node --version")).toBe("readonly");
  });

  it("returns git for safe git commands", () => {
    expect(getSafeCommandCategory("git status")).toBe("git");
    expect(getSafeCommandCategory("git diff HEAD~1")).toBe("git");
  });

  it("returns null for unsafe or unmatched commands", () => {
    expect(getSafeCommandCategory("git push origin main")).toBeNull();
    expect(getSafeCommandCategory("ls && rm -rf /")).toBeNull();
    expect(getSafeCommandCategory("   ")).toBeNull();
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
    expect(events).toEqual([
      {
        type: "command_approval_required",
        runId: "run_123",
        command: "git push origin main",
        approvalId: result.approvalId,
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
