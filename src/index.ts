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

// Tools
export { CORE_TOOLS } from "./tools/definitions.js";
export { ToolExecutor } from "./tools/executor.js";

// Router
export { ModelRouter } from "./router/router.js";

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

// Config
export { loadConfig } from "./config/loader.js";

// Orchestrator
export { Orchestrator } from "./orchestrator.js";
