/**
 * Task Graph — Directed Acyclic Graph for subtask dependencies.
 *
 * Models a complex task as a set of subtasks with dependency edges.
 * Supports:
 * - Topological ordering for sequential execution
 * - Parallel batch extraction (all tasks whose deps are satisfied)
 * - Cycle detection
 * - Status tracking per node
 */

export type SubTaskStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped";

export interface SubTask {
  /** Unique ID within the graph. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description of work. */
  description: string;
  /** IDs of subtasks that must complete before this one starts. */
  dependsOn: string[];
  /** Suggested model role (e.g., "architect", "coder", "fast"). */
  modelRole?: string;
  /** Labels for routing and learning. */
  labels?: string[];
  /** Estimated complexity 1-10. */
  complexity?: number;
  /** Current status. */
  status: SubTaskStatus;
  /** Result summary after completion. */
  result?: string;
  /** Files changed by this subtask. */
  filesChanged?: string[];
  /** Error message if failed. */
  error?: string;
  /** Execution time in ms. */
  durationMs?: number;
}

export class TaskGraph {
  private nodes: Map<string, SubTask> = new Map();
  private edges: Map<string, Set<string>> = new Map(); // dependsOn edges
  private reverseEdges: Map<string, Set<string>> = new Map(); // dependents

  /** Add a subtask to the graph. */
  addTask(task: SubTask): void {
    if (this.nodes.has(task.id)) {
      throw new Error(`Duplicate subtask ID: ${task.id}`);
    }

    this.nodes.set(task.id, { ...task });
    this.edges.set(task.id, new Set(task.dependsOn));

    // Build reverse edges
    if (!this.reverseEdges.has(task.id)) {
      this.reverseEdges.set(task.id, new Set());
    }
    for (const dep of task.dependsOn) {
      if (!this.reverseEdges.has(dep)) {
        this.reverseEdges.set(dep, new Set());
      }
      this.reverseEdges.get(dep)!.add(task.id);
    }
  }

  /** Get a subtask by ID. */
  getTask(id: string): SubTask | undefined {
    return this.nodes.get(id);
  }

  /** Get all subtasks. */
  getAllTasks(): SubTask[] {
    return Array.from(this.nodes.values());
  }

  /** Get total number of subtasks. */
  size(): number {
    return this.nodes.size;
  }

