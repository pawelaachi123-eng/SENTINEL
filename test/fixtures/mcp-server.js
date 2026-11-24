#!/usr/bin/env node
'use strict';

// Minimal stdio MCP server used by the test suite. It speaks newline-delimited
// JSON-RPC exactly like a real stdio server, so the client is exercised for
// real (handshake, discovery, call, error, shutdown) without a network.

const readline = require('node:readline');

const VERSION = '2025-06-18';
const tools = [
  { name: 'echo', title: 'Echo', description: 'Returns the argument', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'destroy', title: 'Destroy', description: 'Pretends to be dangerous', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.method) return;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  if (message.id === undefined) return; // notification
  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: VERSION, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } });
      break;
    case 'tools/list':
      reply({ tools });
      break;
    case 'resources/list':
      reply({ resources: [{ uri: 'file:///readme.txt', name: 'readme' }] });
      break;
    case 'prompts/list':
      reply({ prompts: [{ name: 'summarise', description: 'Summarise a document' }] });
      break;
    case 'tools/call': {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      if (name === 'echo') reply({ content: [{ type: 'text', text: `echo:${args.text || ''}` }] });
      else if (name === 'destroy') reply({ isError: true, content: [{ type: 'text', text: 'refused by fixture' }] });
      else reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
      break;
    }
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method ${message.method} not found` } })}\n`);
  }
});
