"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_js_1 = require("@supabase/supabase-js");
const customerPortalRouter = express_1.default.Router();
const LEMON_ORDERS_FALLBACK_URL = "https://app.lemonsqueezy.com/my-orders";
function getSupabaseAdminClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.");
    }
    return (0, supabase_js_1.createClient)(url, key);
}
customerPortalRouter.get("/", async (req, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
    const apiKey = typeof process.env.LEMONSQUEEZY_API_KEY === "string"
        ? process.env.LEMONSQUEEZY_API_KEY.trim()
        : "";
    if (!userId) {
        res.status(400).json({ error: "Missing userId" });
        return;
    }
    if (!apiKey) {
        res.status(500).json({ error: "Missing Lemon Squeezy API key" });
        return;
    }
    try {
        const supabase = getSupabaseAdminClient();
        const profilesTable = supabase.from("profiles");
        const profileResult = await profilesTable
            .select("email")
            .eq("clerk_user_id", userId)
            .maybeSingle();
        if (profileResult?.error) {
            res.status(500).json({ error: profileResult.error.message || "Profile lookup failed" });
            return;
        }
        const email = profileResult?.data?.email?.trim();
        if (!email) {
            res.json({ url: LEMON_ORDERS_FALLBACK_URL, fallback: true });
            return;
        }
        const url = `https://api.lemonsqueezy.com/v1/customers?filter[email]=${encodeURIComponent(email)}` +
            `&filter[store_id]=339960`;
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: "application/vnd.api+json",
            },
        });
        const payload = (await response.json());
        if (!response.ok) {
            res.status(response.status).json({
                error: payload.errors?.[0]?.detail || "Lemon customer lookup failed",
            });
            return;
        }
        const portalUrl = payload.data?.[0]?.attributes?.urls?.customer_portal;
        if (!portalUrl) {
            res.json({ url: LEMON_ORDERS_FALLBACK_URL, fallback: true });
            return;
        }
        res.json({ url: portalUrl });
    }
    catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
exports.default = customerPortalRouter;
//# sourceMappingURL=getLemonCustomerPortal.js.map