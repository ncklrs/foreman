import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KnowledgeStore } from "../src/learning/knowledge.js";
import { AgentsMdManager } from "../src/learning/agents-md.js";
import { SkillsRegistry } from "../src/skills/registry.js";
import type { AgentSession, ReviewFinding } from "../src/types/index.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── KnowledgeStore Tests ─────────────────────────────────────────

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    task: {
      id: "task_1",
      title: "Fix auth bug",
      description: "Fix authentication issue",
      labels: ["bug", "auth"],
    },
    status: "completed",
    modelName: "claude-sonnet",
    messages: [],
    iterations: 5,
    maxIterations: 50,
    tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    startedAt: new Date(),
    completedAt: new Date(),
    artifacts: [],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "find_1",
    scanner: "security",
    severity: 3,
    title: "SQL injection in query builder",
    description: "Unsanitized input passed to query",
    filePath: "src/db/query.ts",
    lineNumber: 42,
    suggestion: "Use parameterized queries",
    effort: "small",
    tags: ["security", "sql"],
    ...overrides,
  };
}

describe("KnowledgeStore", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foreman-kb-"));
    store = new KnowledgeStore(tmpDir);
    await store.load();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should start with empty knowledge base", () => {
    const kb = store.getKnowledgeBase();
    expect(kb.lessons).toHaveLength(0);
    expect(kb.failurePatterns).toHaveLength(0);
    expect(kb.seenFindings).toHaveLength(0);
  });

  it("should learn from completed session", () => {
    const session = makeSession();
    store.learnFromSession(session);
    const kb = store.getKnowledgeBase();
    expect(kb.lessons.length).toBeGreaterThan(0);
    expect(kb.lessons[0].type).toBe("pattern");
    expect(kb.lessons[0].summary).toContain("claude-sonnet");
  });

  it("should track model preference from completed session", () => {
    const session = makeSession();
    store.learnFromSession(session);
    expect(store.getPreferredModel("bug")).toBe("claude-sonnet");
    expect(store.getPreferredModel("auth")).toBe("claude-sonnet");
  });

  it("should record failure from failed session", () => {
    const session = makeSession({
      status: "failed",
      error: "Context window exceeded",
    });
    store.learnFromSession(session);
    const kb = store.getKnowledgeBase();
    expect(kb.failurePatterns.length).toBe(1);
    expect(kb.failurePatterns[0].pattern).toBe("Context window exceeded");
  });

  it("should reinforce existing lessons", () => {
    const session = makeSession();
    store.learnFromSession(session);
    store.learnFromSession(session);
    const kb = store.getKnowledgeBase();
    const lesson = kb.lessons.find((l) => l.type === "pattern");
    expect(lesson!.reinforcements).toBe(2);
    expect(lesson!.confidence).toBeGreaterThan(0.5);
  });

  it("should increment failure occurrences", () => {
    store.recordFailure({ pattern: "timeout", approach: "method A", labels: ["bug"] });
    store.recordFailure({ pattern: "timeout", approach: "method B", labels: ["bug"] });
    const kb = store.getKnowledgeBase();
    expect(kb.failurePatterns.length).toBe(1);
    expect(kb.failurePatterns[0].occurrences).toBe(2);
  });

  it("should record failure resolution", () => {
    store.recordFailure({ pattern: "timeout", approach: "method A" });
    store.recordFailure({ pattern: "timeout", approach: "method B", resolution: "Increase timeout to 30s" });
    const kb = store.getKnowledgeBase();
    expect(kb.failurePatterns[0].resolution).toBe("Increase timeout to 30s");
  });

  it("should learn from user corrections", () => {
    store.learnFromUser("Use vitest not jest", "This project uses vitest", ["testing"]);
    const kb = store.getKnowledgeBase();
    expect(kb.lessons.length).toBe(1);
    expect(kb.lessons[0].type).toBe("preference");
    expect(kb.lessons[0].source).toBe("user");
  });

  it("should deduplicate autopilot findings", () => {
    const finding1 = makeFinding();
    const finding2 = makeFinding({ id: "find_2", title: "XSS in template" });
    const finding1Dup = makeFinding({ id: "find_3" }); // Same scanner+filePath+title

    const novel1 = store.learnFromFindings([finding1, finding2]);
    expect(novel1).toHaveLength(2);

    const novel2 = store.learnFromFindings([finding1Dup]);
    expect(novel2).toHaveLength(0);
  });

  it("should detect known findings", () => {
    const finding = makeFinding();
    store.learnFromFindings([finding]);
    expect(store.isKnownFinding(finding)).toBe(true);
    expect(store.isKnownFinding(makeFinding({ title: "Different issue" }))).toBe(false);
  });

  it("should retrieve lessons for task by labels", () => {
    store.learnFromUser("Use vitest", "details", ["testing"]);
    store.learnFromUser("Use eslint", "details", ["lint"]);
    store.learnFromUser("Auth pattern", "details", ["auth"]);

    const lessons = store.getLessonsForTask(["auth"], 10);
    expect(lessons.length).toBe(3);
    // Auth-tagged lesson should score higher
    expect(lessons[0].summary).toBe("Auth pattern");
  });

  it("should get failures for task by labels", () => {
    store.recordFailure({ pattern: "timeout", approach: "A", labels: ["bug"] });
    store.recordFailure({ pattern: "auth error", approach: "B", labels: ["auth"] });

    const failures = store.getFailuresForTask(["auth"]);
    expect(failures.length).toBe(1);
    expect(failures[0].pattern).toBe("auth error");
  });

  it("should return failures with high occurrences regardless of labels", () => {
    store.recordFailure({ pattern: "OOM", approach: "A", labels: ["infra"] });
    store.recordFailure({ pattern: "OOM", approach: "A", labels: ["infra"] });
    store.recordFailure({ pattern: "OOM", approach: "A", labels: ["infra"] });

    const failures = store.getFailuresForTask(["unrelated"]);
    expect(failures.length).toBe(1);
  });

  it("should build prompt section from lessons", () => {
    store.learnFromUser("Use vitest", "details", ["testing"]);
    store.recordFailure({ pattern: "Jest not found", approach: "ran jest", labels: ["testing"] });

    const section = store.buildPromptSection(["testing"]);
    expect(section).toContain("Lessons from Previous Sessions");
    expect(section).toContain("Project preferences");
    expect(section).toContain("Known failure patterns");
  });

  it("should return empty prompt section when no data", () => {
    const section = store.buildPromptSection(["anything"]);
    expect(section).toBe("");
  });

  it("should persist and reload", async () => {
    store.learnFromUser("Persist test", "detail", ["test"]);
    await store.save();

    const store2 = new KnowledgeStore(tmpDir);
    await store2.load();
    const kb = store2.getKnowledgeBase();
    expect(kb.lessons.length).toBe(1);
    expect(kb.lessons[0].summary).toBe("Persist test");
  });

  it("should skip save when not dirty", async () => {
    // Should not throw or create file if nothing changed
    await store.save();
    expect(existsSync(join(tmpDir, "knowledge.json"))).toBe(false);
  });

  it("should extract tool usage tips from sessions with excessive tool calls", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: Array.from({ length: 20 }, () => ({
          type: "tool_use" as const,
          id: "1",
          name: "read_file",
          input: {},
        })),
      },
    ];
    const session = makeSession({ messages });
    store.learnFromSession(session);

    const kb = store.getKnowledgeBase();
    const tip = kb.lessons.find((l) => l.type === "tool_tip");
    expect(tip).toBeDefined();
    expect(tip!.summary).toContain("read_file");
    expect(tip!.summary).toContain("20x");
  });

  it("should cap lessons at 200", () => {
    for (let i = 0; i < 210; i++) {
      store.learnFromUser(`Lesson ${i}`, `detail ${i}`, [`tag${i}`]);
    }
    const kb = store.getKnowledgeBase();
    expect(kb.lessons.length).toBeLessThanOrEqual(200);
  });

  it("should cap seen findings at 500", () => {
    const findings = Array.from({ length: 510 }, (_, i) =>
      makeFinding({ id: `find_${i}`, title: `Unique issue ${i}` })
    );
    store.learnFromFindings(findings);
    const kb = store.getKnowledgeBase();
    expect(kb.seenFindings.length).toBeLessThanOrEqual(500);
  });
});

