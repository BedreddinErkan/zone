CREATE OR REPLACE FUNCTION deduct_credits_and_increment_runs(
  p_user_id TEXT,
  p_credits NUMERIC
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET
    credits = credits - p_credits,
    runs_used_this_month = COALESCE(runs_used_this_month, 0) + 1,
    total_runs = total_runs + 1,
    updated_at = NOW()
  WHERE clerk_user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
