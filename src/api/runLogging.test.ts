import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type ConversationRow = {
  id: string;
  user_id: string;
  mode: "hosted" | "byok";
  repo_path: string;
  role: "developer" | "test_engineer" | "data_analyst";
  charged_run_count: number;
  refinement_count: number;
  has_free_refinement_been_used: boolean;
  created_at: string;
  updated_at: string;
};

const createClientMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

function createFakeSupabase() {
  const runLogs: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const conversations = new Map<string, ConversationRow>();
  let profileSubscriptionStatus: "free" | "pro" = "free";

  const now = () => new Date().toISOString();

  const supabase = {
    from(table: string) {
      if (table === "run_logs") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            runLogs.push(payload);
            return { error: null };
          },
        };
      }
      if (table === "conversations") {
        return {
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const row: ConversationRow = {
                  id: String(payload.id),
                  user_id: String(payload.user_id),
                  mode: payload.mode as ConversationRow["mode"],
                  repo_path: String(payload.repo_path),
                  role: payload.role as ConversationRow["role"],
                  charged_run_count: Number(payload.charged_run_count ?? 0),
                  refinement_count: Number(payload.refinement_count ?? 0),
                  has_free_refinement_been_used: Boolean(
                    payload.has_free_refinement_been_used
                  ),
                  created_at: now(),
                  updated_at: now(),
                };
                conversations.set(row.id, row);
                return { data: row, error: null };
              },
            }),
          }),
          select: () => ({
            eq: (_column: string, value: string) => ({
              maybeSingle: async () => ({
                data: conversations.get(value) ?? null,
                error: null,
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_column: string, value: string) => ({
              select: () => ({
                single: async () => {
                  const existing = conversations.get(value);
                  if (!existing) {
                    return { data: null, error: { message: "not found" } };
                  }
                  const updated: ConversationRow = {
                    ...existing,
                    ...(payload.mode !== undefined
                      ? { mode: payload.mode as ConversationRow["mode"] }
                      : {}),
                    ...(payload.repo_path !== undefined
                      ? { repo_path: String(payload.repo_path) }
                      : {}),
                    ...(payload.role !== undefined
                      ? { role: payload.role as ConversationRow["role"] }
                      : {}),
                    ...(payload.charged_run_count !== undefined
                      ? { charged_run_count: Number(payload.charged_run_count) }
                      : {}),
                    ...(payload.refinement_count !== undefined
                      ? { refinement_count: Number(payload.refinement_count) }
                      : {}),
                    ...(payload.has_free_refinement_been_used !== undefined
                      ? {
                          has_free_refinement_been_used: Boolean(
                            payload.has_free_refinement_been_used
                          ),
                        }
                      : {}),
                    ...(payload.updated_at !== undefined
                      ? { updated_at: String(payload.updated_at) }
                      : {}),
                  };
                  conversations.set(value, updated);
                  return { data: updated, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  subscription_status: profileSubscriptionStatus,
                },
                error: null,
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: async (name: string, payload: Record<string, unknown>) => {
      rpcCalls.push({ name, payload });
      return { error: null };
    },
  } as unknown as SupabaseClient;

  function seedConversation(
    overrides: Partial<ConversationRow> & Pick<ConversationRow, "id">
  ): void {
    conversations.set(overrides.id, {
      id: overrides.id,
      user_id: overrides.user_id ?? "user_123",
      mode: overrides.mode ?? "hosted",
      repo_path: overrides.repo_path ?? "C:/repo",
      role: overrides.role ?? "developer",
      charged_run_count: overrides.charged_run_count ?? 0,
      refinement_count: overrides.refinement_count ?? 0,
      has_free_refinement_been_used:
        overrides.has_free_refinement_been_used ?? false,
      created_at: overrides.created_at ?? "2026-04-13T10:00:00.000Z",
      updated_at: overrides.updated_at ?? "2026-04-13T10:00:00.000Z",
    });
  }

  function setProfileSubscriptionStatus(status: "free" | "pro"): void {
    profileSubscriptionStatus = status;
  }

  return {
    supabase,
    runLogs,
    rpcCalls,
    conversations,
    seedConversation,
    setProfileSubscriptionStatus,
  };
}

describe("logRun billing matrix", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    delete process.env.ZONE_USER_EMAIL;
  });

  it("charges for Free + Hosted", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("free");
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "add badge",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 90,
      creditsUsed: 1,
      billingMode: "hosted",
    });

    expect(conversationId).toBeTruthy();
    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_credits_and_increment_runs",
        payload: { p_user_id: "user_123", p_credits: 1 },
      },
    ]);
    expect([...fake.conversations.values()]).toEqual([
      expect.objectContaining({
        user_id: "user_123",
        mode: "hosted",
        repo_path: "C:/repo",
        role: "developer",
        charged_run_count: 1,
      }),
    ]);
  });

  it("charges for Free + BYOK", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("free");
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "byok free user run",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 88,
      creditsUsed: 1,
      billingMode: "byok",
      isByok: true,
    });

    expect(conversationId).toBeTruthy();
    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_credits_and_increment_runs",
        payload: { p_user_id: "user_123", p_credits: 1 },
      },
    ]);
    expect([...fake.conversations.values()]).toEqual([
      expect.objectContaining({
        mode: "byok",
        charged_run_count: 1,
      })
    ]);
  });

  it("charges for Pro + Hosted", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("pro");
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "hosted pro run",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 88,
      creditsUsed: 1,
      billingMode: "hosted",
    });

    expect(conversationId).toBeTruthy();
    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_credits_and_increment_runs",
        payload: { p_user_id: "user_123", p_credits: 1 },
      },
    ]);
    expect([...fake.conversations.values()]).toEqual([
      expect.objectContaining({
        mode: "hosted",
        charged_run_count: 1,
      })
    ]);
  });

  it("does not charge for Pro + BYOK", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("pro");
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "byok task",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 80,
      creditsUsed: 1,
      isByok: true,
    });

    expect(conversationId).toBeTruthy();
    expect(fake.rpcCalls).toEqual([]);
    expect([...fake.conversations.values()]).toEqual([
      expect.objectContaining({
        mode: "byok",
        charged_run_count: 0,
      }),
    ]);
  });

  it("creates a new conversation when a provided conversationId belongs to another repo or role", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("free");
    fake.seedConversation({
      id: "conv_old",
      repo_path: "C:/other-repo",
      role: "test_engineer",
      charged_run_count: 1,
    });
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "add badge",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 90,
      creditsUsed: 1,
      conversationId: "conv_old",
      billingMode: "hosted",
    });

    expect(conversationId).not.toBe("conv_old");
    expect(fake.conversations.get("conv_old")).toEqual(
      expect.objectContaining({
        charged_run_count: 1,
      })
    );
    expect(
      [...fake.conversations.values()].filter((item) => item.id !== "conv_old")
    ).toHaveLength(1);
  });

  it("ignores old conversation refinement counters for billing decisions", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("free");
    fake.seedConversation({
      id: "conv_existing",
      mode: "byok",
      charged_run_count: 99,
      refinement_count: 42,
      has_free_refinement_been_used: true,
    });
    createClientMock.mockReturnValue(fake.supabase);

    const { logRun } = await import("./runLogging.js");
    await logRun({
      userId: "user_123",
      role: "developer",
      task: "legacy conversation counters should not matter",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 90,
      creditsUsed: 1,
      conversationId: "conv_existing",
      billingMode: "byok",
      isByok: true,
    });

    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_credits_and_increment_runs",
        payload: { p_user_id: "user_123", p_credits: 1 },
      },
    ]);
  });

  it("still deducts when conversation persistence fails before resolver", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("pro");
    const brokenSupabase = {
      ...fake.supabase,
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  throw new Error("conversation lookup failed");
                },
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => {
                  throw new Error("conversation create failed");
                },
              }),
            }),
            update: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => {
                    throw new Error("conversation update failed");
                  },
                }),
              }),
            }),
          };
        }

        return (fake.supabase as unknown as { from: (name: string) => unknown }).from(
          table
        );
      },
    } as SupabaseClient;
    createClientMock.mockReturnValue(brokenSupabase);

    const { logRun } = await import("./runLogging.js");
    const conversationId = await logRun({
      userId: "user_123",
      role: "developer",
      task: "hosted pro run with broken conversation persistence",
      repoPath: "C:/repo",
      decisionMode: "safe_to_apply",
      confidence: 88,
      creditsUsed: 1,
      billingMode: "hosted",
    });

    expect(conversationId).toBeNull();
    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_credits_and_increment_runs",
        payload: { p_user_id: "user_123", p_credits: 1 },
      },
    ]);
  });
});