// ── AgentsMdManager Tests ─────────────────────────────────────────

describe("AgentsMdManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "foreman-agentsmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should return null when no AGENTS.md exists", async () => {
    const manager = new AgentsMdManager(tmpDir);
    const content = await manager.load();
    expect(content).toBeNull();
  });

  it("should load AGENTS.md from root", async () => {
    await writeFile(join(tmpDir, "AGENTS.md"), "# Agent Guide\nUse vitest.");
    const manager = new AgentsMdManager(tmpDir);
    const content = await manager.load();
    expect(content).toBe("# Agent Guide\nUse vitest.");
  });

  it("should load from .github/AGENTS.md", async () => {
    await mkdir(join(tmpDir, ".github"), { recursive: true });
    await writeFile(join(tmpDir, ".github", "AGENTS.md"), "GitHub version");
    const manager = new AgentsMdManager(tmpDir);
    const content = await manager.load();
    expect(content).toBe("GitHub version");
  });

  it("should load from .foreman/AGENTS.md as fallback", async () => {
    await mkdir(join(tmpDir, ".foreman"), { recursive: true });
    await writeFile(join(tmpDir, ".foreman", "AGENTS.md"), "Foreman version");
    const manager = new AgentsMdManager(tmpDir);
    const content = await manager.load();
    expect(content).toBe("Foreman version");
  });

  it("should prefer root AGENTS.md over .github/AGENTS.md", async () => {
    await writeFile(join(tmpDir, "AGENTS.md"), "Root version");
    await mkdir(join(tmpDir, ".github"), { recursive: true });
    await writeFile(join(tmpDir, ".github", "AGENTS.md"), "GitHub version");
    const manager = new AgentsMdManager(tmpDir);
    const content = await manager.load();
    expect(content).toBe("Root version");
  });

  it("should cache loaded content", async () => {
    await writeFile(join(tmpDir, "AGENTS.md"), "Cached version");
    const manager = new AgentsMdManager(tmpDir);
    const first = await manager.load();
    await writeFile(join(tmpDir, "AGENTS.md"), "Updated version");
    const second = await manager.load();
    expect(second).toBe(first);
  });

  it("should invalidate cache", async () => {
    await writeFile(join(tmpDir, "AGENTS.md"), "V1");
    const manager = new AgentsMdManager(tmpDir);
    await manager.load();
    manager.invalidateCache();
    await writeFile(join(tmpDir, "AGENTS.md"), "V2");
    const content = await manager.load();
    expect(content).toBe("V2");
  });

  it("should build prompt section for short content", () => {
    const manager = new AgentsMdManager(tmpDir);
    const section = manager.buildPromptSection("Short guide");
    expect(section).toContain("Project Agent Guidelines");
    expect(section).toContain("Short guide");
  });

  it("should truncate prompt section for long content", () => {
    const manager = new AgentsMdManager(tmpDir);
    const longContent = "## Intro\n" + "x".repeat(2000) + "\n## Middle\n" + "y".repeat(2000) + "\n## End\nDone.";
    const section = manager.buildPromptSection(longContent);
    expect(section.length).toBeLessThan(longContent.length + 100);
    expect(section).toContain("Project Agent Guidelines");
  });

  it("should accept custom search paths", async () => {
    await writeFile(join(tmpDir, "custom-agents.md"), "Custom");
    const manager = new AgentsMdManager(tmpDir, ["custom-agents.md"]);
    const content = await manager.load();
    expect(content).toBe("Custom");
  });
});

