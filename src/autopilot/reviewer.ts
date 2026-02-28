/**
 * Codebase Reviewer.
 * Uses an LLM agent to scan the codebase for improvements, tech debt,
 * security issues, and other actionable findings. Each scanner type
 * produces a focused review prompt that the agent executes.
 */

import type {
  AutopilotScanner,
  ReviewFinding,
  ForemanConfig,
} from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { ToolExecutor } from "../tools/executor.js";

/** Prompt templates for each scanner type. */
const SCANNER_PROMPTS: Record<AutopilotScanner, string> = {
  security: `You are a security auditor. Scan this codebase for:
- Hardcoded secrets, API keys, tokens, or passwords
- SQL injection, command injection, or path traversal vulnerabilities
- Insecure use of crypto, weak hashing, or missing input validation
- Missing authentication or authorization checks
- Dependencies with known CVEs (check package.json / lock files)
- Unsafe deserialization or eval() usage
- SSRF, XSS, or CSRF vulnerabilities

For each issue found, report it as a structured JSON finding.`,

  dependencies: `You are a dependency auditor. Scan this codebase for:
- Outdated dependencies that have newer major versions available
- Dependencies with known security vulnerabilities
- Unused dependencies listed in package.json but never imported
- Missing peer dependencies or version conflicts
- Deprecated packages that should be replaced with alternatives
- Excessively heavy dependencies where lighter alternatives exist

For each issue found, report it as a structured JSON finding.`,

  code_quality: `You are a code quality reviewer. Scan this codebase for:
- Functions or methods that are too long (> 50 lines) and should be decomposed
- Duplicated code blocks that should be extracted into shared utilities
- Inconsistent naming conventions or style violations
- Missing error handling in critical code paths
- Complex conditionals that could be simplified
- God classes or files with too many responsibilities
- Magic numbers or strings that should be constants

For each issue found, report it as a structured JSON finding.`,

  test_coverage: `You are a test coverage analyst. Scan this codebase for:
- Source files with no corresponding test file
- Critical code paths (error handling, data validation, API endpoints) without test coverage
- Test files that only test the happy path without edge cases
- Missing integration tests for key workflows
- Test files that import from other test files (fragile coupling)
- Untested utility functions or helper modules

For each issue found, report it as a structured JSON finding.`,

  performance: `You are a performance analyst. Scan this codebase for:
- N+1 query patterns or unbounded database queries
- Missing pagination on list endpoints
- Synchronous operations that should be async
- Memory leaks from unclosed resources (streams, connections, timers)
- Unbounded array accumulations in loops
- Missing caching for expensive operations
- Large synchronous file reads that should be streamed

For each issue found, report it as a structured JSON finding.`,

  documentation: `You are a documentation reviewer. Scan this codebase for:
- Public API functions or classes with no JSDoc/docstring
- README that is outdated or missing key setup instructions
- Exported types or interfaces without descriptions
- Complex algorithms without explanatory comments
- Missing CHANGELOG entries for significant changes
- Configuration options without documentation

For each issue found, report it as a structured JSON finding.`,

  dead_code: `You are a dead code detector. Scan this codebase for:
- Exported functions or classes that are never imported anywhere
- Unused variables, parameters, or imports
- Commented-out code blocks that should be removed
- Unreachable code after return/throw/break statements
- Feature flags or conditional code that is always true/false
- Unused type definitions or interfaces
- Empty catch blocks or no-op functions

For each issue found, report it as a structured JSON finding.`,

  type_safety: `You are a type safety analyst. Scan this codebase for:
- Usage of 'any' type that could be replaced with proper types
- Missing return types on public functions
- Type assertions (as) that bypass type checking unsafely
- Non-null assertions (!) on potentially null values
- Missing generic constraints
- Inconsistent use of strict TypeScript options
- Record<string, any> or similar weak types in public APIs

For each issue found, report it as a structured JSON finding.`,
};

const FINDING_FORMAT = `
Return your findings as a JSON array. Each finding must have this structure:
{
  "scanner": "<scanner_type>",
  "severity": <1-5>,
  "title": "<short title>",
  "description": "<detailed explanation of the issue>",
  "filePath": "<path/to/file>",
  "lineNumber": <line_number_or_null>,
  "suggestion": "<specific actionable fix>",
  "effort": "<trivial|small|medium|large>",
  "tags": ["<relevant>", "<tags>"]
}

Severity scale:
1 = Info (nice to have)
2 = Low (minor improvement)
3 = Medium (should fix soon)
4 = High (fix before next release)
5 = Critical (fix immediately)

Effort scale:
- trivial: < 5 minutes, single line change
- small: < 30 minutes, a few files
- medium: 1-4 hours, multiple files or design decisions
- large: > 4 hours, significant refactoring

Return ONLY the JSON array, no other text. If no findings, return [].`;

