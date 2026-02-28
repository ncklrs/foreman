import React from "react";
import { Box, Text } from "ink";
import type { AgentSession } from "../../types/index.js";

interface AgentStreamProps {
  sessions: AgentSession[];
  streamOutput: string[];
}

export function AgentStream({ sessions, streamOutput }: AgentStreamProps) {
  const activeSessions = sessions.filter((s) => s.status === "running");

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold underline>Agent Activity</Text>

      {activeSessions.length === 0 ? (
        <Text dimColor>No active agents. Waiting for tasks...</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {activeSessions.map((session) => (
            <Box key={session.id} flexDirection="column" borderStyle="single" paddingX={1}>
              <Box justifyContent="space-between">
                <Text bold color="green">
                  {session.task.title.slice(0, 50)}
                </Text>
                <Text dimColor>
                  {session.modelName} | iter {session.iterations}/{session.maxIterations}
                </Text>
              </Box>
              <Box>
                <Text dimColor>
                  Tokens: {session.tokenUsage.inputTokens + session.tokenUsage.outputTokens} |
                  Started: {session.startedAt.toLocaleTimeString()}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* Live output */}
      <Box flexDirection="column" borderStyle="single" paddingX={1} height={20}>
        <Text bold>Live Output</Text>
        <Text wrap="wrap">
          {streamOutput.slice(-20).join("").slice(-1000) || "Waiting for output..."}
        </Text>
      </Box>
    </Box>
  );
}
