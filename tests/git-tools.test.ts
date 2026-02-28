import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ToolExecutor } from "../src/tools/executor.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

describe("Git Tools", () => {
  let workingDir: string;
  let executor: ToolExecutor;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "foreman-git-test-"));
    executor = new ToolExecutor(workingDir);

    // Initialize a git repo with signing disabled for test environment
    execSync("git init", { cwd: workingDir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    execSync('git config user.email "test@test.com"', { cwd: workingDir });
    execSync('git config user.name "Test"', { cwd: workingDir });
    execSync("git config commit.gpgsign false", { cwd: workingDir });
    execSync("git config tag.gpgsign false", { cwd: workingDir });

    // Create initial commit
    await writeFile(join(workingDir, "README.md"), "# Test\n");
    execSync("git add -A && git commit -m 'initial commit'", { cwd: workingDir });
  });

  afterAll(async () => {
    // Cleanup handled by OS tmpdir
  });

  it("git_status should show clean status", async () => {
    const result = await executor.execute("git_status", {});
    expect(result.isError).toBe(false);
    // Clean repo should have no output or only whitespace
    expect(result.output.trim()).toBe("(no output)");
  });

  it("git_status should show modified files", async () => {
    await writeFile(join(workingDir, "README.md"), "# Updated\n");
    const result = await executor.execute("git_status", {});
    expect(result.isError).toBe(false);
    expect(result.output).toContain("README.md");
  });

  it("git_diff should show unstaged changes", async () => {
    await writeFile(join(workingDir, "README.md"), "# Updated\n");
    const result = await executor.execute("git_diff", {});
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Updated");
  });

  it("git_diff should show staged changes", async () => {
    await writeFile(join(workingDir, "README.md"), "# Staged\n");
    execSync("git add README.md", { cwd: workingDir });

    const result = await executor.execute("git_diff", { staged: true });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Staged");
  });

  it("git_commit should stage and commit files", async () => {
    await writeFile(join(workingDir, "new-file.ts"), "console.log('hello');\n");

    const result = await executor.execute("git_commit", {
      message: "add new file",
      files: ["new-file.ts"],
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("add new file");

    // Verify commit exists
    const log = execSync("git log --oneline -1", { cwd: workingDir }).toString();
    expect(log).toContain("add new file");
  });

  it("git_commit should stage all changes when no files specified", async () => {
    await writeFile(join(workingDir, "a.ts"), "a\n");
    await writeFile(join(workingDir, "b.ts"), "b\n");

    const result = await executor.execute("git_commit", {
      message: "add multiple files",
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("add multiple files");
  });

  it("git_log should show recent commits", async () => {
    const result = await executor.execute("git_log", { count: 5 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("initial commit");
  });

  it("git_branch list should show branches", async () => {
    const result = await executor.execute("git_branch", { action: "list" });
    expect(result.isError).toBe(false);
    // Should contain main or master
    expect(result.output).toMatch(/main|master/);
  });

  it("git_branch create should create a new branch", async () => {
    const result = await executor.execute("git_branch", {
      action: "create",
      name: "feature/test",
    });
    expect(result.isError).toBe(false);

    // Should now be on the new branch
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workingDir }).toString().trim();
    expect(branch).toBe("feature/test");
  });

  it("git_branch switch should switch branches", async () => {
    // Create a branch first
    execSync("git checkout -b other-branch", { cwd: workingDir });
    execSync("git checkout -", { cwd: workingDir }); // go back

    const result = await executor.execute("git_branch", {
      action: "switch",
      name: "other-branch",
    });
    expect(result.isError).toBe(false);

    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: workingDir }).toString().trim();
    expect(branch).toBe("other-branch");
  });

  it("git_branch create should error without name", async () => {
    const result = await executor.execute("git_branch", { action: "create" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Branch name is required");
  });
});
