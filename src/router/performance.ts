/**
 * Historical performance tracker for model routing.
 * Records task outcomes per model and provides statistics
 * for performance-aware routing decisions.
 */

import type { TokenUsage } from "../types/index.js";

export interface PerformanceRecord {
  modelKey: string;
  taskId: string;
  success: boolean;
  durationMs: number;
  iterations: number;
  tokenUsage: TokenUsage;
  labels?: string[];
  timestamp?: Date;
}

export interface ModelStats {
  totalTasks: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDurationMs: number;
  avgIterations: number;
  avgTokens: number;
  totalCost: number;
  recentSuccessRate: number; // last 10 tasks
}

export class PerformanceTracker {
  private records: PerformanceRecord[] = [];
  private maxRecords = 1000;

  record(entry: PerformanceRecord): void {
    entry.timestamp = entry.timestamp ?? new Date();
    this.records.push(entry);

    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /** Get stats for a specific model. */
  getModelStats(modelKey: string): ModelStats {
    const entries = this.records.filter((r) => r.modelKey === modelKey);
    return this.computeStats(entries);
  }

  /** Get stats for all models. */
  getStats(): Record<string, ModelStats> {
    const modelKeys = new Set(this.records.map((r) => r.modelKey));
    const result: Record<string, ModelStats> = {};

    for (const key of modelKeys) {
      result[key] = this.getModelStats(key);
    }

    return result;
  }

  /** Get the best model for a given label/task type based on historical success rate. */
  getBestModelForLabel(label: string): string | null {
    const byModel = new Map<string, { success: number; total: number }>();

    for (const record of this.records) {
      if (!record.labels?.includes(label)) continue;

      const stats = byModel.get(record.modelKey) ?? { success: 0, total: 0 };
      stats.total++;
      if (record.success) stats.success++;
      byModel.set(record.modelKey, stats);
    }

    let bestKey: string | null = null;
    let bestRate = -1;

    for (const [key, stats] of byModel) {
      if (stats.total < 3) continue; // Need minimum sample size
      const rate = stats.success / stats.total;
      if (rate > bestRate) {
        bestRate = rate;
        bestKey = key;
      }
    }

    return bestKey;
  }

  /** Get recent records for display. */
  getRecent(count = 20): PerformanceRecord[] {
    return this.records.slice(-count);
  }

  private computeStats(entries: PerformanceRecord[]): ModelStats {
    if (entries.length === 0) {
      return {
        totalTasks: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgIterations: 0,
        avgTokens: 0,
        totalCost: 0,
        recentSuccessRate: 0,
      };
    }

    const successes = entries.filter((e) => e.success);
    const totalDuration = entries.reduce((sum, e) => sum + e.durationMs, 0);
    const totalIterations = entries.reduce((sum, e) => sum + e.iterations, 0);
    const totalTokens = entries.reduce(
      (sum, e) => sum + e.tokenUsage.inputTokens + e.tokenUsage.outputTokens,
      0
    );

    const recent = entries.slice(-10);
    const recentSuccesses = recent.filter((e) => e.success);

    return {
      totalTasks: entries.length,
      successCount: successes.length,
      failureCount: entries.length - successes.length,
      successRate: successes.length / entries.length,
      avgDurationMs: totalDuration / entries.length,
      avgIterations: totalIterations / entries.length,
      avgTokens: totalTokens / entries.length,
      totalCost: 0, // Would need cost profiles to calculate
      recentSuccessRate: recent.length > 0 ? recentSuccesses.length / recent.length : 0,
    };
  }
}
