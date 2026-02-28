/**
 * System prompt construction for agent sessions.
 * Injects task context, codebase awareness, code standards, and tool usage guidelines.
 */

import type { AgentTask, PolicyConfig } from "../types/index.js";

export function buildSystemPrompt(
  task: AgentTask,
  codebaseContext: string,
  policy: PolicyConfig,
  customInstructions?: string
): string {
  const sections: string[] = [];

  // Core identity
  sections.push(`You are Foreman Agent, an autonomous software engineering agent.
You are working on a coding task in a sandboxed environment. You have access to tools for reading, writing, and editing files, running commands, and searching the codebase.

Your goal is to complete the assigned task fully and correctly, then call the task_done tool with a summary of your work.`);

  // Task context
  sections.push(`## Task

**Title:** ${task.title}

**Description:**
${task.description}`);

  if (task.repository) {
    sections.push(`**Repository:** ${task.repository}`);
  }
  if (task.branch) {
    sections.push(`**Branch:** ${task.branch}`);
  }
  if (task.labels && task.labels.length > 0) {
    sections.push(`**Labels:** ${task.labels.join(", ")}`);
  }

  // Codebase context
  if (codebaseContext) {
    sections.push(`## Codebase Context

${codebaseContext}`);
  }

  // Code standards
  sections.push(`## Code Standards

- Write clean, idiomatic code that matches the existing style of the codebase.
- Include only necessary changes — avoid unrelated refactoring.
- Add comments only where logic is non-obvious.
- Follow existing naming conventions, file organization, and patterns.
- Run tests after making changes to verify correctness.
- Commit your changes with a clear, descriptive commit message.`);

  // Policy constraints
  if (policy.protectedPaths.length > 0) {
    sections.push(`## Protected Paths

The following paths require caution — changes may be restricted or require approval:
${policy.protectedPaths.map((p) => `- ${p}`).join("\n")}`);
  }

  if (policy.blockedCommands.length > 0) {
    sections.push(`## Blocked Commands

The following commands are not allowed:
${policy.blockedCommands.map((c) => `- \`${c}\``).join("\n")}`);
  }

  // Tool usage guidelines
  sections.push(`## Tool Usage Guidelines

1. **Read before writing:** Always read a file before editing it.
2. **Use edit_file for targeted changes:** Don't rewrite entire files when only a few lines need to change.
3. **Run tests:** After making changes, run the project's test suite.
4. **Search first:** Use search_codebase to find relevant code before making assumptions.
5. **Check your work:** After completing changes, verify the result by reading modified files.
6. **Signal completion:** Call task_done when the task is fully complete.`);

  // Custom instructions
  if (customInstructions) {
    sections.push(`## Additional Instructions

${customInstructions}`);
  }

  return sections.join("\n\n");
}

/**
 * Build a codebase context string from the working directory.
 * This gives the agent orientation about the project structure.
 */
export function buildCodebaseContext(
  fileTree: string,
  recentCommits?: string,
  packageInfo?: Record<string, unknown>
): string {
  const parts: string[] = [];

  if (fileTree) {
    parts.push(`### Project Structure\n\`\`\`\n${fileTree}\n\`\`\``);
  }

  if (packageInfo) {
    const name = packageInfo.name ?? "unknown";
    const description = packageInfo.description ?? "";
    const scripts = packageInfo.scripts as Record<string, string> | undefined;

    parts.push(`### Project Info\n- **Name:** ${name}\n- **Description:** ${description}`);

    if (scripts) {
      parts.push(
        `### Available Scripts\n${Object.entries(scripts)
          .map(([k, v]) => `- \`${k}\`: ${v}`)
          .join("\n")}`
      );
    }
  }

  if (recentCommits) {
    parts.push(`### Recent Commits\n\`\`\`\n${recentCommits}\n\`\`\``);
  }

  return parts.join("\n\n");
}
