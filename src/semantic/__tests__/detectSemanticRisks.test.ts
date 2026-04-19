import { describe, expect, it } from "vitest";
import { detectSemanticRisks } from "../detectSemanticRisks.js";
import { scoreSemanticRisk } from "../scoreSemanticRisk.js";

describe("detectSemanticRisks", () => {
  it("detects auth guard removal", () => {
    const risks = detectSemanticRisks({
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

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      code: "AUTH_GUARD_REMOVED",
      severity: "high",
      category: "auth",
      filePath: "src/auth/routes.ts",
    });
  });

  it("detects test assertion removal", () => {
    const risks = detectSemanticRisks({
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

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      code: "TEST_ASSERTION_REMOVED",
      severity: "high",
      category: "tests",
    });
    expect(risks[0].message).toContain("reduced from 2 to 0");
  });

  it("detects secret logging exposure", () => {
    const risks = detectSemanticRisks({
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

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      code: "SECRET_EXPOSED_TO_LOG",
      severity: "critical",
      category: "secrets",
    });
  });

  it("returns no risks for a no-risk change", () => {
    const risks = detectSemanticRisks({
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

    expect(risks).toEqual([]);
  });

  it("detects multiple risks in one file and scores them", () => {
    const risks = detectSemanticRisks({
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
      diffLines: [
        "-  requireAuth(req);",
        "-  const schema = z.object({ email: z.string().email() });",
        "-  const payload = schema.parse(req.body);",
        '+    console.log(process.env);',
        "+    return service.update(req.body);",
        "+  } catch {}",
      ],
    });

    expect(risks.map((risk) => risk.code)).toEqual([
      "AUTH_GUARD_REMOVED",
      "SECRET_EXPOSED_TO_LOG",
      "VALIDATION_REMOVED",
      "BROAD_ERROR_SWALLOWING",
    ]);

    const score = scoreSemanticRisk(risks);

    expect(score).toEqual({
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

  it("does not flag validation removed for comment-only added diff lines", () => {
    const risks = detectSemanticRisks({
      filePath: "src/api/userRoute.ts",
      beforeContent: `
export async function updateUser(req: Request, res: Response) {
  const schema = z.object({ email: z.string().email() });
  return schema.parse(req.body);
}
`.trim(),
      afterContent: `
export async function updateUser(req: Request, res: Response) {
  // validation stays documented here
  /* schema usage explained for future cleanup */
  return req.body;
}
`.trim(),
      diffLines: [
        "+ // validation stays documented here",
        "+ /* schema usage explained for future cleanup */",
      ],
    });

    expect(risks.map((risk) => risk.code)).not.toContain("VALIDATION_REMOVED");
  });

  it("does not flag validation removed without an explicit removed validation diff line", () => {
    const risks = detectSemanticRisks({
      filePath: "src/api/userRoute.ts",
      beforeContent: `
export async function updateUser(req: Request, res: Response) {
  const schema = z.object({ email: z.string().email() });
  return schema.parse(req.body);
}
`.trim(),
      afterContent: `
export async function updateUser(req: Request, res: Response) {
  return req.body;
}
`.trim(),
      diffLines: [
        "-  const payload = buildPayload(req.body);",
        "+  return req.body;",
      ],
    });

    expect(risks.map((risk) => risk.code)).not.toContain("VALIDATION_REMOVED");
  });
});
