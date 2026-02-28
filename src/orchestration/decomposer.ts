/**
 * Task Decomposer.
 *
 * Takes a complex task and breaks it into a DAG of subtasks.
 * Two decomposition modes:
 *
 * 1. **LLM-powered**: Uses an "architect" model to analyze the task
 *    and produce a structured decomposition with dependencies.
 *
 * 2. **Heuristic**: Pattern-based decomposition for common task shapes
 *    (multi-file changes, refactoring, feature implementation).
 *
 * The decomposer produces a TaskGraph that the MultiAgentExecutor
 * can run with parallel batching.
 */

import type { AgentTask, ModelConfig } from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { TaskGraph, type SubTask } from "./graph.js";

export interface DecomposerOptions {
  /** Provider to use for LLM decomposition (usually an architect model). */
  provider?: ModelProvider;
  /** Model config for the decomposer model. */
  modelConfig?: ModelConfig;
  /** Maximum number of subtasks to create. */
  maxSubtasks?: number;
  /** Whether to fall back to heuristic decomposition on LLM failure. */
  heuristicFallback?: boolean;
}

export interface DecompositionResult {
  graph: TaskGraph;
  strategy: "llm" | "heuristic";
  reasoning: string;
}

const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposer for a software engineering agent system.
Given a complex task, break it into smaller, independent subtasks that can be executed by separate agents.

Rules:
1. Each subtask should be self-contained and clearly defined
2. Identify dependencies between subtasks (which must complete before which)
3. Keep subtasks small enough for a single agent session (under 30 tool calls)
4. Assign appropriate model roles: "architect" for design/planning, "coder" for implementation, "fast" for simple tasks like linting or tests
5. Don't over-decompose: 2-8 subtasks is ideal for most tasks

Respond with a JSON array of subtasks:
[
  {
    "id": "step_1",
    "title": "Short title",
    "description": "Detailed description of what to do",
    "dependsOn": [],
    "modelRole": "architect|coder|fast",
    "labels": ["relevant", "labels"],
    "complexity": 1-10
  },
  {
    "id": "step_2",
    "title": "...",
    "description": "...",
    "dependsOn": ["step_1"],
    "modelRole": "coder",
    "labels": [],
    "complexity": 5
  }
]

