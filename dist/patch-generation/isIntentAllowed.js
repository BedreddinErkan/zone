"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIntentAllowed = isIntentAllowed;
const ALLOWED_INTENTS_BY_STRATEGY = {
    blocked: [],
    restricted: ["rename_symbol", "add_comment", "safe_replace"],
    safe: ["rename_symbol", "update_import", "add_comment", "safe_replace"]
};
function isIntentAllowed(intent, strategy) {
    if (intent === "unknown") {
        return false;
    }
    return ALLOWED_INTENTS_BY_STRATEGY[strategy].includes(intent);
}
//# sourceMappingURL=isIntentAllowed.js.map