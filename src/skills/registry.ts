/**
 * Skills Registry.
 * An extensible system for composable agent capabilities.
 *
 * A "skill" is a higher-level capability than a raw tool — it encapsulates
 * a workflow pattern with a prompt template, required tools, and validation.
 *
 * Skills can be:
 * - Built-in (shipped with Foreman)
 * - Loaded from .foreman/skills/ directory
 * - Registered programmatically
 *
 * When an agent encounters a task that matches a skill, the skill's
 * prompt template and tools are injected into the agent's context.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ToolDefinition } from "../types/index.js";

export interface Skill {
  /** Unique identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** When to activate this skill (matched against task labels/title). */
  triggers: string[];
  /** System prompt additions when skill is active. */
  promptTemplate: string;
  /** Additional tools this skill requires. */
  tools?: ToolDefinition[];
  /** Tags for categorization. */
  tags: string[];
  /** Source: built-in, file, or programmatic. */
  source: "builtin" | "file" | "programmatic";
}

export class SkillsRegistry {
  private skills: Map<string, Skill> = new Map();

  constructor() {
    this.registerBuiltins();
  }

  /** Register a skill. */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /** Unregister a skill. */
  unregister(name: string): void {
    this.skills.delete(name);
  }

  /** Get a skill by name. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Get all registered skills. */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Find skills matching a task by title and labels.
   * Returns skills whose triggers match any of the provided terms.
   */
  matchSkills(title: string, labels: string[] = []): Skill[] {
    const terms = [
      ...title.toLowerCase().split(/\s+/),
      ...labels.map((l) => l.toLowerCase()),
    ];

    return Array.from(this.skills.values()).filter((skill) =>
      skill.triggers.some((trigger) => {
        const t = trigger.toLowerCase();
        return terms.some((term) => term.includes(t) || t.includes(term));
      })
    );
  }

  /**
   * Build a prompt section from matched skills.
   */
  buildPromptSection(skills: Skill[]): string {
    if (skills.length === 0) return "";

    const parts = ["## Active Skills\n"];

    for (const skill of skills) {
      parts.push(`### ${skill.name}\n${skill.promptTemplate}\n`);
    }

    return parts.join("\n");
  }

  /**
   * Collect additional tools from active skills.
   */
  collectTools(skills: Skill[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    const seen = new Set<string>();

    for (const skill of skills) {
      if (skill.tools) {
        for (const tool of skill.tools) {
          if (!seen.has(tool.name)) {
            tools.push(tool);
            seen.add(tool.name);
          }
        }
      }
    }

    return tools;
  }

  /**
   * Load skills from .foreman/skills/ directory.
   * Each file is a JSON skill definition.
   */
  async loadFromDirectory(workingDir: string): Promise<number> {
    const skillsDir = join(workingDir, ".foreman", "skills");
    if (!existsSync(skillsDir)) return 0;

    let loaded = 0;
    // Read directory entries
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(skillsDir);

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      try {
        const content = await readFile(resolve(skillsDir, entry), "utf-8");
        const raw = JSON.parse(content) as Record<string, unknown>;

        const skill: Skill = {
          name: String(raw.name ?? entry.replace(".json", "")),
          description: String(raw.description ?? ""),
          triggers: Array.isArray(raw.triggers) ? raw.triggers.map(String) : [],
          promptTemplate: String(raw.prompt_template ?? raw.promptTemplate ?? ""),
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
          source: "file",
        };

        if (Array.isArray(raw.tools)) {
          skill.tools = raw.tools as ToolDefinition[];
        }

        this.skills.set(skill.name, skill);
        loaded++;
      } catch {
        // Skip invalid skill files
      }
    }

    return loaded;
  }

