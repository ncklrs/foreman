import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillsRegistry } from "../src/skills/registry.js";
import type { Skill } from "../src/skills/registry.js";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: overrides.name ?? "test-skill",
    description: overrides.description ?? "A test skill",
    triggers: overrides.triggers ?? ["test"],
    promptTemplate: overrides.promptTemplate ?? "Do the test thing.",
    tags: overrides.tags ?? ["test"],
    source: overrides.source ?? "programmatic",
    ...(overrides.tools ? { tools: overrides.tools } : {}),
  };
}

describe("SkillsRegistry", () => {
  let registry: SkillsRegistry;

  beforeEach(() => {
    registry = new SkillsRegistry();
  });

  describe("built-in skills", () => {
    it("loads built-in skills on construction", () => {
      const all = registry.getAll();
      expect(all.length).toBeGreaterThan(0);
    });

    it("includes the code-review skill", () => {
      const skill = registry.get("code-review");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("code-review");
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("review");
    });

    it("includes the refactor skill", () => {
      const skill = registry.get("refactor");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("refactor");
    });

    it("includes the test-writing skill", () => {
      const skill = registry.get("test-writing");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("test");
    });

    it("includes the bug-fix skill", () => {
      const skill = registry.get("bug-fix");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("bug");
    });

    it("includes the feature-implementation skill", () => {
      const skill = registry.get("feature-implementation");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("feature");
    });

    it("includes the migration skill", () => {
      const skill = registry.get("migration");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("migrate");
    });

    it("includes the security-fix skill", () => {
      const skill = registry.get("security-fix");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("builtin");
      expect(skill!.triggers).toContain("security");
    });

    it("loads exactly 7 built-in skills", () => {
      const builtins = registry.getAll().filter((s) => s.source === "builtin");
      expect(builtins).toHaveLength(7);
    });
  });

  describe("register and getAll", () => {
    it("registers a new skill", () => {
      const skill = makeSkill({ name: "custom-skill" });

      registry.register(skill);

      expect(registry.get("custom-skill")).toBe(skill);
    });

    it("includes registered skills in getAll", () => {
      const skill = makeSkill({ name: "custom-skill" });

      registry.register(skill);

      const all = registry.getAll();
      const names = all.map((s) => s.name);
      expect(names).toContain("custom-skill");
    });

    it("getAll returns all built-in plus registered skills", () => {
      const beforeCount = registry.getAll().length;

      registry.register(makeSkill({ name: "extra-1" }));
      registry.register(makeSkill({ name: "extra-2" }));

      expect(registry.getAll()).toHaveLength(beforeCount + 2);
    });
  });

  describe("getByName (get)", () => {
    it("returns the skill when it exists", () => {
      const skill = makeSkill({ name: "lookup-me" });
      registry.register(skill);

      const result = registry.get("lookup-me");

      expect(result).toBe(skill);
    });

    it("returns undefined for an unregistered name", () => {
      const result = registry.get("nonexistent");

      expect(result).toBeUndefined();
    });

    it("returns the latest version when re-registered", () => {
      registry.register(makeSkill({ name: "dup", description: "first" }));
      registry.register(makeSkill({ name: "dup", description: "second" }));

      const result = registry.get("dup");
      expect(result!.description).toBe("second");
    });
  });

  describe("getByTrigger (matchSkills)", () => {
    it("matches skills by title words", () => {
      const matched = registry.matchSkills("Please review this code");

      const names = matched.map((s) => s.name);
      expect(names).toContain("code-review");
    });

    it("matches skills by labels", () => {
      const matched = registry.matchSkills("Do some work", ["bug"]);

      const names = matched.map((s) => s.name);
      expect(names).toContain("bug-fix");
    });

    it("returns empty array when nothing matches", () => {
      const matched = registry.matchSkills("zzz qqq xxx");

      expect(matched).toHaveLength(0);
    });

    it("matches are case-insensitive", () => {
      const matched = registry.matchSkills("REVIEW the CODE");

      const names = matched.map((s) => s.name);
      expect(names).toContain("code-review");
    });

    it("matches custom registered skills by trigger", () => {
      registry.register(
        makeSkill({
          name: "deploy",
          triggers: ["deploy", "ship"],
        })
      );

      const matched = registry.matchSkills("deploy to production");

      const names = matched.map((s) => s.name);
      expect(names).toContain("deploy");
    });

    it("returns multiple matches when triggers overlap", () => {
      const matched = registry.matchSkills("fix the security bug");

      const names = matched.map((s) => s.name);
      expect(names).toContain("bug-fix");
      expect(names).toContain("security-fix");
    });

    it("matches when trigger is a substring of a title word", () => {
      const matched = registry.matchSkills("refactoring the module");

      const names = matched.map((s) => s.name);
      expect(names).toContain("refactor");
    });
  });

  describe("deduplication", () => {
    it("overwrites a skill when re-registered with the same name", () => {
      const first = makeSkill({ name: "dup-skill", description: "v1" });
      const second = makeSkill({ name: "dup-skill", description: "v2" });

      registry.register(first);
      registry.register(second);

      expect(registry.get("dup-skill")!.description).toBe("v2");
    });

    it("does not increase the count when re-registering the same name", () => {
      const beforeCount = registry.getAll().length;

      registry.register(makeSkill({ name: "same-name" }));
      registry.register(makeSkill({ name: "same-name" }));

      expect(registry.getAll()).toHaveLength(beforeCount + 1);
    });

    it("re-registering a built-in replaces it", () => {
      const custom = makeSkill({
        name: "code-review",
        description: "My custom review",
        source: "programmatic",
      });

      registry.register(custom);

      const skill = registry.get("code-review");
      expect(skill!.description).toBe("My custom review");
      expect(skill!.source).toBe("programmatic");
    });
  });

  describe("unregister", () => {
    it("removes a registered skill", () => {
      registry.register(makeSkill({ name: "to-remove" }));

      registry.unregister("to-remove");

      expect(registry.get("to-remove")).toBeUndefined();
    });

    it("does not throw when unregistering a nonexistent skill", () => {
      expect(() => registry.unregister("nonexistent")).not.toThrow();
    });

    it("reduces the total count after unregister", () => {
      const beforeCount = registry.getAll().length;

      registry.register(makeSkill({ name: "temp" }));
      expect(registry.getAll()).toHaveLength(beforeCount + 1);

      registry.unregister("temp");
      expect(registry.getAll()).toHaveLength(beforeCount);
    });
  });

  describe("buildPromptSection", () => {
    it("returns empty string for no skills", () => {
      expect(registry.buildPromptSection([])).toBe("");
    });

    it("builds a formatted prompt section for matched skills", () => {
      const skill = makeSkill({
        name: "my-skill",
        promptTemplate: "Do the thing.",
      });

      const result = registry.buildPromptSection([skill]);

      expect(result).toContain("## Active Skills");
      expect(result).toContain("### my-skill");
      expect(result).toContain("Do the thing.");
    });

    it("includes multiple skills in the prompt section", () => {
      const skills = [
        makeSkill({ name: "skill-a", promptTemplate: "Template A" }),
        makeSkill({ name: "skill-b", promptTemplate: "Template B" }),
      ];

      const result = registry.buildPromptSection(skills);

      expect(result).toContain("### skill-a");
      expect(result).toContain("Template A");
      expect(result).toContain("### skill-b");
      expect(result).toContain("Template B");
    });
  });

  describe("collectTools", () => {
    it("returns empty array when no skills have tools", () => {
      const skills = [makeSkill({ name: "no-tools" })];

      expect(registry.collectTools(skills)).toEqual([]);
    });

    it("collects tools from skills", () => {
      const tool = {
        name: "my_tool",
        description: "A tool",
        inputSchema: { type: "object" },
      };
      const skill = makeSkill({ name: "with-tools", tools: [tool] });

      const tools = registry.collectTools([skill]);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("my_tool");
    });

    it("deduplicates tools by name across skills", () => {
      const sharedTool = {
        name: "shared_tool",
        description: "Shared",
        inputSchema: {},
      };
      const skillA = makeSkill({ name: "a", tools: [sharedTool] });
      const skillB = makeSkill({ name: "b", tools: [sharedTool] });

      const tools = registry.collectTools([skillA, skillB]);

      expect(tools).toHaveLength(1);
    });

    it("collects unique tools from multiple skills", () => {
      const toolA = { name: "tool_a", description: "A", inputSchema: {} };
      const toolB = { name: "tool_b", description: "B", inputSchema: {} };
      const skillA = makeSkill({ name: "a", tools: [toolA] });
      const skillB = makeSkill({ name: "b", tools: [toolB] });

      const tools = registry.collectTools([skillA, skillB]);

      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain("tool_a");
      expect(names).toContain("tool_b");
    });
  });
});