  /** Update subtask status. */
  setStatus(id: string, status: SubTaskStatus): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown subtask: ${id}`);
    node.status = status;
  }

  /** Set result for a completed subtask. */
  setResult(id: string, result: string, filesChanged?: string[], durationMs?: number): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown subtask: ${id}`);
    node.result = result;
    node.filesChanged = filesChanged;
    node.durationMs = durationMs;
  }

  /** Set error for a failed subtask. */
  setError(id: string, error: string): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown subtask: ${id}`);
    node.error = error;
  }

  /**
   * Get all subtasks that are ready to execute:
   * - Status is "pending"
   * - All dependencies are "completed"
   */
  getReadyTasks(): SubTask[] {
    const ready: SubTask[] = [];

    for (const [id, node] of this.nodes) {
      if (node.status !== "pending") continue;

      const deps = this.edges.get(id) ?? new Set();
      const allDepsDone = Array.from(deps).every((depId) => {
        const dep = this.nodes.get(depId);
        return dep?.status === "completed";
      });

      if (allDepsDone) {
        ready.push(node);
      }
    }

    return ready;
  }

  /**
   * Get subtasks that should be skipped because a dependency failed.
   */
  getSkippableTasks(): SubTask[] {
    const skippable: SubTask[] = [];

    for (const [id, node] of this.nodes) {
      if (node.status !== "pending") continue;

      const deps = this.edges.get(id) ?? new Set();
      const anyDepFailed = Array.from(deps).some((depId) => {
        const dep = this.nodes.get(depId);
        return dep?.status === "failed" || dep?.status === "skipped";
      });

      if (anyDepFailed) {
        skippable.push(node);
      }
    }

    return skippable;
  }

  /** Check if all subtasks are done (completed, failed, or skipped). */
  isComplete(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === "pending" || node.status === "running" || node.status === "ready") {
        return false;
      }
    }
    return true;
  }

  /** Get completion stats. */
  getStats(): { total: number; completed: number; failed: number; skipped: number; pending: number; running: number } {
    let completed = 0, failed = 0, skipped = 0, pending = 0, running = 0;
    for (const node of this.nodes.values()) {
      switch (node.status) {
        case "completed": completed++; break;
        case "failed": failed++; break;
        case "skipped": skipped++; break;
        case "running": running++; break;
        default: pending++; break;
      }
    }
    return { total: this.nodes.size, completed, failed, skipped, pending, running };
  }

  /**
   * Validate the graph:
   * - All dependency references exist
   * - No cycles
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check that all dependency references exist
    for (const [id, deps] of this.edges) {
      for (const depId of deps) {
        if (!this.nodes.has(depId)) {
          errors.push(`Subtask "${id}" depends on unknown subtask "${depId}"`);
        }
      }
    }

    // Check for cycles via DFS
    const cycle = this.detectCycle();
    if (cycle) {
      errors.push(`Cycle detected: ${cycle.join(" → ")}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get topological order (for sequential execution).
   * Returns null if graph has cycles.
   */
  topologicalSort(): SubTask[] | null {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }

    for (const deps of this.edges.values()) {
      for (const dep of deps) {
        if (inDegree.has(dep)) {
          // This counts reverse — we need dependents' in-degree
        }
      }
    }

    // Recompute in-degree correctly: in-degree = number of dependencies
    for (const [id, deps] of this.edges) {
      inDegree.set(id, deps.size);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const result: SubTask[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(this.nodes.get(current)!);

      // Reduce in-degree for dependents
      const dependents = this.reverseEdges.get(current) ?? new Set();
      for (const dependent of dependents) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          queue.push(dependent);
        }
      }
    }

    if (result.length !== this.nodes.size) {
      return null; // Cycle detected
    }

    return result;
  }

  /**
   * Get parallel execution batches.
   * Each batch contains tasks that can run concurrently.
   * Batches are ordered by dependency depth.
   */
  getParallelBatches(): SubTask[][] {
    const sorted = this.topologicalSort();
    if (!sorted) return [];

    const depth = new Map<string, number>();
    const batches = new Map<number, SubTask[]>();

    for (const task of sorted) {
      const deps = this.edges.get(task.id) ?? new Set();
      let maxDepDepth = -1;

      for (const depId of deps) {
        const depDepth = depth.get(depId) ?? 0;
        maxDepDepth = Math.max(maxDepDepth, depDepth);
      }

      const taskDepth = maxDepDepth + 1;
      depth.set(task.id, taskDepth);

      if (!batches.has(taskDepth)) {
        batches.set(taskDepth, []);
      }
      batches.get(taskDepth)!.push(task);
    }

    // Return batches in order
    const maxDepth = Math.max(...Array.from(batches.keys()), -1);
    const result: SubTask[][] = [];
    for (let d = 0; d <= maxDepth; d++) {
      if (batches.has(d)) {
        result.push(batches.get(d)!);
      }
    }

    return result;
  }

  private detectCycle(): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string>();

    for (const id of this.nodes.keys()) {
      color.set(id, WHITE);
    }

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) {
        const cycle = this.dfsCycle(id, color, parent);
        if (cycle) return cycle;
      }
    }

    return null;
  }

  private dfsCycle(
    node: string,
    color: Map<string, number>,
    parent: Map<string, string>
  ): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    color.set(node, GRAY);

    // Visit dependents (nodes that depend on us = nodes we point to in reverse)
    const dependents = this.reverseEdges.get(node) ?? new Set();
    for (const dep of dependents) {
      if (color.get(dep) === GRAY) {
        // Found a cycle — reconstruct path
        const cycle = [dep, node];
        let curr = node;
        while (curr !== dep && parent.has(curr)) {
          curr = parent.get(curr)!;
          cycle.push(curr);
        }
        return cycle.reverse();
      }
      if (color.get(dep) === WHITE) {
        parent.set(dep, node);
        const result = this.dfsCycle(dep, color, parent);
        if (result) return result;
      }
    }

    color.set(node, BLACK);
    return null;
  }
}
