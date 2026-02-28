/**
 * Autopilot Engine.
 * The self-driving codebase pipeline:
 *   1. Cron triggers a review run
 *   2. LLM-powered scanners analyze the codebase
 *   3. Findings are converted to tickets (GitHub/Linear)
 *   4. Optionally, agents auto-resolve the tickets
 *
 * This is the "background agent" — it runs on a schedule without
 * any developer at the keyboard.
 */

import type {
  AutopilotConfig,
  AutopilotRun,
  ForemanConfig,
  ForemanEvent,
  ReviewFinding,
} from "../types/index.js";
import type { ModelProvider } from "../providers/base.js";
import { ProviderRegistry } from "../providers/registry.js";
import { CodebaseReviewer } from "./reviewer.js";
import { AutopilotScheduler } from "./scheduler.js";
import { TicketCreator } from "./tickets.js";
import { GitHubClient } from "../integrations/github.js";
import { LinearClient } from "../linear/client.js";
import { EventBus } from "../events/bus.js";
import { Logger } from "../logging/logger.js";

interface AutopilotEngineOptions {
  config: ForemanConfig;
  autopilotConfig: AutopilotConfig;
  registry: ProviderRegistry;
  eventBus: EventBus;
  logger: Logger;
  githubClient?: GitHubClient | null;
  linearClient?: LinearClient | null;
  /** Callback to enqueue tasks for resolution. */
  onEnqueueTask?: (task: { id: string; title: string; description: string; labels?: string[]; branch?: string }) => void;
}

export class AutopilotEngine {
  private config: ForemanConfig;
  private autopilotConfig: AutopilotConfig;
  private registry: ProviderRegistry;
  private scheduler: AutopilotScheduler;
  private reviewer: CodebaseReviewer;
  private ticketCreator: TicketCreator;
  private eventBus: EventBus;
  private logger: Logger;
  private onEnqueueTask?: AutopilotEngineOptions["onEnqueueTask"];

  private runs: AutopilotRun[] = [];
  private activeRun: AutopilotRun | null = null;

  constructor(options: AutopilotEngineOptions) {
    this.config = options.config;
    this.autopilotConfig = options.autopilotConfig;
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.logger = options.logger.child("autopilot");
    this.onEnqueueTask = options.onEnqueueTask;

    const workingDir = options.autopilotConfig.workingDir ?? process.cwd();
    this.reviewer = new CodebaseReviewer(workingDir);
    this.scheduler = new AutopilotScheduler();
    this.ticketCreator = new TicketCreator(
      options.autopilotConfig,
      options.githubClient,
      options.linearClient
    );
  }

  /** Initialize and start the scheduled autopilot. */
  start(): void {
    this.scheduler.addSchedule(
      "autopilot-review",
      this.autopilotConfig.schedule,
      async () => { await this.executeRun(); },
      this.autopilotConfig.timezone
    );

    this.scheduler.start();
    this.logger.info("Autopilot started", {
      schedule: this.autopilotConfig.schedule,
      scanners: this.autopilotConfig.scanners,
      autoResolve: this.autopilotConfig.autoResolve,
    });
  }

  /** Stop the autopilot scheduler. */
  stop(): void {
    this.scheduler.stop();
    this.logger.info("Autopilot stopped");
  }

  /** Trigger a run immediately (outside of schedule). */
  async triggerRun(): Promise<AutopilotRun> {
    return this.executeRun();
  }

  /** Get history of all autopilot runs. */
  getRuns(): AutopilotRun[] {
    return [...this.runs];
  }

  /** Get the currently active run, if any. */
  getActiveRun(): AutopilotRun | null {
    return this.activeRun;
  }

  /** Get the scheduler for inspection. */
  getScheduler(): AutopilotScheduler {
    return this.scheduler;
  }

