import crypto from "node:crypto";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const lemonWebhookRouter = express.Router();

function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
  }
  return createClient(url, key);
}

function verifyLemonSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(digest, "utf8");
  const actual = Buffer.from(signature.trim(), "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function updateProfileSubscription(input: {
  clerkUserId: string;
  subscriptionStatus: "pro" | "free";
  credits: number;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const profilesTable = supabase.from("profiles") as unknown as {
    update: (values: { subscription_status: string; credits: number; runs_used_this_month: number }) => {
      eq: (
        column: string,
        value: string
      ) => Promise<{ error?: { message?: string } | null }>;
    };
  };
  const result = await profilesTable
    .update({
      subscription_status: input.subscriptionStatus,
      credits: input.credits,
      runs_used_this_month: 0,
    })
    .eq("clerk_user_id", input.clerkUserId);
  if (result?.error) {
    throw new Error(result.error.message || "Failed to update profile subscription.");
  }
}

type LemonWebhookPayload = {
  meta?: {
    event_name?: string;
    custom_data?: {
      user_id?: string;
    };
  };
};

lemonWebhookRouter.post("/", async (req, res) => {
  const signature = req.get("x-signature");
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    res.status(400).json({ ok: false, reason: "missing_webhook_signature" });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));

  if (!verifyLemonSignature(rawBody, signature, secret)) {
    res.status(400).json({ ok: false, reason: "webhook_verification_failed" });
    return;
  }

  let payload: LemonWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as LemonWebhookPayload;
  } catch {
    res.status(400).json({ ok: false, reason: "invalid_webhook_payload" });
    return;
  }

  const eventName = payload.meta?.event_name?.trim() || "";
  const clerkUserId = payload.meta?.custom_data?.user_id?.trim() || "";

  try {
    if (
      clerkUserId &&
      (eventName === "subscription_created" || eventName === "order_created")
    ) {
      await updateProfileSubscription({
        clerkUserId,
        subscriptionStatus: "pro",
        credits: 250,
      });
    }

    if (
      clerkUserId &&
      (eventName === "subscription_expired" || eventName === "subscription_cancelled")
    ) {
      await updateProfileSubscription({
        clerkUserId,
        subscriptionStatus: "free",
        credits: 10,
      });
    }
if (
      clerkUserId &&
      eventName === "subscription_payment_success"
    ) {
      const supabase = getSupabaseAdminClient();
      const profilesTable = supabase.from("profiles") as unknown as {
        update: (values: { runs_used_this_month: number }) => {
          eq: (
            column: string,
            value: string
          ) => Promise<{ error?: { message?: string } | null }>;
        };
      };
      const result = await profilesTable
        .update({ runs_used_this_month: 0 })
        .eq("clerk_user_id", clerkUserId);
      if (result?.error) {
        console.log(`[zone] subscription_payment_success reset failed: ${result.error.message}`);
      } else {
        console.log(`[zone] subscription_payment_success: reset runs for ${clerkUserId}`);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
});

export default lemonWebhookRouter;
