import express from "express";
import Stripe from "stripe";

// Railway/Render env vars:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - STRIPE_PRO_PRICE_ID

const createCheckoutSessionRouter = express.Router();

function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is missing.");
  }
  const StripeClient = Stripe as unknown as {
    new (apiKey: string): {
      checkout: {
        sessions: {
          create: (input: {
            client_reference_id: string;
            success_url: string;
            cancel_url: string;
            mode: "subscription";
            line_items: Array<{ price: string; quantity: number }>;
            subscription_data: {
              metadata: {
                clerk_user_id: string;
              };
            };
          }) => Promise<{ url: string | null }>;
        };
      };
    };
  };
  return new StripeClient(secretKey);
}

createCheckoutSessionRouter.post("/", async (req, res) => {
  const userId =
    typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const priceId =
    typeof process.env.STRIPE_PRO_PRICE_ID === "string"
      ? process.env.STRIPE_PRO_PRICE_ID.trim()
      : "";

  if (!userId) {
    res.status(400).json({ ok: false, reason: "missing_user_id" });
    return;
  }

  if (!priceId) {
    res.status(500).json({ ok: false, reason: "missing_stripe_price_id" });
    return;
  }

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      client_reference_id: userId,
      success_url: "https://zonecli.dev/dashboard?upgraded=true",
      cancel_url: "https://zonecli.dev/dashboard",
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          clerk_user_id: userId,
        },
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
});

export default createCheckoutSessionRouter;
