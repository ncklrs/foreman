import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildCodebaseContext } from "../src/runtime/prompt.js";
import type { PromptEnrichment } from "../src/runtime/prompt.js";
import type { AgentTask, PolicyConfig } from "../src/types/index.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task_1",
    title: "Fix authentication bug",
    description: "Users are unable to log in when using SSO.",
    ...overrides,
  };
}

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    protectedPaths: [],
    blockedCommands: [],
    maxDiffLines: 500,
    requireApprovalAbove: 200,
    ...overrides,
  };
}

// ── buildSystemPrompt ─────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("should include core identity section", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    expect(prompt).toContain("You are Foreman Agent");
    expect(prompt).toContain("autonomous software engineering agent");
    expect(prompt).toContain("task_done");
  });

  it("should include task title and description", () => {
    const task = makeTask({
      title: "Add dark mode",
      description: "Implement dark mode toggle in settings.",
    });
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).toContain("**Title:** Add dark mode");
    expect(prompt).toContain("Implement dark mode toggle in settings.");
  });

  it("should include repository when provided", () => {
    const task = makeTask({ repository: "acme/webapp" });
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).toContain("**Repository:** acme/webapp");
  });

  it("should not include repository when absent", () => {
    const task = makeTask();
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).not.toContain("**Repository:**");
  });

  it("should include branch when provided", () => {
    const task = makeTask({ branch: "feature/dark-mode" });
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).toContain("**Branch:** feature/dark-mode");
  });

  it("should not include branch when absent", () => {
    const task = makeTask();
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).not.toContain("**Branch:**");
  });

  it("should include labels when provided", () => {
    const task = makeTask({ labels: ["bug", "urgent", "auth"] });
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).toContain("**Labels:** bug, urgent, auth");
  });

  it("should not include labels section when labels array is empty", () => {
    const task = makeTask({ labels: [] });
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).not.toContain("**Labels:**");
  });

  it("should not include labels section when labels is undefined", () => {
    const task = makeTask();
    delete task.labels;
    const prompt = buildSystemPrompt(task, "", makePolicy());
    expect(prompt).not.toContain("**Labels:**");
  });

  it("should include codebase context when non-empty", () => {
    const context = "### Project Structure\n```\nsrc/\n  index.ts\n```";
    const prompt = buildSystemPrompt(makeTask(), context, makePolicy());
    expect(prompt).toContain("## Codebase Context");
    expect(prompt).toContain("### Project Structure");
  });

  it("should not include codebase context when empty string", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    expect(prompt).not.toContain("## Codebase Context");
  });

  it("should always include code standards section", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    expect(prompt).toContain("## Code Standards");
    expect(prompt).toContain("Write clean, idiomatic code");
    expect(prompt).toContain("Run tests after making changes");
  });

  it("should always include tool usage guidelines", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    expect(prompt).toContain("## Tool Usage Guidelines");
    expect(prompt).toContain("### File Operations");
    expect(prompt).toContain("### Git Operations");
    expect(prompt).toContain("### Testing & Validation");
    expect(prompt).toContain("### Web & Research");
    expect(prompt).toContain("### Task Delegation");
    expect(prompt).toContain("### Completion");
  });

  // ── Policy constraints ──────────────────────────────────────────

  it("should include protected paths when present", () => {
    const policy = makePolicy({
      protectedPaths: ["package.json", ".env", "tsconfig.json"],
    });
    const prompt = buildSystemPrompt(makeTask(), "", policy);
    expect(prompt).toContain("## Protected Paths");
    expect(prompt).toContain("- package.json");
    expect(prompt).toContain("- .env");
    expect(prompt).toContain("- tsconfig.json");
  });

  it("should not include protected paths section when array is empty", () => {
    const policy = makePolicy({ protectedPaths: [] });
    const prompt = buildSystemPrompt(makeTask(), "", policy);
    expect(prompt).not.toContain("## Protected Paths");
  });

  it("should include blocked commands when present", () => {
    const policy = makePolicy({
      blockedCommands: ["rm -rf /", "DROP TABLE"],
    });
    const prompt = buildSystemPrompt(makeTask(), "", policy);
    expect(prompt).toContain("## Blocked Commands");
    expect(prompt).toContain("- `rm -rf /`");
    expect(prompt).toContain("- `DROP TABLE`");
  });

  it("should not include blocked commands section when array is empty", () => {
    const policy = makePolicy({ blockedCommands: [] });
    const prompt = buildSystemPrompt(makeTask(), "", policy);
    expect(prompt).not.toContain("## Blocked Commands");
  });

  it("should include both protected paths and blocked commands together", () => {
    const policy = makePolicy({
      protectedPaths: [".env"],
      blockedCommands: ["rm -rf /"],
    });
    const prompt = buildSystemPrompt(makeTask(), "", policy);
    expect(prompt).toContain("## Protected Paths");
    expect(prompt).toContain("## Blocked Commands");
  });

  // ── Custom instructions ─────────────────────────────────────────

  it("should include custom instructions when provided", () => {
    const instructions = "Always use TypeScript strict mode.";
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), instructions);
    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("Always use TypeScript strict mode.");
  });

  it("should not include custom instructions section when undefined", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    expect(prompt).not.toContain("## Additional Instructions");
  });

  // ── Enrichment injection ────────────────────────────────────────

  it("should inject lessons section from enrichment", () => {
    const enrichment: PromptEnrichment = {
      lessonsSection: "## Lessons Learned\n- Always run tests before committing.\n- Prefer small PRs.",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    expect(prompt).toContain("## Lessons Learned");
    expect(prompt).toContain("Always run tests before committing.");
    expect(prompt).toContain("Prefer small PRs.");
  });

  it("should inject AGENTS.md section from enrichment", () => {
    const enrichment: PromptEnrichment = {
      agentsMdSection: "## Project Conventions\n- Use camelCase for variables.\n- No default exports.",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    expect(prompt).toContain("## Project Conventions");
    expect(prompt).toContain("Use camelCase for variables.");
  });

  it("should inject skills section from enrichment", () => {
    const enrichment: PromptEnrichment = {
      skillsSection: "## Active Skills\n- code-review: Analyze code for quality issues.\n- bug-fix: Diagnose and fix bugs.",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    expect(prompt).toContain("## Active Skills");
    expect(prompt).toContain("code-review: Analyze code for quality issues.");
  });

  it("should inject all enrichment sections when all provided", () => {
    const enrichment: PromptEnrichment = {
      lessonsSection: "## Lessons\n- Lesson 1",
      agentsMdSection: "## Conventions\n- Convention 1",
      skillsSection: "## Skills\n- Skill 1",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    expect(prompt).toContain("## Lessons");
    expect(prompt).toContain("## Conventions");
    expect(prompt).toContain("## Skills");
  });

  it("should handle enrichment with no sections populated", () => {
    const enrichment: PromptEnrichment = {};
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    // Should still produce a valid prompt with core sections
    expect(prompt).toContain("You are Foreman Agent");
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("## Code Standards");
  });

  it("should place AGENTS.md before lessons in output", () => {
    const enrichment: PromptEnrichment = {
      lessonsSection: "LESSONS_MARKER",
      agentsMdSection: "AGENTSMD_MARKER",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    const agentsPos = prompt.indexOf("AGENTSMD_MARKER");
    const lessonsPos = prompt.indexOf("LESSONS_MARKER");
    expect(agentsPos).toBeLessThan(lessonsPos);
  });

  it("should place skills section after lessons in output", () => {
    const enrichment: PromptEnrichment = {
      lessonsSection: "LESSONS_MARKER",
      skillsSection: "SKILLS_MARKER",
    };
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), undefined, enrichment);
    const lessonsPos = prompt.indexOf("LESSONS_MARKER");
    const skillsPos = prompt.indexOf("SKILLS_MARKER");
    expect(lessonsPos).toBeLessThan(skillsPos);
  });

  // ── Section ordering ────────────────────────────────────────────

  it("should place task before code standards", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    const taskPos = prompt.indexOf("## Task");
    const standardsPos = prompt.indexOf("## Code Standards");
    expect(taskPos).toBeLessThan(standardsPos);
  });

  it("should place code standards before tool usage guidelines", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy());
    const standardsPos = prompt.indexOf("## Code Standards");
    const toolPos = prompt.indexOf("## Tool Usage Guidelines");
    expect(standardsPos).toBeLessThan(toolPos);
  });

  it("should place custom instructions last", () => {
    const prompt = buildSystemPrompt(makeTask(), "", makePolicy(), "Custom stuff");
    const customPos = prompt.indexOf("## Additional Instructions");
    const toolPos = prompt.indexOf("## Tool Usage Guidelines");
    expect(customPos).toBeGreaterThan(toolPos);
  });

  // ── Full integration ────────────────────────────────────────────

  it("should produce a comprehensive prompt with all sections", () => {
    const task = makeTask({
      title: "Implement OAuth2",
      description: "Add OAuth2 login flow with Google provider.",
      repository: "acme/auth-service",
      branch: "feature/oauth2",
      labels: ["feature", "auth"],
    });
    const context = "### Project Structure\n```\nsrc/\n  auth/\n    login.ts\n```";
    const policy = makePolicy({
      protectedPaths: [".env.production"],
      blockedCommands: ["rm -rf /"],
    });
    const instructions = "Use the existing passport.js setup.";
    const enrichment: PromptEnrichment = {
      lessonsSection: "## Lessons\n- Token refresh needs error handling.",
      agentsMdSection: "## Conventions\n- All auth code in src/auth/.",
      skillsSection: "## Skills\n- oauth-setup: Configure OAuth providers.",
    };

    const prompt = buildSystemPrompt(task, context, policy, instructions, enrichment);

    expect(prompt).toContain("You are Foreman Agent");
    expect(prompt).toContain("**Title:** Implement OAuth2");
    expect(prompt).toContain("Add OAuth2 login flow with Google provider.");
    expect(prompt).toContain("**Repository:** acme/auth-service");
    expect(prompt).toContain("**Branch:** feature/oauth2");
    expect(prompt).toContain("**Labels:** feature, auth");
    expect(prompt).toContain("## Codebase Context");
    expect(prompt).toContain("## Conventions");
    expect(prompt).toContain("## Lessons");
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("## Code Standards");
    expect(prompt).toContain("## Protected Paths");
    expect(prompt).toContain("- .env.production");
    expect(prompt).toContain("## Blocked Commands");
    expect(prompt).toContain("- `rm -rf /`");
    expect(prompt).toContain("## Tool Usage Guidelines");
    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("Use the existing passport.js setup.");
  });
});

