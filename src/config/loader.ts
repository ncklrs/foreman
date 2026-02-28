/**
 * Configuration loader — parses foreman.toml and environment variables.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { ApiConfig, AutopilotConfig, AutopilotScanner, ForemanConfig, GitHubIntegrationConfig, ModelConfig, PolicyConfig, RoutingConfig, SandboxConfig, SlackIntegrationConfig } from "../types/index.js";

// ─── Zod Schemas for config validation ─────────────────────────

const ModelConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "local"]),
  model: z.string().min(1, "model name is required"),
  role: z.string(),
  maxTokens: z.number().int().positive().max(1_000_000),
  temperature: z.number().min(0).max(2).optional(),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
});

const ForemanConfigSchema = z.object({
  foreman: z.object({
    name: z.string().min(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    maxConcurrentAgents: z.number().int().positive().max(100),
    runtime: z.enum(["foreman", "claude-code"]).optional(),
    decompose: z.boolean().optional(),
    decomposeThreshold: z.number().int().min(1).max(10).optional(),
  }),
  models: z.record(z.string(), ModelConfigSchema),
  routing: z.object({
    strategy: z.enum(["capability_match", "cost_optimized", "speed_first"]),
    fallbackChain: z.array(z.string()),
  }),
  sandbox: z.object({
    type: z.enum(["docker", "local"]),
    warmPool: z.number().int().min(0).max(50),
    timeoutMinutes: z.number().positive().max(1440),
    cleanup: z.enum(["on_success", "always", "never"]),
    cloud: z.object({
      provider: z.enum(["fly", "daytona"]),
      app: z.string(),
      region: z.string(),
    }).optional(),
  }),
  policy: z.object({
    protectedPaths: z.array(z.string()),
    blockedCommands: z.array(z.string()),
    maxDiffLines: z.number().int().positive(),
    requireApprovalAbove: z.number().int().min(0),
  }),
  linear: z.object({
    apiKey: z.string().min(1),
    team: z.string().min(1),
    watchLabels: z.array(z.string()),
    watchStatus: z.string(),
  }).optional(),
  github: z.object({
    token: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    watchLabels: z.array(z.string()),
    watchState: z.enum(["open", "closed", "all"]).optional(),
  }).optional(),
  slack: z.object({
    botToken: z.string().min(1),
    watchChannels: z.array(z.string()).min(1),
    triggerPrefix: z.string().optional(),
    postProgress: z.boolean().optional(),
  }).optional(),
  autopilot: z.object({
    enabled: z.boolean(),
    schedule: z.string(),
    timezone: z.string().optional(),
    scanners: z.array(z.enum([
      "security", "dependencies", "code_quality", "test_coverage",
      "performance", "documentation", "dead_code", "type_safety",
    ])),
    maxTicketsPerRun: z.number().int().positive(),
    autoResolve: z.boolean(),
    maxConcurrentResolves: z.number().int().positive(),
    minSeverity: z.number().int().min(1).max(5),
    ticketTarget: z.enum(["github", "linear"]),
    ticketLabels: z.array(z.string()),
    branchPrefix: z.string(),
    workingDir: z.string().optional(),
  }).optional(),
  api: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535),
    host: z.string(),
    apiKey: z.string().optional(),
    corsOrigins: z.array(z.string()),
  }).optional(),
});

/** Validate a normalized config against the Zod schema. Throws on invalid. */
export function validateConfig(config: ForemanConfig): ForemanConfig {
  const result = ForemanConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  - ${i.path.join(".")}: ${i.message}`
    ).join("\n");
    throw new Error(`Invalid foreman configuration:\n${issues}`);
  }
  return config;
}

// We parse TOML manually to avoid runtime dependency issues.
// For a production build we'd use @iarna/toml, but this parser handles
// the subset of TOML used by foreman.toml.

export async function loadConfig(configPath?: string): Promise<ForemanConfig> {
  const path = configPath ?? findConfigFile();
  if (!path) {
    throw new Error(
      "No foreman.toml found. Create one in the current directory or specify --config path."
    );
  }

  const raw = await readFile(path, "utf-8");
  const parsed = parseTOML(raw);
  const config = normalizeConfig(parsed);
  return validateConfig(config);
}

function findConfigFile(): string | null {
  const candidates = [
    resolve(process.cwd(), "foreman.toml"),
    resolve(process.cwd(), ".foreman.toml"),
    resolve(process.env.HOME ?? "", ".config/foreman/foreman.toml"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeConfig(raw: Record<string, unknown>): ForemanConfig {
  const foreman = raw.foreman as Record<string, unknown> | undefined;
  const linear = raw.linear as Record<string, unknown> | undefined;
  const github = raw.github as Record<string, unknown> | undefined;
  const slack = raw.slack as Record<string, unknown> | undefined;
  const autopilot = raw.autopilot as Record<string, unknown> | undefined;
  const api = raw.api as Record<string, unknown> | undefined;
  const models = raw.models as Record<string, Record<string, unknown>> | undefined;
  const routing = raw.routing as Record<string, unknown> | undefined;
  const sandbox = raw.sandbox as Record<string, unknown> | undefined;
  const policy = raw.policy as Record<string, unknown> | undefined;

  return {
    foreman: {
      name: resolveValue(String(foreman?.name ?? "foreman")),
      logLevel: (foreman?.log_level as ForemanConfig["foreman"]["logLevel"]) ?? "info",
      maxConcurrentAgents: Number(foreman?.max_concurrent_agents ?? 10),
      runtime: (foreman?.runtime as "foreman" | "claude-code") ?? undefined,
    },
    linear: linear
      ? {
          apiKey: resolveValue(String(linear.api_key ?? "")),
          team: String(linear.team ?? ""),
          watchLabels: (linear.watch_labels as string[]) ?? [],
          watchStatus: String(linear.watch_status ?? "Todo"),
        }
      : undefined,
    github: normalizeGitHub(github),
    slack: normalizeSlack(slack),
    autopilot: normalizeAutopilot(autopilot),
    api: normalizeApi(api),
    models: normalizeModels(models ?? {}),
    routing: normalizeRouting(routing),
    sandbox: normalizeSandbox(sandbox),
    policy: normalizePolicy(policy),
  };
}

function normalizeGitHub(raw?: Record<string, unknown>): GitHubIntegrationConfig | undefined {
  if (!raw) return undefined;
  return {
    token: resolveValue(String(raw.token ?? "")),
    owner: String(raw.owner ?? ""),
    repo: String(raw.repo ?? ""),
    watchLabels: (raw.watch_labels as string[]) ?? [],
    watchState: (raw.watch_state as "open" | "closed" | "all") ?? "open",
  };
}

function normalizeSlack(raw?: Record<string, unknown>): SlackIntegrationConfig | undefined {
  if (!raw) return undefined;
  return {
    botToken: resolveValue(String(raw.bot_token ?? "")),
    watchChannels: (raw.watch_channels as string[]) ?? [],
    triggerPrefix: raw.trigger_prefix ? String(raw.trigger_prefix) : "!agent",
    postProgress: raw.post_progress !== false,
  };
}

function normalizeModels(
  raw: Record<string, Record<string, unknown>>
): Record<string, ModelConfig> {
  const result: Record<string, ModelConfig> = {};

  for (const [key, value] of Object.entries(raw)) {
    result[key] = {
      provider: (value.provider as ModelConfig["provider"]) ?? "anthropic",
      model: String(value.model ?? ""),
      role: String(value.role ?? ""),
      maxTokens: Number(value.max_tokens ?? 4096),
      temperature: value.temperature != null ? Number(value.temperature) : undefined,
      endpoint: value.endpoint ? resolveValue(String(value.endpoint)) : undefined,
      apiKey: value.api_key ? resolveValue(String(value.api_key)) : undefined,
    };
  }

  return result;
}

function normalizeRouting(raw?: Record<string, unknown>): RoutingConfig {
  return {
    strategy: (raw?.strategy as RoutingConfig["strategy"]) ?? "capability_match",
    fallbackChain: (raw?.fallback_chain as string[]) ?? ["coder", "architect", "fast"],
  };
}

function normalizeSandbox(raw?: Record<string, unknown>): SandboxConfig {
  const cloud = raw?.cloud as Record<string, unknown> | undefined;

  return {
    type: (raw?.type as SandboxConfig["type"]) ?? "local",
    warmPool: Number(raw?.warm_pool ?? 3),
    timeoutMinutes: Number(raw?.timeout_minutes ?? 30),
    cleanup: (raw?.cleanup as SandboxConfig["cleanup"]) ?? "on_success",
    cloud: cloud
      ? {
          provider: (cloud.provider as "fly" | "daytona") ?? "fly",
          app: String(cloud.app ?? ""),
          region: String(cloud.region ?? "iad"),
        }
      : undefined,
  };
}

function normalizeAutopilot(raw?: Record<string, unknown>): AutopilotConfig | undefined {
  if (!raw) return undefined;

  const validScanners: AutopilotScanner[] = [
    "security", "dependencies", "code_quality", "test_coverage",
    "performance", "documentation", "dead_code", "type_safety",
  ];

  const rawScanners = (raw.scanners as string[]) ?? ["code_quality", "security"];
  const scanners = rawScanners.filter((s): s is AutopilotScanner =>
    validScanners.includes(s as AutopilotScanner)
  );

  return {
    enabled: raw.enabled !== false,
    schedule: String(raw.schedule ?? "0 9 * * 1-5"),
    timezone: raw.timezone ? String(raw.timezone) : "UTC",
    scanners: scanners.length > 0 ? scanners : ["code_quality", "security"],
    maxTicketsPerRun: Number(raw.max_tickets_per_run ?? 5),
    autoResolve: raw.auto_resolve === true,
    maxConcurrentResolves: Number(raw.max_concurrent_resolves ?? 2),
    minSeverity: Number(raw.min_severity ?? 3),
    ticketTarget: (raw.ticket_target as "github" | "linear") ?? "github",
    ticketLabels: (raw.ticket_labels as string[]) ?? ["autopilot"],
    branchPrefix: String(raw.branch_prefix ?? "autopilot/"),
    workingDir: raw.working_dir ? String(raw.working_dir) : undefined,
  };
}

function normalizeApi(raw?: Record<string, unknown>): ApiConfig | undefined {
  if (!raw) return undefined;
  return {
    enabled: raw.enabled !== false,
    port: Number(raw.port ?? 4820),
    host: String(raw.host ?? "127.0.0.1"),
    apiKey: raw.api_key ? resolveValue(String(raw.api_key)) : undefined,
    corsOrigins: (raw.cors_origins as string[]) ?? ["*"],
  };
}

function normalizePolicy(raw?: Record<string, unknown>): PolicyConfig {
  return {
    protectedPaths: (raw?.protected_paths as string[]) ?? [],
    blockedCommands: (raw?.blocked_commands as string[]) ?? [],
    maxDiffLines: Number(raw?.max_diff_lines ?? 500),
    requireApprovalAbove: Number(raw?.require_approval_above ?? 200),
  };
}

/** Resolve ${ENV_VAR} references in string values. */
function resolveValue(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set (referenced in config)`);
    }
    return envValue;
  });
}

