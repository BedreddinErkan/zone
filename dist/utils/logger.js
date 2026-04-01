"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logInfo = logInfo;
exports.logSuccess = logSuccess;
exports.logWarn = logWarn;
exports.logError = logError;
function logInfo(message) {
    console.log(`[INFO] ${message}`);
}
function logSuccess(message) {
    console.log(`[OK] ${message}`);
}
function logWarn(message) {
    console.warn(`[WARN] ${message}`);
}
function logError(message) {
    console.error(`[ERROR] ${message}`);
}
//# sourceMappingURL=logger.js.map