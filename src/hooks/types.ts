/**
 * Claude Code Hooks types.
 *
 * Matches the HTTP hook protocol defined by Claude Code:
 * https://code.claude.com/docs/en/hooks
 *
 * When Claude Code is configured with HTTP hooks pointing at Foreman,
 * it POSTs JSON payloads at lifecycle events. Foreman responds with
 * decisions (allow/deny/block) and captures telemetry for learning.
 */

// ─── Hook Event Names ────────────────────────────────────────────

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "TaskCompleted"
  | "SessionStart"
  | "Notification";

// ─── Inbound Payloads (Claude Code → Foreman) ───────────────────

export interface HookRequestBase {
  /** The hook event type. */
  type: HookEvent;
  /** Claude Code session ID. */
  session_id: string;
  /** Timestamp of the event. */
  timestamp?: string;
}

export interface PreToolUsePayload extends HookRequestBase {
  type: "PreToolUse";
  /** Name of the tool about to be called (e.g., "Bash", "Write", "Edit"). */
  tool_name: string;
  /** The input the tool will receive. */
  tool_input: Record<string, unknown>;
}

export interface PostToolUsePayload extends HookRequestBase {
  type: "PostToolUse";
  /** Name of the tool that was called. */
  tool_name: string;
  /** The input the tool received. */
  tool_input: Record<string, unknown>;
  /** The tool's output/result. */
  tool_output?: string;
  /** Whether the tool errored. */
  tool_error?: boolean;
  /** Duration of the tool call in ms. */
  duration_ms?: number;
}

export interface StopPayload extends HookRequestBase {
  type: "Stop";
  /** Why Claude Code is stopping. */
  stop_reason?: "end_turn" | "max_turns" | "user_abort" | "error";
  /** Summary of what was accomplished. */
  summary?: string;
  /** Token usage for the session. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /** Number of turns completed. */
  num_turns?: number;
  /** Cost in USD. */
  cost_usd?: number;
}

export interface TaskCompletedPayload extends HookRequestBase {
  type: "TaskCompleted";
  /** The task prompt that was given. */
  task?: string;
  /** Summary of what was accomplished. */
  summary?: string;
  /** Token usage for the session. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /** Number of turns completed. */
  num_turns?: number;
  /** Cost in USD. */
  cost_usd?: number;
}

export interface SessionStartPayload extends HookRequestBase {
  type: "SessionStart";
  /** The model being used. */
  model?: string;
  /** The working directory. */
  cwd?: string;
}

export interface NotificationPayload extends HookRequestBase {
  type: "Notification";
  /** Notification message. */
  message?: string;
  /** Severity level. */
  level?: "info" | "warning" | "error";
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | StopPayload
  | TaskCompletedPayload
  | SessionStartPayload
  | NotificationPayload;

// ─── Outbound Responses (Foreman → Claude Code) ─────────────────

export type HookDecision = "allow" | "deny" | "block";

export interface HookResponse {
  /** The decision: allow, deny (with message), or block (hard stop). */
  decision: HookDecision;
  /** Human-readable reason for the decision. */
  reason?: string;
}

// ─── Hooks Configuration ─────────────────────────────────────────

export interface HooksConfig {
  /** Whether hooks mode is enabled. */
  enabled: boolean;
  /** Which hook events to register. */
  events: HookEvent[];
  /** Timeout for hook responses in ms (Claude Code side). */
  timeout: number;
}

export const DEFAULT_HOOKS_CONFIG: HooksConfig = {
  enabled: false,
  events: ["PreToolUse", "PostToolUse", "Stop", "TaskCompleted", "SessionStart"],
  timeout: 5000,
};

// ─── Hook Session Tracking ───────────────────────────────────────

export interface HookSessionState {
  /** Claude Code session ID. */
  sessionId: string;
  /** When the session started. */
  startedAt: Date;
  /** Model being used (if known). */
  model?: string;
  /** Working directory (if known). */
  cwd?: string;
  /** Running count of tool calls. */
  toolCalls: number;
  /** Running count of denied calls. */
  deniedCalls: number;
  /** Tool call history for learning. */
  toolHistory: Array<{
    tool: string;
    input: Record<string, unknown>;
    output?: string;
    error?: boolean;
    durationMs?: number;
    denied?: boolean;
    timestamp: Date;
  }>;
  /** Cumulative token usage. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}
