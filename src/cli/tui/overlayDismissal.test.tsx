import React, { type ComponentProps, type Dispatch } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { App } from "./App.js";
import { selectIsBlockingModalOpen, type StoreAction, type StoreState } from "./store-core.js";
import { createEventBus } from "../eventBus.js";
import * as registry from "../interactionRegistry.js";
import * as trustApprovals from "../../api/trustApprovals.js";
import { requestEditApproval } from "../../api/editApprovals.js";
import { listSessionsMeta } from "../../api/diskSessions.js";
import { recordHooksTrust } from "../../api/diskTrustedHooks.js";
import { recordMcpTrust } from "../../api/diskTrustedMcp.js";
import { McpClientManager } from "../../mcp/mcpClientManager.js";

// Keep input, event mapping, reducer, and approval registry real. Isolate IO boundaries.
vi.mock("../../api/diskSessions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/diskSessions.js")>(),
  listSessionsMeta: vi.fn(),
}));
vi.mock("../../api/diskTrustedHooks.js", () => ({ recordHooksTrust: vi.fn() }));
vi.mock("../../api/diskTrustedMcp.js", () => ({ recordMcpTrust: vi.fn() }));
vi.mock("../../mcp/mcpClientManager.js", () => ({ McpClientManager: { connect: vi.fn() } }));

const ESC = "\x1b";

async function mountApp(props: ComponentProps<typeof App> = {}) {
  const bus = createEventBus();
  const onSubmit = vi.fn();
  let state: StoreState;
  let dispatch: Dispatch<StoreAction>;
  const app = render(<App {...props} bus={bus} onSubmit={onSubmit}
    onStateChange={(next) => { state = next; }}
    onDispatchCapture={(next) => { dispatch = next; }} />);
  await vi.waitFor(() => expect(state!).toBeDefined());
  await vi.waitFor(() => expect(dispatch!).toBeDefined());
  return {
    ...app, bus, onSubmit,
    state: () => state!,
    dispatch: (action: StoreAction) => dispatch!(action),
    async type(text: string) {
      app.stdin.write(text);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
    },
    async submit(text: string) {
      app.stdin.write(text);
      await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
      app.stdin.write("\r");
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(text, expect.any(AbortController), "normal", undefined));
    },
  };
}

async function openSessions(app: Awaited<ReturnType<typeof mountApp>>) {
  await app.type("/sessions");
  app.stdin.write("\r");
  await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["sessions"]));
  await vi.waitFor(() => expect(app.lastFrame()).toContain("No saved sessions found."));
}

beforeEach(() => {
  vi.mocked(listSessionsMeta).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  registry.abortAll("test cleanup");
});