Only output valid JSON. No markdown, no explanation.`;

export class TaskDecomposer {
  private options: DecomposerOptions;

  constructor(options: DecomposerOptions = {}) {
    this.options = {
      maxSubtasks: 8,
      heuristicFallback: true,
      ...options,
    };
  }

  /**
   * Decompose a task into subtasks.
   * Tries LLM decomposition first, falls back to heuristic.
   */
  async decompose(task: AgentTask): Promise<DecompositionResult> {
    // Try LLM decomposition if provider is available
    if (this.options.provider) {
      try {
        const result = await this.llmDecompose(task);
        if (result.graph.size() >= 2) {
          return result;
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic decomposition
    return this.heuristicDecompose(task);
  }

  /**
   * LLM-powered decomposition using an architect model.
   */
  private async llmDecompose(task: AgentTask): Promise<DecompositionResult> {
    const provider = this.options.provider!;

    const response = await provider.chat({
      messages: [
        {
          role: "user",
          content: `Decompose this task into subtasks:\n\nTitle: ${task.title}\nDescription: ${task.description}\n${task.labels?.length ? `Labels: ${task.labels.join(", ")}` : ""}`,
        },
      ],
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
      maxTokens: this.options.modelConfig?.maxTokens ?? 2048,
      temperature: 0.3,
    });

    // Extract text from response
    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Parse JSON from response
    const subtasks = this.parseSubtasks(text);
    const graph = this.buildGraph(subtasks);

    return {
      graph,
      strategy: "llm",
      reasoning: `Decomposed into ${graph.size()} subtasks by architect model`,
    };
  }

  /**
   * Heuristic decomposition based on task patterns.
   */
  heuristicDecompose(task: AgentTask): DecompositionResult {
    const labels = task.labels ?? [];
    const desc = task.description.toLowerCase();
    const title = task.title.toLowerCase();

    // Pattern: Feature implementation
    if (this.matchesPattern(title, desc, labels, ["feature", "implement", "add", "create", "build"])) {
      return this.decomposeFeature(task);
    }

    // Pattern: Refactoring
    if (this.matchesPattern(title, desc, labels, ["refactor", "restructure", "reorganize", "migrate"])) {
      return this.decomposeRefactor(task);
    }

    // Pattern: Bug fix
    if (this.matchesPattern(title, desc, labels, ["bug", "fix", "issue", "error", "broken"])) {
      return this.decomposeBugFix(task);
    }

    // Pattern: Multi-file or broad changes
    if (desc.length > 1000 || this.matchesPattern(title, desc, labels, ["update", "change", "modify"])) {
      return this.decomposeGeneric(task);
    }

    // Default: simple two-step (implement + verify)
    return this.decomposeSimple(task);
  }

  private decomposeFeature(task: AgentTask): DecompositionResult {
    const subtasks: SubTask[] = [
      {
        id: "plan",
        title: `Plan: ${task.title}`,
        description: `Analyze the requirements and create an implementation plan for: ${task.description}\n\nIdentify the files to create/modify, interfaces to define, and edge cases to handle. Output a clear plan.`,
        dependsOn: [],
        modelRole: "architect",
        labels: ["planning", ...(task.labels ?? [])],
        complexity: 6,
        status: "pending",
      },
      {
        id: "implement",
        title: `Implement: ${task.title}`,
        description: `Implement the feature: ${task.description}\n\nFollow the plan created in the planning step. Write the core implementation code.`,
        dependsOn: ["plan"],
        modelRole: "coder",
        labels: ["implementation", ...(task.labels ?? [])],
        complexity: 7,
        status: "pending",
      },
      {
        id: "test",
        title: `Test: ${task.title}`,
        description: `Write tests for the feature: ${task.title}\n\nCreate unit tests covering the main functionality and edge cases. Ensure all tests pass.`,
        dependsOn: ["implement"],
        modelRole: "coder",
        labels: ["testing", ...(task.labels ?? [])],
        complexity: 5,
        status: "pending",
      },
      {
        id: "verify",
        title: `Verify: ${task.title}`,
        description: `Run the full test suite and linting. Fix any issues found. Verify the implementation is complete and correct.`,
        dependsOn: ["test"],
        modelRole: "fast",
        labels: ["verification", ...(task.labels ?? [])],
        complexity: 3,
        status: "pending",
      },
    ];

    return this.buildResult(subtasks, "Feature implementation pattern: plan → implement → test → verify");
  }

  private decomposeRefactor(task: AgentTask): DecompositionResult {
    const subtasks: SubTask[] = [
      {
        id: "analyze",
        title: `Analyze: ${task.title}`,
        description: `Analyze the current code structure for refactoring: ${task.description}\n\nIdentify all files affected, dependency chains, and potential risks. Create a safe refactoring sequence.`,
        dependsOn: [],
        modelRole: "architect",
        labels: ["analysis", ...(task.labels ?? [])],
        complexity: 7,
        status: "pending",
      },
      {
        id: "refactor",
        title: `Refactor: ${task.title}`,
        description: `Execute the refactoring: ${task.description}\n\nFollow the analysis plan. Make changes incrementally, ensuring each step leaves the code in a working state.`,
        dependsOn: ["analyze"],
        modelRole: "coder",
        labels: ["refactoring", ...(task.labels ?? [])],
        complexity: 7,
        status: "pending",
      },
      {
        id: "fix_tests",
        title: `Fix tests after refactor`,
        description: `Update any tests broken by the refactoring. Add new tests for refactored code paths. Run the full test suite.`,
        dependsOn: ["refactor"],
        modelRole: "coder",
        labels: ["testing", ...(task.labels ?? [])],
        complexity: 5,
        status: "pending",
      },
    ];

    return this.buildResult(subtasks, "Refactoring pattern: analyze → refactor → fix tests");
  }

  private decomposeBugFix(task: AgentTask): DecompositionResult {
    const subtasks: SubTask[] = [
      {
        id: "diagnose",
        title: `Diagnose: ${task.title}`,
        description: `Investigate and diagnose the bug: ${task.description}\n\nRead relevant code, identify the root cause, and determine the fix approach. Do not make changes yet.`,
        dependsOn: [],
        modelRole: "coder",
        labels: ["diagnosis", ...(task.labels ?? [])],
        complexity: 6,
        status: "pending",
      },
      {
        id: "fix",
        title: `Fix: ${task.title}`,
        description: `Apply the fix for: ${task.description}\n\nBased on the diagnosis, implement the minimal fix. Add a regression test.`,
        dependsOn: ["diagnose"],
        modelRole: "coder",
        labels: ["fix", ...(task.labels ?? [])],
        complexity: 5,
        status: "pending",
      },
      {
        id: "verify",
        title: `Verify fix: ${task.title}`,
        description: `Run the full test suite to verify the fix doesn't break anything else. Confirm the regression test passes.`,
        dependsOn: ["fix"],
        modelRole: "fast",
        labels: ["verification", ...(task.labels ?? [])],
        complexity: 2,
        status: "pending",
      },
    ];

    return this.buildResult(subtasks, "Bug fix pattern: diagnose → fix → verify");
  }

  private decomposeGeneric(task: AgentTask): DecompositionResult {
    const subtasks: SubTask[] = [
      {
        id: "plan",
        title: `Plan changes: ${task.title}`,
        description: `Analyze the scope of changes needed: ${task.description}\n\nIdentify all files to modify and create an ordered plan.`,
        dependsOn: [],
        modelRole: "architect",
        labels: ["planning", ...(task.labels ?? [])],
        complexity: 5,
        status: "pending",
      },
      {
        id: "execute",
        title: `Execute: ${task.title}`,
        description: `Make all the requested changes: ${task.description}\n\nFollow the plan and implement each change.`,
        dependsOn: ["plan"],
        modelRole: "coder",
        labels: ["implementation", ...(task.labels ?? [])],
        complexity: 6,
        status: "pending",
      },
      {
        id: "verify",
        title: `Verify: ${task.title}`,
        description: `Run tests and verify all changes are correct and complete.`,
        dependsOn: ["execute"],
        modelRole: "fast",
        labels: ["verification", ...(task.labels ?? [])],
        complexity: 3,
        status: "pending",
      },
    ];

    return this.buildResult(subtasks, "Generic pattern: plan → execute → verify");
  }

  private decomposeSimple(task: AgentTask): DecompositionResult {
    const subtasks: SubTask[] = [
      {
        id: "implement",
        title: task.title,
        description: task.description,
        dependsOn: [],
        modelRole: "coder",
        labels: task.labels ?? [],
        complexity: 5,
        status: "pending",
      },
      {
        id: "verify",
        title: `Verify: ${task.title}`,
        description: `Run tests and verify the implementation is correct.`,
        dependsOn: ["implement"],
        modelRole: "fast",
        labels: ["verification"],
        complexity: 2,
        status: "pending",
      },
    ];

    return this.buildResult(subtasks, "Simple pattern: implement → verify");
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private matchesPattern(title: string, desc: string, labels: string[], keywords: string[]): boolean {
    const combined = `${title} ${desc} ${labels.join(" ")}`.toLowerCase();
    return keywords.some((kw) => {
      // Use word boundary matching to avoid false positives (e.g., "padding" matching "add")
      const pattern = new RegExp(`\\b${kw}\\b`);
      return pattern.test(combined);
    });
  }

  private parseSubtasks(text: string): Array<{
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    modelRole?: string;
    labels?: string[];
    complexity?: number;
  }> {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in LLM response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Empty subtask array");
    }

    // Validate and normalize
    const maxSubtasks = this.options.maxSubtasks ?? 8;
    return parsed.slice(0, maxSubtasks).map((item: any, i) => ({
      id: String(item.id ?? `step_${i + 1}`),
      title: String(item.title ?? `Step ${i + 1}`),
      description: String(item.description ?? ""),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
      modelRole: item.modelRole ? String(item.modelRole) : undefined,
      labels: Array.isArray(item.labels) ? item.labels.map(String) : undefined,
      complexity: typeof item.complexity === "number" ? item.complexity : undefined,
    }));
  }

  private buildGraph(subtasks: Array<{
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    modelRole?: string;
    labels?: string[];
    complexity?: number;
  }>): TaskGraph {
    const graph = new TaskGraph();
    const validIds = new Set(subtasks.map((s) => s.id));

    for (const st of subtasks) {
      // Filter out dependencies to non-existent tasks
      const validDeps = st.dependsOn.filter((d) => validIds.has(d));

      graph.addTask({
        id: st.id,
        title: st.title,
        description: st.description,
        dependsOn: validDeps,
        modelRole: st.modelRole,
        labels: st.labels,
        complexity: st.complexity,
        status: "pending",
      });
    }

    // Validate the graph
    const validation = graph.validate();
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join("; ")}`);
    }

    return graph;
  }

  private buildResult(subtasks: SubTask[], reasoning: string): DecompositionResult {
    const graph = new TaskGraph();
    for (const st of subtasks) {
      graph.addTask(st);
    }
    return { graph, strategy: "heuristic", reasoning };
  }
}
