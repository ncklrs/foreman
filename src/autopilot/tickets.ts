/**
 * Ticket Creator.
 * Creates GitHub issues or Linear tickets from autopilot review findings.
 * Deduplicates against existing open issues to avoid creating duplicates.
 */

import type { ReviewFinding, AutopilotConfig } from "../types/index.js";
import type { GitHubClient } from "../integrations/github.js";
import type { LinearClient } from "../linear/client.js";

export interface TicketResult {
  findingId: string;
  ticketId: string;
  url?: string;
  skipped: boolean;
  reason?: string;
}

interface GitHubIssueCreateResponse {
  id: number;
  number: number;
  html_url: string;
}

const SEVERITY_LABELS: Record<number, string> = {
  1: "priority: low",
  2: "priority: low",
  3: "priority: medium",
  4: "priority: high",
  5: "priority: critical",
};

const EFFORT_LABELS: Record<string, string> = {
  trivial: "effort: trivial",
  small: "effort: small",
  medium: "effort: medium",
  large: "effort: large",
};

export class TicketCreator {
  private githubClient: GitHubClient | null;
  private linearClient: LinearClient | null;
  private config: AutopilotConfig;

  constructor(
    config: AutopilotConfig,
    githubClient?: GitHubClient | null,
    linearClient?: LinearClient | null
  ) {
    this.config = config;
    this.githubClient = githubClient ?? null;
    this.linearClient = linearClient ?? null;
  }

