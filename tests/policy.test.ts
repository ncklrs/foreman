import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";

const defaultPolicy = {
  protectedPaths: ["package.json", ".env*", ".github/*"],
  blockedCommands: ["rm -rf /", "curl | sh"],
  maxDiffLines: 500,
  requireApprovalAbove: 200,
};

describe("PolicyEngine", () => {
  it("allows read operations", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("read_file", { path: "src/index.ts" });
    expect(result.decision).toBe("allow");
  });

  it("allows writing to non-protected paths", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("write_file", {
      path: "src/utils/helper.ts",
      content: "export const x = 1;",
    });
    expect(result.decision).toBe("allow");
  });

  it("requires approval for writing to protected paths", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("write_file", {
      path: "package.json",
      content: "{}",
    });
    expect(result.decision).toBe("require_approval");
  });

  it("requires approval for .env files", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("edit_file", {
      path: ".env.local",
      old_string: "a",
      new_string: "b",
    });
    expect(result.decision).toBe("require_approval");
  });

  it("requires approval for .github paths", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("write_file", {
      path: ".github/workflows/ci.yml",
      content: "on: push",
    });
    expect(result.decision).toBe("require_approval");
  });

  it("denies blocked commands", () => {
    const engine = new PolicyEngine(defaultPolicy);
    const result = engine.evaluate("run_command", { command: "rm -rf /" });
    expect(result.decision).toBe("deny");
  });

  it("denies dangerous patterns", () => {
    const engine = new PolicyEngine(defaultPolicy);

    const forkBomb = engine.evaluate("run_command", {
      command: ":() { :|: & }; :",
    });
    expect(forkBomb.decision).toBe("deny");
  });

  it("requires approval for dependency modifications", () => {
    const engine = new PolicyEngine(defaultPolicy);

    const npmInstall = engine.evaluate("run_command", {
      command: "npm install express",
    });
    expect(npmInstall.decision).toBe("require_approval");

    const gitPush = engine.evaluate("run_command", {
      command: "git push origin main",
    });
    expect(gitPush.decision).toBe("require_approval");
  });

  it("allows normal commands", () => {
    const engine = new PolicyEngine(defaultPolicy);

    const ls = engine.evaluate("run_command", { command: "ls -la" });
    expect(ls.decision).toBe("allow");

    const grep = engine.evaluate("run_command", { command: "grep -r 'TODO' src/" });
    expect(grep.decision).toBe("allow");

    const test = engine.evaluate("run_command", { command: "npm test" });
    expect(test.decision).toBe("allow");
  });

  it("tracks cumulative diff size", () => {
    const engine = new PolicyEngine({
      ...defaultPolicy,
      requireApprovalAbove: 10,
      maxDiffLines: 20,
    });

    // First small write — OK
    const r1 = engine.evaluate("write_file", {
      path: "a.ts",
      content: "line1\nline2\nline3",
    });
    expect(r1.decision).toBe("allow");

    // Second write — cumulative exceeds approval threshold
    const r2 = engine.evaluate("write_file", {
      path: "b.ts",
      content: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10",
    });
    expect(r2.decision).toBe("require_approval");
  });

  it("evaluates diff size limits", () => {
    const engine = new PolicyEngine(defaultPolicy);

    const within = engine.evaluateDiffSize(100);
    expect(within.decision).toBe("allow");

    const needsApproval = engine.evaluateDiffSize(300);
    expect(needsApproval.decision).toBe("require_approval");

    const tooLarge = engine.evaluateDiffSize(600);
    expect(tooLarge.decision).toBe("deny");
  });
});
