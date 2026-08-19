import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";
import { role, glyph } from "../theme.js";

export interface PlanBodyProps {
  objective: string;
  steps: Array<{ title: string; description: string; filesLikely: string[] }>;
  scopeNotes?: string;
  noChangeReason?: string;
  cannotVerifyReason?: string;
  answerOnlyReason?: string;
  riskHints: string[];
  scopeSummary: string;
  /** D3. When present, replaces the fixed objective/steps/riskHints/scopeNotes layout below
   *  with the agent's own markdown, rendered via MarkdownText. Absent renders byte-identically
   *  to before this field existed — the fixed layout is untouched, not merely still reachable. */
  narrative?: string;
  /** D2's plan-level file set, shown under the narrative for the same reason the fixed layout
   *  already lists filesLikely per step: this is what the write guard will actually enforce. */
  filesLikely?: string[];
}

export function PlanBody({
  objective,
  steps,
  scopeNotes,
  noChangeReason,
  cannotVerifyReason,
  answerOnlyReason,
  riskHints,
  scopeSummary,
  narrative,
  filesLikely,
}: PlanBodyProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color={role.accent}>
        {noChangeReason
          ? "Nothing to change?"
          : cannotVerifyReason
            ? "Could not verify?"
            : answerOnlyReason
              ? "Ready to answer?"
              : "Ready to code?"}
      </Text>
      <Text> </Text>
      {narrative ? (
        <>
          <MarkdownText text={narrative} />
          {(noChangeReason || cannotVerifyReason || answerOnlyReason) && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={role.caution}>
                {noChangeReason ? "No changes needed:" : cannotVerifyReason ? "Could not verify:" : "Answering read-only:"}
              </Text>
              <Text color={role.caution}>{noChangeReason ?? cannotVerifyReason ?? answerOnlyReason ?? ""}</Text>
            </Box>
          )}
          {filesLikely && filesLikely.length > 0 && (
            <Box marginTop={1}>
              <Text dimColor>{`Files: ${filesLikely.join(", ")}`}</Text>
            </Box>
          )}
        </>
      ) : (
        <>
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
          {(noChangeReason || cannotVerifyReason || answerOnlyReason) && (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color={role.caution}>
                {noChangeReason ? "No changes needed:" : cannotVerifyReason ? "Could not verify:" : "Answering read-only:"}
              </Text>
              <Text color={role.caution}>{noChangeReason ?? cannotVerifyReason ?? answerOnlyReason ?? ""}</Text>
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
                <Text key={i}>{"  "}{glyph.bullet}{hint}</Text>
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
        </>
      )}
    </Box>
  );
}
