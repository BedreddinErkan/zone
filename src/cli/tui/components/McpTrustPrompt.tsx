import React from "react";
import { Box, Text, useInput } from "ink";
import type { McpConfig } from "../../../api/diskMcp.js";
import { useStore } from "../store.js";
import { role, glyph, spacing } from "../theme.js";

function serverCommandLine(serverName: string, config: McpConfig["mcpServers"][string]): string {
  const parts = [config.command, ...(config.args ?? [])];
  return `${serverName}: ${parts.join(" ")}`;
}

/**
 * Phase 2d — content-only MCP trust prompt. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads pendingMcpTrust
 * from the store; records trust and connects on approve, denies on deny/Esc.
 */
export function McpTrustPrompt(): React.ReactElement | null {
  const { state, dispatch } = useStore();
  const pending = state.pendingMcpTrust;
  if (!pending) return null;

  const { config, projectPath } = pending;

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      (async () => {
        try {
          const [{ recordMcpTrust }, { McpClientManager }] = await Promise.all([
            import("../../../api/diskTrustedMcp.js"),
            import("../../../mcp/mcpClientManager.js"),
          ]);
          recordMcpTrust(projectPath, pending.hash);
          const manager = await McpClientManager.connect(config.mcpServers, projectPath);
          dispatch({ type: "MCP_TRUST_APPROVED", manager });
          dispatch({ type: "OVERLAY_POP" });
        } catch {
          dispatch({ type: "MCP_TRUST_DENIED" });
          dispatch({ type: "OVERLAY_POP" });
        }
      })();
    } else if (input === "n" || input === "N" || key.escape) {
      dispatch({ type: "MCP_TRUST_DENIED" });
      dispatch({ type: "OVERLAY_POP" });
    }
  });

  const serverEntries = Object.entries(config.mcpServers);

  return (
    <Box flexDirection="column">
      <Text>This project defines MCP servers in .zone/mcp.json</Text>
      <Text>that will be spawned as subprocesses during agent tool use.</Text>
      <Box marginTop={spacing.sm} flexDirection="column">
        {serverEntries.map(([name, cfg]) => (
          <Box key={name} flexDirection="column">
            <Text>  <Text color={role.accent}>{glyph.groupMarker}</Text> {serverCommandLine(name, cfg)}</Text>
            <Text dimColor>
              {"      tools: "}
              {cfg.tools ? cfg.tools.join(", ") : "all tools this server provides"}
            </Text>
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
      </Box>
      <Box marginTop={spacing.sm}>
        <Text bold color={role.success}>[y]</Text>
        <Text> Approve and connect{"  "}</Text>
        <Text bold color={role.danger}>[N]</Text>
        <Text> Keep disabled</Text>
      </Box>
    </Box>
  );
}