/**
 * Minimal TOML parser supporting the subset used by foreman.toml:
 * - Top-level and nested tables ([section], [section.subsection])
 * - String values (quoted)
 * - Number values
 * - Boolean values
 * - Array values (inline)
 * - Environment variable references ${VAR}
 */
export function parseTOML(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentTable: Record<string, unknown> = result;
  let currentPath: string[] = [];

  const lines = input.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Table header
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const path = tableMatch[1].split(".").map((s) => s.trim());
      currentPath = path;
      currentTable = ensurePath(result, path);
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const rawValue = stripInlineComment(kvMatch[2].trim());
      currentTable[key] = parseValue(rawValue);
    }
  }

  return result;
}

/** Strip inline comments (# ...) from TOML values, respecting quoted strings. */
function stripInlineComment(value: string): string {
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (inString) {
      if (char === stringChar) inString = false;
    } else if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
    } else if (char === "#") {
      return value.slice(0, i).trim();
    }
  }
  return value;
}

function ensurePath(obj: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = obj;
  for (const segment of path) {
    if (!(segment in current) || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

function parseValue(raw: string): unknown {
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Array
  if (raw.startsWith("[")) {
    return parseArray(raw);
  }

  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;

  // Unquoted string
  return raw;
}

function parseArray(raw: string): unknown[] {
  // Remove brackets and parse comma-separated values
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];

  const items: unknown[] = [];
  let current = "";
  let inString = false;
  let stringChar = "";
  let depth = 0;

  for (const char of inner) {
    if (inString) {
      current += char;
      if (char === stringChar) inString = false;
    } else if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      current += char;
    } else if (char === "[") {
      depth++;
      current += char;
    } else if (char === "]") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) items.push(parseValue(trimmed));
      current = "";
    } else {
      current += char;
    }
  }

  const trimmed = current.trim();
  if (trimmed) items.push(parseValue(trimmed));

  return items;
}
