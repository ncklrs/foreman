/**
 * Claude Code Hooks Configuration Generator.
 *
 * Generates the `.claude/settings.json` hooks configuration that makes
 * Claude Code send HTTP hook events to Foreman's API server.
 *
 * Usage:
 *   foreman --hooks-setup   → writes hooks to .claude/settings.json
 *   foreman --hooks-print   → prints hooks config to stdout
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, HooksConfig } from "./types.js";

export interface HooksSetupOptions {
  /** Foreman API host (default: "127.0.0.1"). */
  host: string;
  /** Foreman API port (default: 4820). */
  port: number;
  /** Which events to register hooks for. */
  events: HookEvent[];
  /** Timeout in ms for each hook (default: 5000). */
  timeout: number;
  /** API key for authentication (optional). */
  apiKey?: string;
}

/**
 * Generate the hooks object for Claude Code settings.
 */
export function generateHooksConfig(options: HooksSetupOptions): Record<string, unknown> {
  const baseUrl = `http://${options.host}:${options.port}/api/hooks`;

  const hooks: Record<string, Array<Record<string, unknown>>> = {};

  for (const event of options.events) {
    const hookEntry: Record<string, unknown> = {
      type: "http",
      url: `${baseUrl}/${eventToPath(event)}`,
      timeout: options.timeout,
    };

    // Add auth header if API key is configured
    if (options.apiKey) {
      hookEntry.headers = {
        Authorization: `Bearer ${options.apiKey}`,
      };
    }

    hooks[event] = [hookEntry];
  }

  return hooks;
}

/**
 * Generate a complete settings.json content with hooks configured.
 * Merges with existing settings if present.
 */
export async function generateSettingsFile(
  settingsDir: string,
  options: HooksSetupOptions
): Promise<string> {
  const settingsPath = join(settingsDir, "settings.json");
  let existing: Record<string, unknown> = {};

  // Load existing settings if present
  if (existsSync(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, "utf-8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  // Merge hooks into existing settings
  const hooks = generateHooksConfig(options);
  existing.hooks = hooks;

  return JSON.stringify(existing, null, 2);
}

/**
 * Write hooks configuration to the Claude Code settings file.
 * Creates .claude/ directory if it doesn't exist.
 */
export async function writeHooksConfig(
  projectDir: string,
  options: HooksSetupOptions
): Promise<string> {
  const claudeDir = join(projectDir, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const content = await generateSettingsFile(claudeDir, options);
  const settingsPath = join(claudeDir, "settings.json");
  await writeFile(settingsPath, content, "utf-8");

  return settingsPath;
}

/**
 * Generate a printable summary of the hooks configuration.
 */
export function printHooksConfig(options: HooksSetupOptions): string {
  const hooks = generateHooksConfig(options);
  const lines: string[] = [
    "Claude Code Hooks Configuration",
    "================================",
    "",
    "Add this to your .claude/settings.json:",
    "",
    JSON.stringify({ hooks }, null, 2),
    "",
    "Or run `foreman --hooks-setup` to auto-configure.",
    "",
    `Foreman API: http://${options.host}:${options.port}`,
    `Events: ${options.events.join(", ")}`,
    `Timeout: ${options.timeout}ms`,
  ];

  if (options.apiKey) {
    lines.push(`Auth: Bearer token configured`);
  }

  return lines.join("\n");
}

/**
 * Convert a hook event name to a URL path segment.
 */
function eventToPath(event: HookEvent): string {
  // Convert PascalCase to kebab-case
  return event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Convert a URL path segment back to a hook event name.
 */
export function pathToEvent(path: string): HookEvent | null {
  const map: Record<string, HookEvent> = {
    "pre-tool-use": "PreToolUse",
    "post-tool-use": "PostToolUse",
    "stop": "Stop",
    "task-completed": "TaskCompleted",
    "session-start": "SessionStart",
    "notification": "Notification",
  };
  return map[path] ?? null;
}
