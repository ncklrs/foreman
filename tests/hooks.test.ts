import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookHandler } from "../src/hooks/handler.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { KnowledgeStore } from "../src/learning/knowledge.js";
import { EventBus } from "../src/events/bus.js";
import { Logger } from "../src/logging/logger.js";
import {
  generateHooksConfig,
  printHooksConfig,
  pathToEvent,
} from "../src/hooks/config.js";
import { DEFAULT_HOOKS_CONFIG } from "../src/hooks/types.js";
import type {
  HookPayload,
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
  TaskCompletedPayload,
  SessionStartPayload,
  NotificationPayload,
  HooksSetupOptions,
} from "../src/hooks/types.js";

// ── Test helpers ────────────────────────────────────────────────

function createHandler() {
  const policyEngine = new PolicyEngine({
    protectedPaths: [".env", ".github/*"],
    blockedCommands: ["rm -rf /"],
    maxDiffLines: 500,
    requireApprovalAbove: 200,
  });

  const knowledgeStore = new KnowledgeStore("/tmp/test-hooks-kb");
  const eventBus = new EventBus(100);
  const logger = new Logger("error", "test");

  const handler = new HookHandler({
    policyEngine,
    knowledgeStore,
    eventBus,
    logger,
  });

  return { handler, policyEngine, knowledgeStore, eventBus, logger };
}

// ── HookHandler Tests ───────────────────────────────────────────

