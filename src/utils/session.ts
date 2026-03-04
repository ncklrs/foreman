/**
 * Shared session utilities.
 * Extracts files changed and summaries from agent sessions.
 */

import type { AgentSession } from "../types/index.js";

/** Extract file paths modified during a session (via write_file / edit_file tool calls). */
export function extractFilesChanged(session: AgentSession): string[] {
  const files = new Set<string>();

  for (const msg of session.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          if (
            (block.name === "write_file" || block.name === "edit_file") &&
            input.path
          ) {
            files.add(String(input.path));
          }
        }
      }
    }
  }

  return Array.from(files);
}

/** Extract a summary from a session's artifacts or last assistant message. */
export function extractSessionSummary(session: AgentSession, fallback = "Agent completed without summary"): string {
  // Look for task_done summary in artifacts
  const doneArtifact = session.artifacts.find(
    (a) => a.type === "log" && a.content !== "Task completed"
  );
  if (doneArtifact) return doneArtifact.content;

  // Fall back to last assistant text message
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") return msg.content.slice(0, 500);
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find(
          (b): b is { type: "text"; text: string } => b.type === "text"
        );
        if (textBlock) return textBlock.text.slice(0, 500);
      }
    }
  }

  return session.error ?? fallback;
}

/** Coerce an unknown error to a string message. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
