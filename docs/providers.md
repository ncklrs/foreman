# Model Providers

Foreman is model-agnostic. It communicates with LLMs through a unified **ModelProvider** interface, so you can swap providers without changing any orchestration logic.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  ProviderRegistry                     │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐     │
│  │ anthropic   │  │  openai    │  │  ollama    │     │
│  │ (Anthropic  │  │ (OpenAI   │  │ (Local     │     │
│  │  Provider)  │  │  Provider) │  │  Provider) │     │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘     │
│        │               │               │             │
│        ▼               ▼               ▼             │
│  ┌─────────────────────────────────────────────┐     │
│  │           ModelProvider Interface            │     │
│  │                                             │     │
│  │  chat()        → ChatResponse               │     │
│  │  chatStream()  → AsyncIterable<StreamEvent>  │     │
│  │  capabilities() → ModelCapabilities          │     │
│  │  costProfile()  → CostProfile               │     │
│  │  healthCheck()  → ProviderHealth            │     │
│  └─────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

## Supported Providers

### Anthropic

The primary provider. Connects to the Anthropic Messages API.

```toml
[models.architect]
provider = "anthropic"
model = "claude-opus-4-6"
role = "planning, architecture, complex reasoning"
max_tokens = 8192
temperature = 0.3

[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation, implementation"
max_tokens = 4096
temperature = 0.2
```

**Authentication**: Set `ANTHROPIC_API_KEY` environment variable or use per-model `api_key` field.

**Capabilities reported**:
| Model Pattern | Reasoning | Speed | Context |
|---------------|-----------|-------|---------|
| `opus` | `very_high` | `slow` | 200k |
| `sonnet` | `high` | `medium` | 200k |
| `haiku` | `medium` | `fast` | 200k |

**Cost profile** (per 1M tokens):
| Model Pattern | Input | Output |
|---------------|-------|--------|
| `opus` | $15.00 | $75.00 |
| `sonnet` | $3.00 | $15.00 |
| `haiku` | $0.25 | $1.25 |

### OpenAI

Connects to the OpenAI Chat Completions API. Supports any OpenAI-compatible endpoint.

```toml
[models.gpt]
provider = "openai"
model = "gpt-4o"
role = "alternative implementation"
max_tokens = 4096
api_key = "${OPENAI_API_KEY}"

[models.o1]
provider = "openai"
model = "o1-preview"
role = "complex reasoning"
max_tokens = 8192
endpoint = "https://custom-endpoint.example.com/v1"
```

**Authentication**: Set `OPENAI_API_KEY` environment variable or use per-model `api_key` field.

**Custom endpoints**: Set the `endpoint` field to use Azure OpenAI, LiteLLM proxies, or any OpenAI-compatible API.

**Capabilities reported**:
| Model Pattern | Reasoning | Speed | Context |
|---------------|-----------|-------|---------|
| `gpt-4o` | `high` | `medium` | 128k |
| `gpt-4-turbo` | `high` | `medium` | 128k |
| `gpt-3.5` | `medium` | `fast` | 16k |
| `o1` / `o3` | `very_high` | `slow` | 200k |

### Ollama (Local)

Connects to a local Ollama instance for fully offline, self-hosted inference. Uses the Ollama OpenAI-compatible API endpoint.

```toml
[models.local]
provider = "local"
model = "qwen3:32b"
endpoint = "http://localhost:11434"
role = "code review"
max_tokens = 2048
```

