import { describe, expect, it } from "vitest";
import { checkCommandSafe } from "./runCommandSafe.js";

describe("checkCommandSafe", () => {
  describe("whitelist — safe commands pass", () => {
    it.each([
      "npx vitest run src/foo.test.ts",
      "npx vitest",
      "vitest run src/bar.test.ts",
      "npm test",
      "npm run test",
      "tsc --noEmit",
      "npx tsc --noEmit",
      "eslint src/",
      "npx eslint src/",
      "prettier --check .",
      "git diff",
      "git diff HEAD~1",
      "git log --oneline -10",
      "git status",
      "git show HEAD",
      "git branch -a",
      "ls -la",
      "ls",
      "cat src/foo.ts",
      "head -20 src/foo.ts",
      "tail -50 src/foo.ts",
      "wc -l src/foo.ts",
      "grep -rn 'pattern' src/",
      "rg 'pattern' src/",
      "go test ./...",
      "go vet ./...",
      "cargo check",
      "pytest src/",
      "python -m pytest src/",
    ])("allows: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(true);
    });
  });

  describe("whitelist — pipe to safe utilities allowed", () => {
    it.each([
      "npx vitest run | head -100",
      "git log --oneline | grep feat",
      "git diff | wc -l",
      "tsc --noEmit | tail -20",
      "ls -la | grep ts",
    ])("allows piped: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(true);
    });
  });

  describe("blacklist — mutations blocked", () => {
    it.each([
      ["rm -rf node_modules", "rm"],
      ["mv src/a.ts src/b.ts", "mv"],
      ["cp src/a.ts src/b.ts", "cp"],
      ["touch newfile.ts", "touch"],
      ["mkdir -p dist", "mkdir"],
      ["chmod 755 script.sh", "chmod"],
      ["chown user file", "chown"],
    ])("blocks mutation: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — redirects blocked", () => {
    it.each([
      "echo 'hello' > file.txt",
      "echo 'hello' >> file.txt",
      "tee output.txt",
    ])("blocks redirect: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — package mutations blocked", () => {
    it.each([
      "npm install lodash",
      "npm i lodash",
      "npm update",
      "npm uninstall lodash",
      "yarn add lodash",
      "yarn remove lodash",
      "pnpm add lodash",
      "pnpm install",
      "pip install requests",
      "cargo install ripgrep",
    ])("blocks package mutation: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — git mutations blocked", () => {
    it.each([
      "git push origin main",
      "git pull",
      "git fetch",
      "git commit -m 'msg'",
      "git merge main",
      "git rebase main",
      "git reset --hard HEAD",
    ])("blocks git mutation: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — network mutations blocked", () => {
    it.each([
      "curl -X POST https://example.com",
      "curl -X PUT https://example.com/data",
      "curl -X DELETE https://example.com/item",
      "wget https://example.com/file",
      "nc localhost 8080",
    ])("blocks network mutation: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — shell substitution blocked", () => {
    it.each([
      ["echo $(whoami)", "$("],
      ["echo `id`", "backtick"],
      ["ls $(pwd)", "$("],
      ["npx vitest $(echo run)", "$("],
    ])("blocks shell substitution: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — chain operators blocked", () => {
    it.each([
      "npx vitest && rm -rf /",
      "npm test; ls",
      "tsc || echo failed",
      "git status; git push",
    ])("blocks chain operator: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — privilege escalation blocked", () => {
    it.each([
      "sudo apt update",
      "sudo rm -rf /",
      "su root",
      "doas make install",
    ])("blocks privilege escalation: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("blacklist — process kill blocked", () => {
    it.each([
      "kill 1234",
      "pkill node",
      "killall node",
    ])("blocks process kill: %s", (cmd) => {
      expect(checkCommandSafe(cmd).safe).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("blocks empty command", () => {
      const result = checkCommandSafe("");
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/empty/);
    });

    it("blocks whitespace-only command", () => {
      expect(checkCommandSafe("   ").safe).toBe(false);
    });

    it("blocks unknown prefix not in whitelist", () => {
      const result = checkCommandSafe("python script.py");
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/not in whitelist/);
    });

    it("allows python -m pytest (explicit whitelist entry)", () => {
      expect(checkCommandSafe("python -m pytest src/").safe).toBe(true);
    });

    it("blocks pipe to unsafe utility", () => {
      expect(checkCommandSafe("npx vitest run | xargs rm").safe).toBe(false);
    });

    it("returns reason string on rejection", () => {
      const result = checkCommandSafe("rm -rf /");
      expect(result.safe).toBe(false);
      expect(typeof result.reason).toBe("string");
      expect(result.reason!.length).toBeGreaterThan(0);
    });

    it("returns no reason on safe command", () => {
      const result = checkCommandSafe("git diff");
      expect(result.safe).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });
});
