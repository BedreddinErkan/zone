import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { StoreProvider, useStore } from "../store.js";
import type { StoreAction } from "../store-core.js";
import { TrustPrompt } from "./TrustPrompt.js";
import { HookTrustPrompt } from "./HookTrustPrompt.js";
import { McpTrustPrompt } from "./McpTrustPrompt.js";

const mockResolveTrustApproval = vi.hoisted(() => vi.fn());
vi.mock("../../../api/trustApprovals.js", () => ({
  resolveTrustApproval: mockResolveTrustApproval,
}));

const mockRecordHooksTrust = vi.hoisted(() => vi.fn());
vi.mock("../../../api/diskTrustedHooks.js", () => ({
  recordHooksTrust: mockRecordHooksTrust,
}));

const mockRecordMcpTrust = vi.hoisted(() => vi.fn());
const mockMcpConnect = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../../../api/diskTrustedMcp.js", () => ({
  recordMcpTrust: mockRecordMcpTrust,
}));
vi.mock("../../../mcp/mcpClientManager.js", () => ({
  McpClientManager: { connect: mockMcpConnect },
}));

function wait(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dispatches PENDING_APPROVAL_SET with kind:"trust" on mount so TrustPrompt renders. */
function TrustHarness(): React.ReactElement {
  const { dispatch } = useStore();
  const fired = useRef(false);
  if (!fired.current) {
    fired.current = true;
    dispatch({ type: "PENDING_APPROVAL_SET", approvalId: "a1", runId: "r1", command: "/proj", kind: "trust" } as StoreAction);
  }
  return <TrustPrompt />;
}

describe("TrustPrompt", () => {
  beforeEach(() => { mockResolveTrustApproval.mockReset(); });

  function renderTrust() {
    return render(
      <StoreProvider initialValues={{ model: "test", capUsd: 10 }}>
        <TrustHarness />
      </StoreProvider>
    );
  }

  it("T-YES: 'y' resolves trust as approved", async () => {
    const { stdin, unmount } = renderTrust();
    await wait();
    stdin.write("y");
    await wait();
    expect(mockResolveTrustApproval).toHaveBeenCalledWith("r1", true);
    unmount();
  });

  it("T-NO: 'n' resolves trust as declined", async () => {
    const { stdin, unmount } = renderTrust();
    await wait();
    stdin.write("n");
    await wait();
    expect(mockResolveTrustApproval).toHaveBeenCalledWith("r1", false);
    unmount();
  });

  it("T-ESC: Esc does not dispatch from component (central handler owns Esc)", async () => {
    const { stdin, unmount } = renderTrust();
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(mockResolveTrustApproval).not.toHaveBeenCalled();
    unmount();
  });
});

describe("HookTrustPrompt", () => {
  beforeEach(() => { mockRecordHooksTrust.mockReset(); });

  function renderHookTrust() {
    return render(
      <StoreProvider initialValues={{
        model: "test", capUsd: 10,
        pendingHookTrust: { config: { hooks: { PreToolUse: [], PostToolUse: [] } } as never, hash: "h1", projectPath: "/proj" },
      }}>
        <HookTrustPrompt />
      </StoreProvider>
    );
  }

  it("T-YES: 'y' approves hook trust", async () => {
    const { stdin, unmount } = renderHookTrust();
    await wait();
    stdin.write("y");
    await wait(150);
    expect(mockRecordHooksTrust).toHaveBeenCalled();
    unmount();
  });

  it("T-NO: 'n' denies hook trust (no recordHooksTrust call)", async () => {
    const { stdin, unmount } = renderHookTrust();
    await wait();
    stdin.write("n");
    await wait();
    expect(mockRecordHooksTrust).not.toHaveBeenCalled();
    unmount();
  });

  it("T-ESC: Esc does not dispatch from component", async () => {
    const { stdin, unmount } = renderHookTrust();
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(mockRecordHooksTrust).not.toHaveBeenCalled();
    unmount();
  });
});

describe("McpTrustPrompt", () => {
  beforeEach(() => { mockRecordMcpTrust.mockReset(); mockMcpConnect.mockReset(); });

  function renderMcpTrust() {
    return render(
      <StoreProvider initialValues={{
        model: "test", capUsd: 10,
        pendingMcpTrust: { config: { mcpServers: { test: { command: "node", args: ["server.js"], tools: ["read"] } } } as never, hash: "h2", projectPath: "/proj" },
      }}>
        <McpTrustPrompt />
      </StoreProvider>
    );
  }

  it("T-YES: 'y' approves MCP trust", async () => {
    const { stdin, unmount } = renderMcpTrust();
    await wait();
    stdin.write("y");
    await wait(200);
    expect(mockRecordMcpTrust).toHaveBeenCalled();
    unmount();
  });

  it("T-NO: 'n' denies MCP trust (no recordMcpTrust call)", async () => {
    const { stdin, unmount } = renderMcpTrust();
    await wait();
    stdin.write("n");
    await wait();
    expect(mockRecordMcpTrust).not.toHaveBeenCalled();
    unmount();
  });

  it("T-ESC: Esc does not dispatch from component", async () => {
    const { stdin, unmount } = renderMcpTrust();
    await wait();
    stdin.write("\x1b");
    await wait();
    expect(mockRecordMcpTrust).not.toHaveBeenCalled();
    unmount();
  });
});
