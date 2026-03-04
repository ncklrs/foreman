/**
 * GitHub Issues integration.
 * Watches for issues matching configured criteria and converts them to agent tasks.
 * Uses the GitHub REST API.
 */

import type { AgentTask } from "../types/index.js";

export interface GitHubConfig {
  /** GitHub personal access token or app token. */
  token: string;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Labels to filter issues (issues must have ALL of these labels). */
  watchLabels: string[];
  /** Only watch issues with this state (default: "open"). */
  watchState?: "open" | "closed" | "all";
  /** Base URL for GitHub API (default: https://api.github.com). */
  apiBaseUrl?: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  html_url: string;
  repository_url: string;
}

export class GitHubClient {
  private config: GitHubConfig;
  private baseUrl: string;

  constructor(config: GitHubConfig) {
    this.config = config;
    this.baseUrl = config.apiBaseUrl ?? "https://api.github.com";
  }

  /** Fetch issues matching watch criteria. */
  async fetchReadyIssues(): Promise<AgentTask[]> {
    const labels = this.config.watchLabels.join(",");
    const state = this.config.watchState ?? "open";

    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues?labels=${encodeURIComponent(labels)}&state=${state}&per_page=20&sort=created&direction=asc`;

    const response = await this.request(url);
    const issues = (await response.json()) as GitHubIssue[];

    // Filter out pull requests (GitHub API returns PRs as issues too)
    return issues
      .filter((issue) => !("pull_request" in issue))
      .map((issue) => this.issueToTask(issue));
  }

  /** Add a comment to an issue. */
  async addComment(issueNumber: number, body: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments`;

    await this.request(url, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  /** Update issue labels. */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels`;

    await this.request(url, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  /** Remove a label from an issue. */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;

    await this.request(url, { method: "DELETE" }).catch(() => {
      // Label might not exist — that's fine
    });
  }

  /** Close an issue. */
  async closeIssue(issueNumber: number): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}`;

    await this.request(url, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  /** Link a PR to an issue via comment. */
  async linkPR(issueNumber: number, prUrl: string): Promise<void> {
    await this.addComment(
      issueNumber,
      `Pull request created by Foreman agent: ${prUrl}`
    );
  }

  /** Create a new issue. */
  async createIssue(
    title: string,
    body: string,
    labels: string[] = []
  ): Promise<{ id: number; number: number; html_url: string }> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/issues`;

    const response = await this.request(url, {
      method: "POST",
      body: JSON.stringify({ title, body, labels }),
    });

    return (await response.json()) as { id: number; number: number; html_url: string };
  }

  private issueToTask(issue: GitHubIssue): AgentTask {
    return {
      id: `gh_${issue.id}`,
      title: `#${issue.number}: ${issue.title}`,
      description: issue.body ?? issue.title,
      repository: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
      labels: issue.labels.map((l) => l.name),
    };
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${errorText}`);
    }

    return response;
  }
}

/**
 * GitHub Issues watcher — polls for new issues matching criteria.
 */
export class GitHubWatcher {
  private client: GitHubClient;
  private callback: (task: AgentTask) => void;
  private pollIntervalMs: number;
  private seenIssues: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config: GitHubConfig,
    callback: (task: AgentTask) => void,
    pollIntervalMs = 30000
  ) {
    this.client = new GitHubClient(config);
    this.callback = callback;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.poll().catch(console.error);

    this.timer = setInterval(() => {
      this.poll().catch(console.error);
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getClient(): GitHubClient {
    return this.client;
  }

  private async poll(): Promise<void> {
    try {
      const tasks = await this.client.fetchReadyIssues();
      for (const task of tasks) {
        if (!this.seenIssues.has(task.id)) {
          this.seenIssues.add(task.id);
          this.callback(task);
        }
      }
      // Prevent unbounded Set growth
      if (this.seenIssues.size > 10_000) {
        this.seenIssues.clear();
      }
    } catch (error) {
      console.error(
        "GitHub poll error:",
        error instanceof Error ? error.message : error
      );
    }
  }
}
