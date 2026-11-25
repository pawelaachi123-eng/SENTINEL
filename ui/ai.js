'use strict';

/**
 * SENTINEL AI surface.
 *
 * One module for everything the assistant itself does in the UI: the orb, the
 * streaming chat, approvals, and the agent / task / memory / knowledge /
 * automation / model / diagnostics panels.
 *
 * Rules it follows:
 *   • every state shown is a state the backend reported — the orb reacts to real
 *     stage events, it does not animate on a timer and pretend to think;
 *   • STOP aborts the request and the model run on the server, and the UI says
 *     "stopped" rather than leaving a half sentence on screen;
 *   • nothing is rendered as HTML from the model: markdown is escaped first, so
 *     a code block cannot inject a tag.
 */
(function () {
  if (window.SENTINEL_AI) return;

  const TOKEN_KEY = 'sentinel.token';
  const params = new URLSearchParams(location.search);
  const token = params.get('t') || localStorage.getItem(TOKEN_KEY) || '';
  if (params.get('t')) localStorage.setItem(TOKEN_KEY, params.get('t'));

  const state = {
    tab: 'home',
    orbState: 'idle',
    streaming: false,
    controller: null,
    runId: null,
    messages: [],
    conversation: 'default',
    mode: 'balanced',
    approvals: [],
    agents: [],
    tools: [],
    models: null,
    gaming: false,
    audio: null,
    recogniser: null,
  };

  /* ── tiny DOM helpers ────────────────────────────────────────────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  /** Polish plural: 1 wspomnienie, 2 wspomnienia, 5 wspomnień. */
  const plural = (count, one, few, many) => {
    const n = Math.abs(Number(count) || 0);
    if (n === 1) return one;
    const rest = n % 10;
    const tens = n % 100;
    if (rest >= 2 && rest <= 4 && !(tens >= 12 && tens <= 14)) return few;
    return many;
  };
  const clock = (value) => {
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };
  const bytes = (value) => {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(1)} GB`;
  };

  /* ── HTTP ────────────────────────────────────────────────────────────── */

  async function api(path, options = {}) {
    const url = `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch {
        /* not JSON */
      }
      throw Object.assign(new Error((detail && (detail.message || detail.error)) || `HTTP ${response.status}`), { status: response.status, detail });
    }
    return response.json();
  }

  /* ── markdown (escaped, deliberately small) ──────────────────────────── */

  function renderMarkdown(text) {
    const source = String(text || '');
    const blocks = [];
    // Fenced code first, so nothing inside it is interpreted.
    const withPlaceholders = source.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, language, code) => {
      const index = blocks.push({ language, code }) - 1;
      return `\u0000CODE${index}\u0000`;
    });
    let html = esc(withPlaceholders)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => {
      const block = blocks[Number(index)];
      return `<pre class="code" data-lang="${esc(block.language || 'text')}"><code>${esc(block.code.replace(/\n$/, ''))}</code></pre>`;
    });
    return `<p>${html}</p>`;
  }

  /* ── the orb ─────────────────────────────────────────────────────────── */

  const Orb = (() => {
    const STATES = {
      idle: { speed: 0.35, amp: 0.35, hue: 206, particles: 42 },
      listening: { speed: 0.9, amp: 0.75, hue: 196, particles: 70 },
      thinking: { speed: 1.5, amp: 0.6, hue: 214, particles: 90 },
      planning: { speed: 1.1, amp: 0.7, hue: 224, particles: 80 },
      working: { speed: 2.1, amp: 0.85, hue: 200, particles: 110 },
      speaking: { speed: 1.2, amp: 1.0, hue: 192, particles: 64 },
      error: { speed: 2.6, amp: 0.9, hue: 354, particles: 40 },
    };
    let canvas = null;
    let ctx = null;
    let raf = 0;
    let current = 'idle';
    let targetAmp = 0.35;
    let amp = 0.35;
    let hue = 206;
    let targetHue = 206;
    let last = 0;
    let visible = true;
    let reduced = false;
    let fpsCap = 60;

    function init(canvasEl) {
      canvas = canvasEl;
      ctx = canvas ? canvas.getContext('2d') : null;
      if (!ctx) return;
      reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      resize();
      window.addEventListener('resize', resize, { passive: true });
      document.addEventListener('visibilitychange', () => {
        visible = !document.hidden;
        if (visible && !raf) loop(performance.now());
      });
      loop(performance.now());
    }

    function resize() {
      if (!canvas) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(160, rect.width || 260);
      const height = Math.max(160, rect.height || 260);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      canvas.dataset.size = `${Math.round(width)}x${Math.round(height)}`;
    }

    function set(next) {
      if (!STATES[next]) next = 'idle';
      current = next;
      targetAmp = STATES[next].amp;
      targetHue = STATES[next].hue;
      if (next === 'error' || next === 'speaking') pulse(1);
      if (canvas) canvas.dataset.state = next;
      const label = document.querySelector('#orb-label');
      if (label) {
        label.textContent = {
          idle: 'Gotowy',
          listening: 'Słucham…',
          thinking: 'Myślę…',
          planning: 'Planuję…',
          working: 'Wykonuję…',
          speaking: 'Mówię…',
          error: 'Błąd',
        }[next] || 'Gotowy';
      }
    }

    function pulse(amount = 0.4) {
      amp = Math.min(1.6, amp + amount);
    }

    function speed() {
      if (reduced) fpsCap = 20;
      if (window.SENTINEL_GAMING) fpsCap = Math.min(fpsCap, 20);
      return fpsCap;
    }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      if (!visible || !ctx) return;
      if (now - last < 1000 / speed()) return;
      const dt = Math.min(64, now - last || 16);
      last = now;
      draw(now, dt);
    }

    function draw(now, dt) {
      const spec = STATES[current];
      amp += (targetAmp - amp) * Math.min(1, dt / 240);
      hue += (targetHue - hue) * Math.min(1, dt / 400);
      const w = canvas.clientWidth || 260;
      const h = canvas.clientHeight || 260;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.27;
      const t = now / 1000;
      ctx.clearRect(0, 0, w, h);

      // ambient halo
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 2.4);
      halo.addColorStop(0, `hsla(${hue}, 100%, 62%, ${0.16 + amp * 0.12})`);
      halo.addColorStop(0.45, `hsla(${hue + 14}, 96%, 55%, 0.07)`);
      halo.addColorStop(1, 'hsla(220, 90%, 50%, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // outer rotating arcs
      for (let index = 0; index < 3; index += 1) {
        const phase = t * spec.speed * (0.5 + index * 0.22) + index * 2.1;
        const r = radius * (1.35 + index * 0.2) + Math.sin(phase) * 3 * amp;
        ctx.beginPath();
        ctx.lineWidth = 1 + index * 0.4;
        ctx.strokeStyle = `hsla(${hue + index * 8}, 95%, 68%, ${0.5 - index * 0.12})`;
        ctx.arc(cx, cy, r, phase, phase + 1.5 + amp * 0.9);
        ctx.stroke();
      }

      // core: layered blobs
      const layers = 5;
      for (let layer = 0; layer < layers; layer += 1) {
        const k = 1 - layer / layers;
        const wobble = Math.sin(t * spec.speed * 1.4 + layer) * 4 * amp;
        const r = radius * (0.55 + k * 0.55) + wobble;
        const gradient = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r);
        gradient.addColorStop(0, `hsla(${hue + 18}, 100%, 78%, ${0.16 + 0.10 * k})`);
        gradient.addColorStop(0.6, `hsla(${hue}, 96%, 52%, ${0.22 + 0.16 * k})`);
        gradient.addColorStop(1, `hsla(${hue - 12}, 92%, 34%, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // rim
      ctx.beginPath();
      const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      rim.addColorStop(0, `hsla(${hue + 30}, 100%, 80%, 0.95)`);
      rim.addColorStop(0.5, `hsla(${hue}, 100%, 62%, 0.7)`);
      rim.addColorStop(1, `hsla(${hue - 30}, 90%, 46%, 0.35)`);
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.6;
      ctx.arc(cx, cy, radius + Math.sin(t * 2) * 1.5 * amp, 0, Math.PI * 2);
      ctx.stroke();

      // particles orbiting; they flow inward while working/thinking
      const count = reduced ? 12 : spec.particles;
      for (let index = 0; index < count; index += 1) {
        const seed = index * 12.9898;
        const angle = t * spec.speed * (0.4 + ((index % 5) + 1) * 0.14) + seed;
        const orbit = radius * (1.05 + ((index % 7) / 9)) * (current === 'working' ? 1 : 1);
        const inflow = current === 'thinking' || current === 'working' ? ((t * 0.6 + index * 0.13) % 1) : 0;
        const r = current === 'thinking' || current === 'working' ? radius * (1.9 - inflow * 1.2) : orbit;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r * 0.92;
        const size = 0.7 + ((index % 4) * 0.5) * (0.6 + amp * 0.5);
        ctx.beginPath();
        ctx.fillStyle = `hsla(${hue + (index % 24)}, 100%, ${70 + (index % 12)}%, ${0.25 + (1 - inflow) * 0.5 * (current === 'thinking' ? 1 : amp)})`;
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // speaking: an inner ripple per pulse
      if (current === 'speaking' || current === 'listening') {
        const ripple = (t * 0.8) % 1;
        ctx.beginPath();
        ctx.strokeStyle = `hsla(${hue}, 100%, 74%, ${(1 - ripple) * 0.5})`;
        ctx.lineWidth = 1.4;
        ctx.arc(cx, cy, radius * (0.5 + ripple * 0.9), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    return {
      init,
      set,
      pulse,
      get state() {
        return current;
      },
    };
  })();

  /* ── chat ────────────────────────────────────────────────────────────── */

  const chatEls = {};

  function stageToOrb(stage) {
    switch (stage) {
      case 'thinking':
      case 'understanding':
      case 'constraints':
      case 'recall':
        return 'thinking';
      case 'routing':
        return 'thinking';
      case 'planning':
        return 'planning';
      case 'working':
      case 'composing':
      case 'reflecting':
      case 'verifying':
        return 'working';
      case 'degraded':
        return 'error';
      case 'cancelled':
        return 'idle';
      case 'done':
        return 'idle';
      default:
        return null;
    }
  }

  function appendMessage(message) {
    state.messages.push(message);
    renderMessages();
  }

  function renderMessages() {
    const list = chatEls.list;
    if (!list) return;
    list.textContent = '';
    if (!state.messages.length) {
      list.append(
        el('div', { class: 'chat-empty' }, [
          el('p', { class: 'chat-empty-title', text: 'Zapytaj o cokolwiek na tym komputerze' }),
          el('p', { class: 'chat-empty-sub', text: 'Sprzęt, procesy, pliki, dokumenty, logi, ESP32, kod. Odpowiedzi opierają się na pomiarach, nie na zgadywaniu.' }),
          el('div', { class: 'chat-suggestions' }, [
            ['Jaki mam GPU i ile VRAM jest zajęte?', 'Sprawdź stan komputera'],
            ['Co jest w folderze projektu?', 'Przejrzyj pliki'],
            ['Znajdź w dokumentach co pisze o ESP32', 'Przeszukaj bazę wiedzy'],
            ['Ile to 128*24+7?', 'Policz coś'],
          ].map(([prompt, label]) =>
            el('button', {
              class: 'chip',
              type: 'button',
              text: label,
              onclick: () => {
                if (chatEls.input) chatEls.input.value = prompt;
                sendMessage(prompt);
              },
            }),
          )),
        ]),
      );
      return;
    }
    for (const message of state.messages) {
      const bubble = el('article', { class: `msg msg-${message.role}${message.error ? ' msg-error' : ''}` });
      const meta = el('div', { class: 'msg-meta' });
      meta.append(el('span', { class: 'msg-who', text: message.role === 'user' ? 'Ty' : message.agentTitle || 'SENTINEL' }));
      meta.append(el('span', { class: 'msg-time', text: clock(message.at || Date.now()) }));
      if (message.mode) meta.append(el('span', { class: 'msg-tag', text: message.mode }));
      if (message.stopped) meta.append(el('span', { class: 'msg-tag msg-tag-warn', text: 'zatrzymane' }));
      bubble.append(meta);

      const body = el('div', { class: 'msg-body' });
      if (message.role === 'user') {
        body.textContent = message.text;
      } else if (message.streaming) {
        body.textContent = message.text || '…';
      } else {
        body.innerHTML = renderMarkdown(message.text || '');
      }
      bubble.append(body);

      if (message.role === 'assistant' && !message.streaming) {
        const bits = [];
        if (message.tools && message.tools.length) bits.push(`narzędzia: ${message.tools.slice(0, 6).join(', ')}`);
        if (message.citations && message.citations.length) bits.push(`źródła: ${message.citations.map((citation) => citation.id).join(' ')}`);
        if (message.confidence != null) bits.push(`pewność ${Math.round(message.confidence * 100)}%`);
        if (message.ms) bits.push(`${(message.ms / 1000).toFixed(1)} s`);
        if (bits.length) bubble.append(el('div', { class: 'msg-foot', text: bits.join(' · ') }));
      }

      if (message.approvals && message.approvals.length) {
        const box = el('div', { class: 'approvals' });
        for (const approval of message.approvals) {
          box.append(
            el('div', { class: 'approval' }, [
              el('div', { class: 'approval-title', text: `Wymaga zgody: ${approval.tool}` }),
              el('div', { class: 'approval-reason', text: approval.reason || '' }),
              el('div', { class: 'approval-actions' }, [
                el('button', { class: 'btn btn-ok', type: 'button', text: 'Zezwól', onclick: () => decideApproval(approval.id, true) }),
                el('button', { class: 'btn btn-ghost', type: 'button', text: 'Odmów', onclick: () => decideApproval(approval.id, false) }),
              ]),
            ]),
          );
        }
        bubble.append(box);
      }
      list.append(bubble);
    }
    list.scrollTop = list.scrollHeight;
  }

  async function decideApproval(id, approve) {
    try {
      const result = await api('/api/approvals/decide', { method: 'POST', body: { id, approve } });
      if (result.ok && result.approved) {
        appendMessage({ role: 'assistant', text: `Zgoda udzielona — \`${result.result && result.result.message ? result.result.message : 'wykonane'}\`.`, at: Date.now() });
      } else if (result.ok) {
        appendMessage({ role: 'assistant', text: 'Odmówiono. Nic nie zostało wykonane.', at: Date.now() });
      } else {
        appendMessage({ role: 'assistant', text: `Nie udało się: ${esc(result.message || 'zgoda wygasła')}.`, at: Date.now(), error: true });
      }
      refreshApprovals();
    } catch (err) {
      appendMessage({ role: 'assistant', text: `Błąd zatwierdzenia: ${err.message}`, at: Date.now(), error: true });
    }
  }

  async function sendMessage(preset = null) {
    const input = chatEls.input;
    const text = (preset != null ? preset : input && input.value) || '';
    const trimmed = String(text).trim();
    if (!trimmed || state.streaming) return;
    if (input && preset == null) input.value = '';
    const attachments = state.attachments || [];
    appendMessage({ role: 'user', text: trimmed, at: Date.now(), attachments: attachments.map((file) => file.name) });
    const reply = { role: 'assistant', text: '', at: Date.now(), streaming: true, mode: state.mode, agentTitle: 'SENTINEL' };
    state.messages.push(reply);
    renderMessages();
    await streamAnswer(trimmed, reply, attachments);
  }

  async function streamAnswer(text, reply, attachments) {
    state.streaming = true;
    Orb.set('thinking');
    setBusy(true);
    const controller = new AbortController();
    state.controller = controller;
    state.runId = `ui_${Date.now().toString(36)}`;
    const body = { text, mode: state.mode, sessionId: state.conversation, runId: state.runId };
    if (attachments && attachments.length) {
      body.images = await Promise.all(
        attachments
          .filter((file) => /^image\//.test(file.type))
          .slice(0, 3)
          .map(async (file) => ({ mime: file.type, name: file.name, data: await toBase64(file) })),
      );
    }
    let stageNote = null;
    try {
      const response = await fetch(`/api/chat?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'start') {
            state.runId = event.runId || state.runId;
          } else if (event.type === 'stage') {
            const next = stageToOrb(event.stage);
            if (next) Orb.set(next);
            if (event.stage === 'working' && event.agent) stageNote = event.title || event.agent;
            if (event.stage === 'planning') stageNote = 'planowanie';
            if (event.stage === 'verifying') stageNote = 'weryfikacja';
            if (chatEls.stage) chatEls.stage.textContent = stageNote ? `${stageNote}…` : '';
          } else if (event.type === 'token') {
            reply.text += event.text;
            reply.streaming = true;
            if (chatEls.list) renderStreamingReply(reply);
          } else if (event.type === 'final') {
            finished = true;
            Object.assign(reply, {
              streaming: false,
              text: event.text || reply.text,
              agent: event.agent,
              agentTitle: event.agentTitle || event.agent,
              mode: event.mode,
              tools: event.tools,
              citations: event.citations,
              confidence: event.confidence,
              ms: event.ms,
              approvals: event.approvals,
              verification: event.verification,
              degraded: event.degraded,
              stopped: event.cancelled,
              error: event.error || undefined,
              at: Date.now(),
            });
            if (event.cancelled) reply.text = reply.text || 'Zatrzymane.';
            renderMessages();
          } else if (event.type === 'error') {
            finished = true;
            reply.streaming = false;
            reply.error = true;
            reply.text = `${reply.text ? `${reply.text}\n\n` : ''}Błąd: ${event.code} — ${event.message}`;
            renderMessages();
          }
        }
      }
      reply.streaming = false;
      if (!reply.text) reply.text = 'Brak odpowiedzi. Sprawdź Diagnostics → model.';
      renderMessages();
      Orb.set(reply.error ? 'error' : 'idle');
      if (reply.error) setTimeout(() => Orb.set('idle'), 2200);
    } catch (err) {
      reply.streaming = false;
      if (controller.signal.aborted) {
        reply.stopped = true;
        reply.text = reply.text ? `${reply.text}\n\n— zatrzymane —` : 'Zatrzymane.';
      } else {
        reply.error = true;
        reply.text = `Nie udało się połączyć z asystentem: ${err.message}`;
      }
      renderMessages();
      Orb.set(controller.signal.aborted ? 'idle' : 'error');
    } finally {
      state.streaming = false;
      state.controller = null;
      setBusy(false);
      if (chatEls.stage) chatEls.stage.textContent = '';
      refreshApprovals();
      refreshTasks();
    }
  }

  function renderStreamingReply(reply) {
    const bubbles = chatEls.list ? $$('.msg-assistant', chatEls.list) : [];
    const last = bubbles[bubbles.length - 1];
    if (!last) return renderMessages();
    const body = $('.msg-body', last);
    if (body) body.textContent = reply.text;
    chatEls.list.scrollTop = chatEls.list.scrollHeight;
  }

  function setBusy(busy) {
    if (chatEls.send) chatEls.send.disabled = busy;
    if (chatEls.stop) chatEls.stop.hidden = !busy;
    const input = chatEls.input;
    if (input) input.placeholder = busy ? 'Myślę… możesz nacisnąć STOP' : 'Zapytaj SENTINELA…';
  }

  async function stopRun() {
    if (state.controller) state.controller.abort();
    try {
      await api('/api/chat/stop', { method: 'POST', body: { runId: state.runId } });
    } catch {
      /* the abort already stopped the client side */
    }
    Orb.set('idle');
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('could not read the image'));
      reader.readAsDataURL(file);
    });
  }

  /* ── panels ──────────────────────────────────────────────────────────── */

  function panel(name) {
    return document.querySelector(`[data-panel="${name}"]`);
  }

  async function loadAgents() {
    const host = panel('agents');
    if (!host) return;
    host.textContent = 'Ładuję agentów…';
    try {
      const data = await api('/api/agents');
      state.agents = data.data || [];
      const grid = el('div', { class: 'grid-cards' });
      for (const agent of state.agents) {
        grid.append(
          el('article', { class: 'card mini-card' }, [
            el('div', { class: 'mini-card-head' }, [el('h3', { text: agent.title }), el('span', { class: `badge badge-${agent.role}`, text: agent.role })]),
            el('p', { class: 'mini-card-desc', text: agent.description }),
            el('div', { class: 'mini-card-tags' }, [
              el('span', { class: 'tag', text: agent.modelClass }),
              ...agent.categories.slice(0, 4).map((category) => el('span', { class: 'tag', text: category })),
            ]),
          ]),
        );
      }
      host.textContent = '';
      host.append(el('p', { class: 'panel-note', text: `${state.agents.length} ${plural(state.agents.length, 'agent', 'agentów', 'agentów')} · dispatcher wybiera najmniejszy zestaw, nie wysyła pytania do wszystkich` }));
      host.append(grid);
    } catch (err) {
      host.textContent = `Nie mogę wczytać agentów: ${err.message}`;
    }
  }

  async function loadTools() {
    const host = panel('tools');
    if (!host) return;
    host.textContent = 'Ładuję narzędzia…';
    try {
      const data = await api('/api/tools');
      state.tools = data.data || [];
      const search = el('input', { class: 'field', type: 'search', placeholder: 'Szukaj narzędzia…' });
      const list = el('div', { class: 'tool-list' });
      const render = (needle = '') => {
        list.textContent = '';
        const filtered = state.tools.filter((tool) => !needle || `${tool.name} ${tool.description}`.toLowerCase().includes(needle.toLowerCase()));
        for (const tool of filtered.slice(0, 200)) {
          list.append(
            el('div', { class: 'tool-row' }, [
              el('code', { class: 'tool-name', text: tool.name }),
              el('span', { class: 'tool-desc', text: tool.description }),
              el('span', { class: `tag tag-${tool.permission}`, text: tool.permission }),
            ]),
          );
        }
        if (!filtered.length) list.append(el('p', { class: 'panel-note', text: 'Nic nie pasuje.' }));
        count.textContent = `${filtered.length} z ${state.tools.length} narzędzi`;
      };
      const count = el('p', { class: 'panel-note' });
      search.addEventListener('input', () => render(search.value));
      host.textContent = '';
      host.append(el('p', { class: 'panel-note', text: 'Każde narzędzie ma walidację parametrów, uprawnienia, limit czasu, anulowanie i wpis w audycie.' }));
      host.append(search, count, list);
      render();
    } catch (err) {
      host.textContent = `Nie mogę wczytać narzędzi: ${err.message}`;
    }
  }

  async function loadCognition() {
    const host = panel('cognition');
    if (!host) return;
    host.textContent = 'Czytam ostatni przebieg…';
    try {
      const report = await api('/api/cognition');
      host.textContent = '';
      const run = report.data;
      if (!run) {
        host.append(el('p', { class: 'empty-note', text: 'Brak przebiegów w tej sesji. Zadaj pytanie w czacie — tu pojawi się jego brief, strategia i weryfikacja.' }));
      } else {
        const brief = run.brief || {};
        const rows = [
          ['Pytanie', run.question],
          ['Tryb', run.mode],
          ['Zamiar', brief.intent || '—'],
          ['Strategia', `${run.strategy || brief.strategy || '—'}${brief.strategyReason ? ` — ${brief.strategyReason}` : ''}`],
          ['Złożoność', brief.complexity || '—'],
          ['Ryzyko', brief.risk ? `${brief.risk.level}${brief.risk.flags && brief.risk.flags.length ? ` (${brief.risk.flags.join(', ')})` : ''}` : '—'],
          ['Pewność', typeof run.verification.confidence === 'number' ? `${Math.round(run.verification.confidence * 100)}%` : '—'],
          ['Kontekst', run.context ? `${run.context.tokens}/${run.context.budget} tokenów (${Math.round((run.context.utilisation || 0) * 100)}%), pominięto ${run.context.dropped ? run.context.dropped.length : 0}` : '—'],
          ['Rozumienie', brief.semantic ? `${brief.semantic.source}${brief.semantic.degraded ? ' (degraded)' : ''}${brief.language ? ` · ${brief.language}` : ''}` : '—'],
          ['Wykonanie', run.execution ? `${run.execution.status}, ${run.execution.counters.steps} kroków, ${run.execution.counters.failures} błędów, ${run.execution.counters.replans} przestawień` : '—'],
          ['Graf', run.graph ? `${run.graph.seeds.length} zalążków, ${run.graph.nodes.length} węzłów` : 'brak trafień'],
          ['Rozmowa', run.conversation ? `${run.conversation.turns} tur, ${run.conversation.decisions.length} decyzji, ${run.conversation.constraints.length} ograniczeń${run.conversation.skippedSecrets ? `, pominięto ${run.conversation.skippedSecrets} sekretów` : ''}` : '—'],
        ];
        host.append(el('dl', { class: 'kv' }, rows.map(([key, value]) => el('div', {}, [el('dt', { text: key }), el('dd', { text: String(value) })]))));
        host.append(el('p', { class: 'panel-note', text: `Kryteria ukończenia: ${(brief.completionCriteria || []).join(' · ') || '—'}` }));
        if (brief.constraints && brief.constraints.length) {
          host.append(el('p', { class: 'panel-note', text: `Ograniczenia: ${brief.constraints.map((entry) => entry.label || entry.id).join(' · ')}` }));
        }
        if (brief.assumptions && brief.assumptions.length) {
          host.append(el('p', { class: 'panel-note', text: `Założenia: ${brief.assumptions.map((entry) => entry.text || entry).join(' · ')}` }));
        }
        if (run.context && run.context.sections) {
          host.append(
            el('div', { class: 'mini-card-tags' }, run.context.sections.map((section) => el('span', { class: `tag${section.truncated ? ' tag-warn' : ''}`, text: `${section.name} ${section.tokens}${section.truncated ? ' (ucięte)' : ''}` }))),
          );
        }
        host.append(el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: 'Oceń odpowiedź',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              const feedback = await api('/api/feedback', { method: 'POST', body: { runId: run.runId, rating: 0.8, note: 'ocena z panelu Poznanie' } });
              event.currentTarget.textContent = feedback.ok ? 'Zapisano ocenę' : `Nie zapisano: ${feedback.message || feedback.code}`;
            },
          }),
          el('span', { class: 'muted', text: `${run.ms} ms · ${(run.tools || []).length} narzędzi · ${(run.agents || []).join(', ') || 'bez agenta'}` }),
        ]));
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać przebiegu: ${err.message}`;
    }
    loadEventLog();
    loadPatches();
    loadExperience();
    loadReliability();
    loadRuntime();
    loadGraph();
    loadOrg();
    loadMcp();
  }

  function profileButton(entry, active) {
    return el('button', {
      class: `chip${active ? ' is-on' : ''}`,
      type: 'button',
      text: entry.label,
      title: entry.description,
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        const result = await api('/api/runtime', { method: 'POST', body: { action: 'set', profile: entry.name, reason: 'wybór w panelu Poznanie' } });
        if (!result.ok || (result.data && result.data.ok === false)) notify((result.data && result.data.message) || result.message || 'Nie udało się zmienić profilu', { tone: 'warn' });
        event.currentTarget.disabled = false;
        loadRuntime();
      },
    });
  }

  async function loadRuntime() {
    const host = panel('runtime');
    const buttons = $('#runtime-profiles');
    if (!host) return;
    try {
      const response = await api('/api/runtime');
      const data = response.data;
      if (!data) {
        host.textContent = 'Runtime nie jest dostępny w tej instalacji.';
        return;
      }
      if (buttons && !buttons.childElementCount) {
        for (const entry of data.profiles) buttons.append(profileButton(entry, entry.name === data.profile));
      } else if (buttons) {
        [...buttons.children].forEach((button, index) => button.classList.toggle('is-on', data.profiles[index] && data.profiles[index].name === data.profile));
      }
      host.textContent = '';
      const hw = data.hardware || {};
      const feasibility = data.feasibility || {};
      const rows = [
        ['Profil', `${data.profile}${data.profileDetail ? ` — ${data.profileDetail.description}` : ''}`],
        ['CPU', `${hw.cpu || '—'} · ${hw.cores || '?'} wątków`],
        ['RAM', hw.memoryGb ? `${hw.memoryGb} GB (wolne ${hw.freeMemoryGb} GB)` : '—'],
        ['GPU', hw.gpu ? `${hw.gpu.name} · ${hw.gpu.vramGb} GB VRAM` : 'nie wykryto (nvidia-smi)'],
        ['Model', feasibility.model ? `${feasibility.model}${feasibility.estimate ? ` — ok. ${feasibility.estimate.totalGb} GB (szacunek)` : ''}` : '—'],
        ['W pamięci', data.resident && data.resident.supported ? (data.resident.models.length ? data.resident.models.map((model) => `${model.name} ${model.vramGb} GB`).join(', ') : 'brak modeli') : (data.resident && data.resident.reason) || '—'],
        ['Przełączenia', `${data.counters.switches} · odmowy ${data.counters.refusals} · wyładowania ${data.counters.unloads}`],
      ];
      host.append(el('dl', { class: 'kv' }, rows.map(([key, value]) => el('div', {}, [el('dt', { text: key }), el('dd', { text: String(value) })]))));
      host.append(el('p', { class: 'panel-note', text: `Szacunki: ${data.estimates.basis}. ${data.estimates.honest}.` }));
      if (feasibility.ok === false) host.append(el('p', { class: 'panel-note warn', text: feasibility.message }));
    } catch (err) {
      host.textContent = `Nie mogę wczytać runtime: ${err.message}`;
    }
  }

  async function loadGraph(query = '') {
    const host = panel('graph');
    if (!host) return;
    try {
      const response = await api(`/api/graph${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      const data = response.data || {};
      host.textContent = '';
      if (query && data.lines) {
        host.append(el('p', { class: 'panel-note', text: data.lines.length ? `Powiązania dla „${query}” (${data.nodes.length} węzłów):` : 'Brak powiązań w grafie.' }));
        if (data.lines.length) host.append(el('ul', { class: 'eventlog' }, data.lines.map((line) => el('li', { text: line }))));
        if (data.nodes.length) {
          host.append(el('div', { class: 'mini-card-tags' }, data.nodes.slice(0, 16).map((node) => el('span', { class: 'tag', text: `${node.type}: ${node.label}`, title: `głębokość ${node.depth}, pewność ${node.confidence}` }))));
        }
        return;
      }
      const stats = data.stats || { nodes: 0, edges: 0, byType: {}, byEdge: {} };
      host.append(el('dl', { class: 'kv' }, [
        el('div', {}, [el('dt', { text: 'Węzły' }), el('dd', { text: String(stats.nodes) })]),
        el('div', {}, [el('dt', { text: 'Krawędzie' }), el('dd', { text: String(stats.edges) })]),
        el('div', {}, [el('dt', { text: 'Typy' }), el('dd', { text: Object.entries(stats.byType || {}).map(([type, count]) => `${type} ${count}`).join(' · ') || '—' })]),
      ]));
      if (data.nodes && data.nodes.length) {
        host.append(el('div', { class: 'mini-card-tags' }, data.nodes.slice(0, 20).map((node) => el('span', { class: 'tag', text: `${node.type}: ${node.label}` }))));
      } else {
        host.append(el('p', { class: 'empty-note', text: 'Graf jest pusty. Użyj „Uzupełnij z pamięci”, aby dodać zapisane fakty i dokumenty.' }));
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać grafu: ${err.message}`;
    }
  }

  async function loadOrg() {
    const host = panel('org');
    if (!host) return;
    try {
      const response = await api('/api/org');
      const data = response.data;
      if (!data) {
        host.textContent = 'Organizacja nie jest dostępna.';
        return;
      }
      host.textContent = '';
      host.append(el('p', { class: 'panel-note', text: `${data.total} agentów · limit głębokości delegacji ${data.maxDepth}` }));
      for (const [tier, entries] of Object.entries(data.tiers)) {
        host.append(el('p', { class: 'panel-note', text: `${tier} (${entries.length}): ${entries.map((entry) => entry.name).join(', ') || '—'}` }));
      }
      host.append(el('p', { class: 'panel-note', text: `Domeny: ${Object.entries(data.domains).map(([domain, info]) => `${domain} → ${info.lead}`).join(' · ')}` }));
    } catch (err) {
      host.textContent = `Nie mogę wczytać organizacji: ${err.message}`;
    }
  }

  async function loadMcp() {
    const host = panel('mcp');
    if (!host) return;
    try {
      const response = await api('/api/mcp');
      const data = response.data;
      if (!data) {
        host.textContent = 'MCP nie jest dostępne.';
        return;
      }
      host.textContent = '';
      host.append(el('p', { class: 'panel-note', text: `${data.enabled ? 'Włączone' : 'Wyłączone w ustawieniach (ai.mcp.enabled)'} · protokół ${data.preferredVersion} · wymagane zatwierdzenie: ${data.requireApproval ? 'tak' : 'nie'}` }));
      if (!data.servers.length) {
        host.append(el('p', { class: 'empty-note', text: 'Brak skonfigurowanych serwerów. Dodaj je w konfiguracji — nic nie łączy się automatycznie.' }));
        return;
      }
      for (const server of data.servers) {
        host.append(el('div', { class: 'mini-card' }, [
          el('strong', { text: `${server.id} · ${server.transport}` }),
          el('p', { class: 'panel-note', text: `${server.status}${server.protocolVersion ? ` · ${server.protocolVersion}` : ''} · ${server.tools} narzędzi${server.lastError ? ` · ${server.lastError}` : ''}` }),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: server.status === 'connected' ? 'Rozłącz' : 'Połącz',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              await api('/api/mcp', { method: 'POST', body: { action: server.status === 'connected' ? 'disconnect' : 'connect', server: server.id } });
              loadMcp();
            },
          }),
        ]));
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać MCP: ${err.message}`;
    }
  }

  function notify(message, options) {
    if (window.SentinelUI && window.SentinelUI.toast) window.SentinelUI.toast(message, options);
  }

  async function loadPatches() {
    const host = panel('patches');
    if (!host) return;
    try {
      const data = await api('/api/patches');
      const sessions = data.data || [];
      host.textContent = '';
      const form = el('div', { class: 'patch-form' }, [
        el('input', { class: 'field', type: 'text', placeholder: 'ścieżka pliku (np. C:/projekt/src/app.js)', id: 'patch-path' }),
        el('textarea', { class: 'field', id: 'patch-text', rows: 5, placeholder: 'pełna nowa treść pliku — nic nie zostanie zapisane bez weryfikacji i zatwierdzenia' }),
        el('input', { class: 'field', type: 'text', placeholder: 'powód zmiany (opcjonalnie)', id: 'patch-reason' }),
        el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: 'Etapuj zmianę',
            onclick: async (event) => {
              const path = $('#patch-path').value.trim();
              const text = $('#patch-text').value;
              if (!path || !text) return notify('Podaj ścieżkę i nową treść pliku.');
              event.currentTarget.disabled = true;
              const result = await api('/api/patches', { method: 'POST', body: { action: 'propose', path, text, reason: $('#patch-reason').value.trim() || null } });
              event.currentTarget.disabled = false;
              notify(result.ok ? `Zetapowano ${result.data.id} (+${result.data.added} −${result.data.removed})` : `Nie udało się: ${result.message || result.code}`);
              loadPatches();
            },
          }),
          el('span', { class: 'muted', text: 'zapis wymaga przejścia weryfikacji i Twojego zatwierdzenia' }),
        ]),
      ]);
      host.append(form);
      if (!sessions.length) {
        host.append(el('p', { class: 'empty-note', text: 'Brak zmian. Asystent w trybie kodowania proponuje zmiany tutaj, zamiast pisać do plików.' }));
        return;
      }
      for (const session of sessions) {
        const row = el('article', { class: 'card patch-row' }, [
          el('div', { class: 'task-head' }, [
            el('h3', { text: session.relative || session.file }),
            el('span', { class: `badge badge-${session.status}`, text: session.status }),
          ]),
          el('p', { class: 'muted', text: `+${session.added} −${session.removed} · ${session.verifier}${session.verification ? ` · ${session.verification.ok ? 'weryfikacja OK' : 'weryfikacja nieudana'}` : ''}${session.description ? ` · ${session.description}` : ''}` }),
          el('div', { class: 'row-actions' }, [
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: 'Pokaż diff',
              onclick: async () => {
                const detail = await api(`/api/patches?id=${encodeURIComponent(session.id)}`);
                if (session.diffNode) session.diffNode.remove();
                const diffNode = el('pre', { class: 'patch-diff', text: detail.diff || 'brak diffu' });
                session.diffNode = diffNode;
                row.append(diffNode);
              },
            }),
            ['staged', 'failed'].includes(session.status)
              ? el('button', {
                  class: 'btn btn-ghost',
                  type: 'button',
                  text: 'Weryfikuj',
                  onclick: async (event) => {
                    event.currentTarget.disabled = true;
                    const result = await api('/api/patches', { method: 'POST', body: { action: 'verify', id: session.id } });
                    notify(result.ok && result.data && result.data.ok ? `Weryfikacja OK (${result.data.ms} ms)` : `Weryfikacja nieudana: ${(result.data && (result.data.output || result.data.message)) || result.message || ''}`.slice(0, 240));
                    loadPatches();
                  },
                })
              : null,
            session.status === 'verified'
              ? el('button', {
                  class: 'btn btn-primary',
                  type: 'button',
                  text: 'Zastosuj…',
                  onclick: () => {
                    (window.SentinelUI ? window.SentinelUI.confirmSheet : (options) => options.onConfirm())({
                      title: 'Zapisać zmianę?',
                      body: `${session.file} zostanie nadpisany. Kopia poprzedniej treści jest zachowywana automatycznie.`,
                      confirmLabel: 'Zapisz plik',
                      onConfirm: async () => {
                        const pending = await api('/api/patches', { method: 'POST', body: { action: 'apply', id: session.id } });
                        if (pending.ok) {
                          notify('Zapisano plik.');
                          return loadPatches();
                        }
                        if (pending.code === 'APPROVAL_REQUIRED' && pending.approval) {
                          const decided = await api('/api/approvals/decide', { method: 'POST', body: { id: pending.approval.id, approve: true } });
                          notify(decided.ok ? `Zapisano: ${decided.result && decided.result.data ? decided.result.data.file : session.file}` : `Nie zapisano: ${decided.result ? decided.result.message : decided.message}`);
                          return loadPatches();
                        }
                        notify(`Nie zapisano: ${pending.message || pending.code}`);
                      },
                    });
                  },
                })
              : null,
            ['staged', 'verified', 'failed'].includes(session.status)
              ? el('button', {
                  class: 'btn btn-ghost',
                  type: 'button',
                  text: 'Odrzuć',
                  onclick: async () => {
                    await api('/api/patches', { method: 'POST', body: { action: 'discard', id: session.id } });
                    loadPatches();
                  },
                })
              : null,
          ]),
        ]);
        host.append(row);
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać zmian: ${err.message}`;
    }
  }

  async function loadEventLog() {
    const host = panel('eventlog');
    if (!host) return;
    try {
      const data = await api('/api/eventlog?limit=40');
      const events = data.data || [];
      host.textContent = '';
      if (!events.length) host.append(el('li', { class: 'empty-note', text: 'Brak zdarzeń.' }));
      for (const event of events.slice().reverse()) {
        const detail = event.payload && (event.payload.stage || event.payload.action || event.payload.name) ? String(event.payload.stage || event.payload.action || event.payload.name) : '';
        host.append(
          el('li', { class: `eventlog-row severity-${event.severity || 'info'}` }, [
            el('time', { class: 'muted', text: new Date(event.at).toLocaleTimeString() }),
            el('span', { class: 'tag', text: event.topic }),
            el('span', { text: detail }),
          ]),
        );
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać zdarzeń: ${err.message}`;
    }
  }

  async function loadExperience() {
    const host = panel('experience');
    if (!host) return;
    try {
      const data = await api('/api/experience');
      const snapshot = data.data || {};
      const strategies = (snapshot.strategies || []).slice().sort((a, b) => b.score - a.score).slice(0, 8);
      host.textContent = '';
      if (!strategies.length) {
        host.append(el('p', { class: 'empty-note', text: 'Brak danych — strategie pojawiają się po pierwszych przebiegach.' }));
      } else {
        host.append(
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Zadanie', 'Strategia', 'Wynik', 'Próbki', 'Czas'].map((label) => el('th', { text: label })))]),
            el('tbody', {}, strategies.map((entry) => el('tr', {}, [
              el('td', { text: entry.taskClass }),
              el('td', { text: entry.strategy }),
              el('td', { text: entry.score.toFixed(2) }),
              el('td', { text: String(entry.samples) }),
              el('td', { text: `${Math.round(entry.avgMs || 0)} ms` }),
            ]))),
          ]),
        );
      }
      if (snapshot.feedback && snapshot.feedback.length) {
        const average = snapshot.feedback.reduce((sum, entry) => sum + entry.rating, 0) / snapshot.feedback.length;
        host.append(el('p', { class: 'panel-note', text: `Opinie użytkownika: ${snapshot.feedback.length}, średnia ${average.toFixed(2)}` }));
      }
      if (snapshot.candidates && snapshot.candidates.length) {
        host.append(
          el('p', {
            class: 'panel-note',
            text: `Kandydaci na ulepszenia (nigdy nie wdrażani automatycznie): ${snapshot.candidates.map((entry) => `${entry.name}: ${entry.status}`).join(' · ')}`,
          }),
        );
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać doświadczenia: ${err.message}`;
    }
  }

  async function loadReliability() {
    const host = panel('reliability');
    if (!host) return;
    try {
      const data = await api('/api/reliability');
      const info = data.data || {};
      host.textContent = '';
      const breakers = info.breakers || [];
      host.append(
        el('div', { class: 'mini-card-tags' }, breakers.length
          ? breakers.map((breaker) => el('span', { class: `tag ${breaker.state === 'open' ? 'tag-warn' : ''}`, text: `${breaker.name}: ${breaker.state} (${breaker.failures || 0} błędów)` }))
          : [el('span', { class: 'tag', text: 'bezpieczniki bezczynne' })]),
      );
      const incidents = info.incidents || { active: [], recent: [] };
      if (incidents.active && incidents.active.length) {
        host.append(el('p', { class: 'panel-note', text: `Aktywne incydenty: ${incidents.active.map((entry) => `${entry.subsystem}/${entry.code} ×${entry.count}`).join(' · ')}` }));
      } else {
        host.append(el('p', { class: 'panel-note', text: 'Brak aktywnych incydentów.' }));
      }
      const watchdogs = info.watchdogs || [];
      if (watchdogs.length) {
        host.append(el('p', { class: 'panel-note', text: `Watchdogi: ${watchdogs.map((entry) => `${entry.name}: ${entry.state === 'up' ? 'sprawny' : entry.state}${entry.lastDetail ? ` (${entry.lastDetail})` : ''}`).join(' · ')}` }));
      }
      if (incidents.recent && incidents.recent.length) {
        host.append(
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Czas', 'Podsystem', 'Kod', 'Opis'].map((label) => el('th', { text: label })))]),
            el('tbody', {}, incidents.recent.slice(-6).reverse().map((entry) => el('tr', {}, [
              el('td', { text: new Date(entry.at).toLocaleTimeString() }),
              el('td', { text: entry.subsystem }),
              el('td', { text: entry.code }),
              el('td', { text: entry.message || '' }),
            ]))),
          ]),
        );
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać niezawodności: ${err.message}`;
    }
  }

  async function loadModels() {
    const host = panel('models');
    if (!host) return;
    host.textContent = 'Pytam providery…';
    try {
      const data = await api('/api/models');
      state.models = data.data;
      host.textContent = '';
      const providers = el('div', { class: 'grid-cards' });
      for (const [name, entry] of Object.entries(state.models.providers || {})) {
        providers.append(
          el('article', { class: 'card mini-card' }, [
            el('div', { class: 'mini-card-head' }, [el('h3', { text: name }), el('span', { class: `badge ${entry.ok ? 'badge-ok' : 'badge-bad'}`, text: entry.ok ? 'online' : 'offline' })]),
            el('p', { class: 'mini-card-desc', text: entry.ok ? `${(entry.models || []).length} modeli · ${entry.baseUrl || ''}` : entry.error || 'brak odpowiedzi' }),
            el('div', { class: 'mini-card-tags' }, (entry.models || []).slice(0, 6).map((model) => el('span', { class: 'tag', text: model.id }))),
          ]),
        );
      }
      host.append(el('p', { class: 'panel-note', text: `Tryb: ${state.models.mode} · zewnętrzne API: ${state.models.allowExternal ? 'włączone' : 'wyłączone'} · offline: ${state.models.offline ? 'tak' : 'nie'}` }));
      host.append(providers);
      const benchmark = el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Benchmark (time-to-first-token)',
        onclick: async () => {
          benchmark.disabled = true;
          benchmark.textContent = 'Mierzę…';
          try {
            const result = await api('/api/models/benchmark', { method: 'POST', body: { modelClass: state.mode } });
            benchmark.textContent = result.ok ? `${result.data.model}: ${result.data.firstTokenMs} ms do pierwszego tokenu, ${result.data.tokensPerSecond} tok/s` : `błąd: ${result.message}`;
          } catch (err) {
            benchmark.textContent = `błąd: ${err.message}`;
          }
          benchmark.disabled = false;
        },
      });
      host.append(benchmark);
    } catch (err) {
      host.textContent = `Nie mogę sprawdzić modeli: ${err.message}`;
    }
  }

  async function loadLab() {
    const host = panel('lab');
    if (!host) return;
    host.textContent = 'Czytam laboratorium…';
    try {
      const [lab, neural, research, hypercore, reranker, comm, briefing, proactive, specialists] = await Promise.all([api('/api/lab'), api('/api/neural'), api('/api/research'), api('/api/hypercore'), api('/api/reranker'), api('/api/communication'), api('/api/briefing'), api('/api/proactive'), api('/api/specialists')]);
      const data = lab.data || {};
      host.textContent = '';
      const active = data.active;
      host.append(
        el('p', { class: 'panel-note', text: active
          ? `Aktywny model: ${active.experimentId} · test ${active.metrics.accuracy} · promowany przez ${active.promotedBy}`
          : 'Brak aktywnego modelu. Trening: sentinel train --approve <imię>; promocja: sentinel lab promote <id> --approve <imię>.' }),
      );
      const provenance = el('p', { class: 'panel-note', text: `Dataset: ${data.dataset ? data.dataset.items : 0} przykładów, ${data.dataset ? data.dataset.labels.length : 0} intencji · ${data.dataset ? data.dataset.provenance : 'brak'} · ${data.honest || ''}` });
      host.append(provenance);
      const cards = el('div', { class: 'grid-cards' });
      for (const experiment of (data.experiments || []).slice(0, 6)) {
        cards.append(
          el('article', { class: 'card mini-card' }, [
            el('div', { class: 'mini-card-head' }, [el('h3', { text: experiment.id.split('_').slice(-1)[0] }), el('span', { class: `badge ${experiment.status === 'candidate' ? 'badge-ok' : 'badge-bad'}`, text: experiment.status })]),
            el('p', { class: 'mini-card-desc', text: `test ${experiment.accuracy} vs baseline ${experiment.baseline} (delta ${experiment.delta}) · ${experiment.artifact.bytes} B` }),
            el('div', { class: 'mini-card-tags' }, [el('span', { class: 'tag', text: `sha ${String(experiment.artifact.checksum).slice(0, 12)}…` }), el('span', { class: 'tag', text: experiment.approvedBy || 'bez zgody' })]),
          ]),
        );
      }
      host.append(cards);
      const neuralBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Neural runtime' }),
        el('p', { class: 'mini-card-desc', text: `${(neural.data && neural.data.models ? neural.data.models.length : 0)} modeli w metadanych · ${(neural.data && neural.data.counts ? neural.data.counts.tools : 0)} z narzędziami · ${(neural.data && neural.data.counts ? neural.data.counts.vision : 0)} wizyjnych` }),
        el('p', { class: 'mini-card-desc', text: neural.data && neural.data.honest ? neural.data.honest : 'metadane tylko z providery' }),
      ]);
      const researchBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Sesje badawcze' }),
        el('p', { class: 'mini-card-desc', text: `${(research.data && research.data.status ? research.data.status.sessions : 0)} sesji · ${(research.data && research.data.status ? research.data.status.sources : 0)} źródeł · online tylko za zgodą` }),
        el('div', { class: 'mini-card-tags' }, ((research.data && research.data.sessions) || []).slice(0, 5).map((session) => el('span', { class: 'tag', text: `${session.status}: ${session.question.slice(0, 40)}` }))),
      ]);
      const hyperBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Hypercore poznawczy' }),
        el('p', { class: 'mini-card-desc', text: hypercore.data && hypercore.data.counts ? `${hypercore.data.counts.goals} celów · ${hypercore.data.counts.beliefs} przekonań · ${hypercore.data.counts.hypotheses} hipotez · ${hypercore.data.counts.openConflicts} sprzeczności` : 'stan niedostępny' }),
        el('p', { class: 'mini-card-desc', text: hypercore.data && hypercore.data.honest ? hypercore.data.honest : 'brak danych' }),
      ]);
      const rerankBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Reranker' }),
        el('p', { class: 'mini-card-desc', text: reranker.data && reranker.data.active ? `NDCG@3 ${reranker.data.active.metrics.ndcgAt3} vs baseline ${reranker.data.active.baseline.ndcgAt3}` : 'brak aktywnego modelu' }),
        el('p', { class: 'mini-card-desc', text: reranker.data ? reranker.data.honest : 'brak danych' }),
      ]);
      const commBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Komunikacja' }),
        el('p', { class: 'mini-card-desc', text: comm.data && comm.data.status ? `${comm.data.status.provider.name} · live: ${comm.data.status.liveCalls} · ${comm.data.status.today.calls} połączeń dzisiaj` : 'brak danych' }),
        el('p', { class: 'mini-card-desc', text: comm.data && comm.data.status ? comm.data.status.honest : 'brak danych' }),
      ]);
      const briefBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Briefing' }),
        el('p', { class: 'mini-card-desc', text: briefing.data && briefing.data.counts ? `${briefing.data.items.length} pozycji · ${briefing.data.counts.overdue} po terminie · ${briefing.data.counts.conflicts} sprzeczności` : 'brak danych' }),
      ]);
      const proactiveBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Proaktywność' }),
        el('p', { class: 'mini-card-desc', text: proactive.data && proactive.data.counts ? `${proactive.data.counts.enabled}/${proactive.data.counts.rules} reguł · kanał: ${proactive.data.deliveryConfigured ? 'skonfigurowany' : 'brak'}` : 'brak danych' }),
      ]);
      const specActive = specialists.data && specialists.data.specialists ? specialists.data.specialists.filter((entry) => entry.active) : [];
      const specBox = el('article', { class: 'card mini-card' }, [
        el('h3', { text: 'Specjaliści' }),
        el('p', { class: 'mini-card-desc', text: `${specActive.length}/4 aktywnych modeli` }),
        el('div', { class: 'mini-card-tags' }, specActive.slice(0, 4).map((entry) => el('span', { class: 'tag', text: `${entry.task}: ${entry.active.metrics.accuracy} vs ${entry.active.baseline.accuracy}` }))),
        el('p', { class: 'mini-card-desc', text: specialists.data ? specialists.data.honest : 'brak danych' }),
      ]);
      host.append(el('div', { class: 'grid-cards' }, [neuralBox, researchBox, hyperBox, rerankBox, commBox, briefBox, proactiveBox, specBox]));
    } catch (err) {
      host.textContent = `Nie mogę wczytać laboratorium: ${err.message}`;
    }
  }

  async function loadTasks() {
    const host = panel('tasks');
    if (!host) return;
    try {
      const data = await api('/api/tasks');
      const list = data.data || [];
      host.textContent = '';
      host.append(el('p', { class: 'panel-note', text: `${list.length} zadań · ${JSON.stringify(data.stats ? data.stats.byStatus : {})}` }));
      if (!list.length) host.append(el('p', { class: 'empty-note', text: 'Brak zadań. W trybie Deep SENTINEL planuje kroki i tworzy zadanie.' }));
      for (const task of list) {
        host.append(
          el('article', { class: 'card task-row' }, [
            el('div', { class: 'task-head' }, [el('h3', { text: task.title }), el('span', { class: `badge badge-${task.status}`, text: task.status })]),
            el('div', { class: 'progress' }, [el('div', { class: 'progress-fill', style: `width:${task.progress}%` })]),
            el('p', { class: 'muted', text: `${task.done}/${task.steps} kroków · ${new Date(task.createdAt).toLocaleString()}` }),
            el('p', { class: 'muted', text: `${task.failed ? `${task.failed} nieudanych · ` : ''}${task.retries ? `${task.retries} ponowień · ` : ''}${task.checkpoint ? `checkpoint #${task.checkpoint.seq} · ` : ''}${task.error || ''}` }),
            el('div', { class: 'row-actions' }, [
              ['running', 'pending', 'planning', 'verifying'].includes(task.status)
                ? el('button', {
                    class: 'btn btn-ghost',
                    type: 'button',
                    text: 'Pauza',
                    onclick: async () => {
                      await api('/api/tasks/pause', { method: 'POST', body: { id: task.id } });
                      loadTasks();
                    },
                  })
                : null,
              ['paused', 'interrupted'].includes(task.status)
                ? el('button', {
                    class: 'btn btn-ghost',
                    type: 'button',
                    text: 'Wznów',
                    onclick: async () => {
                      await api('/api/tasks/resume', { method: 'POST', body: { id: task.id } });
                      loadTasks();
                    },
                  })
                : null,
              ['running', 'pending', 'planning', 'verifying', 'paused', 'waiting_approval'].includes(task.status)
                ? el('button', {
                    class: 'btn btn-ghost',
                    type: 'button',
                    text: 'Anuluj',
                    onclick: async () => {
                      await api('/api/tasks/cancel', { method: 'POST', body: { id: task.id } });
                      loadTasks();
                    },
                  })
                : null,
            ]),
          ]),
        );
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać zadań: ${err.message}`;
    }
  }

  async function refreshTasks() {
    if (document.querySelector('[data-panel="tasks"]') && !document.querySelector('#screen-tasks')?.hidden) loadTasks();
  }

  async function loadMemory() {
    const host = panel('memory');
    if (!host) return;
    host.textContent = 'Czytam pamięć…';
    try {
      const data = await api('/api/memory');
      const records = data.data || [];
      const stats = data.stats || {};
      host.textContent = '';
      host.append(
        el('p', {
          class: 'panel-note',
          text: `${stats.total || 0} ${plural(stats.total, 'wspomnienie', 'wspomnienia', 'wspomnień')} · ${stats.store ? `${stats.store.driver}, ${bytes(stats.store.bytes || 0)}` : ''} · embedder ${stats.embedder ? stats.embedder.name : '?'}`,
        }),
      );
      const conflicts = el('div', { class: 'conflicts' });
      api('/api/memory/conflicts').then((result) => {
        const pairs = (result && result.data) || [];
        if (!pairs.length) return;
        conflicts.append(el('h3', { text: `Sprzeczności (${pairs.length})` }));
        conflicts.append(el('p', { class: 'panel-note', text: 'SENTINEL zachowuje oba fakty i pokazuje je — nie nadpisuje po cichu.' }));
        for (const pair of pairs.slice(0, 5)) {
          conflicts.append(el('article', { class: 'card memory-row' }, [el('p', { text: `A: ${pair.a.text}` }), el('p', { text: `B: ${pair.b.text}` })]));
        }
        host.append(conflicts);
      }).catch(() => {});
      const search = el('input', { class: 'field', type: 'search', placeholder: 'Szukaj w pamięci…' });
      const results = el('div', { class: 'memory-list' });
      const render = (items) => {
        results.textContent = '';
        if (!items.length) results.append(el('p', { class: 'empty-note', text: 'Nic nie znaleziono.' }));
        for (const record of items) {
          results.append(
            el('article', { class: 'card memory-row' }, [
              el('div', { class: 'memory-head' }, [el('span', { class: 'tag', text: record.kind }), el('span', { class: 'muted', text: new Date(record.updatedAt || record.createdAt).toLocaleString() })]),
              el('p', { text: record.text }),
              el('div', { class: 'memory-foot' }, [
                el('span', { class: 'muted', text: (record.tags || []).join(' · ') || '—' }),
                el('button', {
                  class: 'btn btn-ghost btn-tiny',
                  type: 'button',
                  text: 'Zapomnij',
                  onclick: async () => {
                    await api('/api/memory', { method: 'POST', body: { action: 'forget', id: record.id } });
                    loadMemory();
                  },
                }),
              ]),
            ]),
          );
        }
      };
      search.addEventListener('input', async () => {
        const query = search.value.trim();
        if (!query) return render(records);
        try {
          const hits = await api(`/api/memory?q=${encodeURIComponent(query)}`);
          render(hits.data || []);
        } catch {
          render([]);
        }
      });
      const add = el('form', {
        class: 'inline-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const text = add.querySelector('input').value.trim();
          if (!text) return;
          const result = await api('/api/memory', { method: 'POST', body: { text, kind: 'long_term', importance: 0.7 } });
          add.querySelector('input').value = '';
          if (result.rejected) alert(`Nie zapisano: ${result.rejected}`);
          loadMemory();
        },
      }, [
        el('input', { class: 'field', type: 'text', placeholder: 'Zapamiętaj coś trwałego…', maxlength: '500' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Zapamiętaj' }),
      ]);
      host.append(search, add, results);
      render(records);
    } catch (err) {
      host.textContent = `Nie mogę wczytać pamięci: ${err.message}`;
    }
  }

  async function loadKnowledge() {
    const host = panel('knowledge');
    if (!host) return;
    host.textContent = 'Czytam bazę wiedzy…';
    try {
      const data = await api('/api/knowledge');
      const docs = data.data || [];
      const stats = data.stats || {};
      host.textContent = '';
      host.append(
        el('p', {
          class: 'panel-note',
          text: `${stats.documents || 0} ${plural(stats.documents, 'dokument', 'dokumenty', 'dokumentów')} · ${stats.chunks || 0} ${plural(stats.chunks, 'fragment', 'fragmenty', 'fragmentów')} · ${bytes(stats.characters || 0)} tekstu (PDF, DOCX, XLSX, MD, kod, logi)`,
        }),
      );
      const form = el('form', {
        class: 'inline-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const input = form.querySelector('input');
          const path = input.value.trim();
          if (!path) return;
          const button = form.querySelector('button');
          button.disabled = true;
          button.textContent = 'Indeksuję…';
          try {
            const result = await api('/api/knowledge', { method: 'POST', body: { path, recursive: true, maxFiles: 300 } });
            button.textContent = result.ok ? `Dodano ${result.data.indexed} plików` : `Błąd: ${result.message}`;
            if (result.ok) loadKnowledge();
          } catch (err) {
            button.textContent = `Błąd: ${err.message}`;
          }
          button.disabled = false;
        },
      }, [
        el('input', { class: 'field', type: 'text', placeholder: 'Ścieżka do pliku lub folderu…' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Zaindeksuj' }),
      ]);
      const search = el('input', { class: 'field', type: 'search', placeholder: 'Szukaj w dokumentach…' });
      const results = el('div', { class: 'kb-list' });
      const renderDocs = () => {
        results.textContent = '';
        if (!docs.length) results.append(el('p', { class: 'empty-note', text: 'Baza jest pusta. Wskaż folder (np. Dokumenty) powyżej.' }));
        for (const doc of docs) {
          results.append(
            el('article', { class: 'card kb-row' }, [
              el('div', { class: 'kb-head' }, [el('h3', { text: doc.title }), el('span', { class: 'tag', text: doc.kind || 'text' })]),
              el('p', { class: 'muted', text: `${doc.chunks} fragmentów · ${doc.path || 'notatka'} · ${doc.tags && doc.tags.length ? doc.tags.join(', ') : 'bez tagów'}` }),
              el('button', {
                class: 'btn btn-ghost btn-tiny',
                type: 'button',
                text: 'Usuń z bazy',
                onclick: async () => {
                  await api('/api/knowledge', { method: 'POST', body: { action: 'remove', id: doc.id } });
                  loadKnowledge();
                },
              }),
            ]),
          );
        }
      };
      search.addEventListener('input', async () => {
        const query = search.value.trim();
        if (!query) return renderDocs();
        try {
          const hits = await api(`/api/knowledge?q=${encodeURIComponent(query)}`);
          results.textContent = '';
          for (const hit of hits.data || []) {
            results.append(
              el('article', { class: 'card kb-row' }, [
                el('div', { class: 'kb-head' }, [el('h3', { text: hit.title }), el('span', { class: 'tag', text: `§${hit.chunk}` })]),
                el('p', { text: hit.excerpt }),
                el('p', { class: 'muted', text: `${hit.source} · score ${hit.score}` }),
              ]),
            );
          }
          if (!(hits.data || []).length) results.append(el('p', { class: 'empty-note', text: 'Nic nie pasuje.' }));
        } catch {
          /* keep the doc list */
        }
      });
      host.append(form, search, results);
      renderDocs();
    } catch (err) {
      host.textContent = `Nie mogę wczytać bazy wiedzy: ${err.message}`;
    }
  }

  async function loadAutomations() {
    const host = panel('automations');
    if (!host) return;
    try {
      const data = await api('/api/automations');
      const items = data.data || [];
      host.textContent = '';
      const form = el('form', {
        class: 'inline-form wrap',
        onsubmit: async (event) => {
          event.preventDefault();
          const name = form.querySelector('[name=name]').value.trim();
          const prompt = form.querySelector('[name=prompt]').value.trim();
          if (!name || !prompt) return;
          const every = Number(form.querySelector('[name=every]').value) || 60;
          await api('/api/automations', { method: 'POST', body: { name, prompt, everyMinutes: every, type: 'interval' } });
          loadAutomations();
        },
      }, [
        el('input', { class: 'field', name: 'name', type: 'text', placeholder: 'Nazwa', maxlength: '80', required: 'required' }),
        el('input', { class: 'field', name: 'prompt', type: 'text', placeholder: 'Pytanie do asystenta', maxlength: '300', required: 'required' }),
        el('input', { class: 'field field-narrow', name: 'every', type: 'number', min: '5', max: '10080', value: '60' }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: 'Dodaj' }),
      ]);
      host.append(el('p', { class: 'panel-note', text: 'Automatyzacje działają lokalnie. Każde uruchomienie przechodzi przez te same uprawnienia i limity co ręczne polecenie.' }), form);
      if (!items.length) host.append(el('p', { class: 'empty-note', text: 'Brak automatyzacji.' }));
      for (const item of items) {
        host.append(
          el('article', { class: 'card automation-row' }, [
            el('div', { class: 'task-head' }, [
              el('h3', { text: item.name }),
              el('span', { class: `badge ${item.enabled ? 'badge-ok' : 'badge-bad'}`, text: item.enabled ? 'aktywna' : 'pauza' }),
            ]),
            el('p', { class: 'muted', text: `${item.trigger.type === 'daily' ? `codziennie ${item.trigger.at}` : `co ${item.trigger.everyMinutes} min`} · ${item.action.type === 'prompt' ? item.action.prompt : item.action.command} · przebiegi: ${item.runCount}` }),
            item.lastResult ? el('p', { class: 'muted', text: `ostatnio: ${item.lastResult.ok ? 'ok' : item.lastResult.message || 'błąd'}` }) : null,
            el('div', { class: 'row-actions' }, [
              el('button', {
                class: 'btn btn-ghost btn-tiny',
                type: 'button',
                text: item.enabled ? 'Pauza' : 'Wznów',
                onclick: async () => {
                  await api('/api/automations', { method: 'POST', body: { action: 'toggle', id: item.id, enabled: !item.enabled } });
                  loadAutomations();
                },
              }),
              el('button', {
                class: 'btn btn-ghost btn-tiny',
                type: 'button',
                text: 'Uruchom teraz',
                onclick: async () => {
                  await api('/api/automations', { method: 'POST', body: { action: 'run', id: item.id } });
                  loadAutomations();
                },
              }),
              el('button', {
                class: 'btn btn-ghost btn-tiny danger',
                type: 'button',
                text: 'Usuń',
                onclick: async () => {
                  await api('/api/automations', { method: 'POST', body: { action: 'delete', id: item.id } });
                  loadAutomations();
                },
              }),
            ]),
          ]),
        );
      }
    } catch (err) {
      host.textContent = `Nie mogę wczytać automatyzacji: ${err.message}`;
    }
  }

  async function loadComputer() {
    const host = panel('computer');
    if (!host) return;
    host.textContent = 'Odczytuję stan komputera…';
    try {
      const [snapshot, status] = await Promise.all([api('/api/status'), api('/api/ai/status')]);
      const snap = snapshot.data || {};
      host.textContent = '';
      const metrics = el('div', { class: 'metrics-grid' }, [
        metric('CPU', `${snap.cpuPercent ?? '—'}%`),
        metric('RAM', `${snap.memoryDetail ? snap.memoryDetail.percent : '—'}%`),
        metric('Uptime', snap.uptimeLabel || '—'),
        metric('ESP32', snap.esp && snap.esp.connected ? 'połączony' : 'offline'),
      ]);
      host.append(el('h3', { class: 'section-title', text: 'Ten komputer' }), metrics);
      const ai = status.data && status.data.brain ? status.data.brain : null;
      if (ai) {
        host.append(
          el('h3', { class: 'section-title', text: 'Asystent' }),
          el('div', { class: 'metrics-grid' }, [
            metric('Pytania', String(ai.counters.questions)),
            metric('Odpowiedzi', String(ai.counters.answers)),
            metric('Narzędzia', String(ai.counters.toolCalls)),
            metric('Bez modelu', String(ai.counters.noModel)),
          ]),
        );
      }
      const processes = await api('/api/command', { method: 'POST', body: { cmd: 'process.list', args: { limit: 12 } } });
      if (processes.ok && processes.data && processes.data.processes) {
        const table = el('div', { class: 'tool-list' });
        for (const proc of processes.data.processes) {
          table.append(
            el('div', { class: 'tool-row' }, [
              el('code', { class: 'tool-name', text: String(proc.pid) }),
              el('span', { class: 'tool-desc', text: proc.name }),
              el('span', { class: 'tag', text: `${proc.memMB ?? '?'} MB` }),
            ]),
          );
        }
        host.append(el('h3', { class: 'section-title', text: 'Najcięższe procesy' }), table);
      }
    } catch (err) {
      host.textContent = `Nie mogę odczytać stanu: ${err.message}`;
    }
  }

  function metric(label, value) {
    return el('div', { class: 'metric-card' }, [el('span', { class: 'metric-label', text: label }), el('strong', { class: 'metric-value', text: value })]);
  }

  async function loadDiagnostics() {
    const host = panel('diagnostics');
    if (!host) return;
    host.textContent = 'Uruchamiam diagnostykę…';
    try {
      const [doctor, status] = await Promise.all([
        api('/api/doctor', { method: 'POST', body: {} }).catch((err) => ({ ok: false, data: { summary: err.message, checks: [] } })),
        api('/api/ai/status'),
      ]);
      host.textContent = '';
      const data = doctor.data || {};
      host.append(
        el('p', { class: `panel-note ${data.ok ? 'ok' : 'warn'}`, text: `${data.ok ? '✓' : '✗'} ${data.summary}` }),
        el('div', { class: 'checks' }, (data.checks || []).map((check) =>
          el('div', { class: `check ${check.ok ? 'check-ok' : 'check-bad'}` }, [
            el('span', { class: 'check-id', text: check.id }),
            el('span', { class: 'check-detail', text: check.detail }),
            check.fix ? el('span', { class: 'check-fix', text: `→ ${check.fix}` }) : null,
          ]),
        )),
      );
      const ai = status.data || {};
      host.append(
        el('h3', { class: 'section-title', text: 'Stos AI' }),
        el('pre', { class: 'code-block', text: JSON.stringify({ ready: ai.ready, brain: ai.brain && ai.brain.counters, agents: ai.agents && ai.agents.agents, tools: ai.tools, llm: ai.llm, memory: ai.memory && { total: ai.memory.total }, knowledge: ai.knowledge && { documents: ai.knowledge.documents, chunks: ai.knowledge.chunks } }, null, 2) }),
      );
      const backups = await api('/api/backups').catch(() => ({ data: [] }));
      host.append(el('h3', { class: 'section-title', text: 'Backupy' }));
      host.append(el('div', { class: 'tool-list' }, (backups.data || []).map((backup) => el('div', { class: 'tool-row' }, [el('code', { class: 'tool-name', text: backup.name }), el('span', { class: 'tool-desc', text: backup.createdAt })]))));
      if (!(backups.data || []).length) host.append(el('p', { class: 'empty-note', text: 'Brak backupów. Instalator i self-healing tworzą je automatycznie.' }));
    } catch (err) {
      host.textContent = `Diagnostyka nie odpowiada: ${err.message}`;
    }
  }

  /* ── approvals banner ────────────────────────────────────────────────── */

  async function refreshApprovals() {
    const host = $('#approval-strip');
    if (!host) return;
    try {
      const data = await api('/api/approvals');
      state.approvals = data.data || [];
    } catch {
      return;
    }
    host.textContent = '';
    if (!state.approvals.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    for (const approval of state.approvals) {
      host.append(
        el('div', { class: 'approval-strip-card' }, [
          el('div', {}, [
            el('strong', { text: `${approval.tool}` }),
            el('span', { class: 'muted', text: ` — ${approval.reason}` }),
          ]),
          el('div', { class: 'row-actions' }, [
            el('button', { class: 'btn btn-ok btn-tiny', type: 'button', text: 'Zezwól', onclick: () => decideApproval(approval.id, true) }),
            el('button', { class: 'btn btn-ghost btn-tiny', type: 'button', text: 'Odmów', onclick: () => decideApproval(approval.id, false) }),
          ]),
        ]),
      );
    }
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  function wireChat() {
    chatEls.list = $('#chat-messages');
    chatEls.input = $('#chat-input');
    chatEls.send = $('#chat-send');
    chatEls.stop = $('#chat-stop');
    chatEls.stage = $('#chat-stage');
    const form = $('#chat-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        sendMessage();
      });
    }
    if (chatEls.input) {
      chatEls.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      });
      chatEls.input.addEventListener('input', () => {
        chatEls.input.style.height = 'auto';
        chatEls.input.style.height = `${Math.min(200, chatEls.input.scrollHeight)}px`;
      });
    }
    if (chatEls.stop) chatEls.stop.addEventListener('click', stopRun);
    $$('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        $$('[data-mode]').forEach((other) => other.classList.toggle('is-on', other === button));
        api('/api/ai/mode', { method: 'POST', body: { mode: state.mode } }).catch(() => {});
      });
    });

    const cognitionRefresh = $('#btn-cognition-refresh');
    if (cognitionRefresh) cognitionRefresh.addEventListener('click', loadCognition);

    const graphForm = $('#graph-form');
    if (graphForm) {
      graphForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = ($('#graph-query') && $('#graph-query').value.trim()) || '';
        loadGraph(value);
      });
    }
    const graphSync = $('#graph-sync');
    if (graphSync) {
      graphSync.addEventListener('click', async () => {
        graphSync.disabled = true;
        const result = await api('/api/graph', { method: 'POST', body: { action: 'sync' } });
        graphSync.disabled = false;
        if (!result.ok) notify(result.message || 'Synchronizacja grafu nie powiodła się', { tone: 'warn' });
        loadGraph();
      });
    }

    document.addEventListener('keydown', (event) => {
      const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable);
      // Ctrl/Cmd+K jumps to the composer from anywhere; Escape stops a run.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onTab('chat');
        if (chatEls.input) chatEls.input.focus();
      }
      if (event.key === 'Escape' && state.running) {
        event.preventDefault();
        stopRun();
      }
      if (!typing && event.key === '?' && !event.ctrlKey && !event.metaKey) {
        notify('Skróty: Ctrl+K — czat, Escape — stop, Enter — wyślij, Shift+Enter — nowa linia');
      }
    });

    const mic = $('#chat-mic');
    if (mic) {
      mic.addEventListener('click', () => toggleMic(mic));
    }

    const attach = $('#chat-attach');
    if (attach) {
      attach.addEventListener('click', () => $('#chat-file').click());
      $('#chat-file').addEventListener('change', (event) => addAttachments(Array.from(event.target.files || [])));
    }
    const drop = $('#screen-chat');
    if (drop) {
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('dropping');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('dropping'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('dropping');
        addAttachments(Array.from((event.dataTransfer && event.dataTransfer.files) || []));
      });
    }
  }

  function addAttachments(files) {
    state.attachments = (state.attachments || []).concat(files).slice(0, 3);
    const host = $('#chat-attachments');
    if (!host) return;
    host.textContent = '';
    for (const file of state.attachments) {
      host.append(
        el('div', { class: 'attachment' }, [
          el('span', { text: `${file.name} (${bytes(file.size)})` }),
          el('button', {
            class: 'icon-btn',
            type: 'button',
            'aria-label': 'Usuń',
            text: '×',
            onclick: () => {
              state.attachments = state.attachments.filter((entry) => entry !== file);
              addAttachments([]);
            },
          }),
        ]),
      );
    }
  }

  async function toggleMic(button) {
    if (state.audio) {
      state.audio.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      alert('Ta przeglądarka nie udostępnia nagrywania. Użyj przycisku push-to-talk w aplikacji Android.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      state.audio = {
        stop: () => {
          recorder.stop();
          stream.getTracks().forEach((track) => track.stop());
          state.audio = null;
          button.classList.remove('is-recording');
        },
      };
      button.classList.add('is-recording');
      Orb.set('listening');
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        try {
          const result = await api('/api/voice/transcribe', { method: 'POST', body: { audio: await blobToBase64(blob), language: 'pl' } });
          if (result.ok && result.text) {
            chatEls.input.value = result.text;
            sendMessage(result.text);
          } else {
            appendMessage({ role: 'assistant', text: `Nie udało się rozpoznać mowy: ${result.message || 'brak transkrypcji'}. Zainstaluj whisper.cpp i model ggml-base.bin.`, at: Date.now(), error: true });
          }
        } catch (err) {
          appendMessage({ role: 'assistant', text: `STT nie odpowiada: ${err.message}`, at: Date.now(), error: true });
        }
        Orb.set('idle');
      };
      recorder.start();
    } catch (err) {
      alert(`Brak dostępu do mikrofonu: ${err.message}`);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  }

  function wireTabs() {
    for (const button of $$('.tab')) {
      button.addEventListener('click', () => onTab(button.dataset.tab));
    }
    const initial = (location.hash || '').slice(1);
    if (initial && $(`.tab[data-tab="${initial}"]`)) setTimeout(() => onTab(initial), 0);
    window.addEventListener('hashchange', () => {
      const next = (location.hash || '').slice(1);
      if (next && $(`.tab[data-tab="${next}"]`)) onTab(next);
    });
  }

  function onTab(tab) {
    state.tab = tab;
    // Mirror app.js' tab switch so a deep link (#agents) works even before the
    // transport has finished connecting.
    for (const button of $$('.tab')) button.classList.toggle('is-on', button.dataset.tab === tab);
    for (const screen of $$('.screen')) screen.hidden = screen.dataset.screen !== tab;
    if (tab === 'agents') loadAgents();
    if (tab === 'tools') loadTools();
    if (tab === 'models') {
      loadModels();
      loadLab();
    }
    if (tab === 'cognition') loadCognition();
    if (tab === 'tasks') loadTasks();
    if (tab === 'memory') loadMemory();
    if (tab === 'knowledge') loadKnowledge();
    if (tab === 'automations') loadAutomations();
    if (tab === 'computer') loadComputer();
    if (tab === 'diagnostics') loadDiagnostics();
    if (tab === 'chat') {
      chatEls.input && chatEls.input.focus();
      Orb.set('idle');
    }
    try {
      history.replaceState(null, '', `#${tab}`);
    } catch {
      /* file:// */
    }
  }

  function poll() {
    refreshApprovals();
    setInterval(refreshApprovals, 4000);
    setInterval(() => {
      if (state.tab === 'tasks') loadTasks();
      if (state.tab === 'cognition') loadCognition();
      if (state.tab === 'computer') loadComputer();
    }, 8000);
  }

  function boot() {
    const canvas = $('#orb');
    if (canvas) Orb.init(canvas);
    wireChat();
    wireTabs();
    poll();
    refreshApprovals();
    renderMessages();
    // Mode buttons reflect the configured default.
    api('/api/ai/status')
      .then((data) => {
        const mode = data.data && data.data.brain && data.data.brain.modes;
        if (mode) {
          state.mode = mode;
          $$('[data-mode]').forEach((button) => button.classList.toggle('is-on', button.dataset.mode === mode));
        }
      })
      .catch(() => {});
  }

  window.SENTINEL_AI = {
    orb: Orb,
    state,
    send: sendMessage,
    stop: stopRun,
    renderMarkdown,
    api,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
