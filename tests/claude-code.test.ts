import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeCodeRunner } from "../src/runtime/adapters/claude-code.js";
import type { AgentTask, ForemanConfig, ForemanEvent } from "../src/types/index.js";

const baseConfig: ForemanConfig = {
  foreman: { name: "test", logLevel: "info", maxConcurrentAgents: 1, runtime: "claude-code" },
  models: {
    coder: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", role: "coder", maxTokens: 4096 },
  },
  routing: { strategy: "capability_match", fallbackChain: ["coder"] },
  sandbox: { type: "local", warmPool: 1, timeoutMinutes: 30, cleanup: "on_success" },
  policy: { protectedPaths: [], blockedCommands: [], maxDiffLines: 500, requireApprovalAbove: 200 },
};

const baseTask: AgentTask = {
  id: "task_1",
  title: "Fix auth bug",
  description: "Fix the authentication bypass vulnerability in auth.ts",
  labels: ["bug", "security"],
  repository: "myorg/myrepo",
  branch: "fix/auth-bug",
};

describe("ClaudeCodeRunner", () => {
  it("should create session with correct initial state", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    const session = runner.getSession();
    expect(session.id).toMatch(/^cc_/);
    expect(session.status).toBe("idle");
    expect(session.task.title).toBe("Fix auth bug");
    expect(session.iterations).toBe(0);
    expect(session.tokenUsage.inputTokens).toBe(0);
    expect(session.tokenUsage.outputTokens).toBe(0);
  });

  it("should use provided model name", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      model: "claude-opus-4-6",
    });

    expect(runner.getSession().modelName).toBe("claude-opus-4-6");
  });

  it("should abort gracefully", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    runner.abort();
    const session = runner.getSession();
    expect(session.status).toBe("failed");
    expect(session.error).toBe("Aborted by user");
  });

  it("should build prompt with enrichment", () => {
    const events: ForemanEvent[] = [];
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      onEvent: (event) => events.push(event),
      promptEnrichment: {
        lessonsSection: "## Lessons\n- Use vitest not jest",
        agentsMdSection: "## AGENTS.md\n- Follow TypeScript strict mode",
        skillsSection: "## Skills\n### bug-fix\nDiagnose first",
      },
    });

    // Access the private buildPrompt method via prototype
    const prompt = (runner as any).buildPrompt();
    expect(prompt).toContain("Fix auth bug");
    expect(prompt).toContain("Fix the authentication bypass");
    expect(prompt).toContain("Use vitest not jest");
    expect(prompt).toContain("Follow TypeScript strict mode");
    expect(prompt).toContain("Diagnose first");
    expect(prompt).toContain("myorg/myrepo");
    expect(prompt).toContain("fix/auth-bug");
  });

  it("should build correct CLI args", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      model: "claude-opus-4-6",
      maxTurns: 30,
      dangerouslyAutoApprove: true,
      allowedTools: ["Read", "Write"],
      disallowedTools: ["Bash"],
    });

    const args = (runner as any).buildArgs("test prompt");
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
    expect(args).toContain("--max-turns");
    expect(args).toContain("30");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read,Write");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Bash");
    expect(args).toContain("--");
    expect(args[args.length - 1]).toBe("test prompt");
  });

  it("should not include optional flags when not set", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    const args = (runner as any).buildArgs("test");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
  });

  it("should handle stream-json parsing", () => {
    const events: ForemanEvent[] = [];
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      onEvent: (event) => events.push(event),
    });

    // Test parsing assistant text message
    const handler = vi.fn();
    (runner as any).processStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "I'll fix the auth bug." },
      }),
      handler
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe("assistant");
  });

  it("should handle result message parsing", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    const handler = vi.fn();
    (runner as any).processStreamLine(
      JSON.stringify({
        type: "result",
        result: {
          text: "Fixed the auth bug",
          num_turns: 5,
          usage: { input_tokens: 5000, output_tokens: 2000 },
          cost_usd: 0.05,
        },
      }),
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.type).toBe("result");
    expect(msg.result.num_turns).toBe(5);
    expect(msg.result.usage.input_tokens).toBe(5000);
  });

  it("should handle non-JSON lines gracefully", () => {
    const events: ForemanEvent[] = [];
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      onEvent: (event) => events.push(event),
    });

    const handler = vi.fn();
    (runner as any).processStreamLine("not valid json", handler);
    expect(handler).not.toHaveBeenCalled();
    // Should emit as text delta
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("agent:stream");
  });

  it("should handle tool_use parsing", () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    const handler = vi.fn();
    (runner as any).processStreamLine(
      JSON.stringify({
        type: "assistant",
        subtype: "tool_use",
        tool_use: { name: "Read", input: { file_path: "/src/auth.ts" } },
      }),
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].tool_use.name).toBe("Read");
  });

  it("should handle ENOENT error for missing claude CLI", async () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    // Mock the spawn to fail with ENOENT
    const origSpawn = (runner as any).spawnClaude.bind(runner);
    (runner as any).spawnClaude = () =>
      Promise.reject(new Error("spawn claude ENOENT"));

    const session = await runner.run();
    expect(session.status).toBe("failed");
    expect(session.error).toContain("ENOENT");
  });

  it("should emit started event on run", async () => {
    const events: ForemanEvent[] = [];
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
      onEvent: (event) => events.push(event),
    });

    // Mock spawnClaude to resolve immediately
    (runner as any).spawnClaude = () =>
      Promise.resolve({
        exitCode: 0,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        turns: 3,
        summary: "Done",
      });

    await runner.run();

    expect(events[0].type).toBe("agent:started");
    expect(events[events.length - 1].type).toBe("agent:completed");
  });

  it("should handle non-zero exit as failure", async () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    (runner as any).spawnClaude = () =>
      Promise.resolve({
        exitCode: 1,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        turns: 1,
        summary: "",
        error: "Process error",
      });

    const session = await runner.run();
    expect(session.status).toBe("failed");
    expect(session.error).toContain("Process error");
  });

  it("should track tokens from result", async () => {
    const runner = new ClaudeCodeRunner({
      task: baseTask,
      config: baseConfig,
      workingDir: "/tmp",
    });

    (runner as any).spawnClaude = () =>
      Promise.resolve({
        exitCode: 0,
        tokenUsage: { inputTokens: 5000, outputTokens: 2000 },
        turns: 8,
        summary: "Fixed auth bug successfully",
      });

    const session = await runner.run();
    expect(session.status).toBe("completed");
    expect(session.tokenUsage.inputTokens).toBe(5000);
    expect(session.tokenUsage.outputTokens).toBe(2000);
    expect(session.iterations).toBe(8);
    expect(session.artifacts.length).toBe(1);
    expect(session.artifacts[0].content).toBe("Fixed auth bug successfully");
  });
});
