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

export interface ApiConfig {
  /** Whether to enable the HTTP API server. */
  enabled: boolean;
  /** Port to listen on. Default: 4820. */
  port: number;
  /** Host to bind to. Default: "127.0.0.1". */
  host: string;
  /** API key for authentication. If not set, auth is disabled. */
  apiKey?: string;
  /** Allowed CORS origins. Default: ["*"]. */
  corsOrigins: string[];
}

export interface ForemanConfig {
  foreman: ForemanGlobalConfig;
  linear?: LinearConfig;
  github?: GitHubIntegrationConfig;
  slack?: SlackIntegrationConfig;
  autopilot?: AutopilotConfig;
  schedules?: ScheduledTaskConfig[];
  api?: ApiConfig;
  models: Record<string, ModelConfig>;
  routing: RoutingConfig;
  sandbox: SandboxConfig;
  policy: PolicyConfig;
}

export interface GitHubIntegrationConfig {
  token: string;
  owner: string;
  repo: string;
  watchLabels: string[];
  watchState?: "open" | "closed" | "all";
}

export interface SlackIntegrationConfig {
  botToken: string;
  watchChannels: string[];
  triggerPrefix?: string;
  postProgress?: boolean;
}

export interface ForemanGlobalConfig {
  name: string;
  logLevel: "debug" | "info" | "warn" | "error";
  maxConcurrentAgents: number;
  /** Agent runtime: "foreman" (built-in) or "claude-code" (Claude Code CLI). */
  runtime?: "foreman" | "claude-code";
  /** Auto-decompose complex tasks into subtask DAGs. */
  decompose?: boolean;
  /** Minimum complexity score (1-10) to trigger auto-decomposition. */
  decomposeThreshold?: number;
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

// ─── Scheduled Task Types ─────────────────────────────────────────

export interface ScheduledTaskConfig {
  id: string;
  description: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  prompt: string;
  model?: string;
  branch?: string;
  labels?: string[];
}

// ─── Autopilot Types ──────────────────────────────────────────────

export interface AutopilotConfig {
  /** Whether autopilot is enabled. */
  enabled: boolean;
  /** Cron expression for review schedule (e.g., "0 9 * * 1-5"). */
  schedule: string;
  /** Timezone for schedule (default: "UTC"). */
  timezone?: string;
  /** Which review scanners to run. */
  scanners: AutopilotScanner[];
  /** Maximum tickets to create per run. */
  maxTicketsPerRun: number;
  /** Whether to auto-resolve created tickets (vs. just creating them). */
  autoResolve: boolean;
  /** Maximum concurrent resolve agents. */
  maxConcurrentResolves: number;
  /** Minimum severity to create a ticket (1-5, 1=info, 5=critical). */
  minSeverity: number;
  /** Target for created tickets: "github" or "linear". */
  ticketTarget: "github" | "linear";
  /** Labels to add to auto-created tickets. */
  ticketLabels: string[];
  /** Branch prefix for auto-resolve work (default: "autopilot/"). */
  branchPrefix: string;
  /** Working directory to scan (default: "."). */
  workingDir?: string;
}

export type AutopilotScanner =
  | "security"
  | "dependencies"
  | "code_quality"
  | "test_coverage"
  | "performance"
  | "documentation"
  | "dead_code"
  | "type_safety";

export interface ReviewFinding {
  id: string;
  scanner: AutopilotScanner;
  severity: number; // 1-5
  title: string;
  description: string;
  filePath?: string;
  lineNumber?: number;
  suggestion: string;
  effort: "trivial" | "small" | "medium" | "large";
  tags: string[];
}

export interface AutopilotRun {
  id: string;
  startedAt: Date;
  completedAt?: Date;
  status: "scanning" | "creating_tickets" | "resolving" | "completed" | "failed";
  findings: ReviewFinding[];
  ticketsCreated: string[];
  ticketsResolved: string[];
  error?: string;
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
  | { type: "task:assigned"; task: AgentTask; modelKey: string }
  | { type: "task:decomposed"; task: AgentTask; subtaskCount: number; strategy: string }
  | { type: "task:subtask_started"; parentTaskId: string; subtaskId: string; title: string }
  | { type: "task:subtask_completed"; parentTaskId: string; subtaskId: string; title: string; success: boolean }
  | { type: "task:graph_completed"; parentTaskId: string; completed: number; failed: number; skipped: number }
  | { type: "autopilot:run_started"; run: AutopilotRun }
  | { type: "autopilot:scan_complete"; run: AutopilotRun; findingsCount: number }
  | { type: "autopilot:ticket_created"; run: AutopilotRun; finding: ReviewFinding; ticketId: string }
  | { type: "autopilot:resolve_started"; run: AutopilotRun; finding: ReviewFinding }
  | { type: "autopilot:resolve_completed"; run: AutopilotRun; finding: ReviewFinding; success: boolean }
  | { type: "autopilot:run_completed"; run: AutopilotRun }
  | { type: "schedule:fired"; scheduleId: string; taskId: string }
  | { type: "schedule:added"; scheduleId: string }
  | { type: "schedule:removed"; scheduleId: string }
  | { type: "schedule:toggled"; scheduleId: string; enabled: boolean };
