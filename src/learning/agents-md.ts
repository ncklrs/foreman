/**
 * AGENTS.md Generator and Consumer.
 *
 * AGENTS.md is a convention file that codifies how agents should interact
 * with a codebase. It's the "instruction manual" for AI agents, containing:
 * - Project structure overview
 * - Coding conventions and style rules
 * - Testing patterns and requirements
 * - Common pitfalls to avoid
 * - Tool preferences and workflows
 *
 * The generator produces AGENTS.md from codebase analysis.
 * The consumer reads it and injects it into agent system prompts.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelProvider } from "../providers/base.js";

export interface AgentsMdConfig {
  /** Paths to check for AGENTS.md (in priority order). */
  searchPaths: string[];
  /** Whether to auto-generate if not found. */
  autoGenerate: boolean;
}

const DEFAULT_SEARCH_PATHS = [
  "AGENTS.md",
  ".github/AGENTS.md",
  "docs/AGENTS.md",
  ".foreman/AGENTS.md",
];

export class AgentsMdManager {
  private searchPaths: string[];
  private workingDir: string;
  private cached: string | null = null;

  constructor(workingDir: string, searchPaths?: string[]) {
    this.workingDir = workingDir;
    this.searchPaths = searchPaths ?? DEFAULT_SEARCH_PATHS;
  }

  /**
   * Load AGENTS.md from the project. Returns null if not found.
   */
  async load(): Promise<string | null> {
    if (this.cached !== null) return this.cached;

    for (const relPath of this.searchPaths) {
      const fullPath = resolve(this.workingDir, relPath);
      if (existsSync(fullPath)) {
        try {
          this.cached = await readFile(fullPath, "utf-8");
          return this.cached;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  /**
   * Generate AGENTS.md from codebase analysis using an LLM.
   * Writes the file and returns its contents.
   */
  async generate(provider: ModelProvider, context: string): Promise<string> {
    const response = await provider.chat({
      messages: [
        {
          role: "user",
          content: `${GENERATE_PROMPT}\n\n## Codebase Context\n\n${context}`,
        },
      ],
      maxTokens: 4096,
      temperature: 0.2,
      systemPrompt:
        "You are an expert software architect creating an AGENTS.md file " +
        "that will guide AI coding agents working on this project. " +
        "Be specific, practical, and actionable. Focus on what agents " +
        "need to know, not general software wisdom.",
    });

    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Extract just the markdown content (in case the model wraps in code fences)
    const cleaned = text
      .replace(/^```markdown\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    const filePath = resolve(this.workingDir, "AGENTS.md");
    await writeFile(filePath, cleaned, "utf-8");
    this.cached = cleaned;

    return cleaned;
  }

  /**
   * Build a system prompt section from AGENTS.md content.
   * If the file is too long, it summarizes the key sections.
   */
  buildPromptSection(content: string): string {
    // Truncate to ~3000 chars for prompt space
    const maxLength = 3000;
    if (content.length <= maxLength) {
      return `## Project Agent Guidelines (from AGENTS.md)\n\n${content}`;
    }

    // Extract key sections
    const sections = content.split(/^## /m);
    const important: string[] = [];
    let length = 0;

    for (const section of sections) {
      if (length + section.length > maxLength) break;
      important.push(section);
      length += section.length;
    }

    return `## Project Agent Guidelines (from AGENTS.md)\n\n${important.join("## ")}`;
  }

  /** Invalidate cached content. */
  invalidateCache(): void {
    this.cached = null;
  }
}

const GENERATE_PROMPT = `Analyze this codebase and generate an AGENTS.md file — a comprehensive guide for AI coding agents working on this project.

The AGENTS.md should include these sections:

## Project Overview
Brief description of what the project does.

## Architecture
Key architectural patterns, directory structure, and how components interact.

## Coding Conventions
- Naming conventions (files, variables, functions, classes)
- Import organization
- Error handling patterns
- Type usage patterns

## Testing
- Test framework and runner commands
- Test file naming and location conventions
- What to test and what level of coverage is expected
- How to run tests before committing

## Common Patterns
- How to add a new feature (typical workflow)
- How to fix a bug (typical workflow)
- How to add a new API endpoint / component / module

## Pitfalls
- Common mistakes agents make in this codebase
- Files or patterns that are tricky
- Things to watch out for

## Tool Preferences
- Preferred linter/formatter commands
- Build commands
- How to verify changes

## Do NOT
- List of things agents should never do in this codebase

Return the content as a markdown document. Do not wrap in code fences.`;