// ── buildCodebaseContext ──────────────────────────────────────────

describe("buildCodebaseContext", () => {
  it("should include file tree when provided", () => {
    const tree = "src/\n  index.ts\n  utils.ts";
    const context = buildCodebaseContext(tree);
    expect(context).toContain("### Project Structure");
    expect(context).toContain("```\nsrc/\n  index.ts\n  utils.ts\n```");
  });

  it("should return empty string when file tree is empty and nothing else provided", () => {
    const context = buildCodebaseContext("");
    expect(context).toBe("");
  });

  it("should include recent commits when provided", () => {
    const commits = "abc1234 Fix login bug\ndef5678 Add tests";
    const context = buildCodebaseContext("src/", commits);
    expect(context).toContain("### Recent Commits");
    expect(context).toContain("Fix login bug");
    expect(context).toContain("Add tests");
  });

  it("should not include recent commits when undefined", () => {
    const context = buildCodebaseContext("src/");
    expect(context).not.toContain("### Recent Commits");
  });

  it("should include package info when provided", () => {
    const packageInfo = {
      name: "my-app",
      description: "A cool application",
    };
    const context = buildCodebaseContext("src/", undefined, packageInfo);
    expect(context).toContain("### Project Info");
    expect(context).toContain("**Name:** my-app");
    expect(context).toContain("**Description:** A cool application");
  });

  it("should default to 'unknown' name when package name is missing", () => {
    const packageInfo = { description: "No name" };
    const context = buildCodebaseContext("src/", undefined, packageInfo);
    expect(context).toContain("**Name:** unknown");
  });

  it("should default to empty description when package description is missing", () => {
    const packageInfo = { name: "my-app" };
    const context = buildCodebaseContext("src/", undefined, packageInfo);
    expect(context).toContain("**Description:** ");
  });

  it("should include scripts from package info", () => {
    const packageInfo = {
      name: "my-app",
      description: "App",
      scripts: {
        build: "tsc",
        test: "vitest",
        lint: "eslint .",
      },
    };
    const context = buildCodebaseContext("src/", undefined, packageInfo);
    expect(context).toContain("### Available Scripts");
    expect(context).toContain("- `build`: tsc");
    expect(context).toContain("- `test`: vitest");
    expect(context).toContain("- `lint`: eslint .");
  });

  it("should not include scripts section when scripts is undefined", () => {
    const packageInfo = { name: "my-app", description: "App" };
    const context = buildCodebaseContext("src/", undefined, packageInfo);
    expect(context).not.toContain("### Available Scripts");
  });

  it("should combine file tree, package info, and recent commits", () => {
    const tree = "src/\n  main.ts";
    const commits = "abc Fix bug";
    const packageInfo = {
      name: "my-app",
      description: "App",
      scripts: { test: "vitest" },
    };
    const context = buildCodebaseContext(tree, commits, packageInfo);
    expect(context).toContain("### Project Structure");
    expect(context).toContain("### Project Info");
    expect(context).toContain("### Available Scripts");
    expect(context).toContain("### Recent Commits");
  });

  it("should place project structure before recent commits", () => {
    const tree = "src/";
    const commits = "abc Fix";
    const context = buildCodebaseContext(tree, commits);
    const structurePos = context.indexOf("### Project Structure");
    const commitsPos = context.indexOf("### Recent Commits");
    expect(structurePos).toBeLessThan(commitsPos);
  });

  it("should place project info before recent commits", () => {
    const tree = "src/";
    const commits = "abc Fix";
    const packageInfo = { name: "app", description: "d" };
    const context = buildCodebaseContext(tree, commits, packageInfo);
    const infoPos = context.indexOf("### Project Info");
    const commitsPos = context.indexOf("### Recent Commits");
    expect(infoPos).toBeLessThan(commitsPos);
  });
});
