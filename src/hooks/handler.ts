/**
 * Claude Code Hooks Handler.
 *
 * Processes incoming hook events from Claude Code and returns decisions.
 * This is the core of Foreman's "sidecar" mode — instead of spawning
 * Claude Code as a subprocess, Claude Code calls OUT to Foreman for:
 *
 * - Policy enforcement (PreToolUse → deny destructive commands)
 * - Telemetry capture (PostToolUse → track tool usage patterns)
 * - Learning (Stop/TaskCompleted → learn from session outcomes)
 * - Session tracking (SessionStart → register in Foreman's session store)
 *
 * All decisions are returned synchronously within Claude Code's
 * hook timeout window (default 5s).
 */

import type { PolicyEngine } from "../policy/engine.js";
import type { KnowledgeStore } from "../learning/knowledge.js";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logging/logger.js";
import type {
  HookPayload,
  HookResponse,
  HookSessionState,
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
  TaskCompletedPayload,
  SessionStartPayload,
  NotificationPayload,
} from "./types.js";

export interface HookHandlerDeps {
  policyEngine: PolicyEngine;
  knowledgeStore: KnowledgeStore;
  eventBus: EventBus;
  logger: Logger;
}

export class HookHandler {
  private deps: HookHandlerDeps;
  private sessions: Map<string, HookSessionState> = new Map();

