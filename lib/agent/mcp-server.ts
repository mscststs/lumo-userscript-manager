import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSettings } from '@/types';
import { registerAgentTools } from './tools';

/**
 * Build a standard MCP server for one authorized host connection.
 *
 * No protocol code lives here: the SDK owns JSON-RPC framing, `initialize`,
 * capability negotiation, `tools/list` and `tools/call`. This module only wires
 * the tool implementations.
 *
 * The server deliberately sends no `instructions`. An MCP client is free to drop
 * that field — the only host this build ships for never reads it — so anything
 * the model must know lives in a tool's `description`, in a parameter's
 * `describe()`, or in the JSON `code` of a failure.
 */
export function createAgentMcpServer(
  senderId: string | undefined,
  settings: AgentSettings,
): McpServer {
  const server = new McpServer({
    name: 'lumo-userscripts',
    version: chrome.runtime.getManifest().version,
  });
  registerAgentTools(server, senderId, settings);
  return server;
}
