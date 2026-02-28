import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  activeAgents: number;
  maxAgents: number;
  totalTokens: { input: number; output: number };
  viewMode: string;
}

export function StatusBar({ activeAgents, maxAgents, totalTokens, viewMode }: StatusBarProps) {
  const totalTokenCount = totalTokens.input + totalTokens.output;

  return (
    <Box>
      <Text>{"─".repeat(80)}</Text>
      <Box paddingX={1} justifyContent="space-between" width="100%">
        <Text dimColor>
          Agents: {activeAgents}/{maxAgents}
        </Text>
        <Text dimColor>
          Tokens: {formatNumber(totalTokenCount)}
        </Text>
        <Text dimColor>
          View: {viewMode}
        </Text>
      </Box>
    </Box>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