**Setup**: Install [Ollama](https://ollama.ai), then `ollama pull qwen3:32b`.

**No API key required**. Just set the `endpoint` to your Ollama instance.

**Capabilities reported**: `medium` reasoning, `medium` speed, 32k context (conservative defaults).

## ModelProvider Interface

Every provider implements this interface:

```typescript
interface ModelProvider {
  readonly name: string;      // Provider name (e.g., "anthropic")
  readonly modelId: string;   // Model identifier (e.g., "claude-sonnet-4-5-20250929")

  /** Send a chat request and get a complete response. */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Send a chat request and stream the response. */
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;

  /** Return this model's capabilities. */
  capabilities(): ModelCapabilities;

  /** Return this model's cost profile. */
  costProfile(): CostProfile;

  /** Check if the provider is healthy and reachable. */
  healthCheck(): Promise<ProviderHealth>;
}
```

### ChatRequest

```typescript
interface ChatRequest {
  messages: Array<{
    role: "user" | "assistant";
    content: string | ContentBlock[];
  }>;
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "tool"; name: string };
  stopSequences?: string[];
}
```

### ChatResponse

```typescript
interface ChatResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

### ModelCapabilities

```typescript
interface ModelCapabilities {
  toolUse: boolean;
  streaming: boolean;
  vision: boolean;
  reasoningStrength: "low" | "medium" | "high" | "very_high";
  speed: "fast" | "medium" | "slow";
  maxContextTokens: number;
}
```

### CostProfile

```typescript
interface CostProfile {
  inputTokenCostPer1M: number;   // USD per 1M input tokens
  outputTokenCostPer1M: number;  // USD per 1M output tokens
}
```

### StreamEvent

```typescript
type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: string };
```

## ProviderRegistry

The registry manages all configured providers and provides lookup, health checking, and dynamic registration.

```typescript
// Build from config
const registry = ProviderRegistry.fromConfig(config);

// Get a provider by key
const coder = registry.getOrThrow("coder");

// List all keys
const keys = registry.keys(); // ["architect", "coder", "fast"]

// Health check all providers
const health = await registry.healthCheckAll();
// Map<string, ProviderHealth>

// Check if a specific provider is healthy
if (registry.isHealthy("coder")) { ... }

// Register a provider at runtime
registry.register("custom", myProvider);

// Remove a provider
registry.remove("custom");
```

### Health Checking

Health checks send a minimal test prompt (`"Say OK"`) and measure latency:

```typescript
interface ProviderHealth {
  healthy: boolean;
  latencyMs: number;
  lastChecked: Date;
  error?: string;
}
```

The registry caches health results. The [router](routing.md) uses cached health to avoid routing to unhealthy providers.

## Multi-Provider Setup

A typical production setup uses multiple providers:

```toml
# Heavy reasoning → Anthropic Opus
[models.architect]
provider = "anthropic"
model = "claude-opus-4-6"
role = "planning, architecture"
max_tokens = 8192

# Implementation → Anthropic Sonnet
[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation"
max_tokens = 4096

# Quick tasks → Anthropic Haiku
[models.fast]
provider = "anthropic"
model = "claude-haiku-4-5-20251001"
role = "classification, linting"
max_tokens = 1024

# Code review → Local model (no API costs)
[models.reviewer]
provider = "local"
model = "qwen3:32b"
endpoint = "http://localhost:11434"
role = "code review"
max_tokens = 2048

# Fallback → OpenAI
[models.fallback]
provider = "openai"
model = "gpt-4o"
role = "backup"
max_tokens = 4096
api_key = "${OPENAI_API_KEY}"
```

The [router](routing.md) selects the best provider for each task based on complexity, cost, and availability.

## Adding a Custom Provider

Extend `BaseProvider` to add a new provider:

```typescript
import { BaseProvider } from "foreman/providers";

class MyProvider extends BaseProvider {
  readonly name = "my-provider";
  readonly modelId = "my-model-v1";

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Implement your API call
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    // Implement streaming
  }

  capabilities(): ModelCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: false,
      reasoningStrength: "high",
      speed: "medium",
      maxContextTokens: 128_000,
    };
  }

  costProfile(): CostProfile {
    return { inputTokenCostPer1M: 1.0, outputTokenCostPer1M: 5.0 };
  }
}
```

Register it at runtime:

```typescript
const registry = ProviderRegistry.fromConfig(config);
registry.register("my-model", new MyProvider());
```
