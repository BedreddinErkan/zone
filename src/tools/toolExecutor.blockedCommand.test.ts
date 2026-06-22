/**
 * Change 2 regression: isBlockedCommand false-positive fixes.
 * git --format=, npm run format, grep "DROP TABLE" arg must no longer be blocked.
 */

import { describe, expect, it } from "vitest";
import { isBlockedCommand } from "./toolExecutor.js";

describe("isBlockedCommand — fixed false-positives", () => {
  it("git log --format=%H is not blocked", () => {
    expect(isBlockedCommand("git log --format=%H")).toBe(false);
  });
  it("git log --pretty=format:%h is not blocked", () => {
    expect(isBlockedCommand("git log --pretty=format:%h")).toBe(false);
  });
  it("git show -s --format=%an is not blocked", () => {
    expect(isBlockedCommand("git show -s --format=%an")).toBe(false);
  });
  it("npm run format is not blocked", () => {
    expect(isBlockedCommand("npm run format")).toBe(false);
  });
  it("grep \"DROP TABLE\" schema.sql is not blocked", () => {
    expect(isBlockedCommand('grep "DROP TABLE" schema.sql')).toBe(false);
  });
  it("cat schema.sql with no DROP is not blocked", () => {
    expect(isBlockedCommand("cat schema.sql")).toBe(false);
  });
});

describe("isBlockedCommand — preserved coverage", () => {
  it("rm -rf / is still blocked", () => {
    expect(isBlockedCommand("rm -rf /")).toBe(true);
  });
  it("del /f /s is still blocked", () => {
    expect(isBlockedCommand("del /f /s c:\\windows")).toBe(true);
  });
  it("format C: is blocked (Windows disk-format drive-letter form)", () => {
    expect(isBlockedCommand("format C:")).toBe(true);
  });
  it("mysql client with DROP TABLE is blocked", () => {
    expect(isBlockedCommand("mysql -e 'DROP TABLE foo'")).toBe(true);
  });
  it("psql client with DROP DATABASE is blocked", () => {
    expect(isBlockedCommand("psql -c 'DROP DATABASE mydb'")).toBe(true);
  });
});
