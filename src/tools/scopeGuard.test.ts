import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { checkWriteScope, maybeExpandScopeForSymbolMatch } from "./scopeGuard.js";
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

  describe("archetype bypass", () => {
    it("allows any write for refactor archetype regardless of plan", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/completely/unrelated.ts", plan, undefined, "refactor")).toBeNull();
    });

    it("allows any write for complex_multi_file archetype regardless of plan", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/completely/unrelated.ts", plan, undefined, "complex_multi_file")).toBeNull();
    });

    it("still blocks out-of-scope write for targeted_fix archetype", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/b.ts", plan, undefined, "targeted_fix")).toMatch(/outside the planned scope/);
    });

    it("still blocks out-of-scope write when archetype is undefined", () => {
      const plan = makePlan(["src/a.ts"]);
      expect(checkWriteScope("src/b.ts", plan)).toMatch(/outside the planned scope/);
    });
  });

  describe(".zone/ internal directory exemption", () => {
    const plan = makePlan(["src/foo.ts"]);
    const repoPath = "/tmp/myrepo";

    it("allows write to .zone/todo.json even when plan covers only user files", () => {
      expect(checkWriteScope(".zone/todo.json", plan, repoPath)).toBeNull();
    });

    it("allows write to .zone/memory.md", () => {
      expect(checkWriteScope(".zone/memory.md", plan, repoPath)).toBeNull();
    });

    it("allows write to .zone/ (the directory itself)", () => {
      expect(checkWriteScope(".zone", plan, repoPath)).toBeNull();
    });

    it("blocks a '.zone/../src/evil.ts' traversal path — does NOT exempt files outside .zone/", () => {
      // .zone/../src/evil.ts resolves to /tmp/myrepo/src/evil.ts which is outside .zone/
      const result = checkWriteScope(".zone/../src/evil.ts", plan, repoPath);
      // src/evil.ts is not in the plan (plan has src/foo.ts), so it must be blocked
      expect(result).toMatch(/outside the planned scope/);
    });

    it("traversal path .zone/../src/foo.ts is blocked even though resolved path is in plan", () => {
      // normalizePath does not collapse ".." in relative paths, so ".zone/../src/foo.ts"
      // is neither exempted by the .zone/ rule (resolves outside .zone/) nor matched
      // by the plan's "src/foo.ts" entry (different string). Traversal paths are always blocked.
      expect(checkWriteScope(".zone/../src/foo.ts", plan, repoPath)).toMatch(/outside the planned scope/);
    });
  });
});

describe("maybeExpandScopeForSymbolMatch", () => {
  const tmpFiles: string[] = [];

  async function makeTmpFile(content: string): Promise<string> {
    const name = join(tmpdir(), `scopeGuard-test-${randomBytes(6).toString("hex")}.ts`);
    await writeFile(name, content, "utf-8");
    tmpFiles.push(name);
    return name;
  }

  afterEach(async () => {
    for (const f of tmpFiles.splice(0)) {
      await unlink(f).catch(() => {});
    }
  });

  function makeRefactorPlan(objective: string): ExecutionPlan {
    return {
      objective,
      steps: [{ title: "rename", description: "apply rename", filesLikely: ["src/a.ts"] }],
      riskHints: [],
      scopeSummary: "",
    };
  }

  it("expands scope when blocked file contains a plan symbol (refactor archetype)", async () => {
    const tmpFile = await makeTmpFile(
      "export function cumulativeTokens() { return 0; }\n"
    );
    const repoPath = tmpdir();
    const relPath = basename(tmpFile);
    const plan = makeRefactorPlan("rename cumulativeTokens across codebase");
    const result = await maybeExpandScopeForSymbolMatch(
      plan, relPath, repoPath, "refactor"
    );
    expect(result.expanded).toBe(true);
    expect(result.addedFile).toBe(relPath);
    expect(result.reason).toMatch(/symbol_match/);
    expect((plan.steps[0] as { filesLikely: string[] }).filesLikely).toContain(relPath);
  });

  it("does not expand when blocked file does not contain any plan symbol", async () => {
    const tmpFile = await makeTmpFile(
      "export function unrelatedFunction() { return 42; }\n"
    );
    const repoPath = tmpdir();
    const plan = makeRefactorPlan("rename cumulativeTokens across codebase");
    const result = await maybeExpandScopeForSymbolMatch(
      plan, basename(tmpFile), repoPath, "refactor"
    );
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe("symbol_not_in_file");
  });

  it("does not expand for non-refactor archetype (targeted_fix)", async () => {
    const tmpFile = await makeTmpFile(
      "export const cumulativeTokens = 0;\n"
    );
    const repoPath = tmpdir();
    const plan = makeRefactorPlan("rename cumulativeTokens across codebase");
    const result = await maybeExpandScopeForSymbolMatch(
      plan, basename(tmpFile), repoPath, "targeted_fix"
    );
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe("archetype_not_refactor");
  });

  it("also expands for complex_multi_file archetype", async () => {
    const tmpFile = await makeTmpFile(
      "import { cumulativeTokens } from './store';\n"
    );
    const repoPath = tmpdir();
    const plan = makeRefactorPlan("rename cumulativeTokens across codebase");
    const result = await maybeExpandScopeForSymbolMatch(
      plan, basename(tmpFile), repoPath, "complex_multi_file"
    );
    expect(result.expanded).toBe(true);
  });

  it("does not throw when file does not exist — fails safe", async () => {
    const plan = makeRefactorPlan("rename cumulativeTokens across codebase");
    const result = await maybeExpandScopeForSymbolMatch(
      plan, "nonexistent-file-xyz.ts", tmpdir(), "refactor"
    );
    expect(result.expanded).toBe(false);
  });

  it("does not expand when plan is null", async () => {
    const result = await maybeExpandScopeForSymbolMatch(
      null, "src/a.ts", undefined, "refactor"
    );
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe("no_plan");
  });

  it("does not expand when file is already in scope", async () => {
    const tmpFile = await makeTmpFile(
      "export const cumulativeTokens = 0;\n"
    );
    const repoPath = tmpdir();
    const relPath = basename(tmpFile);
    const plan: ExecutionPlan = {
      objective: "rename cumulativeTokens across codebase",
      steps: [{ title: "rename", description: "apply rename", filesLikely: [relPath] }],
      riskHints: [],
      scopeSummary: "",
    };
    const result = await maybeExpandScopeForSymbolMatch(
      plan, relPath, repoPath, "refactor"
    );
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe("already_in_scope");
  });
});

// Schema salvage safety delta: salvaged plan (non-null) vs rejected plan (null → allow-all).
describe("checkWriteScope — salvage safety delta", () => {
  it("null plan (rejected/undefined) → allows write outside intended scope", () => {
    // Before fix: schema rejection left executionPlan=undefined; scopeGuard allowed all writes.
    expect(checkWriteScope("src/unrelated.ts", null)).toBeNull();
  });

  it("salvaged plan (non-empty steps) → blocks write outside filesLikely", () => {
    // After fix: schema salvages steps → executionPlan is defined → scope enforced.
    const plan = makePlan(["src/intended.ts"]);
    expect(checkWriteScope("src/unrelated.ts", plan)).toMatch(/outside the planned scope/);
  });

  it("salvaged plan → allows write inside filesLikely", () => {
    const plan = makePlan(["src/intended.ts"]);
    expect(checkWriteScope("src/intended.ts", plan)).toBeNull();
  });
});
