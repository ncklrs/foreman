import React from "react";
import { Box, Text } from "ink";
import type { AgentSession } from "../../types/index.js";

interface TaskQueueProps {
  sessions: AgentSession[];
}

export function TaskQueue({ sessions }: TaskQueueProps) {
  const running = sessions.filter((s) => s.status === "running");
  const completed = sessions.filter((s) => s.status === "completed");
  const failed = sessions.filter((s) => s.status === "failed");
  const pending = sessions.filter((s) => s.status === "idle");

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold underline>Task Queue</Text>

      {pending.length > 0 && (
        <Section title="Pending" color="yellow" sessions={pending} />
      )}
      {running.length > 0 && (
        <Section title="Running" color="green" sessions={running} />
      )}
      {completed.length > 0 && (
        <Section title="Completed" color="blue" sessions={completed} />
      )}
      {failed.length > 0 && (
        <Section title="Failed" color="red" sessions={failed} />
      )}

      {sessions.length === 0 && (
        <Text dimColor>No tasks in queue. Watching for new tasks...</Text>
      )}
    </Box>
  );
}

interface SectionProps {
  title: string;
  color: string;
  sessions: AgentSession[];
}

function Section({ title, color, sessions }: SectionProps) {
  return (
    <Box flexDirection="column">
      <Text bold color={color}>{title} ({sessions.length})</Text>
      {sessions.map((session) => (
        <Box key={session.id} gap={2} paddingLeft={2}>
          <Text color={color}>
            {color === "green" ? "●" : color === "blue" ? "✓" : color === "red" ? "✗" : "○"}
          </Text>
          <Box width={40}>
            <Text>{session.task.title.slice(0, 38)}</Text>
          </Box>
          <Box width={15}>
            <Text dimColor>{session.modelName.slice(0, 13)}</Text>
          </Box>
          <Box width={15}>
            <Text dimColor>
              {session.status === "running"
                ? `iter ${session.iterations}/${session.maxIterations}`
                : formatDuration(session.startedAt, session.completedAt)}
            </Text>
          </Box>
          {session.error && (
            <Text color="red">{session.error.slice(0, 30)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function formatDuration(start: Date, end?: Date): string {
  const duration = (end?.getTime() ?? Date.now()) - start.getTime();
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