  /**
   * Create tickets from a set of findings.
   * Filters by minimum severity, deduplicates, and respects maxTicketsPerRun.
   */
  async createTickets(
    findings: ReviewFinding[],
    existingTitles?: Set<string>
  ): Promise<TicketResult[]> {
    // Filter by severity threshold
    const eligible = findings.filter(
      (f) => f.severity >= this.config.minSeverity
    );

    // Sort by severity (highest first), then effort (trivial first)
    const effortOrder = { trivial: 0, small: 1, medium: 2, large: 3 };
    const sorted = eligible.sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      return effortOrder[a.effort] - effortOrder[b.effort];
    });

    // Limit to max tickets per run
    const toCreate = sorted.slice(0, this.config.maxTicketsPerRun);

    const results: TicketResult[] = [];
    const known = existingTitles ?? new Set<string>();

    for (const finding of toCreate) {
      const title = this.formatTitle(finding);

      // Skip if a ticket with similar title already exists
      if (this.isDuplicate(title, known)) {
        results.push({
          findingId: finding.id,
          ticketId: "",
          skipped: true,
          reason: "Duplicate — similar issue already exists",
        });
        continue;
      }

      try {
        const result = await this.createTicket(finding, title);
        known.add(title.toLowerCase());
        results.push(result);
      } catch (error) {
        results.push({
          findingId: finding.id,
          ticketId: "",
          skipped: true,
          reason: `Creation failed: ${error instanceof Error ? error.message : error}`,
        });
      }
    }

    return results;
  }

  /** Fetch existing open issue titles for deduplication. */
  async fetchExistingTitles(): Promise<Set<string>> {
    const titles = new Set<string>();

    if (this.config.ticketTarget === "github" && this.githubClient) {
      try {
        const issues = await this.githubClient.fetchReadyIssues();
        for (const issue of issues) {
          titles.add(issue.title.toLowerCase());
        }
      } catch {
        // If we can't fetch, proceed without dedup
      }
    }

    if (this.config.ticketTarget === "linear" && this.linearClient) {
      try {
        const tickets = await this.linearClient.fetchReadyTickets();
        for (const ticket of tickets) {
          titles.add(ticket.title.toLowerCase());
        }
      } catch {
        // Continue without dedup
      }
    }

    return titles;
  }

  private async createTicket(
    finding: ReviewFinding,
    title: string
  ): Promise<TicketResult> {
    const body = this.formatBody(finding);

    if (this.config.ticketTarget === "github" && this.githubClient) {
      return this.createGitHubIssue(finding, title, body);
    }

    if (this.config.ticketTarget === "linear" && this.linearClient) {
      return this.createLinearTicket(finding, title, body);
    }

    return {
      findingId: finding.id,
      ticketId: "",
      skipped: true,
      reason: `No ${this.config.ticketTarget} client configured`,
    };
  }

  private async createGitHubIssue(
    finding: ReviewFinding,
    title: string,
    body: string
  ): Promise<TicketResult> {
    // Use the GitHub API to create an issue
    // The GitHubClient doesn't have createIssue yet, so we use the raw request
    const client = this.githubClient!;
    const labels = [
      ...this.config.ticketLabels,
      `scanner: ${finding.scanner}`,
      SEVERITY_LABELS[finding.severity] ?? "priority: medium",
      EFFORT_LABELS[finding.effort] ?? "effort: small",
    ];

    // Create via addComment on a new issue — we need to extend the API
    // For now, use the createIssue method we'll add
    const result = await (client as GitHubClientWithCreate).createIssue(
      title,
      body,
      labels
    );

    return {
      findingId: finding.id,
      ticketId: `gh_${result.number}`,
      url: result.html_url,
      skipped: false,
    };
  }

  private async createLinearTicket(
    finding: ReviewFinding,
    title: string,
    body: string
  ): Promise<TicketResult> {
    const client = this.linearClient!;

    const ticketId = await (client as LinearClientWithCreate).createIssue(
      title,
      body,
      this.config.ticketLabels,
      this.effortToEstimate(finding.effort)
    );

    return {
      findingId: finding.id,
      ticketId,
      skipped: false,
    };
  }

  private formatTitle(finding: ReviewFinding): string {
    const prefix = `[${finding.scanner}]`;
    return `${prefix} ${finding.title}`;
  }

  private formatBody(finding: ReviewFinding): string {
    const parts: string[] = [];

    parts.push(`## Description\n\n${finding.description}`);

    if (finding.filePath) {
      const loc = finding.lineNumber
        ? `${finding.filePath}:${finding.lineNumber}`
        : finding.filePath;
      parts.push(`## Location\n\n\`${loc}\``);
    }

    parts.push(`## Suggested Fix\n\n${finding.suggestion}`);

    parts.push(`## Metadata\n\n| Field | Value |\n|---|---|\n| Scanner | ${finding.scanner} |\n| Severity | ${finding.severity}/5 |\n| Effort | ${finding.effort} |\n| Tags | ${finding.tags.join(", ") || "none"} |`);

    parts.push(`\n---\n*Created automatically by Foreman Autopilot*`);

    return parts.join("\n\n");
  }

  private isDuplicate(title: string, existing: Set<string>): boolean {
    const normalized = title.toLowerCase();
    for (const existing_title of existing) {
      // Exact match or high similarity
      if (existing_title === normalized) return true;
      // Check if the core title (without prefix) matches
      const coreNew = normalized.replace(/^\[[\w_]+\]\s*/, "");
      const coreExisting = existing_title.replace(/^\[[\w_]+\]\s*/, "").replace(/^#\d+:\s*/, "");
      if (coreNew === coreExisting) return true;
    }
    return false;
  }

  private effortToEstimate(effort: ReviewFinding["effort"]): number {
    switch (effort) {
      case "trivial": return 1;
      case "small": return 2;
      case "medium": return 5;
      case "large": return 8;
    }
  }
}

/** Extended GitHubClient interface with createIssue. */
interface GitHubClientWithCreate {
  createIssue(
    title: string,
    body: string,
    labels: string[]
  ): Promise<GitHubIssueCreateResponse>;
}

/** Extended LinearClient interface with createIssue. */
interface LinearClientWithCreate {
  createIssue(
    title: string,
    body: string,
    labels: string[],
    estimate?: number
  ): Promise<string>;
}
