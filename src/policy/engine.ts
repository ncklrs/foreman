/**
 * Risk Policy Engine.
 * Evaluates tool calls against configured policies and returns allow/deny/require_approval.
 */

import { minimatch } from "../utils/minimatch.js";
import type { PolicyConfig, PolicyDecision, PolicyEvaluation } from "../types/index.js";

export class PolicyEngine {
  private config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  evaluate(
    toolName: string,
    input: Record<string, unknown>
  ): PolicyEvaluation {
    // Check tool-specific policies
    switch (toolName) {
      case "write_file":
      case "edit_file":
        return this.evaluateFileWrite(toolName, input);
      case "run_command":
        return this.evaluateCommand(toolName, input);
      default:
        return {
          decision: "allow",
          reason: "No policy restrictions for this tool",
          toolName,
          input,
        };
    }
  }

  private evaluateFileWrite(
    toolName: string,
    input: Record<string, unknown>
  ): PolicyEvaluation {
    const filePath = input.path as string;

    // Check against protected paths
    for (const pattern of this.config.protectedPaths) {
      if (matchesPath(filePath, pattern)) {
        return {
          decision: "require_approval",
          reason: `File path matches protected pattern: ${pattern}`,
          toolName,
          input,
        };
      }
    }

    return {
      decision: "allow",
      reason: "File path is not protected",
      toolName,
      input,
    };
  }

  private evaluateCommand(
    toolName: string,
    input: Record<string, unknown>
  ): PolicyEvaluation {
    const command = input.command as string;

    // Check against blocked commands
    for (const blocked of this.config.blockedCommands) {
      if (command.includes(blocked)) {
        return {
          decision: "deny",
          reason: `Command matches blocked pattern: ${blocked}`,
          toolName,
          input,
        };
      }
    }

    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /rm\s+(-rf?|--recursive)\s+\//,  // rm -rf /
      /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, // fork bomb
      />\s*\/dev\/sd/,                   // writing to block devices
      /mkfs\./,                          // formatting filesystems
      /dd\s+.*of=\/dev\//,              // dd to devices
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          decision: "deny",
          reason: `Command matches dangerous pattern: ${pattern.source}`,
          toolName,
          input,
        };
      }
    }

    // Commands that modify dependencies should require approval
    const approvalPatterns = [
      /npm\s+(install|uninstall|update)/,
      /yarn\s+(add|remove|upgrade)/,
      /pnpm\s+(add|remove|update)/,
      /pip\s+install/,
      /cargo\s+(add|remove)/,
      /git\s+push/,
      /git\s+reset\s+--hard/,
      /git\s+force-push/,
    ];

    for (const pattern of approvalPatterns) {
      if (pattern.test(command)) {
        return {
          decision: "require_approval",
          reason: `Command modifies dependencies or repository state`,
          toolName,
          input,
        };
      }
    }

    return {
      decision: "allow",
      reason: "Command is allowed",
      toolName,
      input,
    };
  }
}

function matchesPath(filePath: string, pattern: string): boolean {
  // Normalize path
  const normalized = filePath.replace(/^\.\//, "");

  // Direct match
  if (normalized === pattern) return true;

  // Use minimatch for glob patterns
  if (pattern.includes("*")) {
    return minimatch(normalized, pattern);
  }

  // Prefix match for directory patterns
  if (normalized.startsWith(pattern)) return true;

  // Filename match (for cases like "package.json" matching any path ending in it)
  if (normalized.endsWith(`/${pattern}`) || normalized === pattern) return true;

  return false;
}
