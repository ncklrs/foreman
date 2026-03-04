/**
 * Knowledge Store.
 * Persistent cross-session learning system. Mines completed sessions
 * for patterns, failures, and conventions, then surfaces them as
 * "lessons" that inform future agent prompts.
 *
 * Storage: ~/.foreman/knowledge.json
 *
 * Learning sources:
 * - Completed sessions: what worked, what failed, how many iterations
 * - Autopilot findings: recurring issues, resolution patterns
 * - User corrections: when a human rejects/corrects agent output
 * - Performance data: which models work best for which tasks
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSession, ReviewFinding } from "../types/index.js";
import { generateId } from "../utils/id.js";

export interface Lesson {
  id: string;
  type: "pattern" | "anti_pattern" | "convention" | "preference" | "tool_tip";
  /** Short description of what was learned. */
  summary: string;
  /** Detailed context about the lesson. */
  detail: string;
  /** Source of the lesson. */
  source: "session" | "autopilot" | "user" | "agents_md";
  /** How many times this lesson has been reinforced. */
  reinforcements: number;
  /** Relevance tags for matching to future tasks. */
  tags: string[];
  /** Confidence score (0-1). Higher = more reinforced. */
  confidence: number;
  createdAt: string;
  lastReinforcedAt: string;
}

export interface FailurePattern {
  id: string;
  /** The error message or failure mode. */
  pattern: string;
  /** What was tried. */
  approach: string;
  /** What worked instead (if resolved). */
  resolution?: string;
  /** How many times this failure was observed. */
  occurrences: number;
  /** Associated task labels. */
  labels: string[];
  lastSeenAt: string;
}

export interface KnowledgeBase {
  version: number;
  lessons: Lesson[];
  failurePatterns: FailurePattern[];
  /** Fingerprints of previously seen autopilot findings for dedup. */
  seenFindings: string[];
  /** Model preferences per task type. */
  modelPreferences: Record<string, string>;
  updatedAt: string;
}

function createEmptyKB(): KnowledgeBase {
  return {
    version: 1,
    lessons: [],
    failurePatterns: [],
    seenFindings: [],
    modelPreferences: {},
    updatedAt: new Date().toISOString(),
  };
}

export class KnowledgeStore {
  private filePath: string;
  private kb: KnowledgeBase = createEmptyKB();
  /** In-memory Set for O(1) finding dedup lookups. Synced with kb.seenFindings on load/save. */
  private seenFindingsSet: Set<string> = new Set();
  private dirty = false;

  constructor(dir?: string) {
    const baseDir = dir ?? join(homedir(), ".foreman");
    this.filePath = join(baseDir, "knowledge.json");
  }

  /** Load knowledge base from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.kb = JSON.parse(raw) as KnowledgeBase;
    } catch {
      this.kb = createEmptyKB();
    }
    this.seenFindingsSet = new Set(this.kb.seenFindings);
  }

  /** Persist knowledge base to disk. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    this.kb.updatedAt = new Date().toISOString();
    // Sync Set back to array for serialization
    this.kb.seenFindings = Array.from(this.seenFindingsSet);
    const dir = this.filePath.replace(/\/[^/]+$/, "");
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.kb, null, 2), "utf-8");
    this.dirty = false;
  }

  /**
   * Learn from a completed session.
   * Extracts patterns about what worked, what failed, and tool usage.
   */
  learnFromSession(session: AgentSession): void {
    const labels = session.task.labels ?? [];

    if (session.status === "completed") {
      // Learn success pattern
      const efficiency = session.iterations <= 10 ? "efficient" : "thorough";
      this.addLesson({
        type: "pattern",
        summary: `${efficiency} completion with ${session.modelName}`,
        detail: `Task "${session.task.title}" completed in ${session.iterations} iterations using ${session.modelName}. ` +
          `Tokens: ${session.tokenUsage.inputTokens + session.tokenUsage.outputTokens}.`,
        source: "session",
        tags: [...labels, session.modelName],
      });

      // Track model preference
      for (const label of labels) {
        this.kb.modelPreferences[label] = session.modelName;
        this.dirty = true;
      }
    }

    if (session.status === "failed" && session.error) {
      this.recordFailure({
        pattern: session.error.slice(0, 200),
        approach: `Model: ${session.modelName}, Task: ${session.task.title}`,
        labels,
      });
    }

    // Extract tool usage patterns from conversation
    this.extractToolPatterns(session);
  }

