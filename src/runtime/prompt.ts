/**
 * System prompt construction for agent sessions.
 * Injects task context, codebase awareness, code standards, and tool usage guidelines.
 */

import type { AgentTask, PolicyConfig } from "../types/index.js";

export interface PromptEnrichment {
  /** Lessons learned from past sessions (from KnowledgeStore). */
  lessonsSection?: string;
  /** Project conventions (from AGENTS.md). */
  agentsMdSection?: string;
  /** Active skills matching this task (from SkillsRegistry). */
  skillsSection?: string;
}

export function buildSystemPrompt(
  task: AgentTask,
  codebaseContext: string,
  policy: PolicyConfig,
  customInstructions?: string,
  enrichment?: PromptEnrichment
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

  // AGENTS.md project conventions
  if (enrichment?.agentsMdSection) {
    sections.push(enrichment.agentsMdSection);
  }

  // Lessons from past sessions
  if (enrichment?.lessonsSection) {
    sections.push(enrichment.lessonsSection);
  }

  // Active skills
  if (enrichment?.skillsSection) {
    sections.push(enrichment.skillsSection);
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

### File Operations
1. **Read before writing:** Always read a file before editing it.
2. **Use edit_file for targeted changes:** Don't rewrite entire files when only a few lines need to change.
3. **Search first:** Use search_codebase to find relevant code before making assumptions.
4. **Check your work:** After completing changes, verify the result by reading modified files.

### Git Operations
5. **Use git_status** to check the working tree before and after making changes.
6. **Use git_diff** to preview exactly what will be committed.
7. **Use git_commit** with clear, descriptive messages following conventional commit style.
8. **Use git_branch** to create feature branches for your work.
9. **Use create_pull_request** to submit changes for review when the task is complete.
10. **Use git_log** to understand recent commit history and maintain style consistency.

### Testing & Validation
11. **Run tests** after making changes using run_command with the project's test command.
12. **Run linters/type checkers** if available to catch issues early.

### Web & Research
13. **Use web_fetch** to retrieve documentation, API references, or check endpoints when needed.

### Task Delegation
14. **Use spawn_subagent** to delegate clearly separable subtasks to another model. This is useful for parallelizing work (e.g., having a fast model handle linting while you implement features).

### Completion
15. **Signal completion:** Call task_done when the task is fully complete with a summary of your work.`);

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
