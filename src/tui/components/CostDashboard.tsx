import React from "react";
import { Box, Text } from "ink";
import type { AgentSession } from "../../types/index.js";
import type { ModelStats } from "../../router/performance.js";

interface CostDashboardProps {
  sessions: AgentSession[];
  performanceStats: Record<string, ModelStats>;
  modelCosts: Record<string, { inputPer1M: number; outputPer1M: number }>;
}

export function CostDashboard({ sessions, performanceStats, modelCosts }: CostDashboardProps) {
  // Calculate costs per model
  const costByModel: Record<string, { input: number; output: number; total: number; tasks: number }> = {};

  for (const session of sessions) {
    const model = session.modelName;
    if (!costByModel[model]) {
      costByModel[model] = { input: 0, output: 0, total: 0, tasks: 0 };
    }

    const costs = findCost(model, modelCosts);
    const inputCost = (session.tokenUsage.inputTokens / 1_000_000) * costs.inputPer1M;
    const outputCost = (session.tokenUsage.outputTokens / 1_000_000) * costs.outputPer1M;

    costByModel[model].input += inputCost;
    costByModel[model].output += outputCost;
    costByModel[model].total += inputCost + outputCost;
    costByModel[model].tasks++;
  }

  const grandTotal = Object.values(costByModel).reduce((sum, c) => sum + c.total, 0);
  const totalTokens = sessions.reduce(
    (sum, s) => sum + s.tokenUsage.inputTokens + s.tokenUsage.outputTokens,
    0
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold underline>Cost Dashboard</Text>

      {/* Summary cards */}
      <Box gap={2}>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Total Spend</Text>
          <Text color="green">${grandTotal.toFixed(4)}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Total Tokens</Text>
          <Text>{formatNumber(totalTokens)}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Tasks Run</Text>
          <Text>{sessions.length}</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Avg $/Task</Text>
          <Text>{sessions.length > 0 ? `$${(grandTotal / sessions.length).toFixed(4)}` : "N/A"}</Text>
        </Box>
      </Box>

      {/* Per-model breakdown */}
      <Box flexDirection="column">
        <Box gap={1}>
          <Box width={25}><Text bold>Model</Text></Box>
          <Box width={8}><Text bold>Tasks</Text></Box>
          <Box width={12}><Text bold>Input $</Text></Box>
          <Box width={12}><Text bold>Output $</Text></Box>
          <Box width={12}><Text bold>Total $</Text></Box>
          <Box width={10}><Text bold>Success</Text></Box>
        </Box>

        {Object.entries(costByModel)
          .sort(([, a], [, b]) => b.total - a.total)
          .map(([model, cost]) => {
            const perfKey = Object.keys(performanceStats).find((k) =>
              model.includes(k) || k.includes(model)
            );
            const perf = perfKey ? performanceStats[perfKey] : null;

            return (
              <Box key={model} gap={1}>
                <Box width={25}><Text>{model.slice(0, 23)}</Text></Box>
                <Box width={8}><Text>{cost.tasks}</Text></Box>
                <Box width={12}><Text dimColor>${cost.input.toFixed(4)}</Text></Box>
                <Box width={12}><Text dimColor>${cost.output.toFixed(4)}</Text></Box>
                <Box width={12}><Text color="green">${cost.total.toFixed(4)}</Text></Box>
                <Box width={10}>
                  <Text color={perf && perf.successRate >= 0.8 ? "green" : "yellow"}>
                    {perf ? `${(perf.successRate * 100).toFixed(0)}%` : "N/A"}
                  </Text>
                </Box>
              </Box>
            );
          })}
      </Box>

      {/* Performance stats */}
      {Object.keys(performanceStats).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Performance Metrics</Text>
          {Object.entries(performanceStats).map(([key, stats]) => (
            <Box key={key} gap={2} paddingLeft={2}>
              <Text>{key}:</Text>
              <Text dimColor>
                {stats.totalTasks} tasks | {(stats.successRate * 100).toFixed(0)}% success |
                avg {(stats.avgDurationMs / 1000).toFixed(0)}s |
                avg {stats.avgIterations.toFixed(0)} iters |
                avg {formatNumber(stats.avgTokens)} tokens
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function findCost(
  model: string,
  costs: Record<string, { inputPer1M: number; outputPer1M: number }>
): { inputPer1M: number; outputPer1M: number } {
  for (const [key, cost] of Object.entries(costs)) {
    if (model.includes(key) || key.includes(model)) return cost;
  }
  return { inputPer1M: 3, outputPer1M: 15 }; // Default Sonnet-level pricing
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
