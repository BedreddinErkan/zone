-- Token usage ledger + idempotent deduction RPC
-- Purpose: atomic, retry-safe, crash-safe token charging keyed by execution id.

CREATE TABLE IF NOT EXISTS public.token_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  billing_mode TEXT NOT NULL DEFAULT 'hosted',
  tokens_used NUMERIC NOT NULL CHECK (tokens_used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS token_usage_ledger_user_execution_unique
  ON public.token_usage_ledger (clerk_user_id, execution_id);

-- Atomic + idempotent token deduction.
-- - Inserts a ledger row exactly once per (user, execution_id)
-- - Resets daily counters when a new UTC day starts (based on daily_reset_at)
-- - Enforces both total and daily limits
-- - If called again with same (user, execution_id), it is a no-op success
CREATE OR REPLACE FUNCTION public.deduct_tokens_idempotent(
  p_user_id TEXT,
  p_execution_id TEXT,
  p_tokens NUMERIC,
  p_billing_mode TEXT DEFAULT 'hosted'
) RETURNS JSONB AS $$
DECLARE
  v_existing_id UUID;
  v_profile RECORD;
  v_today TEXT;
  v_last_reset TEXT;
  v_tokens NUMERIC;
  v_daily_used NUMERIC;
  v_daily_limit NUMERIC;
  v_total_used NUMERIC;
  v_total_limit NUMERIC;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'missing_user_id';
  END IF;
  IF p_execution_id IS NULL OR btrim(p_execution_id) = '' THEN
    RAISE EXCEPTION 'missing_execution_id';
  END IF;
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    -- Nothing to deduct, but still treat as success for idempotency.
    RETURN jsonb_build_object('ok', true, 'charged', false, 'reason', 'zero_tokens');
  END IF;
  -- Idempotency gate: ensure only one ledger row per (user, execution_id)
  INSERT INTO public.token_usage_ledger (clerk_user_id, execution_id, billing_mode, tokens_used)
  VALUES (p_user_id, p_execution_id, lower(coalesce(p_billing_mode, 'hosted')), p_tokens)
  ON CONFLICT (clerk_user_id, execution_id) DO NOTHING
  RETURNING id INTO v_existing_id;

  IF v_existing_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'charged', false, 'reason', 'already_charged');
  END IF;

  -- Lock profile row and compute limits
  SELECT
    token_credits_used,
    token_credits_limit,
    token_credits_used_today,
    token_credits_daily_limit,
    daily_reset_at
  INTO v_profile
  FROM public.profiles
  WHERE clerk_user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  v_today := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD');
  v_last_reset := CASE
    WHEN v_profile.daily_reset_at IS NULL THEN NULL
    ELSE to_char(v_profile.daily_reset_at AT TIME ZONE 'utc', 'YYYY-MM-DD')
  END;

  v_tokens := p_tokens;
  v_daily_used := COALESCE(v_profile.token_credits_used_today, 0);
  v_daily_limit := COALESCE(v_profile.token_credits_daily_limit, 50000);
  v_total_used := COALESCE(v_profile.token_credits_used, 0);
  v_total_limit := COALESCE(v_profile.token_credits_limit, 500000);

  -- Reset daily if day changed (UTC)
  IF v_last_reset IS NULL OR v_last_reset <> v_today THEN
    v_daily_used := 0;
    UPDATE public.profiles
    SET token_credits_used_today = 0,
        daily_reset_at = NOW(),
        updated_at = NOW()
    WHERE clerk_user_id = p_user_id;
  END IF;

  -- Enforce limits (treat huge limits as "unlimited")
  IF v_total_limit < 999999999 AND (v_total_used + v_tokens) > v_total_limit THEN
    -- rollback ledger insert by raising: caller should see clean failure
    RAISE EXCEPTION 'token_limit_exceeded';
  END IF;
  IF v_daily_limit < 999999999 AND (v_daily_used + v_tokens) > v_daily_limit THEN
    RAISE EXCEPTION 'token_daily_limit_exceeded';
  END IF;

  UPDATE public.profiles
  SET token_credits_used = v_total_used + v_tokens,
      token_credits_used_today = v_daily_used + v_tokens,
      updated_at = NOW()
  WHERE clerk_user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'charged', true,
    'tokens', v_tokens
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

