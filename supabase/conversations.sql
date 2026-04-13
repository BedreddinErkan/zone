CREATE TABLE IF NOT EXISTS public.conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  role TEXT NOT NULL,
  charged_run_count INTEGER NOT NULL DEFAULT 0,
  refinement_count INTEGER NOT NULL DEFAULT 0,
  has_free_refinement_been_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
