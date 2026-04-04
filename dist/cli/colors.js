"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.c = void 0;
exports.colorize = colorize;
exports.badge = badge;
exports.c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    orange: "\x1b[38;5;208m",
    bgGreen: "\x1b[42m",
    bgRed: "\x1b[41m",
    bgBlue: "\x1b[44m",
};
function colorize(text, ...codes) {
    return codes.join("") + text + exports.c.reset;
}
function badge(text, color) {
    return colorize(` ${text} `, exports.c.bold, color);
}
//# sourceMappingURL=colors.js.map