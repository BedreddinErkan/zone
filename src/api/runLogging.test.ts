import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type ConversationRow = {
  id: string;
  user_id: string;
  thread_id: string;
  repo_path: string | null;
  messages: unknown[];
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
  let profileRunsUsedThisMonth = 0;
  let profileCredits = 10;

  const now = () => new Date().toISOString();
  let idCounter = 0;
  const newId = () => `fake-id-${++idCounter}`;
  const convKey = (userId: string, threadId: string) => `${userId}:${threadId}`;

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
            select: (_cols?: string) => ({
              single: async () => {
                const userId = String(payload.user_id);
                const threadId = String(payload.thread_id);
                const key = convKey(userId, threadId);
                const row: ConversationRow = {
                  id: newId(),
                  user_id: userId,
                  thread_id: threadId,
                  repo_path: payload.repo_path != null ? String(payload.repo_path) : null,
                  messages: Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [],
                  created_at: now(),
                  updated_at: now(),
                };
                conversations.set(key, row);
                return { data: row, error: null };
              },
            }),
          }),
          select: (_cols?: string) => {
            const conditions: Array<{ col: string; val: string }> = [];
            const builder = {
              eq: (col: string, val: string) => {
                conditions.push({ col, val });
                return builder;
              },
              maybeSingle: async () => {
                for (const row of conversations.values()) {
                  const match = conditions.every(({ col, val }) => {
                    if (col === "user_id") return row.user_id === val;
                    if (col === "thread_id") return row.thread_id === val;
                    if (col === "id") return row.id === val;
                    return false;
                  });
                  if (match) return { data: row, error: null };
                }
                return { data: null, error: null };
              },
            };
            return builder;
          },
          upsert: (payload: Record<string, unknown>, _opts?: unknown) => ({
            select: (_cols?: string) => ({
              single: async () => {
                const userId = String(payload.user_id);
                const threadId = String(payload.thread_id);
                const key = convKey(userId, threadId);
                const existing = conversations.get(key);
                const row: ConversationRow = {
                  id: existing?.id ?? newId(),
                  user_id: userId,
                  thread_id: threadId,
                  repo_path: payload.repo_path != null ? String(payload.repo_path) : null,
                  messages: Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [],
                  created_at: existing?.created_at ?? now(),
                  updated_at: now(),
                };
                conversations.set(key, row);
                return { data: row, error: null };
              },
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (col: string, val: string) => ({
              select: (_cols?: string) => ({
                single: async () => {
                  for (const [key, row] of conversations.entries()) {
                    const match =
                      (col === "id" && row.id === val) ||
                      (col === "thread_id" && row.thread_id === val);
                    if (match) {
                      const updated = {
                        ...row,
                        ...(payload as Partial<ConversationRow>),
                        updated_at: now(),
                      };
                      conversations.set(key, updated);
                      return { data: updated, error: null };
                    }
                  }
                  return { data: null, error: { message: "not found" } };
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
                  runs_used_this_month: profileRunsUsedThisMonth,
                  credits: profileCredits,
                  subscription_status: profileSubscriptionStatus,
                  token_credits_used: 0,
                  token_credits_limit: 500000,
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
    overrides: Partial<ConversationRow> & Pick<ConversationRow, "user_id" | "thread_id">
  ): void {
    const key = convKey(overrides.user_id, overrides.thread_id);
    conversations.set(key, {
      id: overrides.id ?? newId(),
      user_id: overrides.user_id,
      thread_id: overrides.thread_id,
      repo_path: overrides.repo_path ?? null,
      messages: overrides.messages ?? [],
      created_at: overrides.created_at ?? "2026-04-13T10:00:00.000Z",
      updated_at: overrides.updated_at ?? "2026-04-13T10:00:00.000Z",
    });
  }

  function setProfileSubscriptionStatus(status: "free" | "pro"): void {
    profileSubscriptionStatus = status;
  }

  function setUserQuota(input: {
    runsUsedThisMonth?: number;
    credits?: number;
  }): void {
    if (typeof input.runsUsedThisMonth === "number") {
      profileRunsUsedThisMonth = input.runsUsedThisMonth;
    }
    if (typeof input.credits === "number") {
      profileCredits = input.credits;
    }
  }

  return {
    supabase,
    runLogs,
    rpcCalls,
    conversations,
    seedConversation,
    setProfileSubscriptionStatus,
    setUserQuota,
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
        name: "deduct_tokens_idempotent",
        payload: expect.objectContaining({
          p_user_id: "user_123",
          p_tokens: 50000,
          p_billing_mode: "hosted",
          p_execution_id: expect.any(String),
        }),
      },
    ]);
    expect([...fake.conversations.values()]).toEqual([
      expect.objectContaining({
        user_id: "user_123",
        repo_path: "C:/repo",
      }),
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
        name: "deduct_tokens_idempotent",
        payload: expect.objectContaining({
          p_user_id: "user_123",
          p_tokens: 50000,
          p_billing_mode: "hosted",
          p_execution_id: expect.any(String),
        }),
      },
    ]);
    expect([...fake.conversations.values()]).toHaveLength(1);
  });

  it.skip("creates a new conversation when a provided conversationId belongs to another repo or role", async () => {
    // Cross-repo conversation dedup logic was removed; upsertConversation now writes
    // to the {user_id, thread_id} key regardless of repo_path or role — removed 2026-05-22.
  });

  it("ignores old conversation refinement counters for billing decisions", async () => {
    const fake = createFakeSupabase();
    fake.setProfileSubscriptionStatus("free");
    fake.seedConversation({
      user_id: "user_123",
      thread_id: "conv_existing",
      id: "conv_existing",
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
      billingMode: "hosted",
    });

    expect(fake.rpcCalls).toEqual([
      {
        name: "deduct_tokens_idempotent",
        payload: expect.objectContaining({
          p_user_id: "user_123",
          p_tokens: 50000,
          p_billing_mode: "hosted",
          p_execution_id: expect.any(String),
        }),
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
        name: "deduct_tokens_idempotent",
        payload: expect.objectContaining({
          p_user_id: "user_123",
          p_tokens: 50000,
          p_billing_mode: "hosted",
          p_execution_id: expect.any(String),
        }),
      },
    ]);
  });
});
