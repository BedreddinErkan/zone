import { describe, it, expect } from "vitest";
import { checkWriteScope } from "./scopeGuard.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";

function makePlan(filesLikely: string[]): ExecutionPlan {
  return {
    objective: "test",
    steps: [{ title: "step", description: "desc", filesLikely }],
    riskHints: [],
    scopeSummary: "test",
  };
}

describe("checkWriteScope", () => {
  it("allows any write when no plan is provided", () => {
    expect(checkWriteScope("src/foo.ts", null)).toBeNull();
  });

  it("allows any write when the plan has no filesLikely on any step", () => {
    const plan: ExecutionPlan = {
      objective: "x",
      steps: [{ title: "s", description: "d", filesLikely: [] }],
      riskHints: [],
      scopeSummary: "",
    };
    expect(checkWriteScope("src/anything.ts", plan)).toBeNull();
  });

  it("allows exact-match path", () => {
    const plan = makePlan(["src/cli/tui/store.tsx"]);
    expect(checkWriteScope("src/cli/tui/store.tsx", plan)).toBeNull();
  });

  it("blocks a path that is not in the plan", () => {
    const plan = makePlan(["src/cli/tui/store.tsx"]);
    expect(checkWriteScope("src/cli/tui/other.tsx", plan)).toMatch(/outside the planned scope/);
  });

  it("strips leading ./ before comparing", () => {
    const plan = makePlan(["src/a.ts"]);
    expect(checkWriteScope("./src/a.ts", plan)).toBeNull();
  });

  describe("TS/JS extension-family tolerance", () => {
    it("allows .tsx target when plan lists .ts with same stem and directory", () => {
      const plan = makePlan(["src/cli/tui/store.ts"]);
      expect(checkWriteScope("src/cli/tui/store.tsx", plan)).toBeNull();
    });

    it("allows .ts target when plan lists .tsx (symmetric)", () => {
      const plan = makePlan(["src/cli/tui/store.tsx"]);
      expect(checkWriteScope("src/cli/tui/store.ts", plan)).toBeNull();
    });

    it("allows .jsx target when plan lists .js", () => {
      const plan = makePlan(["src/utils/helper.js"]);
      expect(checkWriteScope("src/utils/helper.jsx", plan)).toBeNull();
    });

    it("allows .mts target when plan lists .mjs", () => {
      const plan = makePlan(["src/worker.mjs"]);
      expect(checkWriteScope("src/worker.mts", plan)).toBeNull();
    });

    it("blocks same stem but different directory", () => {
      const plan = makePlan(["src/cli/tui/store.ts"]);
      expect(checkWriteScope("src/other/store.tsx", plan)).toMatch(/outside the planned scope/);
    });

    it("blocks same stem but cross-family extension (.py vs .ts)", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/a.py", plan)).toMatch(/outside the planned scope/);
    });

    it("blocks different stem even within same extension family", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/b.tsx", plan)).toMatch(/outside the planned scope/);
    });

    it("blocks cross-family extension (.json vs .ts)", () => {
      const plan = makePlan(["src/config.ts"]);
      expect(checkWriteScope("src/config.json", plan)).toMatch(/outside the planned scope/);
    });
  });

  describe("repoPath absolute-path handling", () => {
    it("allows write to a file inside the repo using its absolute path", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/a.ts", plan, "/home/user/project")).toBeNull();
    });

    it("blocks an absolute path outside the repo", () => {
      const plan = makePlan(["src/a.ts"]);
      const result = checkWriteScope("/etc/passwd", plan, "/home/user/project");
      expect(result).toMatch(/resolves outside the repo/);
    });
  });

  describe("error message contents", () => {
    it("includes up to 5 planned paths in the error message", () => {
      const plan = makePlan(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
      const msg = checkWriteScope("z.ts", plan);
      expect(msg).not.toBeNull();
      expect(msg).toMatch(/and 1 more/);
    });
  });
});
