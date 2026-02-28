import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/runtime/context.js";
import type { ChatMessage } from "../src/types/index.js";

describe("ContextManager", () => {
  it("returns messages unchanged when under threshold", async () => {
    const mgr = new ContextManager({
      maxContextTokens: 100000,
      summarizationThreshold: 0.75,
      preserveRecentMessages: 5,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const result = await mgr.manage(messages, 100);
    expect(result).toEqual(messages);
  });

  it("summarizes old messages when over threshold", async () => {
    const mgr = new ContextManager({
      maxContextTokens: 200, // Very small to trigger summarization
      summarizationThreshold: 0.5,
      preserveRecentMessages: 2,
    });

    const messages: ChatMessage[] = [];
    // Add enough messages to exceed threshold
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `Message ${i}: ${"x".repeat(50)}` });
      messages.push({ role: "assistant", content: `Response ${i}: ${"y".repeat(50)}` });
    }

    const result = await mgr.manage(messages, 50);

    // Should be compressed: 1 summary + 2 recent messages
    expect(result.length).toBeLessThan(messages.length);
    expect(result[0].content).toContain("Context Summary");
    // Last 2 messages should be preserved
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1]);
    expect(result[result.length - 2]).toEqual(messages[messages.length - 2]);
  });

  it("tracks tool calls in summary", async () => {
    const mgr = new ContextManager({
      maxContextTokens: 100,
      summarizationThreshold: 0.3,
      preserveRecentMessages: 1,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "1", name: "read_file", input: { path: "src/index.ts" } },
        ],
      },
      { role: "tool", content: "file contents", toolCallId: "1" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "2", name: "write_file", input: { path: "src/new.ts", content: "export {}" } },
        ],
      },
      { role: "tool", content: "File written", toolCallId: "2" },
      { role: "user", content: "Good work" },
    ];

    const result = await mgr.manage(messages, 20);

    // Summary should mention files
    const summaryContent = typeof result[0].content === "string" ? result[0].content : "";
    expect(summaryContent).toContain("src/index.ts");
    expect(summaryContent).toContain("src/new.ts");
  });

  it("reports utilization correctly", async () => {
    const mgr = new ContextManager({
      maxContextTokens: 1000,
      summarizationThreshold: 0.75,
      preserveRecentMessages: 5,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(400) }, // ~100 tokens
    ];

    await mgr.manage(messages, 100); // system prompt ~100 tokens

    // Should report ~20% utilization (200/1000)
    expect(mgr.getUtilization()).toBeGreaterThan(0.1);
    expect(mgr.getUtilization()).toBeLessThan(0.5);
  });
});
