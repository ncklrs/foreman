/**
 * Foreman — Model-agnostic agentic coding runtime.
 *
 * Public API for programmatic usage.
 */

// Core types
export type {
  ForemanConfig,
  ModelConfig,
  AgentTask,
  AgentSession,
  ChatMessage,
  ChatResponse,
  StreamEvent,
  ToolDefinition,
  ModelCapabilities,
  CostProfile,
  ProviderHealth,
  PolicyDecision,
  PolicyEvaluation,
  RoutingDecision,
  TaskComplexity,
  ForemanEvent,
  GitHubIntegrationConfig,
  SlackIntegrationConfig,
  AutopilotConfig,
  AutopilotScanner,
  ReviewFinding,
  AutopilotRun,
  ApiConfig,
} from "./types/index.js";

// Provider layer
export { AnthropicProvider } from "./providers/anthropic.js";
export { OllamaProvider } from "./providers/ollama.js";
export { OpenAIProvider } from "./providers/openai.js";
export { ProviderRegistry } from "./providers/registry.js";
export type { ModelProvider } from "./providers/base.js";

// Runtime
export { AgentLoop } from "./runtime/loop.js";
export { buildSystemPrompt, buildCodebaseContext } from "./runtime/prompt.js";
export { ContextManager } from "./runtime/context.js";
export { RecoveryManager } from "./runtime/recovery.js";
export { ToolResultCache } from "./runtime/cache.js";
export { SubAgentSpawner } from "./runtime/subagent.js";
export { ClaudeCodeRunner } from "./runtime/adapters/claude-code.js";

// Tools
export { CORE_TOOLS } from "./tools/definitions.js";
export { ToolExecutor } from "./tools/executor.js";

// Router
export { ModelRouter } from "./router/router.js";
export { PerformanceTracker } from "./router/performance.js";

// Policy
export { PolicyEngine } from "./policy/engine.js";

// Sandbox
export { SandboxManager } from "./sandbox/manager.js";

// Linear
export { LinearClient } from "./linear/client.js";
export { LinearWatcher } from "./linear/watcher.js";

// Integrations
export { GitHubClient, GitHubWatcher } from "./integrations/github.js";
export { SlackClient, SlackWatcher } from "./integrations/slack.js";

// Events
export { EventBus } from "./events/bus.js";

// Logging
export { Logger } from "./logging/logger.js";

// Storage
export { SessionStore } from "./storage/sessions.js";

// Secrets
export { SecretsManager } from "./secrets/manager.js";

// Utils
export { withRetry } from "./utils/retry.js";

// Config
export { loadConfig } from "./config/loader.js";

// Autopilot
export { AutopilotEngine, AutopilotScheduler, CodebaseReviewer, TicketCreator } from "./autopilot/index.js";

// Learning
export { KnowledgeStore } from "./learning/knowledge.js";
export type { Lesson, FailurePattern, KnowledgeBase } from "./learning/knowledge.js";
export { AgentsMdManager } from "./learning/agents-md.js";

// Skills
export { SkillsRegistry } from "./skills/registry.js";
export type { Skill } from "./skills/registry.js";

// Prompt enrichment
export type { PromptEnrichment } from "./runtime/prompt.js";

// API
export { ApiServer } from "./api/server.js";
export { WebSocketServer } from "./api/websocket.js";
export { RateLimiter } from "./api/middleware.js";

// Hooks
export { HookHandler } from "./hooks/handler.js";
export type {
  HookEvent,
  HookPayload,
  HookResponse,
  HookDecision,
  HooksConfig,
  HookSessionState,
  PreToolUsePayload,
  PostToolUsePayload,
  StopPayload,
  TaskCompletedPayload,
  SessionStartPayload,
} from "./hooks/types.js";
export {
  generateHooksConfig,
  writeHooksConfig,
  printHooksConfig,
  pathToEvent,
} from "./hooks/config.js";

// Orchestrator
export { Orchestrator } from "./orchestrator.js";