// ── SkillsRegistry Tests ─────────────────────────────────────────

describe("SkillsRegistry", () => {
  let registry: SkillsRegistry;

  beforeEach(() => {
    registry = new SkillsRegistry();
  });

  it("should have 7 built-in skills", () => {
    const all = registry.getAll();
    expect(all.length).toBe(7);
    const names = all.map((s) => s.name);
    expect(names).toContain("code-review");
    expect(names).toContain("refactor");
    expect(names).toContain("test-writing");
    expect(names).toContain("bug-fix");
    expect(names).toContain("feature-implementation");
    expect(names).toContain("migration");
    expect(names).toContain("security-fix");
  });

  it("should get skill by name", () => {
    const skill = registry.get("code-review");
    expect(skill).toBeDefined();
    expect(skill!.description).toContain("Review code");
    expect(skill!.source).toBe("builtin");
  });

  it("should match skills by title", () => {
    const matches = registry.matchSkills("Fix the broken auth endpoint");
    const names = matches.map((s) => s.name);
    expect(names).toContain("bug-fix"); // "fix", "broken"
  });

  it("should match skills by labels", () => {
    const matches = registry.matchSkills("Do something", ["security"]);
    const names = matches.map((s) => s.name);
    expect(names).toContain("security-fix");
  });

  it("should match refactor skill", () => {
    const matches = registry.matchSkills("Refactor the payment module");
    const names = matches.map((s) => s.name);
    expect(names).toContain("refactor");
  });

  it("should match test-writing skill", () => {
    const matches = registry.matchSkills("Add unit tests for auth", ["test"]);
    const names = matches.map((s) => s.name);
    expect(names).toContain("test-writing");
  });

  it("should match migration skill", () => {
    const matches = registry.matchSkills("Migrate from React 17 to 18");
    const names = matches.map((s) => s.name);
    expect(names).toContain("migration");
  });

  it("should register custom skills", () => {
    registry.register({
      name: "custom-deploy",
      description: "Deploy to production",
      triggers: ["deploy", "release"],
      promptTemplate: "Deploy instructions here",
      tags: ["deploy"],
      source: "programmatic",
    });
    expect(registry.get("custom-deploy")).toBeDefined();
    expect(registry.getAll().length).toBe(8);
  });

  it("should unregister skills", () => {
    registry.unregister("code-review");
    expect(registry.get("code-review")).toBeUndefined();
    expect(registry.getAll().length).toBe(6);
  });

  it("should build prompt section", () => {
    const skills = registry.matchSkills("Fix the bug", ["bug"]);
    const section = registry.buildPromptSection(skills);
    expect(section).toContain("Active Skills");
    expect(section).toContain("bug-fix");
  });

  it("should return empty prompt section for no skills", () => {
    const section = registry.buildPromptSection([]);
    expect(section).toBe("");
  });

  it("should collect tools from skills", () => {
    registry.register({
      name: "tooled-skill",
      description: "Skill with tools",
      triggers: ["tooled"],
      promptTemplate: "Use tools",
      tools: [
        { name: "deploy_tool", description: "Deploy", inputSchema: { type: "object", properties: {} } },
        { name: "rollback_tool", description: "Rollback", inputSchema: { type: "object", properties: {} } },
      ],
      tags: ["deploy"],
      source: "programmatic",
    });

    const skill = registry.get("tooled-skill")!;
    const tools = registry.collectTools([skill]);
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("deploy_tool");
  });

  it("should deduplicate collected tools", () => {
    const toolDef = { name: "shared_tool", description: "Shared", inputSchema: { type: "object" as const, properties: {} } };
    registry.register({
      name: "skill-a",
      description: "A",
      triggers: ["a"],
      promptTemplate: "A",
      tools: [toolDef],
      tags: [],
      source: "programmatic",
    });
    registry.register({
      name: "skill-b",
      description: "B",
      triggers: ["b"],
      promptTemplate: "B",
      tools: [toolDef],
      tags: [],
      source: "programmatic",
    });

    const a = registry.get("skill-a")!;
    const b = registry.get("skill-b")!;
    const tools = registry.collectTools([a, b]);
    expect(tools.length).toBe(1);
  });

  describe("loadFromDirectory", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "foreman-skills-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("should return 0 when no .foreman/skills directory", async () => {
      const count = await registry.loadFromDirectory(tmpDir);
      expect(count).toBe(0);
    });

    it("should load skills from .foreman/skills/*.json", async () => {
      const skillsDir = join(tmpDir, ".foreman", "skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(
        join(skillsDir, "custom.json"),
        JSON.stringify({
          name: "custom-lint",
          description: "Run custom linter",
          triggers: ["lint", "style"],
          prompt_template: "Run the linter and fix issues",
          tags: ["lint"],
        })
      );

      const count = await registry.loadFromDirectory(tmpDir);
      expect(count).toBe(1);
      const skill = registry.get("custom-lint");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("file");
      expect(skill!.triggers).toEqual(["lint", "style"]);
    });

    it("should skip non-JSON files", async () => {
      const skillsDir = join(tmpDir, ".foreman", "skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(join(skillsDir, "readme.txt"), "not a skill");

      const count = await registry.loadFromDirectory(tmpDir);
      expect(count).toBe(0);
    });

    it("should skip invalid JSON gracefully", async () => {
      const skillsDir = join(tmpDir, ".foreman", "skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(join(skillsDir, "bad.json"), "not valid json{");

      const count = await registry.loadFromDirectory(tmpDir);
      expect(count).toBe(0);
    });

    it("should use filename as skill name if not specified", async () => {
      const skillsDir = join(tmpDir, ".foreman", "skills");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(
        join(skillsDir, "my-skill.json"),
        JSON.stringify({
          description: "Unnamed skill",
          triggers: ["unnamed"],
          prompt_template: "Do something",
        })
      );

      await registry.loadFromDirectory(tmpDir);
      expect(registry.get("my-skill")).toBeDefined();
    });
  });
});
