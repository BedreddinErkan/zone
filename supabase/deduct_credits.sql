CREATE OR REPLACE FUNCTION deduct_credits_and_increment_runs(
  p_user_id TEXT,
  p_credits NUMERIC
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET
    credits = credits - p_credits,
    total_runs = total_runs + 1,
    updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
