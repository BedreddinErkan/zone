"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
// Railway env vars:
// - LEMONSQUEEZY_API_KEY
// - LEMONSQUEEZY_WEBHOOK_SECRET
const createLemonCheckoutRouter = express_1.default.Router();
createLemonCheckoutRouter.post("/", async (req, res) => {
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    const apiKey = typeof process.env.LEMONSQUEEZY_API_KEY === "string"
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
                                id: "1504822",
                            },
                        },
                    },
                },
            }),
        });
        const payload = (await response.json());
        if (!response.ok) {
            res.status(response.status).json({
                ok: false,
                reason: payload.errors?.[0]?.detail || "lemonsqueezy_checkout_failed",
            });
            return;
        }
        res.json({ url: payload.data?.attributes?.url ?? null });
    }
    catch (error) {
        res.status(500).json({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        });
    }
});
exports.default = createLemonCheckoutRouter;
//# sourceMappingURL=createLemonCheckout.js.map