CREATE OR REPLACE FUNCTION reset_monthly_runs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.profiles
  SET runs_used_this_month = 0,
      updated_at = NOW();
END;
$$;
