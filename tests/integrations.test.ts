import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentTask } from "../src/types/index.js";

/**
 * Integration watcher tests.
 * Tests the GitHub, Slack, and Linear watchers using mock fetch.
 */

// --- GitHub Watcher Tests ---

describe("GitHubClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fetch issues and convert to tasks", async () => {
    const mockIssues = [
      {
        id: 100,
        number: 42,
        title: "Fix login bug",
        body: "The login form crashes on submit",
        state: "open",
        labels: [{ name: "agent-ready" }],
        assignee: null,
        html_url: "https://github.com/test/repo/issues/42",
        repository_url: "https://api.github.com/repos/test/repo",
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIssues),
      text: () => Promise.resolve(""),
    });

    const { GitHubClient } = await import("../src/integrations/github.js");
    const client = new GitHubClient({
      token: "test-token",
      owner: "test",
      repo: "repo",
      watchLabels: ["agent-ready"],
    });

    const tasks = await client.fetchReadyIssues();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("gh_100");
    expect(tasks[0].title).toBe("#42: Fix login bug");
    expect(tasks[0].description).toBe("The login form crashes on submit");
    expect(tasks[0].labels).toEqual(["agent-ready"]);
  });

  it("should add a comment to an issue", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });

    const { GitHubClient } = await import("../src/integrations/github.js");
    const client = new GitHubClient({
      token: "test-token",
      owner: "test",
      repo: "repo",
      watchLabels: [],
    });

    await client.addComment(42, "Agent completed the task");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/issues/42/comments"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("should add labels to an issue", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });

    const { GitHubClient } = await import("../src/integrations/github.js");
    const client = new GitHubClient({
      token: "test-token",
      owner: "test",
      repo: "repo",
      watchLabels: [],
    });

    await client.addLabels(42, ["agent-completed"]);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/issues/42/labels"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("should throw on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not Found"),
    });

    const { GitHubClient } = await import("../src/integrations/github.js");
    const client = new GitHubClient({
      token: "test-token",
      owner: "test",
      repo: "repo",
      watchLabels: [],
    });

    await expect(client.fetchReadyIssues()).rejects.toThrow("GitHub API error (404)");
  });
});

describe("GitHubWatcher", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should poll and emit new tasks via callback", async () => {
    const mockIssues = [
      {
        id: 200,
        number: 10,
        title: "Add dark mode",
        body: "Add dark mode support",
        state: "open",
        labels: [{ name: "agent-ready" }],
        assignee: null,
        html_url: "https://github.com/test/repo/issues/10",
        repository_url: "https://api.github.com/repos/test/repo",
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockIssues),
      text: () => Promise.resolve(""),
    });

    const { GitHubWatcher } = await import("../src/integrations/github.js");

    const receivedTasks: AgentTask[] = [];
    const watcher = new GitHubWatcher(
      { token: "test", owner: "t", repo: "r", watchLabels: ["agent-ready"] },
      (task) => receivedTasks.push(task),
      60000, // long interval — we'll poll manually
    );

    watcher.start();
    // Wait for initial poll
    await new Promise((resolve) => setTimeout(resolve, 100));
    watcher.stop();

    expect(receivedTasks.length).toBe(1);
    expect(receivedTasks[0].title).toBe("#10: Add dark mode");
  });

  it("should not emit duplicate tasks", async () => {
    const mockIssues = [
      {
        id: 300,
        number: 5,
        title: "Fix bug",
        body: "desc",
        state: "open",
        labels: [{ name: "agent" }],
        assignee: null,
        html_url: "https://github.com/test/repo/issues/5",
        repository_url: "https://api.github.com/repos/test/repo",
      },
    ];

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockIssues),
        text: () => Promise.resolve(""),
      });
    });

    const { GitHubWatcher } = await import("../src/integrations/github.js");

    const receivedTasks: AgentTask[] = [];
    const watcher = new GitHubWatcher(
      { token: "test", owner: "t", repo: "r", watchLabels: ["agent"] },
      (task) => receivedTasks.push(task),
      50, // short interval for testing
    );

    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    watcher.stop();

    // Should have called fetch multiple times but only emitted the task once
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(receivedTasks.length).toBe(1);
  });
});

