'use strict';

/**
 * MCP tools exposed to the local agent. These four only manage the connection;
 * the actual remote tools are registered dynamically, namespaced
 * `mcp_<server>_<tool>`, with the server's own input schema.
 */

function hub(ctx) {
  if (!ctx.mcp) throw Object.assign(new Error('the MCP client is not available'), { code: 'NO_MCP' });
  return ctx.mcp;
}

module.exports = [
  {
    name: 'mcp.status',
    title: 'MCP connection status',
    description: 'Configured servers, negotiated protocol revisions, discovered tools and counters. MCP is opt-in and disabled by default.',
    category: 'mcp',
    permission: 'read',
    tags: ['mcp', 'status'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      return hub(ctx).status();
    },
    format: (data) => `${data.enabled ? 'włączone' : 'wyłączone'}, ${data.servers.length} serwerów, ${data.tools} narzędzi`,
  },
  {
    name: 'mcp.connect',
    title: 'Connect an MCP server',
    description: 'Connect one configured MCP server. Refused when MCP is disabled in settings. The negotiated protocol version is reported.',
    category: 'mcp',
    permission: 'write',
    tags: ['mcp', 'connect'],
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['server'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return hub(ctx).connect(args.server);
    },
    format: (data) => (data.ok ? `połączono ${data.server.id} (${data.server.protocolVersion}), +${data.added} narzędzi` : `błąd: ${data.message}`),
  },
  {
    name: 'mcp.disconnect',
    title: 'Disconnect an MCP server',
    description: 'Close the connection and stop the server process if it was started by us.',
    category: 'mcp',
    permission: 'write',
    tags: ['mcp', 'disconnect'],
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['server'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return hub(ctx).disconnect(args.server);
    },
    format: (data) => (data.ok ? `rozłączono ${data.server.id}` : 'nieznany serwer'),
  },
  {
    name: 'mcp.list_tools',
    title: 'List MCP tools',
    description: 'Tools advertised by connected servers, with their read-only annotation and the local namespaced name.',
    category: 'mcp',
    permission: 'read',
    tags: ['mcp', 'tools'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      const data = hub(ctx).status();
      const tools = [];
      for (const server of hub(ctx).servers.values()) {
        for (const tool of server.toolList()) tools.push({ server: server.id, name: tool.name, title: tool.title, readOnly: tool.readOnly, destructive: tool.destructive, localName: `mcp_${server.id}_${tool.name}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64) });
      }
      return { tools, count: tools.length, enabled: data.enabled };
    },
    format: (data) => (data.count ? data.tools.map((tool) => `${tool.server}/${tool.name}${tool.readOnly ? ' (read-only)' : ''}`).join('\n') : 'brak narzędzi MCP'),
  },
];
