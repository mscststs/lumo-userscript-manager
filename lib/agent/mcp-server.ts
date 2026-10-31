import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSettings } from '@/types';
import { buildAgentInstructions, registerAgentTools } from './tools';

/**
 * Build a standard MCP server for one authorized host connection.
 *
 * No protocol code lives here: the SDK owns JSON-RPC framing, `initialize`,
 * capability negotiation, `tools/list` and `tools/call`. This module only wires
 * the tool implementations and the policy-shaped instructions.
 */
export function createAgentMcpServer(
  senderId: string | undefined,
  settings: AgentSettings,
): McpServer {
  const server = new McpServer(
    { name: 'lumo-userscripts', version: chrome.runtime.getManifest().version },
    { instructions: buildAgentInstructions(settings) },
  );
  registerAgentTools(server, senderId, settings);
  return server;
}
