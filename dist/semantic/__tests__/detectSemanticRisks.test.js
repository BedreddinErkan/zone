"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const detectSemanticRisks_js_1 = require("../detectSemanticRisks.js");
const scoreSemanticRisk_js_1 = require("../scoreSemanticRisk.js");
(0, vitest_1.describe)("detectSemanticRisks", () => {
    (0, vitest_1.it)("detects auth guard removal", () => {
        const risks = (0, detectSemanticRisks_js_1.detectSemanticRisks)({
            filePath: "src/auth/routes.ts",
            beforeContent: `
export function loadDashboard() {
  return requireAuth(request, () => renderDashboard());
}
`.trim(),
            afterContent: `
export function loadDashboard() {
  return renderDashboard();
}
`.trim(),
        });
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            code: "AUTH_GUARD_REMOVED",
            severity: "high",
            category: "auth",
            filePath: "src/auth/routes.ts",
        });
    });
    (0, vitest_1.it)("detects test assertion removal", () => {
        const risks = (0, detectSemanticRisks_js_1.detectSemanticRisks)({
            filePath: "src/login/login.test.ts",
            beforeContent: `
import { expect, test } from "vitest";

test("logs in", () => {
  expect(result.ok).toBe(true);
  assert(user.id);
});
`.trim(),
            afterContent: `
import { test } from "vitest";

test("logs in", () => {
  performLogin();
});
`.trim(),
        });
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            code: "TEST_ASSERTION_REMOVED",
            severity: "high",
            category: "tests",
        });
        (0, vitest_1.expect)(risks[0].message).toContain("reduced from 2 to 0");
    });
    (0, vitest_1.it)("detects secret logging exposure", () => {
        const risks = (0, detectSemanticRisks_js_1.detectSemanticRisks)({
            filePath: "src/config/debug.ts",
            beforeContent: `
export function printConfig(logger: Logger) {
  logger.info("config loaded");
}
`.trim(),
            afterContent: `
export function printConfig(logger: Logger) {
  logger.info(process.env);
}
`.trim(),
        });
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            code: "SECRET_EXPOSED_TO_LOG",
            severity: "critical",
            category: "secrets",
        });
    });
    (0, vitest_1.it)("returns no risks for a no-risk change", () => {
        const risks = (0, detectSemanticRisks_js_1.detectSemanticRisks)({
            filePath: "src/utils/format.ts",
            beforeContent: `
export function formatName(name: string): string {
  return name.trim();
}
`.trim(),
            afterContent: `
export function formatName(name: string): string {
  return name.trim().toUpperCase();
}
`.trim(),
        });
        (0, vitest_1.expect)(risks).toEqual([]);
    });
    (0, vitest_1.it)("detects multiple risks in one file and scores them", () => {
        const risks = (0, detectSemanticRisks_js_1.detectSemanticRisks)({
            filePath: "src/api/userRoute.ts",
            beforeContent: `
export async function updateUser(req: Request, res: Response) {
  requireAuth(req);
  const schema = z.object({ email: z.string().email() });
  const payload = schema.parse(req.body);

  try {
    return service.update(payload);
  } catch (error) {
    logger.error(error);
    throw error;
  }
}
`.trim(),
            afterContent: `
export async function updateUser(req: Request, res: Response) {
  try {
    console.log(process.env);
    return service.update(req.body);
  } catch {}
}
`.trim(),
        });
        (0, vitest_1.expect)(risks.map((risk) => risk.code)).toEqual([
            "AUTH_GUARD_REMOVED",
            "SECRET_EXPOSED_TO_LOG",
            "VALIDATION_REMOVED",
            "BROAD_ERROR_SWALLOWING",
        ]);
        const score = (0, scoreSemanticRisk_js_1.scoreSemanticRisk)(risks);
        (0, vitest_1.expect)(score).toEqual({
            totalScore: 310,
            highestSeverity: "critical",
            countsBySeverity: {
                low: 0,
                medium: 0,
                high: 3,
                critical: 1,
            },
        });
    });
});
//# sourceMappingURL=detectSemanticRisks.test.js.map