  constructor(deps: HookHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Process an incoming hook payload and return a decision.
   * This is the main entry point called by the API route handler.
   */
  async handle(payload: HookPayload): Promise<HookResponse> {
    const { logger } = this.deps;

    switch (payload.type) {
      case "PreToolUse":
        return this.handlePreToolUse(payload);
      case "PostToolUse":
        return this.handlePostToolUse(payload);
      case "Stop":
        return this.handleStop(payload);
      case "TaskCompleted":
        return this.handleTaskCompleted(payload);
      case "SessionStart":
        return this.handleSessionStart(payload);
      case "Notification":
        return this.handleNotification(payload);
      default:
        logger.warn(`Unknown hook event type: ${(payload as HookPayload).type}`);
        return { decision: "allow" };
    }
  }

  /**
   * PreToolUse: evaluate tool call against Foreman's policy engine.
   * Returns deny if the tool call violates configured policies.
   */
  private handlePreToolUse(payload: PreToolUsePayload): HookResponse {
    const { policyEngine, eventBus, logger } = this.deps;

    // Map Claude Code tool names to Foreman tool names for policy evaluation
    const toolMapping: Record<string, string> = {
      Bash: "run_command",
      Write: "write_file",
      Edit: "edit_file",
    };

    const foremanToolName = toolMapping[payload.tool_name] ?? payload.tool_name;

    // Adapt input for policy engine
    const policyInput = this.adaptToolInput(payload.tool_name, payload.tool_input);
    const evaluation = policyEngine.evaluate(foremanToolName, policyInput);

    // Emit event for telemetry
    eventBus.emit({
      type: "agent:tool_call",
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      input: payload.tool_input,
    });

    // Track in session state
    const session = this.getOrCreateSession(payload.session_id);
    session.toolCalls++;

    if (evaluation.decision === "deny") {
      session.deniedCalls++;
      logger.warn(`Hook denied tool call: ${payload.tool_name}`, {
        sessionId: payload.session_id,
        reason: evaluation.reason,
      });

      return {
        decision: "deny",
        reason: evaluation.reason,
      };
    }

    if (evaluation.decision === "require_approval") {
      // In hooks mode, require_approval maps to deny with a reason
      // (there's no interactive approval flow via hooks)
      session.deniedCalls++;
      logger.info(`Hook blocked tool call requiring approval: ${payload.tool_name}`, {
        sessionId: payload.session_id,
        reason: evaluation.reason,
      });

      return {
        decision: "deny",
        reason: `Requires approval: ${evaluation.reason}`,
      };
    }

    return { decision: "allow" };
  }

  /**
   * PostToolUse: capture tool usage for telemetry and learning.
   * Always returns allow (can't retroactively deny a completed call).
   */
  private handlePostToolUse(payload: PostToolUsePayload): HookResponse {
    const { eventBus } = this.deps;

    // Track in session state
    const session = this.getOrCreateSession(payload.session_id);
    session.toolHistory.push({
      tool: payload.tool_name,
      input: payload.tool_input,
      output: payload.tool_output?.slice(0, 500),
      error: payload.tool_error,
      durationMs: payload.duration_ms,
      timestamp: new Date(),
    });

    // Emit tool result event
    eventBus.emit({
      type: "agent:tool_result",
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      result: {
        output: payload.tool_output?.slice(0, 200) ?? "",
        isError: payload.tool_error ?? false,
        duration: payload.duration_ms ?? 0,
      },
    });

    return { decision: "allow" };
  }

  /**
   * Stop: session is ending. Capture final state for learning.
   */
  private handleStop(payload: StopPayload): HookResponse {
    const { knowledgeStore, eventBus, logger } = this.deps;

    const session = this.sessions.get(payload.session_id);
    if (!session) {
      return { decision: "allow" };
    }

    // Update usage
    if (payload.usage) {
      session.usage.inputTokens = payload.usage.input_tokens;
      session.usage.outputTokens = payload.usage.output_tokens;
    }

    // Learn from tool usage patterns
    this.learnFromToolHistory(session);

    logger.info(`Hook session stopped: ${payload.session_id}`, {
      reason: payload.stop_reason,
      turns: payload.num_turns,
      toolCalls: session.toolCalls,
      deniedCalls: session.deniedCalls,
    });

    // Emit completion event
    const failed = payload.stop_reason === "error";
    if (failed) {
      eventBus.emit({
        type: "agent:failed",
        session: this.toAgentSession(session, "failed", payload.summary),
        error: payload.stop_reason ?? "Unknown error",
      });
    }

    return { decision: "allow" };
  }

  /**
   * TaskCompleted: task finished successfully. Learn from the outcome.
   */
  private handleTaskCompleted(payload: TaskCompletedPayload): HookResponse {
    const { knowledgeStore, eventBus, logger } = this.deps;

    const session = this.sessions.get(payload.session_id);
    if (!session) {
      return { decision: "allow" };
    }

    // Update usage
    if (payload.usage) {
      session.usage.inputTokens = payload.usage.input_tokens;
      session.usage.outputTokens = payload.usage.output_tokens;
    }

    // Learn from completed session
    const agentSession = this.toAgentSession(session, "completed", payload.summary);
    knowledgeStore.learnFromSession(agentSession);

    logger.info(`Hook task completed: ${payload.session_id}`, {
      turns: payload.num_turns,
      cost: payload.cost_usd,
      toolCalls: session.toolCalls,
    });

    eventBus.emit({
      type: "agent:completed",
      session: agentSession,
    });

    // Clean up session after completion
    this.sessions.delete(payload.session_id);

    return { decision: "allow" };
  }

  /**
   * SessionStart: register a new Claude Code session.
   */
  private handleSessionStart(payload: SessionStartPayload): HookResponse {
    const { eventBus, logger } = this.deps;

    const session: HookSessionState = {
      sessionId: payload.session_id,
      startedAt: new Date(),
      model: payload.model,
      cwd: payload.cwd,
      toolCalls: 0,
      deniedCalls: 0,
      toolHistory: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    this.sessions.set(payload.session_id, session);

    logger.info(`Hook session started: ${payload.session_id}`, {
      model: payload.model,
      cwd: payload.cwd,
    });

    eventBus.emit({
      type: "agent:started",
      session: this.toAgentSession(session, "running"),
    });

    return { decision: "allow" };
  }

  /**
   * Notification: log Claude Code notifications.
   */
  private handleNotification(payload: NotificationPayload): HookResponse {
    const { logger } = this.deps;

    const level = payload.level ?? "info";
    const msg = `Hook notification [${payload.session_id}]: ${payload.message ?? ""}`;

    if (level === "error") {
      logger.error(msg);
    } else if (level === "warning") {
      logger.warn(msg);
    } else {
      logger.info(msg);
    }

    return { decision: "allow" };
  }

  // ─── Public accessors ──────────────────────────────────────────

  /** Get all tracked hook sessions. */
  getSessions(): HookSessionState[] {
    return Array.from(this.sessions.values());
  }

  /** Get a specific hook session. */
  getSession(sessionId: string): HookSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get session count. */
  getSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private getOrCreateSession(sessionId: string): HookSessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        startedAt: new Date(),
        toolCalls: 0,
        deniedCalls: 0,
        toolHistory: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Adapt Claude Code tool input to Foreman's policy engine format.
   */
  private adaptToolInput(
    toolName: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    switch (toolName) {
      case "Bash":
        return { command: input.command ?? input.cmd ?? "" };
      case "Write":
        return { path: input.file_path ?? input.path ?? "", content: input.content ?? "" };
      case "Edit":
        return {
          path: input.file_path ?? input.path ?? "",
          old_string: input.old_string ?? "",
          new_string: input.new_string ?? "",
        };
      default:
        return input;
    }
  }

  /**
   * Extract learning patterns from a session's tool history.
   */
  private learnFromToolHistory(session: HookSessionState): void {
    const { knowledgeStore } = this.deps;

    // Count tool usage
    const toolCounts = new Map<string, number>();
    let totalErrors = 0;

    for (const entry of session.toolHistory) {
      toolCounts.set(entry.tool, (toolCounts.get(entry.tool) ?? 0) + 1);
      if (entry.error) totalErrors++;
    }

    // Note excessive tool usage
    for (const [tool, count] of toolCounts) {
      if (count > 15) {
        knowledgeStore.learnFromUser(
          `Tool "${tool}" used ${count}x in hook session — consider reducing calls`,
          `Session ${session.sessionId} used "${tool}" ${count} times. ` +
            `Total tools: ${session.toolCalls}, errors: ${totalErrors}.`,
          [tool, "hook_session"]
        );
      }
    }

    // Note high error rate
    if (totalErrors > 0 && session.toolCalls > 0) {
      const errorRate = totalErrors / session.toolCalls;
      if (errorRate > 0.3) {
        knowledgeStore.recordFailure({
          pattern: `High tool error rate (${Math.round(errorRate * 100)}%)`,
          approach: `Session ${session.sessionId}: ${session.toolCalls} calls, ${totalErrors} errors`,
          labels: ["hook_session"],
        });
      }
    }
  }

  /**
   * Convert hook session state to an AgentSession for Foreman's event system.
   */
  private toAgentSession(
    session: HookSessionState,
    status: "running" | "completed" | "failed",
    summary?: string
  ) {
    return {
      id: session.sessionId,
      task: {
        id: `hook_${session.sessionId}`,
        title: `Claude Code session`,
        description: `Interactive Claude Code session in ${session.cwd ?? "unknown directory"}`,
        labels: ["hook_session"],
      },
      status,
      modelName: session.model ?? "unknown",
      messages: [],
      iterations: session.toolCalls,
      maxIterations: 0,
      tokenUsage: {
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
      },
      startedAt: session.startedAt,
      completedAt: status !== "running" ? new Date() : undefined,
      artifacts: summary
        ? [{ type: "log" as const, content: summary, createdAt: new Date() }]
        : [],
    };
  }
}
