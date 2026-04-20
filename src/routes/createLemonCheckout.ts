import express from "express";
import { createClient } from "@supabase/supabase-js";

// Railway env vars:
// - LEMONSQUEEZY_API_KEY
// - LEMONSQUEEZY_WEBHOOK_SECRET

const createLemonCheckoutRouter = express.Router();
const PRO_VARIANT_ID = "1512928";
const UNLIMITED_VARIANT_ID = "1552852";

function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
  }
  return createClient(url, key);
}

async function requireProForUnlimited(
  req: express.Request,
  res: express.Response
): Promise<boolean> {
  const userId =
    typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

  if (!userId) {
    res.status(400).json({ ok: false, reason: "missing_user_id" });
    return false;
  }

  const supabase = getSupabaseAdminClient();
  const profilesTable = supabase.from("profiles") as unknown as {
    select: (
      columns: string
    ) => {
      eq: (
        column: string,
        value: string
      ) => {
        maybeSingle: () => Promise<{
          data: { subscription_status?: string | null } | null;
          error?: { message?: string } | null;
        }>;
      };
    };
  };
  const result = await profilesTable
    .select("subscription_status")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (result?.error) {
    throw new Error(result.error.message || "Failed to load subscription status.");
  }

  if ((result.data?.subscription_status ?? "").trim().toLowerCase() !== "pro") {
    res.status(403).json({ ok: false, reason: "pro_required_for_unlimited" });
    return false;
  }

  return true;
}

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
  if (req.body?.plan === "unlimited" && !(await requireProForUnlimited(req, res))) {
    return;
  }
  const variantId =
    req.body?.plan === "unlimited" ? UNLIMITED_VARIANT_ID : PRO_VARIANT_ID;
  await handleCreateCheckout(req, res, variantId);
});

createLemonCheckoutRouter.post("/unlimited", async (req, res) => {
  if (!(await requireProForUnlimited(req, res))) {
    return;
  }
  await handleCreateCheckout(req, res, UNLIMITED_VARIANT_ID);
});

export default createLemonCheckoutRouter;
