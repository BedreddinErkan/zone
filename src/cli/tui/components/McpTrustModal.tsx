import { Box, Text, useInput } from "ink";
import type { McpConfig } from "../../../api/diskMcp.js";

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
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Text bold color="yellow">MCP Servers — Trust Required</Text>
      <Text> </Text>
      <Text>This project defines MCP servers in .zone/mcp.json</Text>
      <Text>that will be spawned as subprocesses during agent tool use.</Text>
      <Text> </Text>
      {serverEntries.map(([name, cfg]) => (
        <Text key={name}>  <Text color="cyan">●</Text> {serverCommandLine(name, cfg)}</Text>
      ))}
      <Text> </Text>
      <Text dimColor>
        <Text bold color="green">[a]</Text> Approve and connect{"  "}
        <Text bold color="red">[N]</Text> Keep disabled
      </Text>
    </Box>
  );
}
