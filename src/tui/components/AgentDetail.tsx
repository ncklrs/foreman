import React from "react";
import { Box, Text } from "ink";
import type { AgentSession, ContentBlock } from "../../types/index.js";

interface AgentDetailProps {
  session: AgentSession | null;
  onBack: () => void;
}

export function AgentDetail({ session, onBack }: AgentDetailProps) {
  if (!session) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No agent selected. Press [Esc] to go back.</Text>
      </Box>
    );
  }

  const statusColor =
    session.status === "completed" ? "green" :
    session.status === "failed" ? "red" :
    session.status === "running" ? "cyan" : "yellow";

  const totalTokens = session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;
  const duration = (session.completedAt
    ? new Date(session.completedAt).getTime()
    : Date.now()) - new Date(session.startedAt).getTime();

  return (
    <Box flexDirection="column" gap={1}>
      {/* Header */}
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold>{session.task.title}</Text>
        <Box gap={2}>
          <Text color={statusColor}>{session.status.toUpperCase()}</Text>
          <Text dimColor>Model: {session.modelName}</Text>
          <Text dimColor>
            Iterations: {session.iterations}/{session.maxIterations}
          </Text>
          <Text dimColor>Tokens: {formatNumber(totalTokens)}</Text>
          <Text dimColor>Duration: {formatDuration(duration)}</Text>
        </Box>
        {session.error && <Text color="red">Error: {session.error}</Text>}
      </Box>

      {/* Task description */}
      <Box flexDirection="column">
        <Text bold>Task Description</Text>
        <Text wrap="wrap">{session.task.description.slice(0, 300)}</Text>
      </Box>

      {/* Conversation history (condensed) */}
      <Box flexDirection="column">
        <Text bold>Conversation ({session.messages.length} messages)</Text>
        <Box flexDirection="column" height={25} overflowY="hidden">
          {session.messages.slice(-20).map((msg, i) => {
            const roleColor =
              msg.role === "assistant" ? "cyan" :
              msg.role === "tool" ? "yellow" :
              "white";

            let content: string;
            if (typeof msg.content === "string") {
              content = msg.content.slice(0, 120);
            } else if (Array.isArray(msg.content)) {
              content = summarizeBlocks(msg.content);
            } else {
              content = "(empty)";
            }

            return (
              <Box key={i} gap={1}>
                <Box width={10}>
                  <Text color={roleColor} bold>{msg.role}</Text>
                </Box>
                <Text wrap="truncate">{content}</Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Artifacts */}
      {session.artifacts.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Artifacts ({session.artifacts.length})</Text>
          {session.artifacts.map((artifact, i) => (
            <Box key={i} gap={1} paddingLeft={2}>
              <Text>[{artifact.type}]</Text>
              <Text dimColor>{artifact.content.slice(0, 80)}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>[Esc] Back to list</Text>
    </Box>
  );
}

function summarizeBlocks(blocks: ContentBlock[]): string {
  return blocks.map((b) => {
    if (b.type === "text") return b.text.slice(0, 60);
    if (b.type === "tool_use") return `[${b.name}]`;
    if (b.type === "tool_result") return `[result: ${b.content.slice(0, 30)}]`;
    return "";
  }).filter(Boolean).join(" | ");
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
