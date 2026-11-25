/* ============================================================================
   SENTINEL console — application controller.

   Everything the phone does lives here:
     • pairing (with visible progress and real error messages)
     • the encrypted link, polling, reconnection
     • rendering the control surface from a single snapshot command
     • policy-aware command execution

   No frameworks, no build step: this file is shipped as-is to the phone.
   ========================================================================== */
(function () {
  'use strict';

  const T = window.SentinelTransport;
  const APP_VERSION = '7.0.0';
  const STORE = {
    pairing: 'sentinel.pairing.v2',
    demo: 'sentinel.demo.v2',
    activity: 'sentinel.activity.v2',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ── tiny helpers ──────────────────────────────────────────────────────── */

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const svgIcon = (path, size = 18) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  const ICONS = {
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
    sleep: '<path d="M20 14.3A7.6 7.6 0 0 1 9.7 4a7.8 7.8 0 1 0 10.3 10.3Z"/>',
    restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    power: '<path d="M12 3.5v7.8"/><path d="M6.8 6.6a8 8 0 1 0 10.4 0"/>',
    cancel: '<circle cx="12" cy="12" r="8"/><path d="M8.6 8.6l6.8 6.8"/>',
    wake: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 17v3"/>',
    shot: '<rect x="3" y="6" width="18" height="13" rx="2.4"/><circle cx="12" cy="12.5" r="3.4"/>',
    play: '<path d="M8 5.6 18.5 12 8 18.4Z"/>',
    next: '<path d="M6 5.8 15 12 6 18.2Z"/><path d="M18 5.5v13"/>',
    volup: '<path d="M4 10h3l4-3.4v10.8L7 14H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.6a7.4 7.4 0 0 1 0 10.8"/>',
    voldown: '<path d="M4 10h3l4-3.4v10.8L7 14H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
    mute: '<path d="M4 10h3l4-3.4v10.8L7 14H4Z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    bolt: '<path d="M13.5 3 6 13.4h4.6L9.8 21l7.6-10.6h-4.7Z"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.6v3M14 3.6v3M10 17.4v3M14 17.4v3M3.6 10h3M3.6 14h3M17.4 10h3M17.4 14h3"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none"/>',
    brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.4 5.6A3 3 0 0 0 7 19h2V4.5Z"/><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.4 5.6A3 3 0 0 1 17 19h-2V4.5Z"/>',
  };

  const fmtBytes = (bytes) => {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  };

  const fmtDuration = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m`;
    return `${total}s`;
  };

  const fmtClock = (iso) => {
    const date = iso ? new Date(iso) : new Date();
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const timeAgo = (iso) => {
    if (!iso) return '—';
    const delta = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (delta < 5) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  };

  const maskKey = (key) => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '—');

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { style: 'position:fixed;opacity:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      const ok = document.execCommand && document.execCommand('copy');
      area.remove();
      return Boolean(ok);
    }
  }

  /* ── diagnostics ───────────────────────────────────────────────────────── */

  const Diag = {
    entries: [],
    add(level, message, extra) {
      const entry = {
        at: new Date().toISOString().slice(11, 23),
        level: level || 'info',
        message: String(message || ''),
        extra: extra === undefined ? null : extra,
      };
      this.entries.push(entry);
      if (this.entries.length > 200) this.entries.shift();
      const panel = document.getElementById('diag-log');
      if (panel && panel.offsetParent !== null) renderDiag();
    },
    clear() {
      this.entries = [];
      renderDiag();
    },
  };

  function renderDiag() {
    const panel = $('#diag-log');
    if (panel) {
      panel.textContent = Diag.entries.length
        ? Diag.entries.map((entry) => `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`).join('\n')
        : '(nothing yet — the app logs every attempt here)';
    }
    const meta = $('#diag-meta');
    if (meta) {
      meta.innerHTML = '';
      const rows = [
        ['Page origin', location.origin],
        ['Secure context', String(window.isSecureContext)],
        ['Web Crypto', String(Boolean(window.crypto && crypto.subtle))],
        ['Connection', S.pairing ? `${S.pairing.kind} · ${S.pairing.base}` : 'not paired'],
        ['Round trip', S.link && S.link.rtt != null ? `${S.link.rtt} ms` : '—'],
        ['Online', String(S.online)],
        ['User agent', navigator.userAgent],
      ];
      for (const [key, value] of rows) {
        meta.append(el('dt', { text: key }));
        meta.append(el('dd', { text: value }));
      }
    }
    const settingsPanel = $('#settings-diag');
    if (settingsPanel && !settingsPanel.hidden) settingsPanel.textContent = diagText();
  }

  /* ── storage ───────────────────────────────────────────────────────────── */

  const store = {
    get(key, soft) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : soft;
      } catch {
        return soft;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    drop(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* private mode — nothing to do */
      }
    },
  };

  /* ── state ─────────────────────────────────────────────────────────────── */

  const S = {
    pairing: null,
    link: null,
    snap: null,
    espRaw: null,
    hardwareOnly: false,
    online: false,
    reconnecting: false,
    demo: false,
    demoRelay: false,
    tab: 'home',
    filter: 'all',
    events: store.get(STORE.activity, []),
    lastError: null,
    busyCommands: new Set(),
    pollTimer: null,
    eventTimer: null,
    failures: 0,
    token: null,
    deferredInstall: null,
  };

  /* ── toasts ────────────────────────────────────────────────────────────── */

  function toast(title, { sub = '', tone = 'ok', ttl = 4200 } = {}) {
    const host = $('#toasts');
    if (!host) return;
    const node = el('div', { class: `toast ${tone === 'ok' ? '' : tone}`.trim(), role: 'status' }, [
      el('span', { class: 't-dot' }),
      el('div', { class: 't-body' }, [
        el('span', { class: 't-title', text: title }),
        sub ? el('span', { class: 't-sub', text: sub }) : null,
      ]),
    ]);
    host.append(node);
    const remove = () => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 260);
    };
    setTimeout(remove, ttl);
    node.addEventListener('click', remove);
  }

  /* ── sheet ─────────────────────────────────────────────────────────────── */

  function openSheet({ title, body, actions = [] }) {
    const sheet = $('#sheet');
    $('#sheet-title').textContent = title;
    const bodyHost = $('#sheet-body');
    bodyHost.innerHTML = '';
    for (const node of [].concat(body)) bodyHost.append(node instanceof Node ? node : el('p', { text: String(node) }));
    const foot = $('#sheet-foot');
    foot.innerHTML = '';
    for (const action of actions) {
      foot.append(
        el(
          'button',
          {
            class: `action-btn ${action.tone || ''}`.trim(),
            type: 'button',
            onclick: () => {
              closeSheet();
              if (action.run) action.run();
            },
          },
          action.label,
        ),
      );
    }
    $('#sheet-backdrop').hidden = false;
    sheet.hidden = false;
    const first = foot.querySelector('button');
    if (first) first.focus();
  }

  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
  }

  function confirmSheet({ title, message, confirmLabel = 'Confirm', tone = 'danger', warning = '', onConfirm }) {
    const body = [el('p', { text: message })];
    if (warning) body.push(el('p', { class: 'warn-text', text: warning }));
    openSheet({
      title,
      body,
      actions: [
        { label: 'Cancel', run: () => {} },
        {
          label: confirmLabel,
          tone,
          run: () => {
            Promise.resolve(onConfirm()).catch((err) => toast(err.message || 'That did not work', { tone: 'err' }));
          },
        },
      ],
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PAIRING
     ══════════════════════════════════════════════════════════════════════════ */

  const Pair = {
    steps: [],
    busy: false,
  };

  function renderPairSteps(activeIndex) {
    const host = $('#pair-steps');
    if (!Pair.steps.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML = '';
    Pair.steps.forEach((step, index) => {
      const state = activeIndex === null || index < activeIndex ? 'done' : index === activeIndex ? 'active' : '';
      host.append(
        el('div', { class: `step ${state}`.trim() }, [
          el('span', { class: 'mark' }),
          el('div', {}, [
            el('strong', { text: step.text }),
            step.detail ? el('span', { class: 'detail', text: step.detail }) : null,
          ]),
        ]),
      );
    });
  }

  function showPairError(err, { offerProbe = true } = {}) {
    const host = $('#pair-error');
    host.hidden = false;
    host.className = 'alert';
    host.innerHTML = '';

    const title = el('span', { class: 'alert-title', text: err.title || 'Could not connect' });
    host.append(title);
    if (err.message) host.append(el('span', { text: err.message }));
    if (err.hint) host.append(el('span', { class: 'alert-hint', text: err.hint }));

    const actions = el('div', { class: 'alert-actions' });
    if (offerProbe) {
      actions.append(
        el('button', {
          class: 'ghost-btn',
          type: 'button',
          text: 'Test the address',
          onclick: () => runProbe(),
        }),
      );
    }
    actions.append(
      el('button', {
        class: 'ghost-btn',
        type: 'button',
        text: 'Show diagnostics',
        onclick: () => {
          $('#pair-diagnostics').hidden = false;
          $('#pair-diagnostics-toggle').setAttribute('aria-expanded', 'true');
          $('#pair-diagnostics').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
      }),
    );
    if (err.detail) {
      actions.append(
        el('button', {
          class: 'ghost-btn',
          type: 'button',
          text: 'Copy details',
          onclick: async () => {
            const ok = await copyText(String(err.detail));
            toast(ok ? 'Details copied' : 'Copy failed', { tone: ok ? 'ok' : 'warn' });
          },
        }),
      );
    }
    host.append(actions);
    Diag.add('error', `${err.title || 'error'}: ${err.message || ''}`);
  }

  function clearPairError() {
    const host = $('#pair-error');
    host.hidden = true;
    host.innerHTML = '';
  }

  function setPairBusy(busy) {
    Pair.busy = busy;
    const button = $('#pair-submit');
    button.disabled = busy;
    button.querySelector('.btn-label').textContent = busy ? 'Connecting…' : 'Connect';
    button.querySelector('.spinner').hidden = !busy;
    for (const input of $$('#pair-form input')) input.disabled = busy;
  }

  /**
   * Turns the address the user typed into a concrete attempt list:
   * first the agent tunnel, then the ESP32 tunnel. Whichever answers wins, so
   * nobody has to know whether 192.168.1.1 is a PC or an ESP32.
   */
  function candidatesFor(address) {
    const url = new URL(T.normaliseAddress(address));
    const origins = [url.origin];
    // "192.168.1.50" almost certainly means the agent on 7878, so try that too.
    if (!url.port) origins.push(`${url.protocol}//${url.hostname}:7878`);
    const list = [];
    for (const origin of origins) {
      list.push({ kind: 'agent', base: `${origin}/api/tunnel`, label: 'PC agent', origin });
      list.push({ kind: 'esp', base: `${origin}/t`, label: 'ESP32', origin });
    }
    return list;
  }

  async function attemptConnect({ address, key, token, onStep = () => {} }) {
    if (token && !key) {
      // Token mode: no key needed, the console token is the credential.
      const origin = address && address !== 'self' ? new URL(T.normaliseAddress(address)).origin : location.origin;
      onStep([{ text: 'Using the console token', detail: origin }], 0);
      const link = new T.PlainLink({ base: origin, token });
      const result = await link.connect((list) =>
        onStep(
          [{ text: 'Using the console token', detail: origin }].concat(list.map((step) => ({ text: step.text, detail: step.detail }))),
          list.length,
        ),
      );
      return {
        pairing: { kind: 'plain', base: origin, token, label: origin.replace(/^https?:\/\//, ''), name: 'This computer', addedAt: new Date().toISOString() },
        link,
        result,
      };
    }

    const keyHex = T.normaliseKey(key);
    const candidates = candidatesFor(address);
    let lastError = null;

    for (const candidate of candidates) {
      const steps = [{ text: `Trying ${candidate.label}`, detail: candidate.base }];
      onStep(steps, 0);
      Diag.add('info', `connect ${candidate.base}`, { key: maskKey(keyHex) });
      const link = new T.TunnelLink({ base: candidate.base, key: keyHex, label: candidate.label });
      try {
        const result = await link.connect((list) => {
          onStep(
            [{ text: `Trying ${candidate.label}`, detail: candidate.base }].concat(
              list.map((step) => ({ text: step.text, detail: step.detail })),
            ),
            list.length,
          );
        });
        const done = [{ text: `Trying ${candidate.label}`, detail: candidate.base }]
          .concat([{ text: 'Connected', detail: `${result.rtt} ms round trip` }]);
        onStep(done, done.length);
        return {
          pairing: {
            kind: candidate.kind,
            base: candidate.base,
            key: keyHex,
            label: candidate.origin.replace(/^https?:\/\//, ''),
            name: candidate.kind === 'esp' ? 'ESP32' : 'PC agent',
            addedAt: new Date().toISOString(),
          },
          link,
          result,
        };
      } catch (err) {
        lastError = err;
        Diag.add('error', `${candidate.label} @ ${candidate.base}: ${err.code || 'ERROR'} — ${err.message}`);
        // A wrong key is a real answer — asking the next candidate would only
        // produce a second misleading error.
        if (err.code === 'KEY_MISMATCH') throw err;
      }
    }
    throw lastError || new Error('nothing answered at that address');
  }

  function explainTransportError(err) {
    const detail = err && (err.stack || err.message);
    const map = {
      KEY_MISMATCH: {
        title: 'The pairing key does not match',
        hint: 'Copy the key again from the PC console (Pairing panel) or from the ESP32 setup page, then paste it here. The two must be character-for-character identical.',
      },
      UNREACHABLE: {
        title: 'Nothing answered at that address',
        hint: 'Check that the phone is on the same Wi-Fi, that the address is the device\'s local IP, and that SENTINEL is running onthe PC. Tap "Test the address" to see exactly what happens.',
      },
      TIMEOUT: {
        title: 'The device stopped answering',
        hint: 'Something answered but stayed silent. If this is the PC, the agent may have crashed — restart SENTINEL there. If it is the ESP32, power-cycle it.',
      },
      NOT_SENTINEL: {
        title: 'That address is not a SENTINEL device',
        hint: 'It may be a router admin page or another service. The agent listens on port 7878 and the ESP32 on port 80.',
      },
      REFUSED: {
        title: 'The device refused the pairing proof',
        hint: 'The key reached the device but was rejected. Re-copy it — a trailing space or an uppercase/lowercase difference is enough to fail.',
      },
      NO_CRYPTO: {
        title: 'This browser cannot encrypt',
        hint: 'Web Crypto needs a secure context. Open the console through the link the PC shows you, or install the app.',
      },
    };
    const known = map[err && err.code];
    return {
      title: known ? known.title : 'Could not connect',
      message: err && err.message ? err.message : 'unknown error',
      hint: (known && known.hint) || (err && err.hint) || '',
      detail,
    };
  }

  async function runProbe() {
    const address = $('#pair-address').value.trim() || location.host;
    const host = $('#pair-probe');
    host.hidden = false;
    host.innerHTML = '';
    host.append(el('div', { class: 'probe-row' }, [el('span', { text: 'Testing…' }), el('span', { class: 'muted', text: address })]));
    Diag.add('info', `probe ${address}`);
    const report = await T.probeAddress(address);
    host.innerHTML = '';
    for (const attempt of report.attempts) {
      host.append(
        el('div', { class: 'probe-row' }, [
          el('span', { text: attempt.target.replace(/^https?:\/\//, '') }),
          el('span', {
            class: attempt.status && attempt.status < 400 ? 'ok' : attempt.error ? 'bad' : '',
            text: attempt.error ? attempt.error : `HTTP ${attempt.status} · ${attempt.ms} ms`,
          }),
        ]),
      );
    }
    const verdict =
      report.verdict === 'agent'
        ? 'SENTINEL agent found — paste the pairing key and connect.'
        : report.verdict === 'locked'
          ? 'SENTINEL agent found (it wants the key) — paste it and connect.'
          : report.verdict === 'esp32'
            ? `ESP32 found${report.device ? ` (${report.device})` : ''} — pair with the same key.`
            : report.verdict === 'silent'
              ? 'Nothing usable answered. Wrong network or wrong address is the usual cause.'
              : 'That address is not valid.';
    host.append(
      el('div', { class: 'probe-row' }, [
        el('span', { text: verdict }),
        el('span', { class: report.verdict === 'silent' ? 'bad' : 'ok', text: report.verdict }),
      ]),
    );
    Diag.add(report.verdict === 'silent' ? 'warn' : 'info', `probe verdict: ${report.verdict}`, report);
  }

  async function submitPairing(event) {
    if (event) event.preventDefault();
    if (Pair.busy) return;
    clearPairError();

    const address = $('#pair-address').value.trim();
    const key = $('#pair-key').value.trim();
    const token = $('#pair-token').value.trim();

    if (!address && !token && !key) {
      showPairError({
        title: 'Enter an address first',
        message: 'Type the address of your PC (for example 192.168.1.50:7878) or your ESP32 (192.168.1.1).',
        hint: 'The PC console shows its own address at the top of the pairing panel.',
      });
      $('#pair-address').focus();
      return;
    }
    if (!token && !key) {
      showPairError({
        title: 'The pairing key is missing',
        message: 'Every SENTINEL device expects the 64-character key.',
        hint: 'On the PC: Console → Pairing → pairing key. On the ESP32: its setup page shows the same key.',
      });
      $('#pair-key').focus();
      return;
    }

    setPairBusy(true);
    Pair.steps = [];
    renderPairSteps(0);

    try {
      const attempt = await attemptConnect({
        address,
        key,
        token,
        onStep: (steps, active) => {
          Pair.steps = steps;
          renderPairSteps(active);
        },
      });
      renderPairSteps(null);
      S.pairing = attempt.pairing;
      S.link = attempt.link;
      store.set(STORE.pairing, attempt.pairing);
      Diag.add('info', `paired with ${attempt.pairing.base}`, attempt.result);
      toast('Paired', { sub: `${attempt.pairing.name} · ${attempt.result.rtt} ms` });
      setTimeout(() => startApp(), 420);
    } catch (err) {
      const explained = explainTransportError(err);
      showPairError(explained);
      renderPairSteps(null);
      Diag.add('error', `${err.code || 'ERROR'}: ${err.message}`);
    } finally {
      setPairBusy(false);
    }
  }

  function renderDiag() {}

  /* ══════════════════════════════════════════════════════════════════════════
     LINK LIFECYCLE
     ══════════════════════════════════════════════════════════════════════════ */

  function setOnline(online, reason) {
    if (S.online === online) return;
    S.online = online;
    const pill = $('#link-pill');
    const text = $('#link-pill-text');
    if (S.demo) {
      pill.className = 'pill pill-demo';
      text.textContent = 'demo';
    } else if (online) {
      pill.className = 'pill pill-live';
      text.textContent = 'encrypted';
    } else {
      pill.className = 'pill pill-off';
      text.textContent = 'offline';
    }
    if (!online && reason) toast('Connection lost', { sub: reason, tone: 'err' });
    if (!online) scheduleReconnect();
    renderHomeBits();
  }

  function scheduleReconnect() {
    if (S.demo || S.pairing === null) return;
    clearTimeout(S.reconnectTimer);
    const delay = Math.min(30000, 1200 * 2 ** Math.min(S.failures, 4));
    S.failures += 1;
    S.reconnectTimer = setTimeout(() => reconnect({ silent: true }), delay);
  }

  async function reconnect({ silent = false } = {}) {
    if (S.reconnecting || !S.pairing || S.demo) return;
    S.reconnecting = true;
    if (!silent) toast('Reconnecting…', { sub: S.pairing.label });
    try {
      if (S.link) S.link.close();
      const attempt = await attemptConnect({
        address: S.pairing.base.replace(/\/api\/tunnel$|\/t$/, ''),
        key: S.pairing.key,
        token: S.pairing.token,
        onStep: () => {},
      });
      S.link = attempt.link;
      S.failures = 0;
      clearPairError();
      setOnline(true);
      if (!silent) toast('Reconnected', { sub: `${attempt.result.rtt} ms` });
      await refresh();
    } catch (err) {
      Diag.add('error', `reconnect failed: ${err.message}`);
      setOnline(false);
      if (!silent) toast('Still offline', { sub: err.message, tone: 'err' });
    } finally {
      S.reconnecting = false;
    }
  }

  function startPolling() {
    clearInterval(S.pollTimer);
    clearInterval(S.eventTimer);
    const interval = 5000;
    S.pollTimer = setInterval(() => {
      if (document.hidden) return;
      refresh().catch(() => {});
    }, interval);
    if (S.link && typeof S.link.poll === 'function') {
      S.eventTimer = setInterval(() => {
        if (document.hidden || !S.online) return;
        S.link
          .poll()
          .then((events) => {
            if (events && events.length) ingestLogEntries(events);
          })
          .catch(() => {});
      }, 3500);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh().catch(() => {});
    });
  }

  /* ── data fetching ─────────────────────────────────────────────────────── */

  async function refresh() {
    if (S.demo) {
      S.snap = demoSnapshot();
      setOnline(true);
      renderAll();
      return;
    }
    if (!S.link) return;
    try {
      let reply;
      try {
        reply = await S.link.request('system.snapshot');
      } catch (err) {
        if (err.code === 'OFFLINE') throw err;
        reply = { ok: false, code: err.code, message: err.message };
      }
      if (reply.ok) {
        S.snap = reply.data;
        S.hardwareOnly = false;
        S.espRaw = reply.data.esp;
        S.failures = 0;
        setOnline(true);
      } else if (reply.code === 'LINK_OFFLINE') {
        // Talking to the ESP32, but it cannot reach the PC: show hardware only.
        const esp = await S.link.request('esp.status').catch(() => null);
        S.espRaw = esp && esp.ok ? esp.data : null;
        S.hardwareOnly = true;
        setOnline(true);
        renderAll();
        return;
      } else {
        throw Object.assign(new Error(reply.message || 'snapshot failed'), { code: reply.code });
      }
      renderAll();
    } catch (err) {
      S.lastError = err;
      Diag.add('warn', `refresh failed: ${err.message}`);
      setOnline(false, err.message);
    }
  }

  function ingestLogEntries(entries) {
    let changed = false;
    for (const entry of entries) {
      const data = entry.data || entry;
      if (!data || !data.message) continue;
      if (data.level === 'debug') continue;
      S.events.push({
        at: data.at || new Date().toISOString(),
        level: data.level || 'info',
        source: data.source || 'agent',
        message: data.message,
      });
      changed = true;
    }
    if (changed) {
      S.events = S.events.slice(-300);
      store.set(STORE.activity, S.events);
      if (S.tab === 'activity') renderTimeline();
    }
  }

  function recordCommand(cmd, ok, detail, ms) {
    S.events.push({
      at: new Date().toISOString(),
      level: ok ? 'info' : 'error',
      source: 'phone',
      message: `${cmd}${ok ? '' : ` — ${detail || 'failed'}`}`,
      cmd,
      ok,
      ms,
    });
    S.events = S.events.slice(-300);
    store.set(STORE.activity, S.events);
    if (S.tab === 'activity') renderTimeline();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     COMMAND EXECUTION
     ══════════════════════════════════════════════════════════════════════════ */

  const DESTRUCTIVE = new Set([
    'system.shutdown',
    'system.reboot',
    'system.logout',
    'system.sleep',
    'system.cancel_shutdown',
    'app.kill',
    'script.run',
    'esp.power',
    'esp.reset',
  ]);

  const CONFIRM_COPY = {
    'system.shutdown': {
      title: 'Shut down the PC?',
      message: 'The machine will close everything and power off in 30 seconds.',
      warning: 'You can still cancel from this screen while it counts down.',
      confirmLabel: 'Shut down',
    },
    'system.reboot': {
      title: 'Restart the PC?',
      message: 'The machine will restart in 10 seconds.',
      warning: 'Unsaved work in open applications may be lost.',
      confirmLabel: 'Restart',
    },
    'system.sleep': { title: 'Sleep the PC?', message: 'The machine will go to sleep and stop responding until it wakes.', confirmLabel: 'Sleep' },
    'system.logout': { title: 'Log out?', message: 'The current Windows user will be signed out.', confirmLabel: 'Log out' },
    'esp.power': {
      title: 'Press the power button?',
      message: 'The ESP32 will close the power relay as if you pressed the physical button.',
      warning: 'A hard press does not ask the operating system for permission.',
      confirmLabel: 'Press power',
    },
    'esp.reset': {
      title: 'Press the reset button?',
      message: 'The ESP32 will close the reset relay, which reboots the machine immediately.',
      warning: 'This is the hardware reset line. Unsaved work will be lost.',
      confirmLabel: 'Press reset',
    },
  };

  function isDeniedByPolicy(cmd) {
    const policy = (S.snap && S.snap.policy) || null;
    if (!policy) return null;
    const map = {
      'system.shutdown': 'allowShutdown',
      'system.reboot': 'allowReboot',
      'system.sleep': 'allowSleep',
      'system.lock': 'allowLock',
      'system.logout': 'allowLogout',
      'media.play_pause': 'allowMedia',
      'media.next': 'allowMedia',
      'media.previous': 'allowMedia',
      'media.stop': 'allowMedia',
      'volume.up': 'allowVolume',
      'volume.down': 'allowVolume',
      'volume.mute': 'allowVolume',
      'screen.screenshot': 'allowScreenshot',
      'screen.wake': 'allowWake',
      'input.type': 'allowInput',
      'input.key': 'allowInput',
      'app.launch': 'allowAppLaunch',
      'app.kill': 'allowAppKill',
      'script.run': 'allowScripts',
      'files.list': 'allowFileList',
      'esp.power': 'allowEspPower',
      'esp.reset': 'allowEspPower',
    };
    const flag = map[cmd];
    if (flag && policy[flag] === false) return flag;
    return null;
  }

  async function runCommand(cmd, args = {}, { confirm = false, source = 'quick' } = {}) {
    const blocked = isDeniedByPolicy(cmd);
    if (blocked) {
      toast('Blocked by policy', { sub: `${cmd} needs ${blocked} enabled on the PC`, tone: 'warn' });
      recordCommand(cmd, false, `blocked by ${blocked}`);
      return;
    }

    const needsConfirm = DESTRUCTIVE.has(cmd) && !confirm && !(S.snap && S.snap.policy && S.snap.policy.requireConfirm === false);
    if (needsConfirm) {
      const copy = CONFIRM_COPY[cmd] || { title: `${cmd}?`, message: 'This changes the state of the machine.', confirmLabel: 'Continue' };
      confirmSheet({
        ...copy,
        tone: 'danger',
        onConfirm: () => runCommand(cmd, { ...args, confirm: true }, { confirm: true, source }),
      });
      return;
    }

    S.busyCommands.add(cmd);
    renderHomeBits();
    const started = performance.now();
    try {
      const reply = S.demo
        ? await demoCommand(cmd, args)
        : await S.link.request(cmd, { ...args, ...(DESTRUCTIVE.has(cmd) ? { confirm: true } : {}) });
      const ms = Math.round(performance.now() - started);
      if (reply && reply.ok === false) {
        const code = reply.code || 'FAILED';
        const human =
          code === 'QUIET_HOURS'
            ? 'Quiet hours are on — the PC is refusing power commands until morning.'
            : code === 'RATE_LIMITED'
              ? 'Too many commands in a minute. Wait a moment.'
              : code === 'CONFIRM_REQUIRED'
                ? 'The PC wants an explicit confirmation for that.'
                : reply.message || 'The command failed.';
        toast(human, { tone: 'err', sub: code });
        recordCommand(cmd, false, human, ms);
        return { ok: false, code, message: human };
      }
      const label = commandLabel(cmd);
      toast(`${label} sent`, { sub: `${ms} ms${reply && reply.data && reply.data.delayed ? ' · scheduled' : ''}`, tone: 'ok' });
      recordCommand(cmd, true, '', ms);
      if (reply && Array.isArray(reply.events) && reply.events.length) ingestLogEntries(reply.events);
      if (cmd === 'esp.power' || cmd === 'esp.reset') {
        if (S.demo) S.demoRelay = !S.demoRelay;
      }
      await refresh();
      return reply;
    } catch (err) {
      recordCommand(cmd, false, err.message);
      toast('Could not reach the device', { tone: 'err', sub: err.message });
      setOnline(false, err.message);
      return { ok: false, code: err.code, message: err.message };
    } finally {
      S.busyCommands.delete(cmd);
      renderHomeBits();
    }
  }

  function commandLabel(cmd) {
    const catalogue = (S.snap && S.snap.catalogue) || [];
    const found = catalogue.find((entry) => entry.cmd === cmd);
    return found ? found.label : cmd;
  }

  function defaultArgs(args) {
    if (!args) return {};
    const payload = {};
    for (const [name, spec] of Object.entries(args)) {
      if (spec.default !== undefined) payload[name] = spec.default;
    }
    return payload;
  }

  // The assistant bundle (ai.js) is a separate IIFE; expose the two shared
  // primitives instead of duplicating DOM code in two files.
  window.SentinelUI = {
    toast: (message, options) => toast(message, options),
    confirmSheet: (options) => confirmSheet(options),
  };

  function commandArgs(cmd) {
    const catalogue = (S.snap && S.snap.catalogue) || [];
    const entry = catalogue.find((item) => item.cmd === cmd);
    if (!entry || !entry.args) return null;
    const keys = Object.keys(entry.args);
    if (!keys.length) return null;
    return entry.args;
  }

  /**
   * Prompt for arguments only when a command genuinely needs some. Delays and
   * hold times have defaults on the agent, so "Shut down" stays one tap plus a
   * confirmation instead of a form.
   */
  function runCommandWithArgs(cmd) {
    // Refuse in the UI before asking for input the agent would reject anyway.
    const blockedHere = isDeniedByPolicy(cmd);
    if (blockedHere) {
      toast('Blocked by policy', { sub: `${cmd} needs ${blockedHere} enabled on the PC`, tone: 'warn' });
      recordCommand(cmd, false, `blocked by ${blockedHere}`);
      return;
    }
    const args = commandArgs(cmd);
    const needsInput =
      args &&
      Object.values(args).some(
        (spec) => (spec.type === 'string' && spec.default === undefined) || (spec.type === 'number' && spec.default === undefined),
      );
    if (!args || !needsInput) return runCommand(cmd, defaultArgs(args));
    const inputs = {};
    const body = Object.entries(args).map(([name, spec]) => {
      const id = `arg-${cmd.replace(/\W/g, '-')}-${name}`;
      let input;
      if (spec.type === 'enum') {
        input = el('select', { class: 'arg-select', id });
        for (const value of spec.values || []) input.append(el('option', { value, text: value }));
      } else if (spec.type === 'number') {
        input = el('input', {
          type: 'number',
          id,
          value: spec.default ?? 0,
          min: spec.min ?? undefined,
          max: spec.max ?? undefined,
        });
      } else {
        input = el('input', { type: 'text', id, placeholder: spec.example || name, value: spec.default ?? '' });
      }
      inputs[name] = { input, spec };
      return el('div', { class: 'field' }, [
        el('label', { for: id, text: spec.unit ? `${name} (${spec.unit})` : name }),
        input,
        spec.example ? el('p', { class: 'hint', text: `e.g. ${spec.example}` }) : null,
      ]);
    });

    openSheet({
      title: commandLabel(cmd),
      body: el('div', { class: 'sheet-form' }, body),
      actions: [
        { label: 'Cancel', run: () => {} },
        {
          label: 'Run',
          tone: 'primary',
          run: () => {
            const payload = {};
            for (const [name, { input, spec }] of Object.entries(inputs)) {
              payload[name] = spec.type === 'number' ? Number(input.value) : input.value;
            }
            runCommand(cmd, payload);
          },
        },
      ],
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDERING
     ══════════════════════════════════════════════════════════════════════════ */

  const QUICK = [
    { cmd: 'screen.wake', label: 'Wake display', icon: 'wake' },
    { cmd: 'system.lock', label: 'Lock', icon: 'lock' },
    { cmd: 'system.sleep', label: 'Sleep', icon: 'sleep', danger: true },
    { cmd: 'system.reboot', label: 'Restart', icon: 'restart', danger: true },
    { cmd: 'system.cancel_shutdown', label: 'Cancel shutdown', icon: 'cancel' },
    { cmd: 'screen.screenshot', label: 'Screenshot', icon: 'shot' },
    { cmd: 'media.play_pause', label: 'Play / pause', icon: 'play' },
    { cmd: 'media.next', label: 'Next track', icon: 'next' },
    { cmd: 'volume.up', label: 'Volume up', icon: 'volup' },
    { cmd: 'volume.down', label: 'Volume down', icon: 'voldown' },
    { cmd: 'volume.mute', label: 'Mute', icon: 'mute' },
    { cmd: 'agent.status', label: 'Agent status', icon: 'info' },
  ];

  function renderHeader() {
    const snap = S.snap || {};
    const name = (snap.name && String(snap.name)) || (S.pairing && S.pairing.name) || 'SENTINEL';
    $('#device-name').textContent = S.demo ? 'STRIGA-7' : name;
    const sub = S.demo
      ? 'demo data · nothing is really touched'
      : S.pairing
        ? `${S.pairing.kind === 'esp' ? 'via ESP32' : S.pairing.kind === 'plain' ? 'this computer' : 'encrypted tunnel'} · ${S.pairing.label}`
        : 'not paired';
    $('#device-sub').textContent = sub;
    const pill = $('#link-pill');
    const text = $('#link-pill-text');
    if (S.demo) {
      pill.className = 'pill pill-demo';
      text.textContent = 'demo';
    } else if (S.online) {
      pill.className = 'pill pill-live';
      text.textContent = S.link && S.link.rtt ? `${S.link.rtt} ms` : 'encrypted';
    } else {
      pill.className = 'pill pill-off';
      text.textContent = 'offline';
    }
  }

  function renderHero() {
    const snap = S.snap;
    const cpu = snap ? Math.round(snap.cpuPercent || 0) : 0;
    const ring = $('#ring-cpu');
    const circumference = 2 * Math.PI * 52;
    ring.setAttribute('stroke-dasharray', circumference.toFixed(1));
    ring.setAttribute('stroke-dashoffset', (circumference * (1 - Math.min(100, cpu) / 100)).toFixed(1));
    ring.setAttribute('class', `ring-value${cpu > 85 ? ' hot' : cpu > 60 ? ' warn' : ''}`);
    $('#ring-percent').textContent = snap ? `${cpu}%` : '—';

    if (!snap || S.hardwareOnly) {
      $('#hero-state').textContent = S.hardwareOnly ? 'Hardware only' : 'Not connected';
      $('#hero-host').textContent = S.hardwareOnly && S.espRaw ? S.espRaw.device || 'ESP32' : 'Waiting for the PC';
      $('#hero-meta').textContent = S.hardwareOnly
        ? 'The ESP32 is reachable but the PC agent is not linked. Power and reset still work.'
        : 'Pair or reconnect to read the machine state.';
      return;
    }
    const pcOn = snap.esp && snap.esp.pc ? snap.esp.pc : 'unknown';
    $('#hero-state').textContent = pcOn === 'off' ? 'Powered off (relay sees no power)' : 'Online and ready';
    $('#hero-host').textContent = snap.hostname || snap.name || '—';
    const parts = [
      snap.platformLabel || snap.platform || '',
      `${snap.cpuCount || 0} threads`,
      `up ${fmtDuration(snap.uptime)}`,
      snap.agent ? `agent ${snap.agent.version}` : '',
    ].filter(Boolean);
    $('#hero-meta').textContent = parts.join(' · ');
  }

  function renderMetrics() {
    const host = $('#metrics');
    host.innerHTML = '';
    if (!S.snap) {
      for (let i = 0; i < 4; i += 1) host.append(el('div', { class: 'metric' }, [el('div', { class: 'shimmer', text: 'loading' })]));
      return;
    }
    const snap = S.snap;
    const memory = snap.memoryDetail || {
      percent: Math.round((1 - snap.memoryFree / snap.memory) * 100),
      used: snap.memory - (snap.memoryFree || 0),
      total: snap.memory,
    };
    const esp = snap.esp || S.espRaw || {};
    const linkOk = esp.connected !== false && (esp.connected === true || esp.link === 'up');
    const cards = [
      {
        label: 'CPU',
        value: `${Math.round(snap.cpuPercent || 0)}%`,
        sub: (snap.cpuModel || '').split('@')[0].trim() || `${snap.cpuCount} threads`,
        bar: Math.min(100, snap.cpuPercent || 0),
      },
      {
        label: 'Memory',
        value: `${memory.percent || 0}%`,
        sub: `${fmtBytes(memory.used)} of ${fmtBytes(memory.total)}`,
        bar: memory.percent || 0,
      },
      {
        label: 'Uptime',
        value: fmtDuration(snap.uptime),
        sub: `since ${snap.platformLabel || 'boot'}`,
      },
      {
        label: 'ESP32',
        value: linkOk ? 'linked' : 'not linked',
        sub: esp.fw ? `firmware ${esp.fw}` : esp.chip || 'no hardware reported',
        tone: linkOk ? 'good' : 'bad',
      },
      {
        label: 'Tunnel',
        value: S.link && S.link.rtt != null ? `${S.link.rtt} ms` : '—',
        sub: S.pairing ? S.pairing.kind === 'esp' ? 'phone → ESP32' : 'phone → PC' : 'direct',
      },
      {
        label: 'This session',
        value: String((snap.agent && snap.agent.counters && snap.agent.counters.commands) || 0),
        sub: 'commands this run',
      },
    ];
    for (const card of cards) {
      const barClass = card.bar > 85 ? 'hot' : card.bar > 60 ? 'warn' : '';
      host.append(
        el('div', { class: `metric ${card.tone || ''}`.trim() }, [
          el('span', { class: 'metric-label', text: card.label }),
          el('span', { class: 'metric-value', text: card.value }),
          el('span', { class: 'metric-sub', text: card.sub }),
          card.bar !== undefined
            ? el('span', { class: 'bar' }, [el('i', { class: barClass, style: `width:${Math.min(100, card.bar)}%` })])
            : null,
        ]),
      );
    }
  }

  function qaButton(item) {
    const busy = S.busyCommands.has(item.cmd);
    const disabled = S.hardwareOnly && !item.cmd.startsWith('esp.');
    return el(
      'button',
      {
        class: `qa ${item.danger ? 'danger' : ''} ${item.hw ? 'hw' : ''} ${busy ? 'busy' : ''} ${disabled ? 'off' : ''}`.trim(),
        type: 'button',
        title: item.cmd,
        onclick: () => runCommandWithArgs(item.cmd),
      },
      [
        el('span', { class: 'qa-icon', html: svgIcon(ICONS[item.icon] || ICONS.info, 17) }),
        el('span', { class: 'qa-label', text: item.label }),
        el('span', { class: 'qa-sub', text: item.cmd }),
      ],
    );
  }

  function renderInsights() {
    const host = $('#insights');
    if (!host) return;
    host.innerHTML = '';
    const insights = (S.snap && S.snap.insights) || [];
    if (!insights.length) {
      host.append(
        el('div', { class: 'insight-empty' }, [
          el('span', { html: svgIcon(ICONS.brain, 16) }),
          el('span', { text: 'Nothing needs attention. The brain checks CPU, memory, the ESP32 link and command failures every 15 seconds.' }),
        ]),
      );
      return;
    }
    for (const insight of insights) {
      const actions = el('div', { class: 'i-actions' });
      if (insight.action && insight.action.cmd) {
        actions.append(
          el('button', {
            class: 'action-btn primary',
            type: 'button',
            text: insight.action.label || 'Fix it',
            onclick: () => runCommand(insight.action.cmd, insight.action.args || {}),
          }),
        );
      }
      actions.append(
        el('button', {
          class: 'action-btn',
          type: 'button',
          text: 'Dismiss',
          onclick: () => dismissInsight(insight.id),
        }),
      );
      host.append(
        el('div', { class: `insight ${insight.level || 'info'}` }, [
          el('div', { class: 'i-body' }, [
            el('span', { class: 'i-title', text: insight.title }),
            el('span', { class: 'i-detail', text: insight.detail }),
            actions,
          ]),
          el('button', {
            class: 'i-dismiss',
            type: 'button',
            'aria-label': 'Dismiss',
            text: '×',
            onclick: () => dismissInsight(insight.id),
          }),
        ]),
      );
    }
  }

  async function dismissInsight(id) {
    S.snap = S.snap ? { ...S.snap, insights: (S.snap.insights || []).filter((item) => item.id !== id) } : S.snap;
    renderInsights();
    if (S.demo) return;
    try {
      await S.link.request('brain.dismiss', { id });
    } catch (err) {
      toast('Could not dismiss', { sub: err.message, tone: 'warn' });
    }
    refresh().catch(() => {});
  }

  function renderQuickActions() {
    const host = $('#quick-actions');
    host.innerHTML = '';
    for (const item of QUICK) host.append(qaButton(item));
    $('#quick-hint').textContent = S.hardwareOnly
      ? 'PC actions need the agent link'
      : 'Tap to run · destructive actions ask first';
  }

  function renderHardware() {
    const host = $('#hardware');
    host.innerHTML = '';
    const esp = (S.snap && S.snap.esp) || S.espRaw || null;
    const linked = esp && (esp.connected === true || esp.link === 'up');
    if (!esp) {
      host.append(el('p', { class: 'hint', text: 'No ESP32 has reported in yet. Link it from the PC console or from the device\'s own setup page.' }));
      return;
    }
    const pc = esp.pc || 'unknown';
    host.append(
      el('div', { class: 'hw-state' }, [
        el('span', { class: `hw-badge ${linked ? 'on' : 'off'}` }, [el('span', { class: 'dot' }), linked ? 'ESP32 linked' : 'ESP32 offline']),
        el('span', { class: 'hw-badge' }, [el('span', { class: 'dot' }), `PC ${pc}`]),
        esp.chipTemp ? el('span', { class: 'hw-badge' }, [el('span', { class: 'dot' }), `${esp.chipTemp} °C`]) : null,
        esp.fw ? el('span', { class: 'hw-badge' }, [el('span', { class: 'dot' }), `fw ${esp.fw}`]) : null,
      ]),
    );

    const holdValue = el('input', { type: 'range', min: '100', max: '3000', step: '100', value: '600', id: 'hold-ms' });
    const holdLabel = el('label', { for: 'hold-ms', text: '600 ms' });
    holdValue.addEventListener('input', () => {
      holdLabel.textContent = `${holdValue.value} ms`;
    });

    host.append(
      el('div', { class: 'hw-actions' }, [
        el('button', { class: 'action-btn primary', type: 'button', text: 'Power', onclick: () => runCommand('esp.power', { action: 'cycle', holdMs: Number(holdValue.value) }) }),
        el('button', { class: 'action-btn', type: 'button', text: 'Force off', onclick: () => runCommand('esp.power', { action: 'off', holdMs: Number(holdValue.value) }) }),
        el('button', {
          class: 'action-btn danger',
          type: 'button',
          text: 'Reset',
          onclick: () => runCommand('esp.reset', { holdMs: Number(holdValue.value) }),
        }),
      ]),
    );
    host.append(el('div', { class: 'slider-row' }, [holdLabel, holdValue]));
    host.append(el('p', { class: 'hold-note', text: 'Hold time is how long the relay keeps the button pressed. 600 ms behaves like a normal press; longer is a hard power-off.' }));
  }

  function renderCatalogue() {
    const host = $('#catalogue');
    host.innerHTML = '';
    const catalogue = (S.snap && S.snap.catalogue) || [];
    if (!catalogue.length) {
      host.append(el('p', { class: 'hint', text: S.hardwareOnly ? 'The full catalogue needs the agent link.' : 'No commands reported yet.' }));
      return;
    }
    const groups = new Map();
    for (const entry of catalogue) {
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    for (const [group, entries] of groups) {
      host.append(
        el('div', { class: 'catalogue-group' }, [
          el('h4', { text: group }),
          el(
            'div',
            { class: 'catalogue-items' },
            entries.map((entry) =>
              el('button', {
                class: `cmd-chip ${DESTRUCTIVE.has(entry.cmd) ? 'danger' : ''}`.trim(),
                type: 'button',
                text: entry.label,
                title: entry.cmd,
                onclick: () => runCommandWithArgs(entry.cmd),
              }),
            ),
          ),
        ]),
      );
    }
  }

  function renderHomeBits() {
    if (S.tab !== 'home' && S.tab !== undefined) return;
    renderHero();
    renderMetrics();
    renderInsights();
    renderQuickActions();
    renderHardware();
  }

  function renderTimeline() {
    const host = $('#timeline');
    host.innerHTML = '';
    const filter = S.filter;
    const items = S.events
      .filter((entry) => {
        if (filter === 'all') return true;
        if (filter === 'command') return Boolean(entry.cmd) || entry.source === 'phone' || entry.source === 'command';
        if (filter === 'security') return ['security', 'policy', 'tunnel', 'link'].includes(entry.source) || entry.level === 'error';
        return true;
      })
      .slice()
      .reverse()
      .slice(0, 200);

    if (!items.length) {
      host.append(el('p', { class: 'empty', text: 'Nothing here yet. Commands you run will show up with their result.' }));
      return;
    }
    for (const entry of items) {
      const tone = entry.level === 'error' ? 'fail' : entry.level === 'warn' ? 'warn' : entry.cmd ? (entry.ok === false ? 'fail' : 'ok') : '';
      host.append(
        el('div', { class: `tl-item ${tone}`.trim() }, [
          el('span', { class: 'tl-mark', text: entry.level === 'error' ? '!' : entry.level === 'warn' ? '·' : '✓' }),
          el('div', { class: 'tl-body' }, [
            el('span', { class: 'tl-title', text: entry.message }),
            el('span', { class: 'tl-meta', text: `${entry.source || 'agent'}${entry.ms ? ` · ${entry.ms} ms` : ''}` }),
          ]),
          el('span', { class: 'tl-time', text: fmtClock(entry.at) }),
        ]),
      );
    }
  }

  function renderDevices() {
    const host = $('#devices');
    host.innerHTML = '';
    const snap = S.snap || {};
    const esp = snap.esp || S.espRaw || {};
    const pairing = S.pairing;

    // 1 — the link this phone uses
    host.append(
      el('div', { class: 'device' }, [
        el('div', { class: 'device-head' }, [
          el('span', { class: 'device-icon mint', html: svgIcon(ICONS.bolt, 19) }),
          el('div', { class: 'device-title' }, [
            el('strong', { text: pairing ? pairing.name : 'Not paired' }),
            el('span', { text: pairing ? pairing.base : '—' }),
          ]),
        ]),
        el('dl', { class: 'device-meta' }, [
          el('dt', { text: 'Channel' }),
          el('dd', { text: pairing ? (pairing.kind === 'plain' ? 'same-origin token' : 'ST1 · AES-256-GCM') : '—' }),
          el('dt', { text: 'Round trip' }),
          el('dd', { text: S.link && S.link.rtt != null ? `${S.link.rtt} ms` : '—' }),
          el('dt', { text: 'Key' }),
          el('dd', { text: pairing && pairing.key ? maskKey(pairing.key) : '—' }),
          el('dt', { text: 'State' }),
          el('dd', { text: S.online ? 'online' : 'offline' }),
        ]),
        el('div', { class: 'device-foot' }, [
          el('button', { class: 'ghost-btn', type: 'button', text: 'Test now', onclick: () => testLink() }),
          el('button', { class: 'ghost-btn', type: 'button', text: 'Reconnect', onclick: () => reconnect() }),
        ]),
      ]),
    );

    // 2 — the PC
    host.append(
      el('div', { class: 'device' }, [
        el('div', { class: 'device-head' }, [
          el('span', { class: 'device-icon', html: svgIcon(ICONS.chip, 19) }),
          el('div', { class: 'device-title' }, [
            el('strong', { text: S.hardwareOnly ? 'PC agent — not linked' : snap.name || 'PC agent' }),
            el('span', { text: S.hardwareOnly ? 'the ESP32 cannot reach the PC' : snap.hostname || '—' }),
          ]),
        ]),
        el('dl', { class: 'device-meta' }, [
          el('dt', { text: 'Platform' }),
          el('dd', { text: snap.platformLabel || '—' }),
          el('dt', { text: 'Agent' }),
          el('dd', { text: (snap.agent && snap.agent.version) || snap.agentVersion || '—' }),
          el('dt', { text: 'Uptime' }),
          el('dd', { text: snap.uptime ? fmtDuration(snap.uptime) : '—' }),
          el('dt', { text: 'Ports' }),
          el('dd', { text: snap.agent && snap.agent.ports ? `${snap.agent.ports.ui} / ${snap.agent.ports.link}` : '—' }),
        ]),
      ]),
    );

    // 3 — the ESP32
    const linked = esp && (esp.connected === true || esp.link === 'up');
    host.append(
      el('div', { class: 'device' }, [
        el('div', { class: 'device-head' }, [
          el('span', { class: 'device-icon', html: svgIcon(ICONS.brain, 19) }),
          el('div', { class: 'device-title' }, [
            el('strong', { text: esp.device || esp.deviceId || 'ESP32 bridge' }),
            el('span', { text: linked ? 'linked to the agent' : 'not linked' }),
          ]),
        ]),
        el('dl', { class: 'device-meta' }, [
          el('dt', { text: 'Firmware' }),
          el('dd', { text: esp.fw || esp.firmware || '—' }),
          el('dt', { text: 'IP' }),
          el('dd', { text: esp.ip || '—' }),
          el('dt', { text: 'PC power' }),
          el('dd', { text: esp.pc || 'unknown' }),
          el('dt', { text: 'Chip temp' }),
          el('dd', { text: esp.chipTemp ? `${esp.chipTemp} °C` : '—' }),
        ]),
        el('div', { class: 'device-foot' }, [
          el('button', { class: 'ghost-btn', type: 'button', text: 'Identify (blink)', onclick: () => runCommand('esp.identify') }),
          el('button', { class: 'ghost-btn', type: 'button', text: 'Status', onclick: () => runCommand('esp.status') }),
        ]),
      ]),
    );
  }

  async function testLink() {
    if (S.demo) {
      toast('Demo link is fine', { sub: 'simulated 12 ms' });
      return;
    }
    const started = performance.now();
    try {
      const reply = await S.link.request('system.ping');
      const ms = Math.round(performance.now() - started);
      toast('Link works', { sub: `${ms} ms · ${reply.ok ? 'encrypted round trip' : 'device answered'}` });
      Diag.add('info', `manual ping ok in ${ms} ms`);
    } catch (err) {
      toast('Link failed', { sub: err.message, tone: 'err' });
      Diag.add('error', `manual ping failed: ${err.message}`);
    }
  }

  function renderSettings() {
    const kv = (host, rows) => {
      host.innerHTML = '';
      for (const [key, value] of rows) {
        host.append(el('dt', { text: key }));
        host.append(el('dd', { text: value || '—' }));
      }
    };
    const pairing = S.pairing || {};
    kv($('#conn-kv'), [
      ['Mode', pairing.kind === 'plain' ? 'Console token' : `ST1 tunnel${pairing.kind === 'esp' ? ' (ESP32)' : ''}`],
      ['Address', pairing.base],
      ['Device', pairing.name],
      ['Key', pairing.key ? maskKey(pairing.key) : '—'],
      ['Session', S.link && S.link.sid ? S.link.sid : '—'],
      ['Round trip', S.link && S.link.rtt != null ? `${S.link.rtt} ms` : '—'],
      ['Paired', pairing.addedAt ? timeAgo(pairing.addedAt) : '—'],
    ]);
    const policy = (S.snap && S.snap.policy) || {};
    const yesNo = (value) => (value === false ? 'no' : 'yes');
    kv($('#policy-kv'), [
      ['Shutdown', yesNo(policy.allowShutdown)],
      ['Restart', yesNo(policy.allowReboot)],
      ['Sleep', yesNo(policy.allowSleep)],
      ['Screenshots', yesNo(policy.allowScreenshot)],
      ['Typing on the PC', yesNo(policy.allowInput)],
      ['Scripts', yesNo(policy.allowScripts)],
      ['Hardware relay', yesNo(policy.allowEspPower)],
      ['Quiet hours', policy.quietHours && policy.quietHours.enabled ? `${policy.quietHours.from}–${policy.quietHours.to}` : 'off'],
      ['Rate limit', policy.rateLimitPerMinute ? `${policy.rateLimitPerMinute}/min` : '—'],
    ]);
    kv($('#app-kv'), [
      ['Console', APP_VERSION],
      ['Transport', S.pairing && S.pairing.kind === 'plain' ? 'fetch + token' : 'WebCrypto · AES-256-GCM'],
      ['Service worker', 'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'active' : 'not active'],
      ['Activity kept', `${S.events.length} entries`],
    ]);
    $('#btn-demo-out').hidden = !S.demo;
    $('#btn-install').hidden = !S.deferredInstall;
  }

  function renderAll() {
    renderHeader();
    if (S.tab === 'home') {
      renderHero();
      renderMetrics();
      renderInsights();
      renderQuickActions();
      renderHardware();
      renderCatalogue();
    }
    if (S.tab === 'activity') renderTimeline();
    if (S.tab === 'devices') renderDevices();
    if (S.tab === 'settings') renderSettings();
  }

  /* ── tabs ──────────────────────────────────────────────────────────────── */

  function showTab(tab) {
    S.tab = tab;
    for (const button of $$('.tab')) button.classList.toggle('is-on', button.dataset.tab === tab);
    for (const screen of $$('.screen')) screen.hidden = screen.dataset.screen !== tab;
    renderAll();
    if (tab === 'devices') renderDevices();
    if (tab === 'settings') renderSettings();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     DEMO
     ══════════════════════════════════════════════════════════════════════════ */

  function demoSnapshot() {
    const t = Date.now() / 1000;
    return {
      name: 'STRIGA-7',
      hostname: 'STRIGA-7',
      platformLabel: 'Windows',
      platform: 'win32',
      cpuCount: 16,
      cpuModel: 'AMD Ryzen 7 5800X 8-Core',
      cpuPercent: Math.round(18 + 12 * Math.sin(t / 9) + 6 * Math.sin(t / 2.7)),
      memory: 34359738368,
      memoryDetail: { total: 34359738368, used: 19864223744, percent: 58 },
      uptime: 382140,
      uptimeLabel: '4d 10h',
      agent: { version: APP_VERSION, counters: { commands: 37 }, ports: { ui: 7878, link: 7879 } },
      esp: {
        connected: true,
        device: 'esp32-bridge',
        fw: '2.1.0',
        ip: '192.168.1.1',
        pc: S.demoRelay ? 'off' : 'on',
        chipTemp: 47,
        link: 'up',
      },
      policy: {
        allowShutdown: true,
        allowReboot: true,
        allowSleep: true,
        allowLock: true,
        allowScreenshot: true,
        allowInput: false,
        allowScripts: false,
        allowEspPower: true,
        requireConfirm: true,
        rateLimitPerMinute: 40,
        quietHours: { enabled: false, from: '23:00', to: '07:00' },
      },
      insights: [
        {
          id: 'demo-esp',
          level: 'info',
          title: 'The ESP32 link is healthy',
          detail: 'Last state 4 s ago, chip at 47 °C, relay idle.',
        },
        {
          id: 'demo-quiet',
          level: 'warn',
          title: 'Quiet hours start in 25 minutes',
          detail: 'Power commands will be refused between 23:00 and 07:00 unless you change the policy.',
          action: { label: 'See the policy', cmd: 'agent.status' },
        },
      ],
      catalogue: [
        { group: 'Power', cmd: 'system.shutdown', label: 'Shut down' },
        { group: 'Power', cmd: 'system.reboot', label: 'Restart' },
        { group: 'Power', cmd: 'system.sleep', label: 'Sleep' },
        { group: 'Power', cmd: 'system.cancel_shutdown', label: 'Cancel shutdown' },
        { group: 'Session', cmd: 'system.lock', label: 'Lock screen' },
        { group: 'Session', cmd: 'screen.wake', label: 'Wake display' },
        { group: 'Session', cmd: 'screen.screenshot', label: 'Screenshot' },
        { group: 'Media', cmd: 'media.play_pause', label: 'Play / pause' },
        { group: 'Media', cmd: 'media.next', label: 'Next track' },
        { group: 'Media', cmd: 'volume.up', label: 'Volume up' },
        { group: 'Media', cmd: 'volume.down', label: 'Volume down' },
        { group: 'Media', cmd: 'volume.mute', label: 'Mute' },
        { group: 'Hardware', cmd: 'esp.power', label: 'Hard power (relay)' },
        { group: 'Hardware', cmd: 'esp.reset', label: 'Hard reset (relay)' },
        { group: 'Hardware', cmd: 'esp.status', label: 'ESP32 status' },
        { group: 'System', cmd: 'agent.status', label: 'Agent status' },
      ],
    };
  }

  function demoCommand(cmd, args) {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (cmd === 'esp.power' && args.action === 'off') S.demoRelay = true;
        if (cmd === 'esp.power' && args.action === 'on') S.demoRelay = false;
        if (cmd === 'esp.power' && args.action === 'cycle') S.demoRelay = !S.demoRelay;
        resolve({ ok: true, cmd, data: { simulated: true }, ms: 20 + Math.round(Math.random() * 60) });
      }, 180 + Math.random() * 320);
    });
  }

  function startDemo() {
    S.demo = true;
    store.set(STORE.demo, true);
    S.pairing = { kind: 'demo', base: 'demo', label: 'demo', name: 'STRIGA-7', addedAt: new Date().toISOString() };
    S.events = [
      { at: new Date(Date.now() - 600000).toISOString(), level: 'info', source: 'agent', message: 'SENTINEL agent started (demo)' },
      { at: new Date(Date.now() - 420000).toISOString(), level: 'info', source: 'link', message: 'ESP32 authenticated over the local link' },
      { at: new Date(Date.now() - 240000).toISOString(), level: 'warn', source: 'security', message: 'Blocked input.type — allowInput is off' },
    ];
    startApp();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════════ */

  function dismissBoot() {
    const boot = $('#boot');
    if (!boot) return;
    boot.classList.add('out');
    setTimeout(() => boot.remove(), 420);
  }

  function startApp() {
    dismissBoot();
    $('#pair').hidden = true;
    $('#app').hidden = false;
    showTab(S.tab || 'home');
    renderAll();
    startPolling();
    refresh().catch(() => {});
    if (!S.demo) S.online = true;
    setOnline(true);
  }

  function showPairScreen() {
    dismissBoot();
    $('#app').hidden = true;
    $('#pair').hidden = false;
    const address = $('#pair-address');
    if (!address.value && S.pairing) address.value = S.pairing.label || '';
    $('#pair-key').value = S.pairing && S.pairing.key ? S.pairing.key : '';
    const params = new URLSearchParams(location.search);
    if (params.get('t')) {
      $('#pair-token').value = params.get('t');
      $('#pair-advanced').open = true;
      $('#pair-address').value = location.host;
    }
    $('#pair-version').textContent = `SENTINEL ${APP_VERSION}`;
  }

  function wireUi() {
    // pairing
    $('#pair-form').addEventListener('submit', submitPairing);
    $('#pair-key-paste').addEventListener('click', async () => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast('Clipboard blocked', { sub: 'Paste into the field by hand', tone: 'warn' });
        return;
      }
      const cleaned = String(text || '').trim();
      if (!cleaned) {
        toast('Clipboard is empty', { tone: 'warn' });
        return;
      }
      $('#pair-key').value = cleaned;
      $('#pair-key').dispatchEvent(new Event('input'));
      toast('Key pasted', { sub: `${cleaned.replace(/\s/g, '').length} characters` });
    });
    $('#pair-key-eye').addEventListener('click', () => {
      const input = $('#pair-key');
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      $('#pair-key-eye').setAttribute('aria-pressed', String(!shown));
      $('#pair-key-eye').setAttribute('aria-label', shown ? 'Show the key' : 'Hide the key');
    });
    $('#pair-address-help').addEventListener('click', () => {
      openSheet({
        title: 'Where is the address?',
        body: [
          el('p', { text: 'The address is the local IP of your own hardware. Both devices must be on the same Wi-Fi.' }),
          el('p', { text: 'On the PC: open the SENTINEL console. The pairing panel shows the exact address to type, for example 192.168.1.50:7878.' }),
          el('p', { text: 'On the ESP32: connect to its setup network or open its page; the IP is 192.168.1.1 by default.' }),
          el('p', { class: 'hint', text: 'Ports: the PC agent uses 7878, the ESP32 uses 80. If you leave the port out, the app tries the right one.' }),
          el('p', { class: 'hint', text: 'A phone that is on mobile data cannot reach either device. Join the same Wi-Fi first.' }),
        ],
        actions: [{ label: 'Got it', tone: 'primary', run: () => {} }],
      });
    });
    $('#pair-test').addEventListener('click', runProbe);
    $('#pair-address').addEventListener('blur', () => {
      const value = $('#pair-address').value.trim();
      if (!value || value === 'self') return;
      try {
        $('#pair-address').value = T.normaliseAddress(value);
        $('#pair-address').classList.remove('invalid');
      } catch {
        $('#pair-address').classList.add('invalid');
      }
    });
    $('#pair-key').addEventListener('input', () => {
      const value = $('#pair-key').value.replace(/\s/g, '');
      const ok = /^[0-9a-fA-F]{64}$/.test(value);
      $('#pair-key-hint').innerHTML = ok
        ? '<span style="color:var(--mint)">Key looks right — 32 bytes.</span>'
        : value.length
          ? `${value.length}/64 characters`
          : 'Shown in the PC console under <em>Pairing</em>, and on the ESP32 setup page.';
    });
    for (const chip of $$('[data-fill]')) {
      chip.addEventListener('click', () => {
        if (chip.dataset.fill === 'self') {
          $('#pair-address').value = location.host;
          $('#pair-key').focus();
          toast('Using this computer', { sub: 'Add the pairing key to continue' });
        } else if (chip.dataset.fill === 'esp32') {
          $('#pair-address').value = '192.168.1.1';
          $('#pair-key').focus();
          toast('ESP32 address filled in', { sub: 'Now paste the pairing key' });
        }
      });
    }
    $('#pair-diagnostics-toggle').addEventListener('click', () => {
      const panel = $('#pair-diagnostics');
      panel.hidden = !panel.hidden;
      $('#pair-diagnostics-toggle').setAttribute('aria-expanded', String(!panel.hidden));
      renderDiag();
    });
    $('#diag-copy').addEventListener('click', async () => {
      const ok = await copyText(diagText());
      toast(ok ? 'Diagnostics copied' : 'Copy failed', { tone: ok ? 'ok' : 'warn' });
    });
    $('#diag-clear').addEventListener('click', () => Diag.clear());
    $('#pair-demo').addEventListener('click', startDemo);

    // app shell
    for (const tab of $$('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));
    $('#btn-refresh').addEventListener('click', async () => {
      $('#btn-refresh').classList.add('spin');
      try {
        await refresh();
        toast('Refreshed', { sub: S.link && S.link.rtt != null ? `${S.link.rtt} ms` : 'ok' });
      } finally {
        setTimeout(() => $('#btn-refresh').classList.remove('spin'), 400);
      }
    });
    for (const button of $$('[data-quick]')) {
      button.addEventListener('click', () => runCommandWithArgs(button.dataset.quick));
    }
    $('#btn-pair-new').addEventListener('click', () => {
      $('#app').hidden = true;
      showPairScreen();
    });
    $('#btn-reconnect').addEventListener('click', () => reconnect());
    $('#btn-unpair').addEventListener('click', () => {
      confirmSheet({
        title: 'Unpair this phone?',
        message: 'The address and key will be removed from this device. You can pair again with the same key.',
        confirmLabel: 'Unpair',
        onConfirm: () => {
          store.drop(STORE.pairing);
          S.pairing = null;
          if (S.link) S.link.close();
          S.link = null;
          clearInterval(S.pollTimer);
          clearInterval(S.eventTimer);
          location.reload();
        },
      });
    });
    $('#btn-demo-out').addEventListener('click', () => {
      store.drop(STORE.demo);
      location.reload();
    });
    $('#btn-install').addEventListener('click', async () => {
      if (!S.deferredInstall) return;
      S.deferredInstall.prompt();
      const choice = await S.deferredInstall.userChoice;
      toast(choice.outcome === 'accepted' ? 'Installing…' : 'Install dismissed');
      S.deferredInstall = null;
      renderSettings();
    });
    $('#btn-diagnostics').addEventListener('click', () => {
      const panel = $('#settings-diag');
      panel.hidden = !panel.hidden;
      panel.textContent = diagText();
    });
    $('#sheet-close').addEventListener('click', closeSheet);
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSheet();
    });
    $('#activity-filter').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      S.filter = button.dataset.filter;
      for (const seg of $$('#activity-filter .seg')) seg.classList.toggle('is-on', seg === button);
      renderTimeline();
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      S.deferredInstall = event;
      if (S.tab === 'settings') renderSettings();
    });
  }

  function diagText() {
    const lines = Diag.entries.map((entry) => `${entry.at} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`);
    lines.push('');
    lines.push(`app ${APP_VERSION} · ${navigator.userAgent}`);
    lines.push(`origin ${location.origin} · online ${S.online} · demo ${S.demo}`);
    if (S.pairing) lines.push(`pairing ${JSON.stringify({ ...S.pairing, key: maskKey(S.pairing.key) })}`);
    return lines.join('\n');
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.get('t')) S.token = params.get('t');
    wireUi();

    if (params.get('demo') === '1' || store.get(STORE.demo, false)) {
      startDemo();
      return;
    }

    const pairing = store.get(STORE.pairing, null);
    if (pairing && pairing.kind && pairing.kind !== 'demo') {
      S.pairing = pairing;
      $('#boot').querySelector('.boot-text').textContent = `Reaching ${pairing.label || 'your device'}…`;
      try {
        const attempt = await attemptConnect({
          address: pairing.base.replace(/\/api\/tunnel$|\/t$/, ''),
          key: pairing.key,
          token: pairing.token,
          onStep: () => {},
        });
        S.link = attempt.link;
        S.pairing = attempt.pairing;
        store.set(STORE.pairing, attempt.pairing);
        startApp();
        return;
      } catch (err) {
        Diag.add('error', `auto-connect failed: ${err.message}`);
        showPairScreen();
        showPairError(explainTransportError(err));
        return;
      }
    }

    // Same-origin console with a token in the URL: connect straight away.
    if (S.token) {
      $('#boot').querySelector('.boot-text').textContent = 'Signing in to this computer…';
      try {
        const attempt = await attemptConnect({ address: location.host, token: S.token, onStep: () => {} });
        S.link = attempt.link;
        S.pairing = attempt.pairing;
        startApp();
        return;
      } catch (err) {
        Diag.add('error', `token sign-in failed: ${err.message}`);
        showPairScreen();
        showPairError(explainTransportError(err));
        return;
      }
    }

    showPairScreen();
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  boot().catch((err) => {
    showPairScreen();
    showPairError({ title: 'SENTINEL could not start', message: err.message, hint: 'Reload the page. If it keeps happening, open Diagnostics and copy the report.' });
  });
})();
