import { describe, it, expect, vi } from "vitest";

// embeddingsRepository uses supabase-js at module load — mock it so the test
// doesn't need a real Supabase client.
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { isEmbeddingBackendAvailable } from "./embeddingsRepository.js";

describe("isEmbeddingBackendAvailable", () => {
  it("returns true when both env vars are set", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiJ9.test");
    expect(isEmbeddingBackendAvailable()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("returns false when SUPABASE_URL is missing", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiJ9.test");
    delete process.env["SUPABASE_URL"];
    expect(isEmbeddingBackendAvailable()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("returns false when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    expect(isEmbeddingBackendAvailable()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("returns false when both env vars are absent (default CLI path)", () => {
    delete process.env["SUPABASE_URL"];
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
    expect(isEmbeddingBackendAvailable()).toBe(false);
  });

  it("returns false when env vars are empty strings", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(isEmbeddingBackendAvailable()).toBe(false);
    vi.unstubAllEnvs();
  });
});
