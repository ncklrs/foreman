import React from "react";
import { Box, Text } from "ink";
import type { ForemanConfig, ProviderHealth } from "../../types/index.js";

interface ModelRegistryProps {
  config: ForemanConfig;
  providerHealth: Map<string, ProviderHealth>;
}

export function ModelRegistry({ config, providerHealth }: ModelRegistryProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold underline>Model Registry</Text>

      <Box flexDirection="column">
        {/* Header */}
        <Box gap={1}>
          <Box width={12}><Text bold>Role</Text></Box>
          <Box width={12}><Text bold>Provider</Text></Box>
          <Box width={30}><Text bold>Model</Text></Box>
          <Box width={8}><Text bold>Status</Text></Box>
          <Box width={10}><Text bold>Latency</Text></Box>
          <Box><Text bold>Description</Text></Box>
        </Box>

        {/* Models */}
        {Object.entries(config.models).map(([key, model]) => {
          const health = providerHealth.get(key);
          const statusColor = health?.healthy ? "green" : health ? "red" : "yellow";
          const statusText = health?.healthy ? "OK" : health ? "DOWN" : "UNKNOWN";
          const latency = health?.latencyMs ? `${health.latencyMs}ms` : "-";

          return (
            <Box key={key} gap={1}>
              <Box width={12}><Text bold>{key}</Text></Box>
              <Box width={12}><Text>{model.provider}</Text></Box>
              <Box width={30}><Text>{model.model}</Text></Box>
              <Box width={8}><Text color={statusColor}>{statusText}</Text></Box>
              <Box width={10}><Text dimColor>{latency}</Text></Box>
              <Box><Text dimColor>{model.role}</Text></Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Routing strategy: {config.routing.strategy} | Fallback chain: {config.routing.fallbackChain.join(" → ")}
        </Text>
      </Box>
    </Box>
  );
}