  /** Execute the full autopilot pipeline. */
  private async executeRun(): Promise<AutopilotRun> {
    if (this.activeRun) {
      this.logger.warn("Skipping autopilot run — previous run still active");
      return this.activeRun;
    }

    const run: AutopilotRun = {
      id: `autopilot_${Date.now()}`,
      startedAt: new Date(),
      status: "scanning",
      findings: [],
      ticketsCreated: [],
      ticketsResolved: [],
    };

    this.activeRun = run;
    this.runs.push(run);
    this.eventBus.emit({ type: "autopilot:run_started", run });
    this.logger.info("Autopilot run started", { runId: run.id });

    try {
      // Phase 1: Scan the codebase
      const reviewProvider = this.selectReviewProvider();
      if (!reviewProvider) {
        throw new Error("No model provider available for code review");
      }

      run.status = "scanning";
      const findings = await this.reviewer.review(
        reviewProvider,
        this.autopilotConfig.scanners,
        this.config
      );

      // Filter by minimum severity
      run.findings = findings.filter(
        (f) => f.severity >= this.autopilotConfig.minSeverity
      );

      this.eventBus.emit({
        type: "autopilot:scan_complete",
        run,
        findingsCount: run.findings.length,
      });
      this.logger.info("Scan complete", {
        total: findings.length,
        eligible: run.findings.length,
        scanners: this.autopilotConfig.scanners,
      });

      if (run.findings.length === 0) {
        run.status = "completed";
        run.completedAt = new Date();
        this.eventBus.emit({ type: "autopilot:run_completed", run });
        this.activeRun = null;
        return run;
      }

      // Phase 2: Create tickets
      run.status = "creating_tickets";
      const existingTitles = await this.ticketCreator.fetchExistingTitles();
      const ticketResults = await this.ticketCreator.createTickets(
        run.findings,
        existingTitles
      );

      for (const result of ticketResults) {
        if (!result.skipped) {
          run.ticketsCreated.push(result.ticketId);
          const finding = run.findings.find((f) => f.id === result.findingId);
          if (finding) {
            this.eventBus.emit({
              type: "autopilot:ticket_created",
              run,
              finding,
              ticketId: result.ticketId,
            });
          }
        }
      }

      this.logger.info("Tickets created", {
        created: run.ticketsCreated.length,
        skipped: ticketResults.filter((r) => r.skipped).length,
      });

      // Phase 3: Auto-resolve (if enabled)
      if (this.autopilotConfig.autoResolve && this.onEnqueueTask) {
        run.status = "resolving";

        const resolvable = run.findings
          .filter((f) => f.effort === "trivial" || f.effort === "small")
          .slice(0, this.autopilotConfig.maxConcurrentResolves);

        for (const finding of resolvable) {
          this.eventBus.emit({
            type: "autopilot:resolve_started",
            run,
            finding,
          });

          const branchName = `${this.autopilotConfig.branchPrefix}${finding.scanner}-${finding.id.slice(-6)}`;

          this.onEnqueueTask({
            id: `resolve_${finding.id}`,
            title: `[autopilot] ${finding.title}`,
            description: this.buildResolvePrompt(finding),
            labels: ["autopilot", finding.scanner],
            branch: branchName,
          });

          run.ticketsResolved.push(finding.id);

          this.eventBus.emit({
            type: "autopilot:resolve_completed",
            run,
            finding,
            success: true,
          });
        }

        this.logger.info("Auto-resolve tasks enqueued", {
          count: resolvable.length,
        });
      }

      run.status = "completed";
      run.completedAt = new Date();
      this.eventBus.emit({ type: "autopilot:run_completed", run });

      this.logger.info("Autopilot run completed", {
        runId: run.id,
        findings: run.findings.length,
        ticketsCreated: run.ticketsCreated.length,
        ticketsResolved: run.ticketsResolved.length,
        durationMs: Date.now() - run.startedAt.getTime(),
      });
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date();

      this.logger.error("Autopilot run failed", { error: run.error });
    } finally {
      this.activeRun = null;
    }

    return run;
  }

  /** Select the best provider for code review (prefer architect, then coder). */
  private selectReviewProvider(): ModelProvider | null {
    return (
      this.registry.get("architect") ??
      this.registry.get("coder") ??
      this.registry.get("fast") ??
      null
    );
  }

  /** Build a targeted prompt for auto-resolving a finding. */
  private buildResolvePrompt(finding: ReviewFinding): string {
    const parts: string[] = [];

    parts.push(
      `You are resolving an automatically detected issue in the codebase.`
    );
    parts.push(`\n## Issue\n\n**${finding.title}**\n\n${finding.description}`);

    if (finding.filePath) {
      const loc = finding.lineNumber
        ? `${finding.filePath}:${finding.lineNumber}`
        : finding.filePath;
      parts.push(`\n## Location\n\n\`${loc}\``);
    }

    parts.push(`\n## Suggested Fix\n\n${finding.suggestion}`);

    parts.push(`\n## Instructions\n
1. Read the relevant file(s) to understand the current code
2. Apply the suggested fix (or a better one if you see a more appropriate solution)
3. Run tests to verify the fix doesn't break anything
4. Commit the change with a clear message prefixed with the scanner type: "${finding.scanner}: ${finding.title}"
5. Call task_done with a summary of what you changed`);

    return parts.join("\n");
  }
}