  /** Register built-in skills. */
  private registerBuiltins(): void {
    this.register({
      name: "code-review",
      description: "Review code for quality, bugs, and style issues",
      triggers: ["review", "code-review", "audit", "check"],
      promptTemplate: `When performing a code review:
1. Read all changed files carefully
2. Check for bugs, logic errors, and edge cases
3. Verify error handling is adequate
4. Check for security issues (injection, XSS, auth bypasses)
5. Verify naming and style consistency
6. Check test coverage for changes
7. Provide specific, actionable feedback with file:line references
8. Distinguish between blocking issues and suggestions`,
      tags: ["quality", "review"],
      source: "builtin",
    });

    this.register({
      name: "refactor",
      description: "Refactor code while preserving behavior",
      triggers: ["refactor", "clean", "simplify", "extract", "reorganize"],
      promptTemplate: `When refactoring code:
1. Understand the current behavior fully before changing anything
2. Run existing tests first to establish a baseline
3. Make incremental changes — one refactoring at a time
4. Run tests after each change to verify behavior is preserved
5. Prefer extracting functions/modules over rewriting
6. Keep the public API stable unless explicitly asked to change it
7. Update imports and references when moving code
8. Do not change behavior — refactoring is structure-only`,
      tags: ["refactor", "quality"],
      source: "builtin",
    });

    this.register({
      name: "test-writing",
      description: "Write comprehensive tests for existing code",
      triggers: ["test", "coverage", "spec", "unit-test", "integration-test"],
      promptTemplate: `When writing tests:
1. Read the source code to understand all code paths
2. Follow existing test patterns and naming conventions
3. Test happy path, edge cases, and error cases
4. Use descriptive test names that explain the scenario
5. Prefer small, focused tests over large multi-assertion tests
6. Mock external dependencies (network, file system, time)
7. Verify both positive cases (things work) and negative cases (errors are handled)
8. Run the full test suite to verify nothing breaks`,
      tags: ["testing", "quality"],
      source: "builtin",
    });

    this.register({
      name: "bug-fix",
      description: "Diagnose and fix bugs systematically",
      triggers: ["bug", "fix", "broken", "error", "crash", "issue"],
      promptTemplate: `When fixing a bug:
1. Reproduce the issue first — understand exactly what's failing
2. Read error messages and stack traces carefully
3. Search the codebase for related code using search_codebase
4. Identify the root cause before writing any fix
5. Write a failing test that captures the bug
6. Apply the minimal fix needed
7. Verify the fix resolves the issue without side effects
8. Run the full test suite to check for regressions`,
      tags: ["bugfix", "debug"],
      source: "builtin",
    });

    this.register({
      name: "feature-implementation",
      description: "Implement new features end-to-end",
      triggers: ["feature", "implement", "add", "create", "build"],
      promptTemplate: `When implementing a new feature:
1. Understand the requirements fully from the task description
2. Survey the codebase architecture to find where the feature fits
3. Plan the implementation before writing code
4. Follow existing patterns for similar features
5. Implement incrementally — start with the core logic, then add edges
6. Add appropriate error handling
7. Write tests as you go
8. Run the full test suite before marking complete
9. Create a clear commit with conventional commit message`,
      tags: ["feature", "implementation"],
      source: "builtin",
    });

    this.register({
      name: "migration",
      description: "Perform dependency or API migrations",
      triggers: ["migrate", "upgrade", "update-deps", "migration"],
      promptTemplate: `When performing a migration:
1. Read the migration guide or changelog for the target version
2. Back up current state (ensure clean git status)
3. Update dependencies one at a time, not all at once
4. Run tests after each change
5. Update imports, API calls, and configuration as needed
6. Search for deprecated patterns using search_codebase
7. Update type definitions if APIs changed
8. Run the full build and test suite after all changes`,
      tags: ["migration", "dependencies"],
      source: "builtin",
    });

    this.register({
      name: "security-fix",
      description: "Address security vulnerabilities",
      triggers: ["security", "vulnerability", "cve", "xss", "injection", "auth"],
      promptTemplate: `When fixing a security issue:
1. Understand the vulnerability and its attack vector
2. Identify all affected code paths (not just the reported one)
3. Apply the fix following security best practices
4. Add input validation at the boundary (not deep in the code)
5. Never expose sensitive data in error messages or logs
6. Add tests that verify the vulnerability is fixed
7. Check for similar patterns elsewhere in the codebase
8. Prefer well-established security libraries over custom solutions`,
      tags: ["security"],
      source: "builtin",
    });
  }
}
