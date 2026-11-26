'use strict';

/**
 * Prompt assembly, token budgeting and output parsing.
 *
 * Token counts are estimates: the providers report exact usage after the fact,
 * and SENTINEL must decide *before* the call how much context fits. The
 * estimate is deliberately pessimistic (Polish and code both tokenise worse
 * than plain English) and it is corrected by real usage when available.
 */

const MODE_HINTS = {
  fast: 'Work quickly. One pass, read-only tools, short answer.',
  balanced: 'Think briefly, use tools when they help, verify the important parts.',
  deep: 'Plan carefully, gather evidence, check your own work, and say what you are unsure about.',
};

function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  const byChars = Math.ceil(value.length / 3.4);
  return Math.max(words, byChars);
}

function messageTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 6, 0);
}

/**
 * Drops the oldest non-system messages until the conversation fits the budget.
 * Tool results are kept newest-first because they are usually the evidence the
 * answer depends on.
 */
function trimMessages(messages, { maxTokens = 6000, reserve = 900 } = {}) {
  const budget = Math.max(400, maxTokens - reserve);
  const system = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  let used = messageTokens(system);
  const kept = [];
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i];
    const cost = estimateTokens(message.content) + 6 + (message.images ? 800 : 0);
    if (used + cost > budget && kept.length) break;
    used += cost;
    kept.unshift(message);
  }
  return [...system, ...kept];
}

/** Tool descriptors → OpenAI/Ollama function schema. */
function toToolSchema(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name.replace(/\./g, '_'),
      description: `${tool.description}${tool.permission && tool.permission !== 'read' ? ` (requires ${tool.permission} permission)` : ''}`,
      parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false },
    },
  }));
}

/** Maps a model-side tool name back to the dotted registry name. */
function fromToolName(name, tools) {
  const direct = tools.find((tool) => tool.name === name);
  if (direct) return direct;
  const underscored = tools.find((tool) => tool.name.replace(/\./g, '_') === name);
  return underscored || null;
}

/** Models wrap JSON in code fences more often than not. */
function parseJsonLoose(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The identity and rules every agent shares. Kept short on purpose: long system
 * prompts cost context on every call and models follow fewer rules well than
 * many rules badly.
 */
function baseSystemPrompt({ identity, mode = 'balanced', language = 'auto', now = new Date() }) {
  return [
    `You are ${identity}, the local assistant inside SENTINEL running on the user's own computer.`,
    'Rules:',
    '- Answer in the language the user wrote in (Polish or English). Never switch language without reason.',
    `- ${MODE_HINTS[mode] || MODE_HINTS.balanced}`,
    '- Use the provided tools for facts about this machine. Do not invent hardware, versions, paths or log lines.',
    '- If a tool fails, say what failed and what it means. Never present a guess as a measurement.',
    '- Never print secrets (keys, tokens, passwords). Never ask for them.',
    '- When you are unsure, say so and state what would resolve it.',
    `- Local time: ${now.toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    language === 'auto' ? '' : `- The user prefers ${language}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Renders recalled memories and knowledge chunks as citable context. */
function contextBlock({ memories = [], knowledge = [], device = null }) {
  const parts = [];
  if (device) {
    parts.push(
      `Machine state (measured ${device.ageSeconds != null ? `${device.ageSeconds}s ago` : 'just now'}):\n` +
        [
          device.hostname ? `- host: ${device.hostname}` : '',
          device.platformLabel ? `- system: ${device.platformLabel} ${device.release || ''} (${device.arch || ''})` : '',
          device.cpuModel ? `- cpu: ${device.cpuModel} × ${device.cpuCount || '?'}, load ${device.cpuPercent ?? '?'}%` : '',
          device.memoryDetail ? `- memory: ${device.memoryDetail.percent}% of ${Math.round(device.memoryDetail.total / 1024 ** 3)} GB` : '',
          device.uptimeLabel ? `- uptime: ${device.uptimeLabel}` : '',
          device.esp ? `- esp32: ${device.esp.connected ? 'linked' : 'not linked'}${device.esp.pc ? `, pc ${device.esp.pc}` : ''}${device.esp.tempC ? `, ${device.esp.tempC} °C` : ''}` : '',
          device.policy ? `- policy: shutdown ${device.policy.allowShutdown ? 'on' : 'off'}, input ${device.policy.allowInput ? 'on' : 'off'}, confirm ${device.policy.requireConfirm ? 'required' : 'off'}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
    );
  }
  if (memories.length) {
    parts.push(
      'Relevant memories (cite as [M1], [M2] if you use them):\n' +
        memories
          .map((entry, index) => `[M${index + 1}] (${entry.record.kind}) ${entry.record.text.replace(/\s+/g, ' ').slice(0, 400)}`)
          .join('\n'),
    );
  }
  if (knowledge.length) {
    parts.push(
      'Relevant documents (cite as [K1], [K2]):\n' +
        knowledge
          .map((entry, index) => {
            const source = entry.chunk.meta && entry.chunk.meta.source ? entry.chunk.meta.source : 'document';
            const lines = entry.chunk.meta && entry.chunk.meta.lines ? `:${entry.chunk.meta.lines}` : '';
            return `[K${index + 1}] ${source}${lines}\n${entry.chunk.text.slice(0, 700)}`;
          })
          .join('\n\n'),
    );
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** Pulls [M1]/[K2] citations out of an answer so the UI can link them. */
function extractCitations(text, { memories = [], knowledge = [] } = {}) {
  const found = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/\[(M|K)(\d+)\]/g)) {
    const key = `${match[1]}${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = Number(match[2]) - 1;
    if (match[1] === 'M' && memories[index]) {
      found.push({ id: key, kind: 'memory', title: memories[index].record.kind, ref: memories[index].record.id, snippet: memories[index].record.text.slice(0, 160) });
    } else if (match[1] === 'K' && knowledge[index]) {
      const chunk = knowledge[index].chunk;
      found.push({
        id: key,
        kind: 'knowledge',
        title: (chunk.meta && chunk.meta.source) || 'document',
        ref: chunk.id,
        snippet: chunk.text.slice(0, 160),
      });
    }
  }
  return found;
}

module.exports = {
  MODE_HINTS,
  estimateTokens,
  messageTokens,
  trimMessages,
  toToolSchema,
  fromToolName,
  parseJsonLoose,
  baseSystemPrompt,
  contextBlock,
  extractCitations,
};
