/**
 * Slack integration.
 * Listens for messages in configured channels and converts them to agent tasks.
 * Also posts agent progress updates and completion notifications.
 *
 * Uses Slack Web API (no Socket Mode / Events API server required — poll-based).
 */

import type { AgentTask, AgentSession } from "../types/index.js";

export interface SlackConfig {
  /** Slack Bot OAuth token (xoxb-...). */
  botToken: string;
  /** Channel IDs to watch for task messages. */
  watchChannels: string[];
  /** Trigger prefix — messages starting with this are treated as tasks (default: "!agent"). */
  triggerPrefix?: string;
  /** Whether to post progress updates as thread replies (default: true). */
  postProgress?: boolean;
  /** Base URL for Slack API (default: https://slack.com/api). */
  apiBaseUrl?: string;
}

interface SlackMessage {
  type: string;
  ts: string;
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
}

interface SlackConversationHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  error?: string;
}

export class SlackClient {
  private config: SlackConfig;
  private baseUrl: string;
  private triggerPrefix: string;

  constructor(config: SlackConfig) {
    this.config = config;
    this.baseUrl = config.apiBaseUrl ?? "https://slack.com/api";
    this.triggerPrefix = config.triggerPrefix ?? "!agent";
  }

  /** Fetch recent messages from watched channels that match the trigger. */
  async fetchTaskMessages(since?: string): Promise<AgentTask[]> {
    const tasks: AgentTask[] = [];

    for (const channel of this.config.watchChannels) {
      const messages = await this.getChannelHistory(channel, since);

      for (const msg of messages) {
        if (msg.text.startsWith(this.triggerPrefix)) {
          const taskText = msg.text.slice(this.triggerPrefix.length).trim();
          if (taskText) {
            tasks.push({
              id: `slack_${msg.channel}_${msg.ts}`,
              title: taskText.split("\n")[0].slice(0, 100),
              description: taskText,
              labels: ["slack"],
            });
          }
        }
      }
    }

    return tasks;
  }

  /** Post a message to a channel. */
  async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const response = await this.apiCall("chat.postMessage", body);
    return response.ts as string;
  }

  /** Post an agent status update. */
  async postAgentUpdate(
    channel: string,
    session: AgentSession,
    threadTs?: string
  ): Promise<void> {
    const statusEmoji = {
      running: ":hourglass:",
      completed: ":white_check_mark:",
      failed: ":x:",
      idle: ":clock1:",
      paused: ":pause_button:",
      awaiting_approval: ":question:",
    };

    const emoji = statusEmoji[session.status] ?? ":robot_face:";
    const tokens = session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;

    let text = `${emoji} *${session.task.title}*\n`;
    text += `Status: ${session.status} | Model: ${session.modelName} | `;
    text += `Iterations: ${session.iterations}/${session.maxIterations} | Tokens: ${tokens}`;

    if (session.error) {
      text += `\nError: ${session.error}`;
    }

    await this.postMessage(channel, text, threadTs);
  }

  /** React to a message with an emoji. */
  async addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    await this.apiCall("reactions.add", {
      channel,
      timestamp,
      name: emoji,
    }).catch(() => {
      // Reaction might already exist
    });
  }

  private async getChannelHistory(
    channel: string,
    oldest?: string
  ): Promise<SlackMessage[]> {
    const params: Record<string, unknown> = {
      channel,
      limit: 50,
    };
    if (oldest) params.oldest = oldest;

    const response = await this.apiCall(
      "conversations.history",
      params
    ) as unknown as SlackConversationHistoryResponse;

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }

    return response.messages ?? [];
  }

  private async apiCall(
    method: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.config.botToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Slack API HTTP error (${response.status}): ${errorText}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }
}

/**
 * Slack watcher — polls channels for task-triggering messages.
 */
export class SlackWatcher {
  private client: SlackClient;
  private callback: (task: AgentTask) => void;
  private pollIntervalMs: number;
  private seenMessages: Set<string> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollTs: string | undefined;
  private running = false;

  constructor(
    config: SlackConfig,
    callback: (task: AgentTask) => void,
    pollIntervalMs = 10000
  ) {
    this.client = new SlackClient(config);
    this.callback = callback;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Set initial timestamp to now (don't process old messages)
    this.lastPollTs = String(Date.now() / 1000);

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

  getClient(): SlackClient {
    return this.client;
  }

  private async poll(): Promise<void> {
    try {
      const tasks = await this.client.fetchTaskMessages(this.lastPollTs);
      this.lastPollTs = String(Date.now() / 1000);

      for (const task of tasks) {
        if (!this.seenMessages.has(task.id)) {
          this.seenMessages.add(task.id);
          this.callback(task);
        }
      }
      // Prevent unbounded Set growth — time-based filtering handles dedup
      if (this.seenMessages.size > 10_000) {
        this.seenMessages.clear();
      }
    } catch (error) {
      console.error(
        "Slack poll error:",
        error instanceof Error ? error.message : error
      );
    }
  }
}
