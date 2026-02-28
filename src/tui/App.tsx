/**
 * Foreman TUI — Main application component.
 * Built with Ink (React for CLI).
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { AgentSession, ForemanConfig, ForemanEvent, PolicyEvaluation, ProviderHealth } from "../types/index.js";
import type { ModelStats } from "../router/performance.js";
import { Header } from "./components/Header.js";
import { ModelRegistry } from "./components/ModelRegistry.js";
import { TaskQueue } from "./components/TaskQueue.js";
import { AgentStream } from "./components/AgentStream.js";
import { StatusBar } from "./components/StatusBar.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import type { PendingApproval } from "./components/ApprovalPrompt.js";
import { CostDashboard } from "./components/CostDashboard.js";
import { AgentDetail } from "./components/AgentDetail.js";

type ViewMode = "dashboard" | "agents" | "models" | "tasks" | "costs";

interface AppProps {
  config: ForemanConfig;
  events: ForemanEvent[];
  sessions: AgentSession[];
  providerHealth: Map<string, ProviderHealth>;
  performanceStats?: Record<string, ModelStats>;
  modelCosts?: Record<string, { inputPer1M: number; outputPer1M: number }>;
  onApproval?: (handler: (evaluation: PolicyEvaluation, session: AgentSession) => Promise<boolean>) => void;
}

export function App({
  config,
  events,
  sessions,
  providerHealth,
  performanceStats = {},
  modelCosts = {},
  onApproval,
}: AppProps) {
  const { exit } = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [streamOutput, setStreamOutput] = useState<string[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  // Register approval handler with orchestrator
  useEffect(() => {
    if (!onApproval) return;
    onApproval(async (evaluation, session) => {
      return new Promise<boolean>((resolve) => {
        setPendingApproval({ evaluation, session, resolve });
      });
    });
  }, [onApproval]);

  // Clear pending approval after resolve
  useEffect(() => {
    if (!pendingApproval) return;
    const origResolve = pendingApproval.resolve;
    const wrappedPending: PendingApproval = {
      ...pendingApproval,
      resolve: (approved: boolean) => {
        origResolve(approved);
        setPendingApproval(null);
      },
    };
    setPendingApproval(wrappedPending);
    // Only run once when a new approval comes in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApproval?.evaluation]);

  // Process events for stream output
  useEffect(() => {
    const latestEvents = events.slice(-100);
    const streamLines: string[] = [];

    for (const event of latestEvents) {
      if (event.type === "agent:stream" && event.event.text) {
        streamLines.push(event.event.text);
      } else if (event.type === "agent:tool_call") {
        streamLines.push(`\n[tool] ${event.toolName}(${JSON.stringify(event.input).slice(0, 100)}...)\n`);
      } else if (event.type === "agent:tool_result") {
        const output = event.result.output.slice(0, 200);
        streamLines.push(`[result] ${output}${event.result.output.length > 200 ? "..." : ""}\n`);
      }
    }

    setStreamOutput(streamLines);
  }, [events]);

  // Keyboard shortcuts
  useInput((input, key) => {
    // If approval prompt is showing, don't intercept other keys
    if (pendingApproval) return;

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
    if (input === "1") setViewMode("dashboard");
    if (input === "2") setViewMode("agents");
    if (input === "3") setViewMode("models");
    if (input === "4") setViewMode("tasks");
    if (input === "5") setViewMode("costs");
    if (key.escape && selectedAgentId) {
      setSelectedAgentId(null);
    }
    if (key.tab) {
      const modes: ViewMode[] = ["dashboard", "agents", "models", "tasks", "costs"];
      const idx = modes.indexOf(viewMode);
      setViewMode(modes[(idx + 1) % modes.length]);
    }
  });

  const activeSessions = sessions.filter((s) => s.status === "running");
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const failedSessions = sessions.filter((s) => s.status === "failed");

  const totalTokens = sessions.reduce(
    (acc, s) => ({
      input: acc.input + s.tokenUsage.inputTokens,
      output: acc.output + s.tokenUsage.outputTokens,
    }),
    { input: 0, output: 0 }
  );

  const selectedSession = selectedAgentId
    ? sessions.find((s) => s.id === selectedAgentId) ?? null
    : null;

  return (
    <Box flexDirection="column" width="100%">
      <Header
        name={config.foreman.name}
        viewMode={viewMode}
      />

      {/* Approval overlay */}
      {pendingApproval && <ApprovalPrompt pending={pendingApproval} />}

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {viewMode === "dashboard" && (
          <DashboardView
            activeSessions={activeSessions}
            completedSessions={completedSessions}
            failedSessions={failedSessions}
            totalTokens={totalTokens}
            streamOutput={streamOutput}
          />
        )}

        {viewMode === "agents" && !selectedAgentId && (
          <AgentStream
            sessions={sessions}
            streamOutput={streamOutput}
          />
        )}

        {viewMode === "agents" && selectedAgentId && (
          <AgentDetail
            session={selectedSession}
            onBack={() => setSelectedAgentId(null)}
          />
        )}

        {viewMode === "models" && (
          <ModelRegistry
            config={config}
            providerHealth={providerHealth}
          />
        )}

        {viewMode === "tasks" && (
          <TaskQueue sessions={sessions} />
        )}

        {viewMode === "costs" && (
          <CostDashboard
            sessions={sessions}
            performanceStats={performanceStats}
            modelCosts={modelCosts}
          />
        )}
      </Box>

      <StatusBar
        activeAgents={activeSessions.length}
        maxAgents={config.foreman.maxConcurrentAgents}
        totalTokens={totalTokens}
        viewMode={viewMode}
      />
    </Box>
  );
}

interface DashboardViewProps {
  activeSessions: AgentSession[];
  completedSessions: AgentSession[];
  failedSessions: AgentSession[];
  totalTokens: { input: number; output: number };
  streamOutput: string[];
}

function DashboardView({
  activeSessions,
  completedSessions,
  failedSessions,
  totalTokens,
  streamOutput,
}: DashboardViewProps) {
  return (
    <Box flexDirection="column" gap={1}>
      {/* Stats row */}
      <Box gap={2}>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Active Agents</Text>
          <Text color="green">{activeSessions.length}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Completed</Text>
          <Text color="blue">{completedSessions.length}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Failed</Text>
          <Text color="red">{failedSessions.length}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Tokens Used</Text>
          <Text>{formatTokens(totalTokens.input + totalTokens.output)}</Text>
        </Box>
      </Box>

      {/* Active agents list */}
      {activeSessions.length > 0 && (
        <Box flexDirection="column">
          <Text bold underline>Active Agents</Text>
          {activeSessions.map((session) => (
            <Box key={session.id} gap={2}>
              <Text color="green">●</Text>
              <Text bold>{session.task.title.slice(0, 40)}</Text>
              <Text dimColor>({session.modelName})</Text>
              <Text dimColor>iter: {session.iterations}/{session.maxIterations}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Live stream */}
      <Box flexDirection="column" borderStyle="single" paddingX={1} height={15}>
        <Text bold>Agent Output</Text>
        <Text>
          {streamOutput.slice(-10).join("").slice(-500)}
        </Text>
      </Box>
    </Box>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
