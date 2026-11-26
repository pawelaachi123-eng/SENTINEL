'use strict';

/**
 * Model providers.
 *
 * Every provider speaks either:
 *   • Ollama's native API  (/api/chat, /api/embed, /api/tags) — default
 *   • the OpenAI-compatible API (/v1/chat/completions, /v1/embeddings,
 *     /v1/models) — LM Studio, llama.cpp server, vLLM, and anything else that
 *     implements it, including an explicitly allowed external endpoint.
 *
 * Both streams are parsed here into one shape:
 *   { text, toolCalls: [{ id, name, arguments }], usage: { prompt, completion }, finish }
 */

class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', status = 0, provider = '', cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.cause = cause;
  }
}

/** Reads a streaming body line by line without buffering the whole response. */
async function* lines(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

function normaliseToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const call of raw) {
    const fn = (call && call.function) || {};
    const name = fn.name || call.name;
    if (!name) continue;
    let args = fn.arguments !== undefined ? fn.arguments : call.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        args = { _raw: args };
      }
    }
    out.push({ id: call.id || `call_${out.length}`, name, arguments: args || {} });
  }
  return out;
}

/* ── Ollama ────────────────────────────────────────────────────────────── */

function createOllama({ baseUrl, name = 'ollama', fetchImpl = globalThis.fetch, apiKey = null }) {
  const root = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const headers = () => {
    const out = { 'content-type': 'application/json' };
    if (apiKey) out.authorization = `Bearer ${apiKey}`;
    return out;
  };

  return {
    name,
    kind: 'ollama',
    baseUrl: root,

    async health({ signal } = {}) {
      const started = Date.now();
      const response = await fetchImpl(`${root}/api/tags`, { method: 'GET', headers: headers(), signal });
      if (!response.ok) throw new ProviderError(`Ollama answered HTTP ${response.status}`, { status: response.status, provider: name });
      const json = await response.json();
      const models = (json.models || []).map((model) => ({
        id: model.name || model.model,
        size: model.size || 0,
        family: model.details && model.details.family,
        parameters: model.details && model.details.parameter_size,
        quantization: model.details && model.details.quantization_level,
        modified: model.modified_at,
      }));
      return { ok: true, latencyMs: Date.now() - started, models };
    },

    async listModels() {
      const health = await this.health();
      return health.models;
    },

    async chat({ model, messages, temperature, maxTokens, json, tools, keepAlive, signal, onToken }) {
      const body = {
        model,
        messages: messages.map((message) => {
          const out = { role: message.role, content: message.content || '' };
          if (message.images && message.images.length) out.images = message.images;
          if (message.tool_calls) out.tool_calls = message.tool_calls;
          if (message.name) out.name = message.name;
          return out;
        }),
        stream: true,
        options: { temperature, num_predict: maxTokens },
        keep_alive: keepAlive || '30m',
      };
      if (json) body.format = 'json';
      if (tools && tools.length) body.tools = tools;

      const response = await fetchImpl(`${root}/api/chat`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(`Ollama rejected the request (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`, {
          status: response.status,
          provider: name,
          code: response.status === 404 ? 'MODEL_MISSING' : 'HTTP_ERROR',
        });
      }

      let text = '';
      let toolCalls = [];
      let usage = { prompt: 0, completion: 0 };
      let finish = 'stop';
      for await (const line of lines(response.body)) {
        if (line.startsWith('data:')) continue; // not expected, but tolerate
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.error) throw new ProviderError(String(event.error), { provider: name });
        const piece = (event.message && event.message.content) || '';
        if (piece) {
          text += piece;
          if (onToken) onToken(piece);
        }
        const calls = normaliseToolCalls(event.message && event.message.tool_calls);
        if (calls.length) toolCalls = toolCalls.concat(calls);
        if (event.done) {
          usage = { prompt: event.prompt_eval_count || 0, completion: event.eval_count || 0 };
          finish = event.done_reason || 'stop';
        }
      }
      return { text, toolCalls, usage, finish };
    },

    async embed({ model, input, signal }) {
      const list = Array.isArray(input) ? input : [input];
      const response = await fetchImpl(`${root}/api/embed`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, input: list, truncate: true }),
        signal,
      });
      if (response.ok) {
        const json = await response.json();
        if (Array.isArray(json.embeddings) && json.embeddings.length) return json.embeddings;
      }
      // Older Ollama builds only expose /api/embeddings (one prompt per call).
      const out = [];
      for (const prompt of list) {
        const single = await fetchImpl(`${root}/api/embeddings`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ model, prompt }),
          signal,
        });
        if (!single.ok) throw new ProviderError(`Ollama embeddings failed (HTTP ${single.status})`, { provider: name, status: single.status });
        const json = await single.json();
        out.push(json.embedding);
      }
      return out;
    },
  };
}

