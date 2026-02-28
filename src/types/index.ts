/**
 * Core type definitions for Foreman runtime.
 */

// ─── Provider Types ───────────────────────────────────────────────

export interface ModelCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  maxContextWindow: number;
  maxOutputTokens: number;
  reasoningStrength: "low" | "medium" | "high" | "very_high";
  speed: "slow" | "medium" | "fast";
}

export interface CostProfile {
  inputTokenCostPer1M: number;
  outputTokenCostPer1M: number;
  currency: string;
}

export interface ProviderHealth {
  healthy: boolean;
  latencyMs: number | null;
  lastChecked: Date;
  error?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  name?: string;
  toolCallId?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stopSequences?: string[];
}

export interface ChatResponse {
  id: string;
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: TokenUsage;
  model: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_use_delta" | "tool_use_end" | "message_start" | "message_end" | "error";
  text?: string;
  toolUse?: Partial<ToolUseBlock>;
  usage?: TokenUsage;
  error?: string;
}

// ─── Configuration Types ──────────────────────────────────────────

export interface ForemanConfig {
  foreman: ForemanGlobalConfig;
  linear?: LinearConfig;
  models: Record<string, ModelConfig>;
  routing: RoutingConfig;
  sandbox: SandboxConfig;
  policy: PolicyConfig;
}

export interface ForemanGlobalConfig {
  name: string;
  logLevel: "debug" | "info" | "warn" | "error";
  maxConcurrentAgents: number;
}

export interface LinearConfig {
  apiKey: string;
  team: string;
  watchLabels: string[];
  watchStatus: string;
}

export interface ModelConfig {
  provider: "anthropic" | "openai" | "local";
  model: string;
  role: string;
  maxTokens: number;
  temperature?: number;
  endpoint?: string;
  apiKey?: string;
}

export interface RoutingConfig {
  strategy: "capability_match" | "cost_optimized" | "speed_first";
  fallbackChain: string[];
}

export interface SandboxConfig {
  type: "docker" | "local";
  warmPool: number;
  timeoutMinutes: number;
  cleanup: "on_success" | "always" | "never";
  cloud?: CloudSandboxConfig;
}

export interface CloudSandboxConfig {
  provider: "fly" | "daytona";
  app: string;
  region: string;
}

export interface PolicyConfig {
  protectedPaths: string[];
  blockedCommands: string[];
  maxDiffLines: number;
  requireApprovalAbove: number;
}

// ─── Agent Runtime Types ──────────────────────────────────────────

export type AgentStatus = "idle" | "running" | "paused" | "completed" | "failed" | "awaiting_approval";

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  repository?: string;
  branch?: string;
  labels?: string[];
  estimate?: number;
  linearTicketId?: string;
  assignedModel?: string;
}

export interface AgentSession {
  id: string;
  task: AgentTask;
  status: AgentStatus;
  modelName: string;
  messages: ChatMessage[];
  iterations: number;
  maxIterations: number;
  tokenUsage: TokenUsage;
  startedAt: Date;
  completedAt?: Date;
  artifacts: AgentArtifact[];
  error?: string;
}

export interface AgentArtifact {
  type: "diff" | "pr_description" | "log" | "file";
  path?: string;
  content: string;
  createdAt: Date;
}

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  duration: number;
}

// ─── Policy Types ─────────────────────────────────────────────────

export type PolicyDecision = "allow" | "require_approval" | "deny";

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
  toolName: string;
  input: Record<string, unknown>;
}

// ─── Router Types ─────────────────────────────────────────────────

export interface TaskComplexity {
  score: number; // 1-10
  reasoning: string;
  requiredCapabilities: string[];
}

export interface RoutingDecision {
  modelKey: string;
  modelConfig: ModelConfig;
  reason: string;
  fallbacksAvailable: string[];
}

// ─── Event Types ──────────────────────────────────────────────────

export type ForemanEvent =
  | { type: "agent:started"; session: AgentSession }
  | { type: "agent:iteration"; session: AgentSession; iteration: number }
  | { type: "agent:stream"; sessionId: string; event: StreamEvent }
  | { type: "agent:tool_call"; sessionId: string; toolName: string; input: Record<string, unknown> }
  | { type: "agent:tool_result"; sessionId: string; toolName: string; result: ToolExecutionResult }
  | { type: "agent:completed"; session: AgentSession }
  | { type: "agent:failed"; session: AgentSession; error: string }
  | { type: "agent:approval_required"; session: AgentSession; evaluation: PolicyEvaluation }
  | { type: "provider:health_changed"; providerName: string; health: ProviderHealth }
  | { type: "task:queued"; task: AgentTask }
  | { type: "task:assigned"; task: AgentTask; modelKey: string };
