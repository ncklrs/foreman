/**
 * Linear integration client.
 * Watches for tickets matching configured criteria,
 * updates ticket status, and links PRs.
 */

import type { AgentTask, LinearConfig } from "../types/index.js";

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  estimate?: number;
  url: string;
  branchName: string;
}

interface LinearIssuesResponse {
  data: {
    issues: {
      nodes: LinearIssue[];
    };
  };
}

interface LinearStateResponse {
  data: {
    workflowStates: {
      nodes: Array<{ id: string; name: string }>;
    };
  };
}

export class LinearClient {
  private apiKey: string;
  private config: LinearConfig;
  private baseUrl = "https://api.linear.app/graphql";
  private stateCache: Map<string, string> = new Map(); // name -> id

  constructor(config: LinearConfig) {
    this.apiKey = config.apiKey;
    this.config = config;
  }

  /** Fetch tickets matching watch criteria. */
  async fetchReadyTickets(): Promise<AgentTask[]> {
    const labelFilter = this.config.watchLabels.length > 0
      ? `labels: { name: { in: [${this.config.watchLabels.map((l) => `"${l}"`).join(", ")}] } }`
      : "";

    const query = `
      query {
        issues(
          filter: {
            team: { key: { eq: "${this.config.team}" } }
            state: { name: { eq: "${this.config.watchStatus}" } }
            ${labelFilter}
          }
          first: 20
          orderBy: createdAt
        ) {
          nodes {
            id
            identifier
            title
            description
            state { name }
            labels { nodes { name } }
            estimate
            url
            branchName
          }
        }
      }
    `;

    const response = await this.graphql<LinearIssuesResponse>(query);
    const issues = response.data.issues.nodes;

    return issues.map((issue) => ({
      id: issue.id,
      title: `${issue.identifier}: ${issue.title}`,
      description: issue.description || issue.title,
      branch: issue.branchName,
      labels: issue.labels.nodes.map((l) => l.name),
      estimate: issue.estimate,
      linearTicketId: issue.id,
    }));
  }

  /** Update ticket status (e.g., "In Progress", "In Review", "Done"). */
  async updateStatus(issueId: string, statusName: string): Promise<void> {
    const stateId = await this.resolveStateId(statusName);
    if (!stateId) {
      console.warn(`Could not resolve workflow state: ${statusName}`);
      return;
    }

    const mutation = `
      mutation {
        issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) {
          success
        }
      }
    `;

    await this.graphql(mutation);
  }

  /** Add a comment to a ticket. */
  async addComment(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation {
        commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(body)} }) {
          success
        }
      }
    `;

    await this.graphql(mutation);
  }

  /** Attach a PR URL to a ticket via comment. */
  async attachPR(issueId: string, prUrl: string): Promise<void> {
    await this.addComment(
      issueId,
      `Pull request created by Foreman agent: ${prUrl}`
    );
  }

  private async resolveStateId(name: string): Promise<string | null> {
    if (this.stateCache.has(name)) {
      return this.stateCache.get(name)!;
    }

    const query = `
      query {
        workflowStates(
          filter: { team: { key: { eq: "${this.config.team}" } } }
        ) {
          nodes { id name }
        }
      }
    `;

    const response = await this.graphql<LinearStateResponse>(query);
    for (const state of response.data.workflowStates.nodes) {
      this.stateCache.set(state.name, state.id);
    }

    return this.stateCache.get(name) ?? null;
  }

  private async graphql<T = unknown>(query: string): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Linear API error (${response.status}): ${errorText}`);
    }

    return (await response.json()) as T;
  }
}
