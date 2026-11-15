/**
 * Minimal MCP host: opens `lumo:mcp`, performs the handshake over raw JSON-RPC
 * and reports what came back. It runs as a *separate extension*, which is the
 * only way to exercise `onConnectExternal` (an extension cannot be its own
 * external sender).
 */
window.probeAgent = async (lumoId) => {
  const response = await chrome.runtime.sendMessage(lumoId, {
    channel: 'lumo:probe',
    version: 1,
    id: 'probe-1',
    client: { id: chrome.runtime.id, name: 'Lumo MCP Test Client', version: '1.0.0' },
  });
  return response;
};

window.mcpHandshake = async (lumoId) => {
  const log = [];
  const inbound = [];
  let disconnected = null;

  const port = chrome.runtime.connect(lumoId, { name: 'lumo:mcp' });
  port.onMessage.addListener((message) => {
    inbound.push(message);
    log.push({ dir: 'in', method: message.method ?? null, id: message.id ?? null });
  });
  port.onDisconnect.addListener(() => {
    disconnected = chrome.runtime.lastError?.message ?? 'closed';
    log.push({ dir: 'disconnect', message: disconnected });
  });

  const send = (message) => {
    log.push({ dir: 'out', method: message.method ?? null, id: message.id ?? null });
    port.postMessage(message);
  };
  const waitFor = async (id) => {
    for (let i = 0; i < 240; i += 1) {
      const hit = inbound.find((message) => message.id === id);
      if (hit) return hit;
      if (disconnected) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Lumo MCP Test Client', version: '1.0.0' },
    },
  });
  const initialize = await waitFor(1);
  if (!initialize?.result) return { log, disconnected, initialize, tools: [] };

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitFor(2);
  return {
    log,
    disconnected,
    initialize,
    tools: (list?.result?.tools ?? []).map((tool) => tool.name),
  };
};