describe("HookHandler", () => {
  describe("PreToolUse", () => {
    it("should allow safe tool calls", async () => {
      const { handler } = createHandler();

      const payload: PreToolUsePayload = {
        type: "PreToolUse",
        session_id: "sess_1",
        tool_name: "Read",
        tool_input: { file_path: "/src/index.ts" },
      };

      const response = await handler.handle(payload);
      expect(response.decision).toBe("allow");
    });

    it("should deny blocked commands via Bash", async () => {
      const { handler } = createHandler();

      const payload: PreToolUsePayload = {
        type: "PreToolUse",
        session_id: "sess_1",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      };

      const response = await handler.handle(payload);
      expect(response.decision).toBe("deny");
      expect(response.reason).toContain("blocked");
    });

    it("should deny writes to protected paths", async () => {
      const { handler } = createHandler();

      const payload: PreToolUsePayload = {
        type: "PreToolUse",
        session_id: "sess_1",
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "SECRET=leaked" },
      };

      const response = await handler.handle(payload);
      expect(response.decision).toBe("deny");
      expect(response.reason).toContain("protected");
    });

    it("should deny edits to protected paths", async () => {
      const { handler } = createHandler();

      const payload: PreToolUsePayload = {
        type: "PreToolUse",
        session_id: "sess_1",
        tool_name: "Edit",
        tool_input: { file_path: ".env", old_string: "FOO=bar", new_string: "FOO=baz" },
      };

      const response = await handler.handle(payload);
      expect(response.decision).toBe("deny");
    });

    it("should map require_approval to deny in hooks mode", async () => {
      const { handler } = createHandler();

      // git push requires approval in the policy engine
      const payload: PreToolUsePayload = {
        type: "PreToolUse",
        session_id: "sess_1",
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      };

      const response = await handler.handle(payload);
      expect(response.decision).toBe("deny");
      expect(response.reason).toContain("approval");
    });

    it("should track tool calls in session state", async () => {
      const { handler } = createHandler();

      await handler.handle({
        type: "PreToolUse",
        session_id: "sess_track",
        tool_name: "Read",
        tool_input: { file_path: "/src/a.ts" },
      });

      await handler.handle({
        type: "PreToolUse",
        session_id: "sess_track",
        tool_name: "Read",
        tool_input: { file_path: "/src/b.ts" },
      });

      const session = handler.getSession("sess_track");
      expect(session).toBeDefined();
      expect(session!.toolCalls).toBe(2);
    });

    it("should track denied calls separately", async () => {
      const { handler } = createHandler();

      await handler.handle({
        type: "PreToolUse",
        session_id: "sess_deny",
        tool_name: "Read",
        tool_input: { file_path: "/safe.ts" },
      });

      await handler.handle({
        type: "PreToolUse",
        session_id: "sess_deny",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      });

      const session = handler.getSession("sess_deny");
      expect(session!.toolCalls).toBe(2);
      expect(session!.deniedCalls).toBe(1);
    });

    it("should emit tool_call event", async () => {
      const { handler, eventBus } = createHandler();

      const events: any[] = [];
      eventBus.onAny((e) => events.push(e));

      await handler.handle({
        type: "PreToolUse",
        session_id: "sess_evt",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("agent:tool_call");
      expect(events[0].toolName).toBe("Read");
    });
  });

  describe("PostToolUse", () => {
    it("should always return allow", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "PostToolUse",
        session_id: "sess_1",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_output: "hello",
        duration_ms: 50,
      });

      expect(response.decision).toBe("allow");
    });

    it("should track tool history in session", async () => {
      const { handler } = createHandler();

      await handler.handle({
        type: "PostToolUse",
        session_id: "sess_post",
        tool_name: "Read",
        tool_input: { file_path: "/src/a.ts" },
        tool_output: "file contents",
        duration_ms: 10,
      });

      await handler.handle({
        type: "PostToolUse",
        session_id: "sess_post",
        tool_name: "Write",
        tool_input: { file_path: "/src/b.ts", content: "new content" },
        tool_output: "written",
        duration_ms: 25,
      });

      const session = handler.getSession("sess_post");
      expect(session!.toolHistory).toHaveLength(2);
      expect(session!.toolHistory[0].tool).toBe("Read");
      expect(session!.toolHistory[1].tool).toBe("Write");
      expect(session!.toolHistory[1].durationMs).toBe(25);
    });

    it("should emit tool_result event", async () => {
      const { handler, eventBus } = createHandler();

      const events: any[] = [];
      eventBus.onAny((e) => events.push(e));

      await handler.handle({
        type: "PostToolUse",
        session_id: "sess_evt",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_output: "files",
        tool_error: false,
        duration_ms: 20,
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("agent:tool_result");
      expect(events[0].toolName).toBe("Bash");
    });

    it("should record error status from tool calls", async () => {
      const { handler } = createHandler();

      await handler.handle({
        type: "PostToolUse",
        session_id: "sess_err",
        tool_name: "Bash",
        tool_input: { command: "false" },
        tool_output: "command failed",
        tool_error: true,
        duration_ms: 5,
      });

      const session = handler.getSession("sess_err");
      expect(session!.toolHistory[0].error).toBe(true);
    });
  });

  describe("SessionStart", () => {
    it("should register a new session", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "SessionStart",
        session_id: "sess_start_1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/home/user/project",
      });

      expect(response.decision).toBe("allow");

      const session = handler.getSession("sess_start_1");
      expect(session).toBeDefined();
      expect(session!.model).toBe("claude-sonnet-4-5-20250929");
      expect(session!.cwd).toBe("/home/user/project");
    });

    it("should emit agent:started event", async () => {
      const { handler, eventBus } = createHandler();

      const events: any[] = [];
      eventBus.onAny((e) => events.push(e));

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_start_2",
        model: "claude-opus-4-6",
      });

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("agent:started");
      expect(events[0].session.modelName).toBe("claude-opus-4-6");
    });

    it("should be accessible via getSessions", async () => {
      const { handler } = createHandler();

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_a",
      });

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_b",
      });

      expect(handler.getSessions()).toHaveLength(2);
      expect(handler.getSessionCount()).toBe(2);
    });
  });

  describe("Stop", () => {
    it("should return allow", async () => {
      const { handler } = createHandler();

      // Start a session first
      await handler.handle({
        type: "SessionStart",
        session_id: "sess_stop",
      });

      const response = await handler.handle({
        type: "Stop",
        session_id: "sess_stop",
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 500 },
        num_turns: 5,
      });

      expect(response.decision).toBe("allow");
    });

    it("should emit agent:failed on error stop", async () => {
      const { handler, eventBus } = createHandler();

      const events: any[] = [];
      eventBus.onAny((e) => events.push(e));

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_fail",
      });

      await handler.handle({
        type: "Stop",
        session_id: "sess_fail",
        stop_reason: "error",
      });

      const failEvent = events.find((e) => e.type === "agent:failed");
      expect(failEvent).toBeDefined();
    });

    it("should handle stop for unknown session gracefully", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "Stop",
        session_id: "unknown_session",
        stop_reason: "end_turn",
      });

      expect(response.decision).toBe("allow");
    });
  });

  describe("TaskCompleted", () => {
    it("should learn from completed task", async () => {
      const { handler, knowledgeStore } = createHandler();

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_complete",
        model: "claude-sonnet-4-5-20250929",
      });

      await handler.handle({
        type: "TaskCompleted",
        session_id: "sess_complete",
        task: "Fix the login bug",
        summary: "Fixed the authentication issue in auth.ts",
        usage: { input_tokens: 5000, output_tokens: 2000 },
        num_turns: 8,
        cost_usd: 0.05,
      });

      // Session should be cleaned up after completion
      expect(handler.getSession("sess_complete")).toBeUndefined();

      // Knowledge should have been updated
      const kb = knowledgeStore.getKnowledgeBase();
      expect(kb.lessons.length).toBeGreaterThan(0);
    });

    it("should emit agent:completed event", async () => {
      const { handler, eventBus } = createHandler();

      const events: any[] = [];
      eventBus.onAny((e) => events.push(e));

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_tc",
      });

      await handler.handle({
        type: "TaskCompleted",
        session_id: "sess_tc",
        summary: "Done",
      });

      const completedEvent = events.find((e) => e.type === "agent:completed");
      expect(completedEvent).toBeDefined();
    });

    it("should handle completion for unknown session", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "TaskCompleted",
        session_id: "unknown",
        summary: "Done",
      });

      expect(response.decision).toBe("allow");
    });
  });

  describe("Notification", () => {
    it("should return allow", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "Notification",
        session_id: "sess_1",
        message: "Agent is processing...",
        level: "info",
      });

      expect(response.decision).toBe("allow");
    });

    it("should handle all log levels", async () => {
      const { handler } = createHandler();

      for (const level of ["info", "warning", "error"] as const) {
        const response = await handler.handle({
          type: "Notification",
          session_id: "sess_1",
          message: `Test ${level}`,
          level,
        });
        expect(response.decision).toBe("allow");
      }
    });
  });

  describe("unknown events", () => {
    it("should return allow for unknown event types", async () => {
      const { handler } = createHandler();

      const response = await handler.handle({
        type: "UnknownEvent" as any,
        session_id: "sess_1",
      });

      expect(response.decision).toBe("allow");
    });
  });

  describe("learning from tool history", () => {
    it("should learn from excessive tool usage on stop", async () => {
      const { handler, knowledgeStore } = createHandler();

      // Start session
      await handler.handle({
        type: "SessionStart",
        session_id: "sess_learn",
      });

      // Simulate 20 Read calls via PostToolUse
      for (let i = 0; i < 20; i++) {
        await handler.handle({
          type: "PostToolUse",
          session_id: "sess_learn",
          tool_name: "Read",
          tool_input: { file_path: `/src/file${i}.ts` },
          tool_output: "content",
          duration_ms: 10,
        });
      }

      // Stop the session — triggers learning
      await handler.handle({
        type: "Stop",
        session_id: "sess_learn",
        stop_reason: "end_turn",
      });

      const kb = knowledgeStore.getKnowledgeBase();
      const toolLesson = kb.lessons.find((l) => l.summary.includes("Read"));
      expect(toolLesson).toBeDefined();
    });

    it("should record high error rate as failure pattern", async () => {
      const { handler, knowledgeStore } = createHandler();

      await handler.handle({
        type: "SessionStart",
        session_id: "sess_errors",
      });

      // 4 out of 5 calls error
      for (let i = 0; i < 5; i++) {
        await handler.handle({
          type: "PostToolUse",
          session_id: "sess_errors",
          tool_name: "Bash",
          tool_input: { command: `test ${i}` },
          tool_output: i < 4 ? "error" : "ok",
          tool_error: i < 4,
          duration_ms: 10,
        });
      }

      // Also need PreToolUse calls for toolCalls count
      for (let i = 0; i < 5; i++) {
        await handler.handle({
          type: "PreToolUse",
          session_id: "sess_errors",
          tool_name: "Bash",
          tool_input: { command: `test ${i}` },
        });
      }

      await handler.handle({
        type: "Stop",
        session_id: "sess_errors",
        stop_reason: "end_turn",
      });

      const kb = knowledgeStore.getKnowledgeBase();
      const failure = kb.failurePatterns.find((f) => f.pattern.includes("error rate"));
      expect(failure).toBeDefined();
    });
  });
});

