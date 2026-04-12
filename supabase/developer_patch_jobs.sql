CREATE TABLE IF NOT EXISTS public.developer_patch_jobs (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  task TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress_stage TEXT,
  request_payload JSONB,
  result_payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_developer_patch_jobs_status_created_at
  ON public.developer_patch_jobs (status, created_at);

CREATE OR REPLACE FUNCTION claim_next_developer_patch_job()
RETURNS public.developer_patch_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  claimed public.developer_patch_jobs;
BEGIN
  UPDATE public.developer_patch_jobs
  SET
    status = 'running',
    progress_stage = 'Starting job...',
    started_at = NOW()
  WHERE id = (
    SELECT id
    FROM public.developer_patch_jobs
    WHERE status = 'queued' AND role = 'developer'
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO claimed;

  RETURN claimed;
END;
$$;
