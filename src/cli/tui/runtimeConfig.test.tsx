import React, { type ComponentProps, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as renderTest } from "ink-testing-library";
import { render as renderInk } from "ink";
import { App } from "./App.js";
import { runTui } from "./index.js";
import { runOneShotInner } from "../dispatch.js";
import { loadDiskModel, loadDiskModelSync, saveDiskModel, type DiskModelSettings } from "../../api/diskModel.js";
import { loadDiskKeys } from "../../api/diskKeys.js";
import { buildSessionWindow } from "../../llm/sessionWindow.js";
import { getRequestContext } from "../../llm/openaiContext.js";
import { readGatewayProfilesSync } from "../../llm/gatewayProfiles.js";
import { USER_FACING_MODELS } from "../../llm/modelRegistry.js";
import { visibleModelRows } from "./modelPickerList.js";
import { readDailyUsdCapOverride, writeDailyUsdCapOverride } from "../../visual/tierSettings.js";
import type { CliFlags } from "../config.js";
import type { StoreState, StoreAction } from "./store-core.js";

vi.mock("ink", async (original) => ({ ...await original<typeof import("ink")>(), render: vi.fn() }));
vi.mock("../dispatch.js", () => ({ runOneShotInner: vi.fn(), buildResumeFlowInput: vi.fn() }));
vi.mock("./stdoutShield.js", () => ({
  applyStdoutInterception: () => () => {}, applyStderrInterception: () => () => {},
}));
vi.mock("../../api/diskModel.js", () => ({ loadDiskModel: vi.fn(), loadDiskModelSync: vi.fn(), saveDiskModel: vi.fn() }));
vi.mock("../../api/diskKeys.js", () => ({ loadDiskKeys: vi.fn() }));
vi.mock("../../llm/gatewayProfiles.js", async (original) => ({
  ...await original<typeof import("../../llm/gatewayProfiles.js")>(), readGatewayProfilesSync: vi.fn(),
}));
vi.mock("../../api/diskTrust.js", () => ({ loadDiskTrust: async () => ({ trustedPrefixes: [] }), diskTrustPrefixes: () => [] }));
vi.mock("../../api/diskHooks.js", () => ({ loadDiskHooks: async () => null }));
vi.mock("../../api/diskMcp.js", () => ({ loadDiskMcp: async () => null }));
vi.mock("./userCommands.js", () => ({ loadUserCommands: async () => [] }));
vi.mock("../../api/diskRunEnvelope.js", async (original) => ({
  ...await original<typeof import("../../api/diskRunEnvelope.js")>(), latestResumableEnvelope: async () => null,
}));
vi.mock("../../api/diskSessions.js", async (original) => ({
  ...await original<typeof import("../../api/diskSessions.js")>(), saveSession: vi.fn(), pruneOldSessions: vi.fn(),
}));
vi.mock("../../usage/usageTracker.js", async (original) => ({
  ...await original<typeof import("../../usage/usageTracker.js")>(), getUsage: async () => ({ totalCostUsd: 0 }),
}));
vi.mock("../../llm/sessionWindow.js", async (original) => ({
  ...await original<typeof import("../../llm/sessionWindow.js")>(), buildSessionWindow: vi.fn(),
}));
vi.mock("../../core/conversationFilesystemStore.js", async (original) => ({
  ...await original<typeof import("../../core/conversationFilesystemStore.js")>(), appendFsConversationEvent: async () => true,
  readFsConversationEvents: () => [],
}));
vi.mock("../../visual/tierSettings.js", () => ({ readDailyUsdCapOverride: vi.fn(), writeDailyUsdCapOverride: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync: () => "test-identity",
}));

const SAVED: DiskModelSettings = {
  version: 2, model: "claude-sonnet-4-6", provider: "anthropic", effort: "medium",
  summaryFormat: "compact", memoryEnabled: false, commitOnSuccess: false,
  webSearchEnabled: true, planDepth: "quick", updatedAt: "2026-01-01T00:00:00Z",
};

let screen: ReturnType<typeof renderTest> | undefined;
let state: StoreState;
let appProps: ComponentProps<typeof App>;
let dispatch: React.Dispatch<StoreAction>;
let finish: (() => void) | undefined;
let lifecycle: Promise<void> | undefined;
let contexts: (number | undefined)[];
let listeners: Map<string | symbol, Function[]>;

