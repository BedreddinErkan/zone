import { Box, Text, useInput } from "ink";
import type { McpConfig } from "../../../api/diskMcp.js";
import { role, glyph } from "../theme.js";

interface McpTrustModalProps {
  config: McpConfig;
  projectPath: string;
  onApprove: () => void;
  onDeny: () => void;
}

function serverCommandLine(serverName: string, config: McpConfig["mcpServers"][string]): string {
  const parts = [config.command, ...(config.args ?? [])];
  return `${serverName}: ${parts.join(" ")}`;
}

export function McpTrustModal({ config, onApprove, onDeny }: McpTrustModalProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "a" || input === "A") {
      onApprove();
    } else if (input === "n" || input === "N" || key.escape) {
      onDeny();
    }
  });

  const serverEntries = Object.entries(config.mcpServers);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={role.caution}
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text bold color={role.caution}>MCP Servers — Trust Required</Text>
      <Text> </Text>
      <Text>This project defines MCP servers in .zone/mcp.json</Text>
      <Text>that will be spawned as subprocesses during agent tool use.</Text>
      <Text> </Text>
      {serverEntries.map(([name, cfg]) => (
        <Box key={name} flexDirection="column">
          <Text>  <Text color={role.accent}>{glyph.groupMarker}</Text> {serverCommandLine(name, cfg)}</Text>
          {/* Until the `tools` allowlist existed this modal showed a command line
              and nothing else — it renders BEFORE connect(), so the server's own
              tool list has never been available here to show. The allowlist is
              declared in the file, so it is knowable at this point, and showing
              it is what makes the approval cover what actually runs. */}
          <Text dimColor>
            {"      tools: "}
            {cfg.tools ? cfg.tools.join(", ") : "all tools this server provides"}
          </Text>
          {/* The approval declaration is shown for the same reason the tools list is: this modal is
              where the user consents to the file, and consenting to a config whose approval
              overrides are invisible would approve something different from what runs. Only
              rendered when set — the default (gate whatever the server calls destructive) needs no
              line, and an empty one would imply a choice nobody made. */}
          {cfg.requireApproval && Object.keys(cfg.requireApproval).length > 0 && (
            <Text dimColor>
              {"      approval: "}
              {Object.entries(cfg.requireApproval)
                .map(([tool, req]) => `${tool} ${req ? "always asks" : "never asks"}`)
                .join(", ")}
            </Text>
          )}
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>
        <Text bold color={role.success}>[a]</Text> Approve and connect{"  "}
        <Text bold color={role.danger}>[N]</Text> Keep disabled
      </Text>
    </Box>
  );
}