/* ── OpenAI-compatible ─────────────────────────────────────────────────── */

function createOpenAICompat({ baseUrl, name = 'openai-compatible', fetchImpl = globalThis.fetch, apiKey = null }) {
  const root = String(baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  const headers = () => {
    const out = { 'content-type': 'application/json' };
    if (apiKey) out.authorization = `Bearer ${apiKey}`;
    return out;
  };

  return {
    name,
    kind: 'openai',
    baseUrl: root,

    async health({ signal } = {}) {
      const started = Date.now();
      const response = await fetchImpl(`${root}/models`, { method: 'GET', headers: headers(), signal });
      if (!response.ok) throw new ProviderError(`${name} answered HTTP ${response.status}`, { status: response.status, provider: name });
      const json = await response.json();
      const models = (json.data || []).map((model) => ({ id: model.id, owned: model.owned_by || '' }));
      return { ok: true, latencyMs: Date.now() - started, models };
    },

    async listModels() {
      const health = await this.health();
      return health.models;
    },

    async chat({ model, messages, temperature, maxTokens, json, tools, signal, onToken }) {
      const body = {
        model,
        messages: messages.map((message) => {
          const out = { role: message.role, content: message.content || '' };
          if (message.images && message.images.length) {
            out.content = [
              { type: 'text', text: message.content || '' },
              ...message.images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } })),
            ];
          }
          if (message.tool_calls) out.tool_calls = message.tool_calls;
          if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
          if (message.name) out.name = message.name;
          return out;
        }),
        stream: true,
        temperature,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
      };
      if (json) body.response_format = { type: 'json_object' };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const response = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(`${name} rejected the request (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`, {
          status: response.status,
          provider: name,
          code: response.status === 404 ? 'MODEL_MISSING' : 'HTTP_ERROR',
        });
      }

      let text = '';
      const pending = new Map(); // tool call index → accumulating call
      let usage = { prompt: 0, completion: 0 };
      let finish = 'stop';

      for await (const line of lines(response.body)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.error) throw new ProviderError(event.error.message || String(event.error), { provider: name });
        if (event.usage) usage = { prompt: event.usage.prompt_tokens || 0, completion: event.usage.completion_tokens || 0 };
        const choice = (event.choices || [])[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) {
          text += delta.content;
          if (onToken) onToken(delta.content);
        }
        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0;
          const entry = pending.get(index) || { id: '', name: '', arguments: '' };
          if (call.id) entry.id = call.id;
          if (call.function && call.function.name) entry.name = call.function.name;
          if (call.function && call.function.arguments) entry.arguments += call.function.arguments;
          pending.set(index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const toolCalls = normaliseToolCalls([...pending.values()].map((entry) => ({ id: entry.id, function: { name: entry.name, arguments: entry.arguments } })));
      return { text, toolCalls, usage, finish };
    },

    async embed({ model, input, signal }) {
      const response = await fetchImpl(`${root}/embeddings`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, input: Array.isArray(input) ? input : [input] }),
        signal,
      });
      if (!response.ok) throw new ProviderError(`${name} embeddings failed (HTTP ${response.status})`, { status: response.status, provider: name });
      const json = await response.json();
      return (json.data || []).map((entry) => entry.embedding);
    },
  };
}

module.exports = { createOllama, createOpenAICompat, ProviderError, normaliseToolCalls, lines };
