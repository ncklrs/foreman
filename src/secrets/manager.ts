/**
 * Secrets Manager.
 * Implements the "External Credential Sync" pattern:
 * - Loads secrets from environment variables, .env files, and config
 * - Provides masked access (never logs raw values)
 * - Validates required secrets on startup
 * - Supports multiple secret sources with priority
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface SecretSource {
  type: "env" | "file" | "config";
  path?: string;
}

export interface SecretsManagerOptions {
  /** Ordered list of secret sources to search (highest priority first). */
  sources?: SecretSource[];
  /** Working directory for resolving .env file paths. */
  workingDir?: string;
}

export class SecretsManager {
  private secrets: Map<string, string> = new Map();
  private sources: SecretSource[];
  private workingDir: string;
  private accessLog: Array<{ key: string; timestamp: Date; source: string }> = [];

  constructor(options?: SecretsManagerOptions) {
    this.sources = options?.sources ?? [
      { type: "env" },
      { type: "file", path: ".env" },
      { type: "file", path: ".env.local" },
    ];
    this.workingDir = options?.workingDir ?? process.cwd();
  }

  /** Load secrets from all configured sources. */
  async initialize(): Promise<void> {
    // Load in reverse order so highest-priority sources overwrite
    for (const source of [...this.sources].reverse()) {
      switch (source.type) {
        case "env":
          this.loadFromEnv();
          break;
        case "file":
          if (source.path) {
            await this.loadFromDotenv(source.path);
          }
          break;
        case "config":
          // Config secrets are set via setSecret()
          break;
      }
    }
  }

  /** Get a secret value. Returns undefined if not found. */
  get(key: string): string | undefined {
    const value = this.secrets.get(key);
    if (value) {
      this.accessLog.push({ key, timestamp: new Date(), source: "get" });
    }
    return value;
  }

  /** Get a secret value, throwing if not found. */
  getRequired(key: string): string {
    const value = this.get(key);
    if (!value) {
      throw new Error(`Required secret "${key}" is not set. Check your environment variables or .env file.`);
    }
    return value;
  }

  /** Set a secret programmatically. */
  set(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  /** Check if a secret exists. */
  has(key: string): boolean {
    return this.secrets.has(key);
  }

  /** Validate that all required secrets are present. Returns missing keys. */
  validateRequired(keys: string[]): string[] {
    return keys.filter((key) => !this.secrets.has(key));
  }

  /**
   * Resolve a config value that may reference a secret.
   * Patterns: ${SECRET_NAME} or $SECRET_NAME
   */
  resolveValue(value: string): string {
    return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
      const key = braced ?? bare;
      const resolved = this.get(key);
      if (!resolved) {
        throw new Error(`Secret "${key}" referenced in config but not found`);
      }
      return resolved;
    });
  }

  /** Return a masked version of a secret for safe logging. */
  masked(key: string): string {
    const value = this.secrets.get(key);
    if (!value) return "(not set)";
    if (value.length <= 8) return "****";
    return value.slice(0, 4) + "****" + value.slice(-4);
  }

  /** Get all loaded secret keys (never values). */
  keys(): string[] {
    return Array.from(this.secrets.keys());
  }

  /** Get the access audit log. */
  getAccessLog(): ReadonlyArray<{ key: string; timestamp: Date; source: string }> {
    return this.accessLog;
  }

  private loadFromEnv(): void {
    // Load all env vars that look like API keys or secrets
    const secretPatterns = [
      /^[A-Z_]*API[_]?KEY$/,
      /^[A-Z_]*TOKEN$/,
      /^[A-Z_]*SECRET$/,
      /^[A-Z_]*PASSWORD$/,
      /^[A-Z_]*CREDENTIAL/,
    ];

    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      // Load everything — env is the primary source
      this.secrets.set(key, value);
    }
  }

  private async loadFromDotenv(filename: string): Promise<void> {
    const filePath = resolve(this.workingDir, filename);
    if (!existsSync(filePath)) return;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;

        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();

        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Don't overwrite existing (env takes precedence)
        if (!this.secrets.has(key)) {
          this.secrets.set(key, value);
        }
      }
    } catch {
      // Silently skip unreadable .env files
    }
  }
}
