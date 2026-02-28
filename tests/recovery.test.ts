import { describe, it, expect } from "vitest";
import { RecoveryManager } from "../src/runtime/recovery.js";
import type { ChatResponse, ToolUseBlock } from "../src/types/index.js";

const knownTools = new Set(["read_file", "write_file", "edit_file", "run_command", "search_codebase", "list_files", "task_done"]);

function makeResponse(content: ChatResponse["content"], stopReason: ChatResponse["stopReason"] = "tool_use"): ChatResponse {
  return {
    id: "test",
    content,
    stopReason,
    usage: { inputTokens: 100, outputTokens: 50 },
    model: "test-model",
  };
}

describe("RecoveryManager", () => {
  it("continues on valid responses", () => {
    const mgr = new RecoveryManager({ knownTools });
    const response = makeResponse([
      { type: "text", text: "I'll read the file" },
      { type: "tool_use", id: "1", name: "read_file", input: { path: "src/index.ts" } },
    ]);

    const action = mgr.analyze(response);
    expect(action.type).toBe("continue");
  });

  it("detects hallucinated tools", () => {
    const mgr = new RecoveryManager({ knownTools });
    const response = makeResponse([
      { type: "tool_use", id: "1", name: "execute_python", input: { code: "print(1)" } },
    ]);

    const action = mgr.analyze(response);
    expect(action.type).toBe("inject_message");
    if (action.type === "inject_message") {
      expect(action.message.content).toContain("not a valid tool");
    }
  });

  it("detects infinite loops (repeated identical tool calls)", () => {
    const mgr = new RecoveryManager({
      knownTools,
      maxRepeatedToolCalls: 3,
    });

    const sameCall: ToolUseBlock = {
      type: "tool_use",
      id: "1",
      name: "read_file",
      input: { path: "src/index.ts" },
    };

    // First two should be fine
    expect(mgr.analyze(makeResponse([sameCall])).type).toBe("continue");
    expect(mgr.analyze(makeResponse([sameCall])).type).toBe("continue");

    // Third should trigger loop detection
    const action = mgr.analyze(makeResponse([sameCall]));
    expect(action.type).toBe("inject_message");
    if (action.type === "inject_message") {
      expect(action.message.content).toContain("loop");
    }
  });

  it("detects stalled agents (no writes)", () => {
    const mgr = new RecoveryManager({
      knownTools,
      maxStallIterations: 3,
    });

    // Three iterations of only reading
    for (let i = 0; i < 2; i++) {
      mgr.analyze(makeResponse([
        { type: "tool_use", id: String(i), name: "read_file", input: { path: `file${i}.ts` } },
      ]));
    }

    // Third should trigger stall detection
    const action = mgr.analyze(makeResponse([
      { type: "tool_use", id: "3", name: "search_codebase", input: { pattern: "TODO" } },
    ]));
    expect(action.type).toBe("inject_message");
    if (action.type === "inject_message") {
      expect(action.message.content).toContain("without making any file changes");
    }
  });

  it("resets stall counter on writes", () => {
    const mgr = new RecoveryManager({
      knownTools,
      maxStallIterations: 3,
    });

    // Two reads
    mgr.analyze(makeResponse([
      { type: "tool_use", id: "1", name: "read_file", input: { path: "a.ts" } },
    ]));
    mgr.analyze(makeResponse([
      { type: "tool_use", id: "2", name: "read_file", input: { path: "b.ts" } },
    ]));

    // A write should reset
    const action = mgr.analyze(makeResponse([
      { type: "tool_use", id: "3", name: "write_file", input: { path: "c.ts", content: "x" } },
    ]));
    expect(action.type).toBe("continue");
  });

  it("detects empty responses", () => {
    const mgr = new RecoveryManager({ knownTools });
    const response = makeResponse([
      { type: "text", text: "" },
    ], "end_turn");

    const action = mgr.analyze(response);
    expect(action.type).toBe("inject_message");
    if (action.type === "inject_message") {
      expect(action.message.content).toContain("empty");
    }
  });

  it("aborts after too many consecutive errors", () => {
    const mgr = new RecoveryManager({
      knownTools,
      maxConsecutiveErrors: 2,
    });

    mgr.recordError("API error 1");
    const action = mgr.recordError("API error 2");
    expect(action.type).toBe("abort");
  });

  it("resets error counter on success", () => {
    const mgr = new RecoveryManager({
      knownTools,
      maxConsecutiveErrors: 3,
    });

    mgr.recordError("Error 1");
    mgr.recordError("Error 2");

    // Successful response resets counter
    mgr.analyze(makeResponse([
      { type: "text", text: "I'll fix this" },
      { type: "tool_use", id: "1", name: "read_file", input: { path: "x.ts" } },
    ]));

    // Should not abort on next error
    const action = mgr.recordError("Error 3");
    expect(action.type).toBe("inject_message");
  });
});