beforeEach(async () => {
  listeners = new Map(process.eventNames().map((event) => [event, process.listeners(event)]));
  screen = undefined;
  finish = undefined;
  lifecycle = undefined;
  contexts = [];
  for (const key of ["ZONE_MODEL", "ZONE_PROVIDER", "ZONE_EFFORT", "ZONE_DAILY_USD_CAP", "ZONE_ORG_POLICY_PATH", "ZONE_RESUME_ENVELOPE_ID"]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-anthropic");
  vi.stubEnv("OPENAI_API_KEY", "fixture-openai");
  vi.mocked(loadDiskModel).mockResolvedValue({ ...SAVED });
  vi.mocked(loadDiskModelSync).mockReturnValue({ ...SAVED });
  vi.mocked(saveDiskModel).mockResolvedValue(undefined);
  vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [] });
  vi.mocked(readGatewayProfilesSync).mockReturnValue([]);
  vi.mocked(buildSessionWindow).mockReturnValue("");
  vi.mocked(runOneShotInner).mockImplementation(async () => {
    contexts.push(getRequestContext()?.dailyUsdCap);
    return { ok: true, fileDiffs: [] } as never;
  });
  const actual = await vi.importActual<typeof import("ink")>("ink");
  vi.mocked(renderInk).mockImplementation(((tree: ReactElement<{ children: ReactElement<ComponentProps<typeof App>> }>, options: { stdin?: unknown }) => {
    if (options?.stdin) return actual.render(tree, options as never);
    const child = tree.props.children;
    appProps = child.props;
    const wrapped = React.cloneElement(tree, {}, React.cloneElement(child, {
      onStateChange: (next: StoreState) => { state = next; appProps.onStateChange?.(next); },
      onDispatchCapture: (next: React.Dispatch<StoreAction>) => { dispatch = next; appProps.onDispatchCapture?.(next); },
    }));
    screen = renderTest(wrapped);
    const exited = new Promise<void>((resolve) => { finish = resolve; });
    return { unmount: screen.unmount, waitUntilExit: () => exited };
  }) as typeof renderInk);
});

afterEach(async () => {
  cleanup();
  finish?.();
  await lifecycle;
  for (const event of process.eventNames()) {
    for (const listener of process.listeners(event)) {
      if (!listeners.get(event)?.includes(listener)) process.removeListener(event, listener as never);
    }
  }
  vi.unstubAllEnvs();
});

async function start(flags: CliFlags = {}, initialPrompt?: string) {
  lifecycle = runTui(initialPrompt, flags);
  await vi.waitFor(() => expect(screen).toBeDefined());
  await vi.waitFor(() => expect(state?.config).toBeDefined());
}

async function type(text: string) {
  screen!.stdin.write(text);
  await vi.waitFor(() => expect(screen!.lastFrame()).toContain(text));
}

async function command(text: string) {
  await type(text);
  screen!.stdin.write("\r");
}

async function submit(text: string, count: number) {
  await command(text);
  await vi.waitFor(() => expect(runOneShotInner).toHaveBeenCalledTimes(count));
  return vi.mocked(runOneShotInner).mock.calls[count - 1]![1];
}

async function selectModel(id: string) {
  await command("/model");
  await vi.waitFor(() => expect(state.overlayStack).toEqual(["model"]));
  const rows = visibleModelRows(USER_FACING_MODELS, state.providersWithKey, state.modelSettings!.model);
  const index = rows.findIndex((row) => row.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  for (let i = state.modelSelectedIndex; i < index; i++) {
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(state.modelSelectedIndex).toBe(i + 1));
  }
  screen!.stdin.write("\r");
  await vi.waitFor(() => expect(state.overlayStack).toEqual([]));
}