// ── Config Generator Tests ──────────────────────────────────────

describe("Hooks Config", () => {
  const defaultOpts: HooksSetupOptions = {
    host: "127.0.0.1",
    port: 4820,
    events: ["PreToolUse", "PostToolUse", "Stop", "TaskCompleted", "SessionStart"],
    timeout: 5000,
  };

  describe("generateHooksConfig", () => {
    it("should generate config for all events", () => {
      const config = generateHooksConfig(defaultOpts);

      expect(config.PreToolUse).toBeDefined();
      expect(config.PostToolUse).toBeDefined();
      expect(config.Stop).toBeDefined();
      expect(config.TaskCompleted).toBeDefined();
      expect(config.SessionStart).toBeDefined();
    });

    it("should use correct URLs with kebab-case paths", () => {
      const config = generateHooksConfig(defaultOpts);

      const preToolUse = (config.PreToolUse as any[])[0];
      expect(preToolUse.url).toBe("http://127.0.0.1:4820/api/hooks/pre-tool-use");
      expect(preToolUse.type).toBe("http");
      expect(preToolUse.timeout).toBe(5000);

      const taskCompleted = (config.TaskCompleted as any[])[0];
      expect(taskCompleted.url).toBe("http://127.0.0.1:4820/api/hooks/task-completed");
    });

    it("should include auth headers when API key is set", () => {
      const config = generateHooksConfig({
        ...defaultOpts,
        apiKey: "sk-test-key",
      });

      const preToolUse = (config.PreToolUse as any[])[0];
      expect(preToolUse.headers).toBeDefined();
      expect(preToolUse.headers.Authorization).toBe("Bearer sk-test-key");
    });

    it("should not include auth headers when no API key", () => {
      const config = generateHooksConfig(defaultOpts);

      const preToolUse = (config.PreToolUse as any[])[0];
      expect(preToolUse.headers).toBeUndefined();
    });

    it("should use custom port and host", () => {
      const config = generateHooksConfig({
        ...defaultOpts,
        host: "0.0.0.0",
        port: 9999,
      });

      const stop = (config.Stop as any[])[0];
      expect(stop.url).toBe("http://0.0.0.0:9999/api/hooks/stop");
    });
  });

  describe("pathToEvent", () => {
    it("should convert kebab-case paths to event names", () => {
      expect(pathToEvent("pre-tool-use")).toBe("PreToolUse");
      expect(pathToEvent("post-tool-use")).toBe("PostToolUse");
      expect(pathToEvent("stop")).toBe("Stop");
      expect(pathToEvent("task-completed")).toBe("TaskCompleted");
      expect(pathToEvent("session-start")).toBe("SessionStart");
      expect(pathToEvent("notification")).toBe("Notification");
    });

    it("should return null for unknown paths", () => {
      expect(pathToEvent("unknown")).toBeNull();
      expect(pathToEvent("foo-bar")).toBeNull();
    });
  });

  describe("printHooksConfig", () => {
    it("should include all expected sections", () => {
      const output = printHooksConfig(defaultOpts);

      expect(output).toContain("Claude Code Hooks Configuration");
      expect(output).toContain(".claude/settings.json");
      expect(output).toContain("127.0.0.1:4820");
      expect(output).toContain("PreToolUse");
      expect(output).toContain("5000ms");
    });

    it("should mention auth when API key is set", () => {
      const output = printHooksConfig({ ...defaultOpts, apiKey: "secret" });
      expect(output).toContain("Bearer token configured");
    });
  });

  describe("DEFAULT_HOOKS_CONFIG", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_HOOKS_CONFIG.enabled).toBe(false);
      expect(DEFAULT_HOOKS_CONFIG.events).toContain("PreToolUse");
      expect(DEFAULT_HOOKS_CONFIG.events).toContain("PostToolUse");
      expect(DEFAULT_HOOKS_CONFIG.events).toContain("Stop");
      expect(DEFAULT_HOOKS_CONFIG.events).toContain("TaskCompleted");
      expect(DEFAULT_HOOKS_CONFIG.events).toContain("SessionStart");
      expect(DEFAULT_HOOKS_CONFIG.timeout).toBe(5000);
    });
  });
});

