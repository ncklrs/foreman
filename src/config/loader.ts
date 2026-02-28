/**
 * Configuration loader — parses foreman.toml and environment variables.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ForemanConfig, ModelConfig, PolicyConfig, RoutingConfig, SandboxConfig } from "../types/index.js";

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
  return normalizeConfig(parsed);
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
  const models = raw.models as Record<string, Record<string, unknown>> | undefined;
  const routing = raw.routing as Record<string, unknown> | undefined;
  const sandbox = raw.sandbox as Record<string, unknown> | undefined;
  const policy = raw.policy as Record<string, unknown> | undefined;

  return {
    foreman: {
      name: resolveValue(String(foreman?.name ?? "foreman")),
      logLevel: (foreman?.log_level as ForemanConfig["foreman"]["logLevel"]) ?? "info",
      maxConcurrentAgents: Number(foreman?.max_concurrent_agents ?? 10),
    },
    linear: linear
      ? {
          apiKey: resolveValue(String(linear.api_key ?? "")),
          team: String(linear.team ?? ""),
          watchLabels: (linear.watch_labels as string[]) ?? [],
          watchStatus: String(linear.watch_status ?? "Todo"),
        }
      : undefined,
    models: normalizeModels(models ?? {}),
    routing: normalizeRouting(routing),
    sandbox: normalizeSandbox(sandbox),
    policy: normalizePolicy(policy),
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
      const rawValue = kvMatch[2].trim();
      currentTable[key] = parseValue(rawValue);
    }
  }

  return result;
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