// --- Slack Client Tests ---

describe("SlackClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fetch task messages matching trigger prefix", async () => {
    const mockHistory = {
      ok: true,
      messages: [
        { type: "message", ts: "1234.5678", channel: "C123", user: "U1", text: "!agent Fix the login page" },
        { type: "message", ts: "1234.5679", channel: "C123", user: "U2", text: "random message" },
      ],
      has_more: false,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockHistory),
      text: () => Promise.resolve(""),
    });

    const { SlackClient } = await import("../src/integrations/slack.js");
    const client = new SlackClient({
      botToken: "xoxb-test",
      watchChannels: ["C123"],
    });

    const tasks = await client.fetchTaskMessages();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Fix the login page");
    expect(tasks[0].id).toBe("slack_C123_1234.5678");
  });

  it("should post a message to a channel", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, ts: "1234.9999" }),
      text: () => Promise.resolve(""),
    });

    const { SlackClient } = await import("../src/integrations/slack.js");
    const client = new SlackClient({
      botToken: "xoxb-test",
      watchChannels: [],
    });

    const ts = await client.postMessage("C123", "Hello from Foreman");
    expect(ts).toBe("1234.9999");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("chat.postMessage"),
      expect.any(Object),
    );
  });

  it("should support custom trigger prefix", async () => {
    const mockHistory = {
      ok: true,
      messages: [
        { type: "message", ts: "1.1", channel: "C1", user: "U1", text: "/code Fix the auth" },
        { type: "message", ts: "1.2", channel: "C1", user: "U1", text: "!agent this won't match" },
      ],
      has_more: false,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockHistory),
      text: () => Promise.resolve(""),
    });

    const { SlackClient } = await import("../src/integrations/slack.js");
    const client = new SlackClient({
      botToken: "xoxb-test",
      watchChannels: ["C1"],
      triggerPrefix: "/code",
    });

    const tasks = await client.fetchTaskMessages();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe("Fix the auth");
  });
});

// --- Linear Client Tests ---

describe("LinearClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fetch tickets and convert to tasks", async () => {
    const mockResponse = {
      data: {
        issues: {
          nodes: [
            {
              id: "lin-1",
              identifier: "ENG-123",
              title: "Add search feature",
              description: "Implement full-text search",
              state: { name: "Ready" },
              labels: { nodes: [{ name: "feature" }] },
              estimate: 3,
              url: "https://linear.app/team/issue/ENG-123",
              branchName: "eng-123-add-search",
            },
          ],
        },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
      text: () => Promise.resolve(""),
    });

    const { LinearClient } = await import("../src/linear/client.js");
    const client = new LinearClient({
      apiKey: "lin_test_key",
      team: "ENG",
      watchLabels: ["feature"],
      watchStatus: "Ready",
    });

    const tasks = await client.fetchReadyTickets();
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("lin-1");
    expect(tasks[0].title).toBe("ENG-123: Add search feature");
    expect(tasks[0].branch).toBe("eng-123-add-search");
    expect(tasks[0].labels).toEqual(["feature"]);
  });

  it("should update ticket status", async () => {
    // First call returns workflow states, second updates the issue
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              workflowStates: {
                nodes: [
                  { id: "state-1", name: "In Progress" },
                  { id: "state-2", name: "Done" },
                ],
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { issueUpdate: { success: true } } }),
      });
    });

    const { LinearClient } = await import("../src/linear/client.js");
    const client = new LinearClient({
      apiKey: "lin_test",
      team: "ENG",
      watchLabels: [],
      watchStatus: "Ready",
    });

    await client.updateStatus("lin-1", "In Progress");
    expect(callCount).toBe(2);
  });

  it("should throw on API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const { LinearClient } = await import("../src/linear/client.js");
    const client = new LinearClient({
      apiKey: "bad_key",
      team: "ENG",
      watchLabels: [],
      watchStatus: "Ready",
    });

    await expect(client.fetchReadyTickets()).rejects.toThrow("Linear API error (401)");
  });
});
