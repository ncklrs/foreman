import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PolicyEvaluation, AgentSession } from "../../types/index.js";

interface PendingApproval {
  evaluation: PolicyEvaluation;
  session: AgentSession;
  resolve: (approved: boolean) => void;
}

interface ApprovalPromptProps {
  pending: PendingApproval | null;
}

export function ApprovalPrompt({ pending }: ApprovalPromptProps) {
  const [selected, setSelected] = useState<"approve" | "deny">("approve");

  useInput((input, key) => {
    if (!pending) return;

    if (key.leftArrow || input === "a") {
      setSelected("approve");
    }
    if (key.rightArrow || input === "d") {
      setSelected("deny");
    }
    if (key.return) {
      pending.resolve(selected === "approve");
    }
    if (input === "y") {
      pending.resolve(true);
    }
    if (input === "n") {
      pending.resolve(false);
    }
  });

  if (!pending) return null;

  const { evaluation, session } = pending;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
    >
      <Text bold color="yellow">
        APPROVAL REQUIRED
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box gap={1}>
          <Text bold>Agent:</Text>
          <Text>{session.task.title.slice(0, 50)}</Text>
        </Box>
        <Box gap={1}>
          <Text bold>Tool:</Text>
          <Text>{evaluation.toolName}</Text>
        </Box>
        <Box gap={1}>
          <Text bold>Reason:</Text>
          <Text color="yellow">{evaluation.reason}</Text>
        </Box>
        <Box gap={1}>
          <Text bold>Input:</Text>
          <Text dimColor>{JSON.stringify(evaluation.input).slice(0, 100)}</Text>
        </Box>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text
          bold={selected === "approve"}
          color={selected === "approve" ? "green" : undefined}
          dimColor={selected !== "approve"}
        >
          [y/a] Approve
        </Text>
        <Text
          bold={selected === "deny"}
          color={selected === "deny" ? "red" : undefined}
          dimColor={selected !== "deny"}
        >
          [n/d] Deny
        </Text>
        <Text dimColor>[Enter] Confirm</Text>
      </Box>
    </Box>
  );
}

export type { PendingApproval };
