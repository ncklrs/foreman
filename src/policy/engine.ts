/**
 * Risk Policy Engine.
 * Evaluates tool calls against configured policies and returns allow/deny/require_approval.
 */

import { minimatch } from "../utils/minimatch.js";
import type { PolicyConfig, PolicyDecision, PolicyEvaluation } from "../types/index.js";

export class PolicyEngine {
  private config: PolicyConfig;
  private diffLineTracker: Map<string, number> = new Map();

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
        return this.evaluateFileWrite(toolName, input, true);
      case "edit_file":
        return this.evaluateFileWrite(toolName, input, false);
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

  /**
   * Evaluate cumulative diff size across all file writes in a session.
   * Returns require_approval if the total exceeds the configured threshold.
   */
  evaluateDiffSize(totalDiffLines: number): PolicyEvaluation {
    if (totalDiffLines > this.config.maxDiffLines) {
      return {
        decision: "deny",
        reason: `Total diff size (${totalDiffLines} lines) exceeds maximum (${this.config.maxDiffLines})`,
        toolName: "diff_check",
        input: { totalDiffLines },
      };
    }

    if (totalDiffLines > this.config.requireApprovalAbove) {
      return {
        decision: "require_approval",
        reason: `Total diff size (${totalDiffLines} lines) exceeds approval threshold (${this.config.requireApprovalAbove})`,
        toolName: "diff_check",
        input: { totalDiffLines },
      };
    }

    return {
      decision: "allow",
      reason: "Diff size within limits",
      toolName: "diff_check",
      input: { totalDiffLines },
    };
  }

  /**
   * Track lines changed by a write/edit operation.
   * Returns the current cumulative diff line count.
   */
  trackDiffLines(path: string, linesChanged: number): number {
    const current = this.diffLineTracker.get(path) ?? 0;
    this.diffLineTracker.set(path, current + linesChanged);
    return this.getTotalDiffLines();
  }

  /** Get total diff lines across all files. */
  getTotalDiffLines(): number {
    let total = 0;
    for (const lines of this.diffLineTracker.values()) {
      total += lines;
    }
    return total;
  }

  /** Reset diff tracking (e.g., after approval). */
  resetDiffTracking(): void {
    this.diffLineTracker.clear();
  }

  private evaluateFileWrite(
    toolName: string,
    input: Record<string, unknown>,
    isFullWrite: boolean
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

    // Estimate diff size and track it
    let estimatedLines = 0;
    if (isFullWrite && input.content) {
      estimatedLines = String(input.content).split("\n").length;
    } else if (input.new_string) {
      // For edits, estimate based on the replacement
      const oldLines = String(input.old_string ?? "").split("\n").length;
      const newLines = String(input.new_string).split("\n").length;
      estimatedLines = Math.abs(newLines - oldLines) + Math.min(oldLines, newLines);
    }

    if (estimatedLines > 0) {
      const totalDiff = this.trackDiffLines(filePath, estimatedLines);

      // Check cumulative diff size
      const diffEval = this.evaluateDiffSize(totalDiff);
      if (diffEval.decision !== "allow") {
        return {
          decision: diffEval.decision,
          reason: diffEval.reason,
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
    // For patterns like ".github/*", also try matching with "**" for deep nesting
    if (minimatch(normalized, pattern)) return true;
    // Convert trailing /* to /** for recursive matching (policy convention)
    if (pattern.endsWith("/*")) {
      const recursivePattern = pattern.slice(0, -2) + "/**";
      if (minimatch(normalized, recursivePattern)) return true;
    }
    return false;
  }

  // Prefix match for directory patterns
  if (normalized.startsWith(pattern)) return true;

  // Filename match (for cases like "package.json" matching any path ending in it)
  if (normalized.endsWith(`/${pattern}`) || normalized === pattern) return true;

  return false;
}
