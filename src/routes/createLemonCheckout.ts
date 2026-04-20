import express from "express";

// Railway env vars:
// - LEMONSQUEEZY_API_KEY
// - LEMONSQUEEZY_WEBHOOK_SECRET

const createLemonCheckoutRouter = express.Router();
const PRO_VARIANT_ID = "1512928";
const UNLIMITED_VARIANT_ID = "1552852";

async function handleCreateCheckout(
  req: express.Request,
  res: express.Response,
  variantId: string
): Promise<void> {
  const userId =
    typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const apiKey =
    typeof process.env.LEMONSQUEEZY_API_KEY === "string"
      ? process.env.LEMONSQUEEZY_API_KEY.trim()
      : "";

  if (!userId) {
    res.status(400).json({ ok: false, reason: "missing_user_id" });
    return;
  }

  if (!apiKey) {
    res.status(500).json({ ok: false, reason: "missing_lemonsqueezy_api_key" });
    return;
  }

  try {
    const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              custom: {
                user_id: userId,
              },
            },
            product_options: {
              redirect_url: "https://zonecli.dev/dashboard?upgraded=true",
            },
          },
          relationships: {
            store: {
              data: {
                type: "stores",
                id: "339960",
              },
            },
            variant: {
              data: {
                type: "variants",
                id: variantId,
              },
            },
          },
        },
      }),
    });

    const payload = (await response.json()) as {
      data?: {
        attributes?: {
          url?: string;
        };
      };
      errors?: Array<{ detail?: string }>;
    };

    if (!response.ok) {
      res.status(response.status).json({
        ok: false,
        reason: payload.errors?.[0]?.detail || "lemonsqueezy_checkout_failed",
      });
      return;
    }

    res.json({ url: payload.data?.attributes?.url ?? null });
  } catch (error) {
    res.status(500).json({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

createLemonCheckoutRouter.post("/", async (req, res) => {
  const variantId =
    req.body?.plan === "unlimited" ? UNLIMITED_VARIANT_ID : PRO_VARIANT_ID;
  await handleCreateCheckout(req, res, variantId);
});

createLemonCheckoutRouter.post("/unlimited", async (req, res) => {
  await handleCreateCheckout(req, res, UNLIMITED_VARIANT_ID);
});

export default createLemonCheckoutRouter;
