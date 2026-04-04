"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const rankRelevantFiles_js_1 = require("./rankRelevantFiles.js");
function buildRepoFile(path, category = "unknown") {
    const extension = path.includes(".") ? path.split(".").pop() ?? "" : "";
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension,
        category,
    };
}
(0, vitest_1.describe)("rankRelevantFiles", () => {
    (0, vitest_1.it)("prioritizes frontend component files for component tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "update the booking component UI",
            files: [
                buildRepoFile("server/routes/bookings.ts", "backend"),
                buildRepoFile("src/components/BookingCard.tsx", "frontend"),
                buildRepoFile("README.md"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("src/components/BookingCard.tsx");
    });
    (0, vitest_1.it)("prioritizes backend endpoint files for endpoint tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "fix the bookings endpoint response",
            files: [
                buildRepoFile("src/components/BookingCard.tsx", "frontend"),
                buildRepoFile("server/routes/bookings.ts", "backend"),
                buildRepoFile("server/controllers/bookingsController.ts", "backend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("server/controllers/bookingsController.ts");
        (0, vitest_1.expect)(ranked[1].path).toBe("server/routes/bookings.ts");
    });
    (0, vitest_1.it)("prioritizes auth-related files for auth tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "fix auth bug in login flow",
            files: [
                buildRepoFile("src/components/Dashboard.tsx", "frontend"),
                buildRepoFile("server/middleware/auth.ts", "backend"),
                buildRepoFile("server/routes/login.ts", "backend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("server/middleware/auth.ts");
        (0, vitest_1.expect)(ranked[1].path).toBe("server/routes/login.ts");
    });
    (0, vitest_1.it)("prioritizes config files for config and build tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "update build config for vite",
            files: [
                buildRepoFile("src/components/App.tsx", "frontend"),
                buildRepoFile("vite.config.ts"),
                buildRepoFile("package.json"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("vite.config.ts");
        (0, vitest_1.expect)(ranked[1].path).toBe("package.json");
    });
    (0, vitest_1.it)("falls back deterministically for ambiguous tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "improve flow",
            files: [
                buildRepoFile("README.md"),
                buildRepoFile("src/app.ts", "unknown"),
                buildRepoFile("server/index.ts", "backend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("server/index.ts");
        (0, vitest_1.expect)(ranked[1].path).toBe("src/app.ts");
        (0, vitest_1.expect)(ranked[2].path).toBe("README.md");
    });
    (0, vitest_1.it)("prioritizes ui html and css files for font and styling tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "improve font size and css styling for the ui header",
            files: [
                buildRepoFile("server/routes/bookings.ts", "backend"),
                buildRepoFile("src/ui/index.html", "frontend"),
                buildRepoFile("src/ui/styles.css", "frontend"),
                buildRepoFile("src/components/Header.tsx", "frontend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("src/ui/index.html");
        (0, vitest_1.expect)(ranked[1].path).toBe("src/ui/styles.css");
    });
    (0, vitest_1.it)("prioritizes css directory files for spacing and layout tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "fix layout spacing and padding in css",
            files: [
                buildRepoFile("src/app.ts", "frontend"),
                buildRepoFile("src/css/global.css", "frontend"),
                buildRepoFile("src/styles/theme.scss", "frontend"),
                buildRepoFile("server/index.ts", "backend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("src/css/global.css");
        (0, vitest_1.expect)(ranked[1].path).toBe("src/styles/theme.scss");
    });
    (0, vitest_1.it)("prioritizes src/ui/index.html for button background tasks", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "change Execute button background color in the Zone UI",
            files: [
                buildRepoFile("src/components/LoginForm.tsx", "frontend"),
                buildRepoFile("src/ui/index.html", "frontend"),
                buildRepoFile("src/ui/styles.css", "frontend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("src/ui/index.html");
    });
    (0, vitest_1.it)("prioritizes src/ui/index.html when task explicitly mentions index.html or known ui classes", () => {
        const ranked = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
            task: "update src/ui index.html exec-btn color and decision-badge styling",
            files: [
                buildRepoFile("src/components/LoginForm.tsx", "frontend"),
                buildRepoFile("src/ui/index.html", "frontend"),
                buildRepoFile("src/ui/styles.css", "frontend"),
            ],
        });
        (0, vitest_1.expect)(ranked[0].path).toBe("src/ui/index.html");
    });
});
//# sourceMappingURL=rankRelevantFiles.test.js.map