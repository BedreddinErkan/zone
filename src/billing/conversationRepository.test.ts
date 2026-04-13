import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createConversation,
  getConversationById,
  updateConversation,
} from "./conversationRepository.js";

function createConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "conv_123",
    user_id: "user_123",
    mode: "hosted",
    repo_path: "C:/repo",
    role: "developer",
    charged_run_count: 0,
    refinement_count: 0,
    has_free_refinement_been_used: false,
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
      mode: "hosted",
      repoPath: "C:/repo",
      role: "developer",
    });

    expect(from).toHaveBeenCalledWith("conversations");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_123",
        mode: "hosted",
        repo_path: "C:/repo",
        role: "developer",
        charged_run_count: 0,
        refinement_count: 0,
        has_free_refinement_been_used: false,
      })
    );
    expect(result).toEqual({
      id: "conv_123",
      userId: "user_123",
      mode: "hosted",
      repoPath: "C:/repo",
      role: "developer",
      chargedRunCount: 0,
      refinementCount: 0,
      hasFreeRefinementBeenUsed: false,
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    });
  });

  it("getConversationById returns the stored conversation", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: createConversationRow({
        id: "conv_lookup",
        charged_run_count: 2,
        refinement_count: 1,
        has_free_refinement_been_used: true,
      }),
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const supabase = { from } as unknown as SupabaseClient;

    const result = await getConversationById(supabase, "conv_lookup");

    expect(eq).toHaveBeenCalledWith("id", "conv_lookup");
    expect(result).toEqual({
      id: "conv_lookup",
      userId: "user_123",
      mode: "hosted",
      repoPath: "C:/repo",
      role: "developer",
      chargedRunCount: 2,
      refinementCount: 1,
      hasFreeRefinementBeenUsed: true,
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    });
  });

  it("updateConversation changes the expected fields", async () => {
    const single = vi.fn().mockResolvedValue({
      data: createConversationRow({
        id: "conv_update",
        charged_run_count: 3,
        refinement_count: 2,
        has_free_refinement_been_used: true,
        updated_at: "2026-04-13T11:00:00.000Z",
      }),
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    const supabase = { from } as unknown as SupabaseClient;

    const result = await updateConversation(supabase, "conv_update", {
      chargedRunCount: 3,
      refinementCount: 2,
      hasFreeRefinementBeenUsed: true,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        charged_run_count: 3,
        refinement_count: 2,
        has_free_refinement_been_used: true,
      })
    );
    expect(eq).toHaveBeenCalledWith("id", "conv_update");
    expect(result).toEqual({
      id: "conv_update",
      userId: "user_123",
      mode: "hosted",
      repoPath: "C:/repo",
      role: "developer",
      chargedRunCount: 3,
      refinementCount: 2,
      hasFreeRefinementBeenUsed: true,
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T11:00:00.000Z",
    });
  });
});