// ── Integration: Full hook lifecycle ────────────────────────────

describe("Hook lifecycle integration", () => {
  it("should track a full session from start to completion", async () => {
    const { handler, eventBus, knowledgeStore } = createHandler();

    const events: any[] = [];
    eventBus.onAny((e) => events.push(e));

    // 1. Session starts
    await handler.handle({
      type: "SessionStart",
      session_id: "lifecycle_1",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/home/user/project",
    });

    expect(handler.getSessionCount()).toBe(1);

    // 2. Tool calls
    await handler.handle({
      type: "PreToolUse",
      session_id: "lifecycle_1",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.ts" },
    });

    await handler.handle({
      type: "PostToolUse",
      session_id: "lifecycle_1",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.ts" },
      tool_output: "export function main() {}",
      duration_ms: 15,
    });

    await handler.handle({
      type: "PreToolUse",
      session_id: "lifecycle_1",
      tool_name: "Edit",
      tool_input: { file_path: "/src/main.ts", old_string: "{}", new_string: "{ return 42; }" },
    });

    await handler.handle({
      type: "PostToolUse",
      session_id: "lifecycle_1",
      tool_name: "Edit",
      tool_input: { file_path: "/src/main.ts" },
      tool_output: "edited",
      duration_ms: 5,
    });

    // 3. Task completes
    await handler.handle({
      type: "TaskCompleted",
      session_id: "lifecycle_1",
      summary: "Added return value to main()",
      usage: { input_tokens: 2000, output_tokens: 500 },
      num_turns: 3,
      cost_usd: 0.02,
    });

    // Session should be cleaned up
    expect(handler.getSessionCount()).toBe(0);

    // Events should include full lifecycle
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("agent:started");
    expect(eventTypes).toContain("agent:tool_call");
    expect(eventTypes).toContain("agent:tool_result");
    expect(eventTypes).toContain("agent:completed");
  });

  it("should enforce policy across tool calls", async () => {
    const { handler } = createHandler();

    await handler.handle({
      type: "SessionStart",
      session_id: "policy_1",
    });

    // Allowed: read a normal file
    const r1 = await handler.handle({
      type: "PreToolUse",
      session_id: "policy_1",
      tool_name: "Read",
      tool_input: { file_path: "/src/index.ts" },
    });
    expect(r1.decision).toBe("allow");

    // Denied: write to .env
    const r2 = await handler.handle({
      type: "PreToolUse",
      session_id: "policy_1",
      tool_name: "Write",
      tool_input: { file_path: ".env", content: "SECRET=bad" },
    });
    expect(r2.decision).toBe("deny");

    // Denied: dangerous command
    const r3 = await handler.handle({
      type: "PreToolUse",
      session_id: "policy_1",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    expect(r3.decision).toBe("deny");

    // Allowed: safe command
    const r4 = await handler.handle({
      type: "PreToolUse",
      session_id: "policy_1",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    });
    expect(r4.decision).toBe("allow");

    const session = handler.getSession("policy_1");
    expect(session!.toolCalls).toBe(4);
    expect(session!.deniedCalls).toBe(2);
  });
});