export class CodebaseReviewer {
  private executor: ToolExecutor;

  constructor(workingDir: string) {
    this.executor = new ToolExecutor(workingDir);
  }

  /**
   * Run a set of scanners against the codebase and return findings.
   * Uses the provided LLM to analyze codebase content.
   */
  async review(
    provider: ModelProvider,
    scanners: AutopilotScanner[],
    config: ForemanConfig
  ): Promise<ReviewFinding[]> {
    // Gather codebase context for the reviewer
    const context = await this.gatherContext();
    const allFindings: ReviewFinding[] = [];

    for (const scanner of scanners) {
      const findings = await this.runScanner(provider, scanner, context);
      allFindings.push(...findings);
    }

    return allFindings;
  }

  /** Run a single scanner and parse its findings. */
  private async runScanner(
    provider: ModelProvider,
    scanner: AutopilotScanner,
    context: string
  ): Promise<ReviewFinding[]> {
    const prompt = SCANNER_PROMPTS[scanner];

    const response = await provider.chat({
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n## Codebase Context\n\n${context}\n\n${FINDING_FORMAT}`,
        },
      ],
      maxTokens: 4096,
      temperature: 0.1,
      systemPrompt:
        "You are an expert code reviewer performing an automated audit. " +
        "Be thorough but precise — only report real issues, not false positives. " +
        "Every finding must be actionable with a specific fix suggestion.",
    });

    return this.parseFindings(response.content, scanner);
  }

  /** Parse LLM response into structured findings. */
  private parseFindings(
    content: (import("../types/index.js").ContentBlock)[],
    scanner: AutopilotScanner
  ): ReviewFinding[] {
    // Extract text from response
    const text = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Try to extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const raw = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      return raw.map((item, idx) => ({
        id: `${scanner}_${Date.now()}_${idx}`,
        scanner: (item.scanner as AutopilotScanner) ?? scanner,
        severity: Math.min(5, Math.max(1, Number(item.severity ?? 3))),
        title: String(item.title ?? "Untitled finding"),
        description: String(item.description ?? ""),
        filePath: item.filePath ? String(item.filePath) : undefined,
        lineNumber: item.lineNumber ? Number(item.lineNumber) : undefined,
        suggestion: String(item.suggestion ?? ""),
        effort: (item.effort as ReviewFinding["effort"]) ?? "small",
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      }));
    } catch {
      return [];
    }
  }

  /** Gather codebase context for scanners to analyze. */
  private async gatherContext(): Promise<string> {
    const parts: string[] = [];

    // File tree
    const tree = await this.executor.execute("run_command", {
      command:
        "find . -maxdepth 4 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' | head -200 | sort",
      timeout: 10000,
    });
    if (!tree.isError) {
      parts.push(`### File Tree\n\`\`\`\n${tree.output}\n\`\`\``);
    }

    // Package.json
    const pkg = await this.executor.execute("read_file", { path: "package.json" });
    if (!pkg.isError) {
      parts.push(`### package.json\n\`\`\`json\n${pkg.output}\n\`\`\``);
    }

    // tsconfig.json
    const tsconfig = await this.executor.execute("read_file", { path: "tsconfig.json" });
    if (!tsconfig.isError) {
      parts.push(`### tsconfig.json\n\`\`\`json\n${tsconfig.output}\n\`\`\``);
    }

    // Recent git log
    const gitLog = await this.executor.execute("run_command", {
      command: "git log --oneline -20 2>/dev/null || true",
      timeout: 5000,
    });
    if (!gitLog.isError && gitLog.output.trim()) {
      parts.push(`### Recent Commits\n\`\`\`\n${gitLog.output}\n\`\`\``);
    }

    // Sample source files (first few .ts files for style context)
    const sourceFiles = await this.executor.execute("run_command", {
      command: "find ./src -name '*.ts' -not -name '*.d.ts' | head -8",
      timeout: 5000,
    });
    if (!sourceFiles.isError) {
      const files = sourceFiles.output.trim().split("\n").filter(Boolean);
      for (const file of files.slice(0, 5)) {
        const content = await this.executor.execute("read_file", { path: file });
        if (!content.isError) {
          parts.push(`### ${file}\n\`\`\`typescript\n${content.output.slice(0, 3000)}\n\`\`\``);
        }
      }
    }

    return parts.join("\n\n");
  }
}
