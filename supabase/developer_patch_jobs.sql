CREATE OR REPLACE FUNCTION public.claim_next_developer_patch_job()
RETURNS SETOF public.developer_patch_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  claimed public.developer_patch_jobs%ROWTYPE;
BEGIN
  UPDATE public.developer_patch_jobs
  SET
    status = 'running',
    progress_stage = 'Starting job...',
    started_at = NOW()
  WHERE id = (
    SELECT id
    FROM public.developer_patch_jobs
    WHERE status = 'queued'
      AND role = 'developer'
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO claimed;

  IF claimed.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.developer_patch_jobs
  WHERE id = claimed.id;
END;
$$;