describe("runTui → App keyboard → real prompt implementation → dispatch config", () => {
  it("switches providers without forwarding inactive credentials or altering earlier snapshots", async () => {
    await start();
    const first = await submit("vendor one", 1);
    await selectModel("gpt-5.4");
    const next = await submit("vendor two", 2);
    expect(next.provider).toBe("openai");
    expect(next.model).toBe("gpt-5.4");
    expect(next.openaiApiKey === "fixture-openai").toBe(true);
    expect(next.anthropicApiKey).toBeUndefined();
    expect(next.profile).toBeUndefined();
    expect(next.profileApiKey).toBeUndefined();
    expect(next.planDepth).toBe("quick");
    expect(next.memoryEnabled).toBe(false);
    expect(first.provider).toBe("anthropic");
    expect(first.openaiApiKey).toBeUndefined();
    expect(first.anthropicApiKey === "fixture-anthropic").toBe(true);
    // Credentials remain available in the TUI authority for a later switch back.
    expect(state.config.anthropicApiKey === "fixture-anthropic").toBe(true);
    expect(vi.mocked(saveDiskModel).mock.calls.at(-1)?.[1].planDepth).toBe("quick");
    expect(vi.mocked(saveDiskModel).mock.calls.at(-1)?.[1].memoryEnabled).toBe(false);
  });

  it("clears only effective gateway credentials and deep-copies earlier profile snapshots", async () => {
    const profile = {
      id: "fixture-proxy", protocol: "openai-chat" as const, adapterProvider: "openai" as const,
      baseUrl: "https://fixture.invalid/v1", keyRef: { envVar: "FIXTURE_PROXY_KEY", keyExample: "fixture" },
    };
    vi.mocked(readGatewayProfilesSync).mockReturnValue([profile]);
    vi.mocked(loadDiskKeys).mockResolvedValue({ version: 1, keys: [{ provider: "fixture-proxy", key: "fixture-proxy", addedAt: "2026-01-01" }] });
    await start({ provider: "fixture-proxy", model: "custom-model" });
    const first = await submit("gateway task", 1);
    expect(first.profileApiKey === "fixture-proxy").toBe(true);
    expect(first.anthropicApiKey).toBeUndefined();
    expect(first.openaiApiKey).toBeUndefined();
    expect(first.profile?.keyRef).not.toBe(state.config.profile?.keyRef);
    state.config.profile!.keyRef.envVar = "CHANGED_FIXTURE";
    expect(first.profile?.keyRef.envVar).toBe("FIXTURE_PROXY_KEY");
    await selectModel("gpt-5.4");
    const next = await submit("builtin task", 2);
    expect(next.profile).toBeUndefined();
    expect(next.profileApiKey).toBeUndefined();
    expect(next.pendingProfileId).toBeUndefined();
    expect(state.config.profileApiKey).toBeUndefined();
    expect(state.activeProfile).toBeNull();
    expect((await loadDiskKeys()).keys).toHaveLength(1);
  });

  it("keeps resolved startup flags until a live change, including unrelated setting changes", async () => {
    await start({ model: "gpt-5.4", effort: "high", forceTier: "simple", trust: false, maxTurns: 3, maxBudgetUsd: 2 });
    const first = await submit("first task", 1);
    expect(first.model).toBe("gpt-5.4");
    expect(first.provider).toBe("openai");
    expect(first.effort).toBe("high");
    await command("/summary");
    await vi.waitFor(() => expect(state.overlayStack).toEqual(["summary"]));
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(state.summarySelectedIndex).toBe(1));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.config.summaryFormat).toBe("detailed"));
    const next = await submit("second task", 2);
    expect(next.model).toBe("gpt-5.4");
    expect(next.effort).toBe("high");
    expect(next.summaryFormat).toBe("detailed");
    expect(next.forceTier).toBe("simple");
    expect(next.trust).toBe(false);
    expect(next.maxTurns).toBe(3);
    expect(next.maxBudgetUsd).toBe(2);
    expect(next.autoApprove).toBe(false);
    expect("dailyCapUsd" in next).toBe(false);
    expect("dailyCapConstraints" in next).toBe(false);
    expect(first.summaryFormat).toBe("compact");
    expect(next).not.toBe(first);
  });

  it("applies keyboard web-search, planning-depth and effort changes after overlay closure", async () => {
    await start();
    const first = await submit("before settings", 1);
    await command("/websearch");
    await vi.waitFor(() => expect(state.modelSettings?.webSearchEnabled).toBe(false));
    await command("/plan-mode");
    await vi.waitFor(() => expect(state.overlayStack).toEqual(["planMode"]));
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(state.planModeSelectedIndex).toBe(1));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.overlayStack).toEqual([]));
    await command("/effort");
    await vi.waitFor(() => expect(state.overlayStack).toEqual(["effort"]));
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(state.effortSelectedIndex).toBe(2));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.overlayStack).toEqual([]));
    const next = await submit("after settings", 2);
    expect(next.webSearchEnabled).toBe(false);
    expect(next.planDepth).toBe("strict");
    expect(next.effort).toBe("high");
    expect(first.webSearchEnabled).toBe(true);
    expect(first.planDepth).toBe("quick");
  });

  it.each([[5, 5], [20, 10]])("/limits %s respects the environment ceiling in display, dispatch and gate context", async (requested, effective) => {
    vi.stubEnv("ZONE_DAILY_USD_CAP", "10");
    await start();
    await command("/limits");
    await vi.waitFor(() => expect(state.overlayStack).toEqual(["limits"]));
    // Editor starts with 10.00; clear five characters and enter a new limit.
    for (let i = 0; i < 5; i++) screen!.stdin.write("\x7f");
    for (const ch of String(requested)) screen!.stdin.write(ch);
    await vi.waitFor(() => expect(screen!.lastFrame()).toContain(`New cap: $${requested}`));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.overlayStack).toEqual([]));
    const config = await submit("budgeted task", 1);
    expect(config.dailyUsdCap).toBe(effective);
    expect(state.config.dailyCapUsd).toBe(effective);
    expect(state.statusBar.capUsd).toBe(effective);
    expect(contexts).toEqual([effective]);
    expect(writeDailyUsdCapOverride).toHaveBeenCalledWith(requested);
  });

  it("captures before async memory loading and does not mutate an active run", async () => {
    vi.mocked(loadDiskModel).mockResolvedValue({ ...SAVED, memoryEnabled: true });
    let releaseMemory!: (value: string) => void;
    vi.mocked(buildSessionWindow).mockReturnValueOnce(new Promise<string>((resolve) => { releaseMemory = resolve; }) as unknown as string);
    await start();
    await command("first pending task");
    await vi.waitFor(() => expect(buildSessionWindow).toHaveBeenCalledOnce());
    expect(runOneShotInner).not.toHaveBeenCalled();
    await command("/websearch");
    await vi.waitFor(() => expect(state.modelSettings?.webSearchEnabled).toBe(false));
    releaseMemory("");
    await vi.waitFor(() => expect(runOneShotInner).toHaveBeenCalledOnce());
    const first = vi.mocked(runOneShotInner).mock.calls[0]![1];
    expect(first.webSearchEnabled).toBe(true);
    const next = await submit("next task", 2);
    expect(next.webSearchEnabled).toBe(false);
    expect(first.webSearchEnabled).toBe(true);
  });

  it("keeps an in-flight dispatch snapshot while later settings change", async () => {
    let complete!: (result: never) => void;
    vi.mocked(runOneShotInner).mockImplementationOnce((_prompt, _config, runId, options) => {
      options?.onProgress?.({ progress: { type: "agent_loop_start", runId, ts: Date.now(), title: "Starting" } });
      return new Promise((resolve) => { complete = resolve; });
    });
    await start();
    const first = await submit("in flight", 1);
    await vi.waitFor(() => expect(state.runState).toBe("running"));
    await command("/limits");
    await vi.waitFor(() => expect(screen!.lastFrame()).toContain("Cannot change /limits"));
    // Settings commands are gated while running. A late settings action must
    // nevertheless remain isolated from an execution already handed to dispatch.
    dispatch({ type: "LIMITS_APPLY", capUsd: 5 });
    await vi.waitFor(() => expect(state.config.dailyCapUsd).toBe(5));
    expect(first.dailyUsdCap).toBe(10);
    complete({ ok: true, fileDiffs: [] } as never);
    await vi.waitFor(() => expect(state.runState).toBe("done"));
    const next = await submit("after flight", 2);
    expect(next.dailyUsdCap).toBe(5);
    expect(first.dailyUsdCap).toBe(10);
  });

  it("seeds the settings UI from CLI configuration when no settings file exists", async () => {
    vi.mocked(loadDiskModel).mockResolvedValue(null);
    vi.mocked(loadDiskModelSync).mockReturnValue(null);
    await start({ model: "gpt-5.4", effort: "high" });
    await command("/websearch");
    await vi.waitFor(() => expect(state.config.webSearchEnabled).toBe(false));
    const config = await submit("no saved settings", 1);
    expect(config.model).toBe("gpt-5.4");
    expect(config.provider).toBe("openai");
    expect(config.effort).toBe("high");
    expect(config.memoryEnabled).toBe(true);
  });

  it("uses resolved configuration for the automatically submitted startup prompt", async () => {
    await start({ model: "gpt-5.4", effort: "high" }, "startup task");
    await vi.waitFor(() => expect(runOneShotInner).toHaveBeenCalledOnce());
    const config = vi.mocked(runOneShotInner).mock.calls[0]![1];
    expect(config.model).toBe("gpt-5.4");
    expect(config.effort).toBe("high");
    expect(config.autoApprove).toBe(false);
  });

  it("propagates live memory and auto-commit preferences without performing a commit", async () => {
    await start();
    // The palette also matches /sessions; select the session-memory command explicitly.
    await type("/session");
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(screen!.lastFrame()).toMatch(/▸\s*\/session\s/));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.overlayStack).toEqual(["session"]));
    screen!.stdin.write("\x1b[B");
    await vi.waitFor(() => expect(state.memorySelectedIndex).toBe(1));
    screen!.stdin.write("\r");
    await vi.waitFor(() => expect(state.config.memoryEnabled).toBe(true));
    await command("/autocommit");
    await vi.waitFor(() => expect(state.config.commitOnSuccess).toBe(true));
    const config = await submit("preference task", 1);
    expect(config.memoryEnabled).toBe(true);
    expect(config.commitOnSuccess).toBe(true);
  });

  it.each([[undefined, "normal"], ["plan", "plan"]] as const)("preserves initial permission mode %s", async (permissionMode, expected) => {
    await start({ permissionMode });
    await submit("mode task", 1);
    expect(state.mode).toBe(expected);
    expect(vi.mocked(runOneShotInner).mock.calls[0]![3]?.mode).toBe(expected);
  });
});
