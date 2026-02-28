import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";
import type { PolicyConfig } from "../src/types/index.js";

const defaultConfig: PolicyConfig = {
  protectedPaths: ["package.json", ".env*", ".github/*"],
  blockedCommands: ["rm -rf /", "curl | sh"],
  maxDiffLines: 500,
  requireApprovalAbove: 200,
};

describe("PolicyEngine — git/PR tools", () => {
  it("should require approval for create_pull_request", () => {
    const engine = new PolicyEngine(defaultConfig);
    const result = engine.evaluate("create_pull_request", {
      title: "Add new feature",
      body: "Description",
      base: "main",
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toContain("remote repository");
  });

  it("should allow git_commit when diff is small", () => {
    const engine = new PolicyEngine(defaultConfig);
    const result = engine.evaluate("git_commit", {
      message: "fix typo",
    });

    expect(result.decision).toBe("allow");
  });

  it("should require approval for git_commit when diff is large", () => {
    const engine = new PolicyEngine(defaultConfig);

    // Simulate large changes
    for (let i = 0; i < 50; i++) {
      engine.trackDiffLines(`file${i}.ts`, 10);
    }
    // Total: 500 lines > 200 threshold

    const result = engine.evaluate("git_commit", {
      message: "large refactor",
    });

    expect(result.decision).toBe("require_approval");
    expect(result.reason).toContain("approval threshold");
  });

  it("should allow read-only git tools without restriction", () => {
    const engine = new PolicyEngine(defaultConfig);

    expect(engine.evaluate("git_status", {}).decision).toBe("allow");
    expect(engine.evaluate("git_diff", {}).decision).toBe("allow");
    expect(engine.evaluate("git_log", {}).decision).toBe("allow");
    expect(engine.evaluate("git_branch", { action: "list" }).decision).toBe("allow");
  });

  it("should allow web_fetch without restriction", () => {
    const engine = new PolicyEngine(defaultConfig);
    const result = engine.evaluate("web_fetch", {
      url: "https://example.com/api/docs",
    });

    expect(result.decision).toBe("allow");
  });
});
