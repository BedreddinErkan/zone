import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createConversation,
  getConversationByThreadId,
  upsertConversation,
} from "./conversationRepository.js";

function createConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "conv_123",
    user_id: "user_123",
    thread_id: "thread_123",
    repo_path: "C:/repo",
    messages: [],
    created_at: "2026-04-13T10:00:00.000Z",
    updated_at: "2026-04-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("conversationRepository", () => {
  it("createConversation returns the expected initial state", async () => {
    const single = vi.fn().mockResolvedValue({
      data: createConversationRow(),
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ insert }));
    const supabase = { from } as unknown as SupabaseClient;

    const result = await createConversation(supabase, {
      userId: "user_123",
      threadId: "thread_123",
      repoPath: "C:/repo",
      messages: [],
    });

    expect(from).toHaveBeenCalledWith("conversations");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_123",
        thread_id: "thread_123",
        repo_path: "C:/repo",
        messages: [],
      })
    );
    expect(result).toEqual({
      id: "conv_123",
      userId: "user_123",
      threadId: "thread_123",
      repoPath: "C:/repo",
      messages: [],
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    });
  });

  it("getConversationById returns the stored conversation", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: createConversationRow({
        id: "conv_lookup",
        thread_id: "thread_lookup",
        messages: [{ role: "user", content: "hello" }],
      }),
      error: null,
    });
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    const from = vi.fn(() => ({ select }));
    const supabase = { from } as unknown as SupabaseClient;

    const result = await getConversationByThreadId(supabase, {
      userId: "user_123",
      threadId: "thread_lookup",
    });

    expect(eq1).toHaveBeenCalledWith("user_id", "user_123");
    expect(eq2).toHaveBeenCalledWith("thread_id", "thread_lookup");
    expect(result).toEqual({
      id: "conv_lookup",
      userId: "user_123",
      threadId: "thread_lookup",
      repoPath: "C:/repo",
      messages: [{ role: "user", content: "hello" }],
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    });
  });

  it("updateConversation changes the expected fields", async () => {
    const single = vi.fn().mockResolvedValue({
      data: createConversationRow({
        id: "conv_update",
        thread_id: "thread_update",
        messages: [{ role: "assistant", content: "hi" }],
        updated_at: "2026-04-13T11:00:00.000Z",
      }),
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const upsertFn = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ upsert: upsertFn }));
    const supabase = { from } as unknown as SupabaseClient;

    const result = await upsertConversation(supabase, {
      userId: "user_123",
      threadId: "thread_update",
      repoPath: "C:/repo",
      messages: [{ role: "assistant", content: "hi" }],
    });

    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_123",
        thread_id: "thread_update",
        repo_path: "C:/repo",
        messages: [{ role: "assistant", content: "hi" }],
      }),
      { onConflict: "user_id,thread_id" }
    );
    expect(result).toEqual({
      id: "conv_update",
      userId: "user_123",
      threadId: "thread_update",
      repoPath: "C:/repo",
      messages: [{ role: "assistant", content: "hi" }],
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T11:00:00.000Z",
    });
  });
});