describe("App overlay Escape lifecycle", () => {
  it("closes /sessions and accepts a subsequent Composer submission", async () => {
    const app = await mountApp();
    await openSessions(app);
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual([]));
    expect(app.lastFrame()).not.toContain("No saved sessions found.");
    expect(app.state().modalView).toBe("none");
    expect(app.onSubmit).not.toHaveBeenCalled();
    await app.submit("after sessions");
  });

  it("settles project trust as false once, including repeated Escape and late abort", async () => {
    const app = await mountApp();
    const resolve = vi.spyOn(trustApprovals, "resolveTrustApproval");
    const settled = vi.fn();
    const ac = new AbortController();
    const decision = trustApprovals.requestTrustApproval({
      runId: "escape-trust", projectPath: "/test-project", abortSignal: ac.signal,
      emit: (event) => app.bus.emit(event.type, event),
    });
    void decision.then(settled);
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["trust"]));
    expect(registry.pendingCount("trust")).toBe(1);
    app.stdin.write(ESC);
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(false));
    await expect(decision).resolves.toBe(false);
    expect(resolve.mock.calls.every(([, approved]) => approved === false)).toBe(true);
    expect(resolve.mock.results.filter((result) => result.value?.ok)).toHaveLength(1);
    await vi.waitFor(() => expect(app.state().pendingApproval).toBeNull());
    expect(app.state().overlayStack).toEqual([]);
    expect(registry.pendingCount()).toBe(0);
    expect(app.onSubmit).not.toHaveBeenCalled();
    app.stdin.write(ESC);
    ac.abort();
    // Let Ink finish parsing the standalone Escape before sending printable input
    // (Escape immediately followed by a character is a terminal Alt-key sequence).
    await new Promise((resolve) => setTimeout(resolve, 60));
    await app.submit("after trust");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(app.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("dismisses project trust above sessions without clearing the underlying blocker", async () => {
    const app = await mountApp();
    await openSessions(app);
    const decision = trustApprovals.requestTrustApproval({
      runId: "stacked-trust", projectPath: "/test-project",
      emit: (event) => app.bus.emit(event.type, event),
    });
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["sessions", "trust"]));
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(registry.pendingCount("trust")).toBe(0));
    await expect(decision).resolves.toBe(false);
    expect(app.state().overlayStack).toEqual(["sessions"]);
    expect(app.state().modalView).toBe("sessions");
    expect(selectIsBlockingModalOpen(app.state())).toBe(true);
    expect(app.onSubmit).not.toHaveBeenCalled();
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().modalView).toBe("none"));
    await app.submit("after stacked overlays");
  });

  it("denies stacked MCP and hook trust in order without starting their approval work", async () => {
    const app = await mountApp({
      initialPendingHookTrust: {
        config: { version: 1, hooks: { PreToolUse: [{ command: "test-hook" }] } },
        hash: "hooks-hash", projectPath: "/test-project",
      },
      initialPendingMcpTrust: {
        config: { version: 1, mcpServers: { test: { command: "test-server" } } },
        hash: "mcp-hash", projectPath: "/test-project",
      },
    });
    expect(app.state().overlayStack).toEqual(["hookTrust", "mcpTrust"]);
    expect(registry.pendingCount()).toBe(0);
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["hookTrust"]));
    expect(app.state().pendingMcpTrust).toBeNull();
    expect(app.state().pendingHookTrust).not.toBeNull();
    expect(selectIsBlockingModalOpen(app.state())).toBe(true);
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(selectIsBlockingModalOpen(app.state())).toBe(false));
    expect(app.state().pendingHookTrust).toBeNull();
    expect(app.state().armedUserHooks).toBeNull();
    expect(app.state().armedMcpManager).toBeNull();
    expect(registry.pendingCount()).toBe(0);
    expect(app.onSubmit).not.toHaveBeenCalled();
    await app.submit("after startup trust");
    expect(recordHooksTrust).not.toHaveBeenCalled();
    expect(recordMcpTrust).not.toHaveBeenCalled();
    expect(McpClientManager.connect).not.toHaveBeenCalled();
  });

  it("leaves a nested model editor to consume the first Escape", async () => {
    const app = await mountApp();
    await app.type("/model");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["model"]));
    app.stdin.write("c");
    await vi.waitFor(() => expect(app.state().overlaySubModeOpen).toBe(true));
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().overlaySubModeOpen).toBe(false));
    expect(app.state().overlayStack).toEqual(["model"]);
    expect(app.state().modelCustomMode).toBe("none");
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual([]));
    await app.submit("after model editor");
  });

  it.each(["effort", "sessions"] as const)("preserves sessions below a %s layer until its own Escape", async (overlayId) => {
    const app = await mountApp();
    await openSessions(app);
    app.dispatch({ type: "OVERLAY_PUSH", overlayId });
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["sessions", overlayId]));
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().overlayStack).toEqual(["sessions"]));
    expect(app.state().modalView).toBe("sessions");
    expect(selectIsBlockingModalOpen(app.state())).toBe(true);
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().modalView).toBe("none"));
    expect(app.onSubmit).not.toHaveBeenCalled();
    await app.submit("after both layers");
  });

  it("keeps the legacy plan review pending on Escape", async () => {
    const app = await mountApp();
    // Seed this legacy dialog through the public dispatch seam; dismissal uses real stdin.
    app.dispatch({ type: "PLAN_PROPOSED", revisionId: "revision", runId: "review",
      revisionType: "mixed", revisionReason: "review", originalPlan: "old", revisedPlanSummary: "new" });
    await vi.waitFor(() => expect(app.state().modalView).toBe("plan"));
    app.stdin.write(ESC);
    app.stdin.write("unhandled text");
    app.stdin.write("\r");
    // Allow keyboard delivery, then check that the owning dialog still blocks submission.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.state().planProposal).not.toBeNull();
    expect(app.state().modalView).toBe("plan");
    expect(selectIsBlockingModalOpen(app.state())).toBe(true);
    expect(app.onSubmit).not.toHaveBeenCalled();
  });

  it("preserves safe Escape rejection of edit approvals", async () => {
    const app = await mountApp();
    const decision = requestEditApproval({ runId: "edit-run", filePath: "example.ts",
      emit: (event) => app.bus.emit(event.type, { ...event, ts: Date.now(), title: "Edit" }) });
    await vi.waitFor(() => expect(app.state().pendingApproval?.kind).toBe("edit"));
    app.stdin.write(ESC);
    await vi.waitFor(() => expect(app.state().pendingApproval).toBeNull());
    await expect(decision).resolves.toMatchObject({ approved: false });
    expect(registry.pendingCount()).toBe(0);
    expect(app.onSubmit).not.toHaveBeenCalled();
    await app.submit("after edit approval");
  });
});