  /**
   * Learn from autopilot findings.
   * Tracks recurring issues and avoids duplicating known findings.
   */
  learnFromFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const novel: ReviewFinding[] = [];

    for (const finding of findings) {
      const fingerprint = this.fingerprintFinding(finding);

      if (this.seenFindingsSet.has(fingerprint)) {
        // Reinforce existing lesson about this pattern
        const existing = this.kb.lessons.find(
          (l) => l.tags.includes(finding.scanner) && l.summary.includes(finding.title.slice(0, 40))
        );
        if (existing) {
          existing.reinforcements++;
          existing.confidence = Math.min(1, existing.confidence + 0.1);
          existing.lastReinforcedAt = new Date().toISOString();
          this.dirty = true;
        }
      } else {
        this.seenFindingsSet.add(fingerprint);
        // Cap the seen set
        if (this.seenFindingsSet.size > 500) {
          const iter = this.seenFindingsSet.values();
          for (let i = 0; i < this.seenFindingsSet.size - 500; i++) {
            this.seenFindingsSet.delete(iter.next().value!);
          }
        }
        novel.push(finding);
        this.dirty = true;
      }
    }

    return novel;
  }

  /**
   * Record a user correction or preference.
   */
  learnFromUser(summary: string, detail: string, tags: string[] = []): void {
    this.addLesson({
      type: "preference",
      summary,
      detail,
      source: "user",
      tags,
    });
  }

  /**
   * Record a failure pattern with optional resolution.
   */
  recordFailure(opts: {
    pattern: string;
    approach: string;
    resolution?: string;
    labels?: string[];
  }): void {
    const existing = this.kb.failurePatterns.find(
      (f) => f.pattern === opts.pattern
    );

    if (existing) {
      existing.occurrences++;
      existing.lastSeenAt = new Date().toISOString();
      if (opts.resolution) existing.resolution = opts.resolution;
    } else {
      this.kb.failurePatterns.push({
        id: generateId("fail"),
        pattern: opts.pattern,
        approach: opts.approach,
        resolution: opts.resolution,
        occurrences: 1,
        labels: opts.labels ?? [],
        lastSeenAt: new Date().toISOString(),
      });
    }

    // Cap failure patterns
    if (this.kb.failurePatterns.length > 200) {
      this.kb.failurePatterns = this.kb.failurePatterns.slice(-200);
    }

    this.dirty = true;
  }

  /**
   * Get relevant lessons for a given task.
   * Matches by tags/labels and returns sorted by confidence.
   */
  getLessonsForTask(labels: string[], limit = 10): Lesson[] {
    if (this.kb.lessons.length === 0) return [];

    const scored = this.kb.lessons.map((lesson) => {
      let score = lesson.confidence;
      // Boost for matching tags
      for (const tag of labels) {
        if (lesson.tags.includes(tag)) score += 0.3;
      }
      // Boost for high reinforcement
      score += Math.min(0.3, lesson.reinforcements * 0.05);
      return { lesson, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.lesson);
  }

  /**
   * Get failure patterns relevant to a task.
   */
  getFailuresForTask(labels: string[], limit = 5): FailurePattern[] {
    const relevant = this.kb.failurePatterns.filter(
      (f) => f.labels.some((l) => labels.includes(l)) || f.occurrences >= 3
    );

    return relevant
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, limit);
  }

  /**
   * Get preferred model for a task label.
   */
  getPreferredModel(label: string): string | undefined {
    return this.kb.modelPreferences[label];
  }

  /**
   * Build a "lessons learned" section for the system prompt.
   */
  buildPromptSection(labels: string[]): string {
    const lessons = this.getLessonsForTask(labels, 8);
    const failures = this.getFailuresForTask(labels, 3);

    if (lessons.length === 0 && failures.length === 0) return "";

    const parts: string[] = ["## Lessons from Previous Sessions\n"];

    if (lessons.length > 0) {
      parts.push("### What works well:");
      for (const lesson of lessons.filter((l) => l.type === "pattern" || l.type === "convention")) {
        parts.push(`- ${lesson.summary}`);
      }

      const prefs = lessons.filter((l) => l.type === "preference");
      if (prefs.length > 0) {
        parts.push("\n### Project preferences:");
        for (const pref of prefs) {
          parts.push(`- ${pref.summary}: ${pref.detail}`);
        }
      }

      const tips = lessons.filter((l) => l.type === "tool_tip");
      if (tips.length > 0) {
        parts.push("\n### Tool tips:");
        for (const tip of tips) {
          parts.push(`- ${tip.summary}`);
        }
      }
    }

    if (failures.length > 0) {
      parts.push("\n### Known failure patterns (avoid these):");
      for (const failure of failures) {
        const resolution = failure.resolution ? ` → Fix: ${failure.resolution}` : "";
        parts.push(`- ${failure.pattern} (seen ${failure.occurrences}x)${resolution}`);
      }
    }

    return parts.join("\n");
  }

  /** Check if a finding has been seen before. */
  isKnownFinding(finding: ReviewFinding): boolean {
    return this.seenFindingsSet.has(this.fingerprintFinding(finding));
  }

  /** Get the full knowledge base (for inspection/debugging). */
  getKnowledgeBase(): Readonly<KnowledgeBase> {
    return this.kb;
  }

  private addLesson(opts: {
    type: Lesson["type"];
    summary: string;
    detail: string;
    source: Lesson["source"];
    tags: string[];
  }): void {
    // Check for existing similar lesson
    const existing = this.kb.lessons.find(
      (l) => l.type === opts.type && l.summary === opts.summary
    );

    if (existing) {
      existing.reinforcements++;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.lastReinforcedAt = new Date().toISOString();
    } else {
      this.kb.lessons.push({
        id: generateId("lesson"),
        type: opts.type,
        summary: opts.summary,
        detail: opts.detail,
        source: opts.source,
        reinforcements: 1,
        tags: opts.tags,
        confidence: 0.5,
        createdAt: new Date().toISOString(),
        lastReinforcedAt: new Date().toISOString(),
      });
    }

    // Cap lessons
    if (this.kb.lessons.length > 200) {
      // Keep highest confidence lessons
      this.kb.lessons.sort((a, b) => b.confidence - a.confidence);
      this.kb.lessons = this.kb.lessons.slice(0, 200);
    }

    this.dirty = true;
  }

  private extractToolPatterns(session: AgentSession): void {
    const toolCalls = new Map<string, number>();

    for (const msg of session.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolCalls.set(block.name, (toolCalls.get(block.name) ?? 0) + 1);
          }
        }
      }
    }

    // Note tools that were used excessively (potential loop/inefficiency)
    for (const [tool, count] of toolCalls) {
      if (count > 15) {
        this.addLesson({
          type: "tool_tip",
          summary: `Tool "${tool}" used ${count}x in one session — consider reducing calls`,
          detail: `In task "${session.task.title}", the tool "${tool}" was called ${count} times. ` +
            `This may indicate an inefficient approach.`,
          source: "session",
          tags: session.task.labels ?? [],
        });
      }
    }
  }

  private fingerprintFinding(finding: ReviewFinding): string {
    return `${finding.scanner}:${finding.filePath ?? ""}:${finding.title.slice(0, 50).toLowerCase()}`;
  }
}
