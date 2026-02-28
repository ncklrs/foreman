import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  name: string;
  viewMode: string;
}

export function Header({ name, viewMode }: HeaderProps) {
  const tabs = [
    { key: "1", label: "Dashboard", mode: "dashboard" },
    { key: "2", label: "Agents", mode: "agents" },
    { key: "3", label: "Models", mode: "models" },
    { key: "4", label: "Tasks", mode: "tasks" },
    { key: "5", label: "Costs", mode: "costs" },
  ];

  return (
    <Box flexDirection="column">
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">
          FOREMAN
        </Text>
        <Text dimColor>{name}</Text>
      </Box>
      <Box paddingX={1} gap={2}>
        {tabs.map((tab) => (
          <Text
            key={tab.key}
            bold={viewMode === tab.mode}
            color={viewMode === tab.mode ? "cyan" : undefined}
            dimColor={viewMode !== tab.mode}
          >
            [{tab.key}] {tab.label}
          </Text>
        ))}
        <Text dimColor>[Tab] Cycle  [q] Quit</Text>
      </Box>
      <Box>
        <Text>{"─".repeat(80)}</Text>
      </Box>
    </Box>
  );
}
