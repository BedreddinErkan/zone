"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const stripe_1 = __importDefault(require("stripe"));
const supabase_js_1 = require("@supabase/supabase-js");
const stripeWebhookRouter = express_1.default.Router();
function getStripeClient() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error("STRIPE_SECRET_KEY is missing.");
    }
    const StripeClient = stripe_1.default;
    return new StripeClient(secretKey);
}
function getSupabaseAdminClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
    }
    return (0, supabase_js_1.createClient)(url, key);
}
async function updateProfileSubscription(input) {
    const supabase = getSupabaseAdminClient();
    const profilesTable = supabase.from("profiles");
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
    let event;
    try {
        const stripe = getStripeClient();
        const payload = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(req.body);
        event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    }
    catch (error) {
        res.status(400).json({
            ok: false,
            reason: `webhook_verification_failed:${error instanceof Error ? error.message : String(error)}`,
        });
        return;
    }
    try {
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
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
            const subscription = event.data.object;
            const clerkUserId = subscription.metadata?.clerk_user_id?.trim() ||
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
    }
    catch (error) {
        res.status(500).json({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        });
    }
});
exports.default = stripeWebhookRouter;
//# sourceMappingURL=stripeWebhook.js.map