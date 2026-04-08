import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripeWebhookRouter = express.Router();

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing.");
  }
  const StripeClient = Stripe as unknown as {
    new (apiKey: string): {
      webhooks: {
        constructEvent: (payload: Buffer, signature: string, secret: string) => unknown;
      };
    };
  };
  return new StripeClient(secretKey);
}

function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
  }
  return createClient(url, key);
}

async function updateProfileSubscription(input: {
  clerkUserId: string;
  subscriptionStatus: "pro" | "free";
  credits: number;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const profilesTable = supabase.from("profiles") as unknown as {
    update: (values: { subscription_status: string; credits: number }) => {
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
    })
    .eq("clerk_user_id", input.clerkUserId);

  if (result?.error) {
    throw new Error(result.error.message || "Failed to update profile subscription.");
  }
}

stripeWebhookRouter.post("/", async (req, res) => {
  const signature = req.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    res.status(400).json({ ok: false, reason: "missing_webhook_signature" });
    return;
  }

  let event: {
    type: string;
    data: { object: unknown };
  };
  try {
    const stripe = getStripeClient();
    const payload = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body as string);
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    ) as {
      type: string;
      data: { object: unknown };
    };
  } catch (error) {
    res.status(400).json({
      ok: false,
      reason: `webhook_verification_failed:${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as { client_reference_id?: string | null };
      const clerkUserId = session.client_reference_id?.trim();
      if (clerkUserId) {
        await updateProfileSubscription({
          clerkUserId,
          subscriptionStatus: "pro",
          credits: 1000,
        });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as {
        metadata?: Record<string, string | undefined>;
      };
      const clerkUserId =
        subscription.metadata?.clerk_user_id?.trim() ||
        subscription.metadata?.userId?.trim() ||
        "";

      if (clerkUserId) {
        await updateProfileSubscription({
          clerkUserId,
          subscriptionStatus: "free",
          credits: 20,
        });
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

export default stripeWebhookRouter;
