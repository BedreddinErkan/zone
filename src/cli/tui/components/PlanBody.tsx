import React from "react";
import { Box, Text } from "ink";

export interface PlanBodyProps {
  objective: string;
  steps: Array<{ title: string; description: string; filesLikely: string[] }>;
  scopeNotes?: string;
  noChangeReason?: string;
  cannotVerifyReason?: string;
  riskHints: string[];
  scopeSummary: string;
}

export function PlanBody({
  objective,
  steps,
  scopeNotes,
  noChangeReason,
  cannotVerifyReason,
  riskHints,
  scopeSummary,
}: PlanBodyProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Ready to code?</Text>
      <Text> </Text>
      <Text dimColor>Objective:</Text>
      <Text>{objective}</Text>
      {!!scopeSummary && (
        <>
          <Text> </Text>
          <Text dimColor>Summary:</Text>
          <Text>{scopeSummary}</Text>
        </>
      )}
      <Text> </Text>
      {(noChangeReason || cannotVerifyReason) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">
            {noChangeReason ? "No changes needed:" : "Could not verify:"}
          </Text>
          <Text color="yellow">{noChangeReason ?? cannotVerifyReason ?? ""}</Text>
        </Box>
      )}
      {steps.map((step, i) => (
        <Box key={i} flexDirection="column">
          <Box flexDirection="row">
            <Text dimColor>{`  ${i + 1}. `}</Text>
            <Text>{step.title}</Text>
          </Box>
          {!!step.description && (
            <Box flexGrow={1} marginLeft={5}>
              <Text dimColor>{step.description}</Text>
            </Box>
          )}
          {step.filesLikely.length > 0 && (
            <Box marginLeft={5}>
              <Text dimColor>{`(${step.filesLikely.join(", ")})`}</Text>
            </Box>
          )}
        </Box>
      ))}
      {riskHints.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>Risks:</Text>
          {riskHints.map((hint, i) => (
            <Text key={i}>{`  • ${hint}`}</Text>
          ))}
        </>
      )}
      {!!scopeNotes && (
        <>
          <Text> </Text>
          <Box flexDirection="row">
            <Text dimColor>{"Scope: "}</Text>
            <Text dimColor>{scopeNotes}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
