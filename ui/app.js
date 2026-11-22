/* ============================================================
   SENTINEL control surface — plain ES2020, no framework, no build
   step so the exact same file runs in the desktop window and in
   the Android WebView.
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const icon = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const STORE_BASE = 'sentinel.base';
  const STORE_TOKEN = 'sentinel.token';
  const STORE_DEMO = 'sentinel.demo';
  const STORE_ESP_BASE = 'sentinel.esp.base';
  const STORE_ESP_TOKEN = 'sentinel.esp.token';

  const state = {
    base: '',
    token: '',
    demo: false,
    connected: false,
    status: null,
    log: [],
    macros: {},
    catalogue: [],
    view: 'dashboard',
    level: 'all',
    latency: null,
    pendingMacroSteps: [],
    paletteIndex: 0,
    paletteItems: [],
  };

  /* ─────────────────────────── utilities ─────────────────────────── */

  const isNative = () =>
    Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());

  const fmtBytes = (bytes) => {
    if (!bytes && bytes !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  };

  const fmtUptime = (seconds) => {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  };

  const timeOf = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString(undefined, { hour12: false });
  };

  const esc = (text) =>
    String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  };

  const toast = (message, kind = 'info', ms = 3800) => {
    const node = document.createElement('div');
    node.className = `toast is-${kind}`;
    node.innerHTML = `${icon(kind === 'ok' ? 'check' : kind === 'err' ? 'x' : 'activity')}<p>${esc(message)}</p>`;
    $('#toasts').appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 220);
    }, ms);
  };

  const banner = (message, kind = 'warn') => {
    const node = $('#banner');
    if (!message) {
      node.classList.add('hidden');
      return;
    }
    node.className = `banner${kind === 'error' ? ' is-error' : ''}`;
    node.innerHTML = `${icon(kind === 'error' ? 'x' : 'shield')}<span>${esc(message)}</span>`;
  };

  /* ─────────────────────────── transport ─────────────────────────── */

  const apiUrl = (path) => `${state.base}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(state.token)}`;

  async function api(path, { method = 'GET', body = null } = {}) {
    if (state.demo) return demoApi(path, method, body);
    const started = performance.now();
    const res = await fetch(apiUrl(path), {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${state.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    state.latency = Math.round(performance.now() - started);
    if (res.status === 401) {
      throw Object.assign(new Error('Rejected: the access token is not valid'), { code: 'UNAUTHORISED' });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.message) throw new Error(`Agent returned HTTP ${res.status}`);
    return data;
  }

  async function run(cmd, args = {}, { quiet = false } = {}) {
    try {
      const result = await api('/api/command', { method: 'POST', body: { cmd, args } });
      if (!result.ok) {
        toast(result.message || `${cmd} failed`, 'err', 5200);
        return result;
      }
      if (!quiet) toast(describeSuccess(cmd, result.data), 'ok', 2400);
      if (cmd === 'system.screenshot' && result.data && result.data.data) showShot(result.data);
      refreshStatus();
      return result;
    } catch (err) {
      if (err.code === 'UNAUTHORISED') handleAuthFailure(err);
      else toast(err.message || 'Network error', 'err', 5200);
      return { ok: false, message: err.message };
    }
  }

  function describeSuccess(cmd, data) {
    const map = {
      'system.shutdown': `Shutdown scheduled${data && data.scheduledInSec ? ` in ${data.scheduledInSec}s` : ''}`,
      'system.reboot': `Restart scheduled${data && data.scheduledInSec ? ` in ${data.scheduledInSec}s` : ''}`,
      'system.cancel_shutdown': 'Shutdown cancelled',
      'system.lock': 'Workstation locked',
      'system.sleep': 'Going to sleep',
      'system.logout': 'Logging out',
      'screen.wake': 'Display woken',
      'screen.screenshot': 'Screenshot captured',
      'media.play_pause': 'Play / pause sent',
      'media.next': 'Next track',
      'media.previous': 'Previous track',
      'volume.up': 'Volume up',
      'volume.down': 'Volume down',
      'volume.mute': 'Mute toggled',
      'input.type': 'Text typed',
      'input.key': 'Key sent',
      'esp.power': `Relay: ${data && data.action ? data.action : 'pulse'} complete`,
      'esp.reset': 'Reset pulse sent',
      'macro.run': 'Macro finished',
      'app.launch': 'Application started',
      'script.run': 'Script finished',
    };
    return map[cmd] || `${cmd} · ok`;
  }

  function showShot(payload) {
    const url = `data:${payload.mime || 'image/png'};base64,${payload.data}`;
    $('#shot-img').src = url;
    $('#shot-download').href = url;
    $('#shot-modal').classList.remove('hidden');
    const preview = $('#shot-preview');
    preview.innerHTML = `<img src="${url}" alt="Latest screenshot" />`;
  }

  /* ─────────────────────────── demo mode ─────────────────────────── */

  function demoStatus() {
    const now = new Date();
    return {
      name: 'STUDIO-PC',
      hostname: 'studio-pc',
      platform: 'win32',
      platformLabel: 'Windows',
      release: '10.0.26100',
      arch: 'x64',
      cpuModel: 'AMD Ryzen 7 7800X3D',
      cpuCount: 16,
      cpuPercent: 37,
      memory: { total: 34359738368, used: 18575733555, free: 15784004813, percent: 54 },
      uptime: 239472,
      uptimeLabel: '2d 18h',
      user: 'pawel',
      agentVersion: '2.0.0',
      node: 'v22',
      capabilities: { shutdown: true, reboot: true, sleep: true, lock: true, logout: true, media: true, volume: true, screenshot: true, wake: true, input: true, apps: true },
      policy: {
        allowShutdown: true, allowReboot: true, allowSleep: true, allowLock: true, allowLogout: true,
        allowMedia: true, allowVolume: true, allowScreenshot: true, allowWake: true, allowAppLaunch: true,
        allowAppKill: false, allowInput: true, allowScripts: false, allowFileList: false,
        allowEspPower: true, requireConfirm: true, rateLimitPerMinute: 40,
        quietHours: { enabled: false, from: '23:00', to: '07:00' },
      },
      esp: {
        connected: true, deviceId: 'esp32-sentinel', transport: 'tcp', ip: '10.8.0.7',
        rssi: -54, tempC: 42.5, fw: '2.0.0', pcState: 'on', deviceUptime: 86400, wg: true, gpio: { relay: false },
      },
      agent: { version: '2.0.0', counters: { commands: 128, errors: 1 }, lastCommand: { cmd: 'system.lock', at: now.toISOString(), ms: 42 } },
      apps: ['Spotify', 'Steam', 'OBS'],
      appList: [
        { name: 'Spotify', path: 'C:\\Users\\pawel\\AppData\\Roaming\\Spotify\\Spotify.exe' },
        { name: 'Steam', path: 'C:\\Program Files (x86)\\Steam\\steam.exe' },
        { name: 'OBS', path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' },
      ],
      catalogue: demoCatalogue(),
      macros: ['Morning setup', 'Cinema mode'],
      serverTime: now.toISOString(),
      capabilitiesLabel: 'demo',
    };
  }

  function demoCatalogue() {
    return [
      { group: 'Power', cmd: 'system.shutdown', label: 'Shut down' },
      { group: 'Power', cmd: 'system.reboot', label: 'Restart' },
      { group: 'Power', cmd: 'system.sleep', label: 'Sleep' },
      { group: 'Power', cmd: 'esp.power', label: 'Hard power (relay)' },
      { group: 'Session', cmd: 'system.lock', label: 'Lock screen' },
      { group: 'Session', cmd: 'system.logout', label: 'Log out' },
      { group: 'Session', cmd: 'screen.screenshot', label: 'Screenshot' },
      { group: 'Session', cmd: 'screen.wake', label: 'Wake display' },
      { group: 'Media', cmd: 'media.play_pause', label: 'Play / pause' },
      { group: 'Media', cmd: 'media.next', label: 'Next track' },
      { group: 'Media', cmd: 'media.previous', label: 'Previous track' },
      { group: 'Media', cmd: 'volume.up', label: 'Volume up' },
      { group: 'Media', cmd: 'volume.down', label: 'Volume down' },
      { group: 'Media', cmd: 'volume.mute', label: 'Mute' },
      { group: 'Input', cmd: 'input.type', label: 'Type text' },
      { group: 'Apps', cmd: 'app.launch', label: 'Launch app' },
    ];
  }

  const demoMacros = {
    'Morning setup': { description: 'Wake, unlock, open mail', steps: [{ cmd: 'screen.wake' }, { cmd: 'app.launch', args: { name: 'Spotify' } }] },
    'Cinema mode': { description: 'Dim, mute notifications', steps: [{ cmd: 'volume.down' }, { cmd: 'system.lock' }] },
  };

  async function demoApi(path, method, body) {
    await sleep(120 + Math.random() * 180);
    state.latency = Math.round(90 + Math.random() * 60);
    if (path.startsWith('/api/status')) return { ok: true, data: demoStatus() };
    if (path.startsWith('/api/macros') && method === 'GET') return { ok: true, data: demoMacros };
    if (path.startsWith('/api/pairing')) {
      return {
        ok: true,
        data: {
          agent_host: '10.8.0.5',
          agent_port: 7879,
          psk: 'demo0000demo0000demo0000demo0000demo0000demo0000demo0000demo0000',
          power_pin: 25,
          reset_pin: 26,
          device_id: 'esp32-sentinel',
          ui_url: 'http://10.8.0.5:7878',
          token: 'demo-token-not-a-real-secret',
        },
      };
    }
    if (path.startsWith('/api/log')) return { ok: true, data: demoLog() };
    if (path.startsWith('/api/command')) {
      const cmd = body && body.cmd;
      const data = cmd === 'system.shutdown' || cmd === 'system.reboot' ? { scheduledInSec: 30 } : {};
      return { ok: true, cmd, data, ms: 40 };
    }
    if (path.startsWith('/api/keys')) return { ok: true, data: { psk: 'rotated-demo-key', uiToken: 'rotated-token' } };
    return { ok: true, data: {} };
  }

  function demoLog() {
    const now = Date.now();
    return [
      { at: new Date(now - 120000).toISOString(), level: 'info', source: 'agent', message: 'SENTINEL 2.0.0 ready' },
      { at: new Date(now - 100000).toISOString(), level: 'info', source: 'link', message: 'ESP32 "esp32-sentinel" linked over tcp' },
      { at: new Date(now - 74000).toISOString(), level: 'info', source: 'command', message: 'system.lock → ok (38ms)' },
      { at: new Date(now - 41000).toISOString(), level: 'warn', source: 'esp', message: 'Relay cycle (hold 600ms)' },
      { at: new Date(now - 9000).toISOString(), level: 'info', source: 'command', message: 'media.play_pause → ok (61ms)' },
    ];
  }

  /* ─────────────────────────── rendering ─────────────────────────── */

  function setView(view) {
    state.view = view;
    $$('.view').forEach((section) => section.classList.toggle('is-active', section.dataset.view === view));
    $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
    const titles = {
      dashboard: ['Overview', 'Your machine at a glance'],
      control: ['Control', 'Media, keyboard and capabilities'],
      automation: ['Automation', 'Macros and the command catalogue'],
      devices: ['Devices', 'The ESP32 bridge and pairing'],
      activity: ['Activity', 'Everything that has happened, live'],
      settings: ['Settings', 'Safety, apps and connection'],
    };
    const [title, sub] = titles[view] || ['SENTINEL', ''];
    $('#view-title').textContent = title;
    $('#view-sub').textContent = sub;
    if (view === 'activity') renderLog();
    if (view === 'devices') loadPairing();
    if (view === 'automation') loadMacros();
    if (window.innerWidth < 900) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render(status) {
    state.status = status;
    state.connected = true;
    state.catalogue = status.catalogue || state.catalogue;

    const name = status.name || status.hostname || 'This PC';
    const memory = status.memory || { used: 0, total: 0, percent: 0 };
    const cpu = Math.max(0, Math.min(100, Math.round(status.cpuPercent || 0)));

    $('#hero-name').textContent = name;
    $('#hero-platform').textContent = status.platformLabel || status.platform || 'PC';
    $('#hero-arch').textContent = status.arch || '';
    $('#hero-sub').textContent = `${status.cpuModel || 'CPU'} · ${status.cpuCount || '?'} threads · ${status.user || ''}`;
    $('#hero-ip').textContent = state.base.replace(/^https?:\/\//, '') || location.host;
    $('#avatar').textContent = (name || 'PC').slice(0, 2).toUpperCase();

    const statePill = $('#hero-state');
    statePill.classList.toggle('is-down', !state.connected);
    statePill.querySelector('span:last-child').textContent = 'Online';
    $('#set-system').innerHTML = `
      <div><span>Host</span><strong>${esc(status.hostname || '—')}</strong></div>
      <div><span>OS</span><strong>${esc(status.platformLabel || status.platform)} ${esc(status.release || '')}</strong></div>
      <div><span>User</span><strong>${esc(status.user || '—')}</strong></div>
      <div><span>Agent</span><strong>v${esc(status.agentVersion || '—')}</strong></div>
      <div><span>ESP32</span><strong>${esc(status.esp && status.esp.deviceId ? status.esp.deviceId : 'not linked')}</strong></div>`;

    // CPU gauge
    const gauge = $('#gauge');
    const circumference = 2 * Math.PI * 52;
    const arc = circumference * 0.75;
    const value = $('.gauge-value');
    value.style.strokeDasharray = `${arc} ${circumference}`;
    value.style.strokeDashoffset = String(arc - (arc * cpu) / 100);
    $('#gauge-cpu').textContent = String(cpu);
    gauge.classList.toggle('is-hot', cpu >= 70 && cpu < 90);
    gauge.classList.toggle('is-critical', cpu >= 90);

    // memory
    $('#mem-used').textContent = fmtBytes(memory.used);
    $('#mem-total').textContent = `/ ${fmtBytes(memory.total)}`;
    $('#mem-meter').style.width = `${memory.percent || 0}%`;
    $('#mem-percent').textContent = `${memory.percent || 0}% in use`;
    $('#mem-meter').parentElement.classList.toggle('is-hot', (memory.percent || 0) > 85);

    $('#up-value').textContent = fmtUptime(status.uptime);
    $('#up-foot').textContent = `host ${status.hostname || ''}`;

    const counters = (status.agent && status.agent.counters) || {};
    $('#cmd-count').textContent = String(counters.commands || 0);
    const last = status.agent && status.agent.lastCommand;
    $('#cmd-last').textContent = last ? `${last.cmd} · ${timeOf(last.at)}` : 'no commands yet';

    renderEsp(status.esp);
    renderPolicy(status.policy);
    renderCapsGrid(status.policy, status.capabilities);
    renderSafety(status.policy);
    renderApps(status.appList || []);
    renderCatalogue(status.catalogue || []);
    renderChips(status.apps || []);
    renderConnection(status);

    $('#set-name').value = status.name || '';
    $('#latency').textContent = state.latency == null ? '—' : `${state.latency} ms`;
    $('#latency-pill').className = `pill${state.latency != null && state.latency < 250 ? ' is-good' : state.latency != null ? ' is-bad' : ''}`;

    document.title = `SENTINEL · ${name}`;
  }

  function renderEsp(esp) {
    const connected = Boolean(esp && esp.connected);
    const badge = $('#esp-badge');
    if (badge) {
      badge.textContent = connected ? 'linked' : 'offline';
      badge.className = `badge ${connected ? 'is-on' : 'is-off'}`;
    }
    const badge2 = $('#esp-badge-2');
    if (badge2) {
      badge2.textContent = connected ? `linked · ${esp.transport || 'tcp'}` : 'offline';
      badge2.className = `badge ${connected ? 'is-on' : 'is-off'}`;
    }

    const chip = $('#link-chip');
    chip.className = `link-chip ${connected ? 'is-on' : 'is-off'}`;
    $('#link-label').textContent = connected ? 'ESP32 linked' : 'ESP32 offline';
    $('#link-detail').textContent = connected
      ? `${esp.transport === 'usb' ? 'USB serial' : esp.ip || 'tcp'}${esp.rssi ? ` · ${esp.rssi} dBm` : ''}`
      : 'no bridge connected';

    const pairs = [
      ['Transport', connected ? (esp.transport === 'usb' ? 'USB serial' : 'TCP / VPN') : '—'],
      ['Wi-Fi', esp && esp.rssi ? `${esp.rssi} dBm` : '—'],
      ['Chip temp', esp && esp.tempC != null ? `${esp.tempC.toFixed(1)} °C` : '—'],
      ['PC sense', esp && esp.pcState && esp.pcState !== 'unknown' ? esp.pcState.toUpperCase() : '—'],
      ['Firmware', (esp && esp.fw) || '—'],
      ['Tunnel', esp && esp.wg ? 'WireGuard up' : connected ? 'direct' : '—'],
    ];
    const html = pairs.map(([k, v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');
    $('#esp-kv').innerHTML = html;
    const kv2 = $('#esp-kv-2');
    if (kv2) kv2.innerHTML = html;
  }

  const POLICY_FLAGS = [
    ['allowShutdown', 'Shut down', 'Power the PC off cleanly'],
    ['allowReboot', 'Restart', 'Reboot the PC'],
    ['allowSleep', 'Sleep', 'Suspend the machine'],
    ['allowLock', 'Lock screen', 'Lock the workstation'],
    ['allowLogout', 'Log out', 'End the user session'],
    ['allowScreenshot', 'Screenshot', 'Capture the screen'],
    ['allowWake', 'Wake display', 'Wake the monitor'],
    ['allowMedia', 'Media keys', 'Play, pause, skip'],
    ['allowVolume', 'Volume', 'Change system volume'],
    ['allowEspPower', 'Hard power relay', 'Cut/return mains through the ESP32'],
    ['allowAppLaunch', 'Launch apps', 'Only allow-listed apps'],
    ['allowInput', 'Keyboard input', 'Type and press keys on the PC'],
    ['allowAppKill', 'Kill processes', 'Force-quit allow-listed apps'],
    ['allowScripts', 'Run scripts', 'Execute configured scripts'],
  ];

  function renderCapsGrid(policy, capabilities) {
    const grid = $('#caps-grid');
    if (!grid || !policy) return;
    grid.innerHTML = POLICY_FLAGS.map(([flag, label, desc]) => {
      const on = policy[flag] !== false;
      const unsupported =
        capabilities &&
        ((flag === 'allowInput' && capabilities.input === false) ||
          (flag === 'allowScreenshot' && capabilities.screenshot === false) ||
          (flag === 'allowMedia' && capabilities.media === false) ||
          (flag === 'allowVolume' && capabilities.volume === false));
      return `<div class="cap ${on ? '' : 'is-off'}">
        <div class="cap-body">
          <strong>${label}</strong>
          <span>${unsupported ? 'not available on this OS' : desc}</span>
        </div>
        <button class="switch ${on ? 'is-on' : ''}" role="switch" aria-checked="${on}" data-policy="${flag}" title="Toggle ${label}"></button>
      </div>`;
    }).join('');

    const inputOn = policy.allowInput !== false && (!capabilities || capabilities.input !== false);
    const badge = $('#input-badge');
    badge.textContent = inputOn ? 'enabled' : 'locked';
    badge.className = `badge ${inputOn ? 'is-on' : 'badge-warn'}`;
    $('#type-form').querySelector('button[type="submit"]').disabled = !inputOn;
  }

  function renderPolicy(policy) {
    if (!policy) return;
    $$('[data-policy]').forEach((btn) => {
      const on = policy[btn.dataset.policy] !== false;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
    });
  }

  function renderSafety(policy) {
    if (!policy) return;
    const quiet = policy.quietHours || { enabled: false, from: '23:00', to: '07:00' };
    $('#safety-list').innerHTML = `
      <div class="switch-row">
        <div><strong>Ask before destructive actions</strong><span>Shutdown, restart, killing apps and relays need a hold-to-confirm.</span></div>
        <button class="switch ${policy.requireConfirm !== false ? 'is-on' : ''}" role="switch" aria-checked="${policy.requireConfirm !== false}" data-policy="requireConfirm"></button>
      </div>
      <div class="switch-row">
        <div><strong>Quiet hours</strong><span>Block power actions overnight unless you cancel the shutdown.</span></div>
        <button class="switch ${quiet.enabled ? 'is-on' : ''}" role="switch" aria-checked="${quiet.enabled}" data-quiet="1"></button>
      </div>
      <div class="switch-row">
        <div><strong>Window</strong><span>From / to, local time on the PC.</span></div>
        <div class="row-buttons">
          <input class="select" id="quiet-from" type="time" value="${esc(quiet.from)}" style="width:112px" />
          <input class="select" id="quiet-to" type="time" value="${esc(quiet.to)}" style="width:112px" />
        </div>
      </div>
      <div class="switch-row">
        <div><strong>Rate limit</strong><span>Commands per minute from any one client.</span></div>
        <input class="select" id="rate-limit" type="number" min="5" max="240" value="${Number(policy.rateLimitPerMinute) || 40}" style="width:92px" />
      </div>`;
    $('#quiet-from').addEventListener('change', saveQuietHours);
    $('#quiet-to').addEventListener('change', saveQuietHours);
    $('#rate-limit').addEventListener('change', (e) => {
      patchPolicy({ rateLimitPerMinute: Math.max(5, Math.min(240, Number(e.target.value) || 40)) });
    });
    $$('[data-quiet]').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (!state.status) return;
        const current = (state.status.policy.quietHours || {}).enabled;
        patchPolicy({ quietHours: { ...(state.status.policy.quietHours || {}), enabled: !current } });
      }),
    );
  }

  function saveQuietHours() {
    patchPolicy({
      quietHours: {
        ...((state.status && state.status.policy.quietHours) || {}),
        enabled: true,
        from: $('#quiet-from').value || '23:00',
        to: $('#quiet-to').value || '07:00',
      },
    });
  }

  function renderApps(appList) {
    const list = $('#app-list');
    if (!list) return;
    if (!appList.length) {
      list.innerHTML = '<li><span class="grow">No apps allow-listed yet</span></li>';
      return;
    }
    list.innerHTML = appList
      .map(
        (app) => `<li><strong>${esc(app.label || app.name)}</strong><span class="grow">${esc(app.path || '')}</span>
        <button class="mini-x" data-app-remove="${esc(app.name)}" title="Remove">${icon('x')}</button></li>`,
      )
      .join('');
    $$('[data-app-remove]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const name = btn.dataset.appRemove;
        if (state.demo) return toast(`Removed ${name} (demo)`, 'ok');
        const result = await api(`/api/apps/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (result.ok) {
          toast(`Removed ${name}`, 'ok');
          refreshStatus();
        }
      }),
    );
  }

  function renderChips(apps) {
    const chips = $('#apps-chips');
    if (!chips) return;
    if (!apps.length) {
      chips.innerHTML = '<span class="muted small">No apps allow-listed yet — add one in Settings.</span>';
      return;
    }
    chips.innerHTML = apps.map((name) => `<button class="chip" data-run-app="${esc(name)}">${esc(name)}</button>`).join('');
    $$('[data-run-app]').forEach((chip) =>
      chip.addEventListener('click', () => run('app.launch', { name: chip.dataset.runApp })),
    );
  }

  function renderCatalogue(catalogue) {
    if (!catalogue || !catalogue.length) return;
    state.catalogue = catalogue;
    const wrap = $('#catalogue');
    if (wrap) {
      const groups = {};
      for (const item of catalogue) (groups[item.group] = groups[item.group] || []).push(item);
      wrap.innerHTML = Object.entries(groups)
        .map(([group, items]) => {
          const rows = items
            .map(
              (item) =>
                `<button data-catalogue="${esc(item.cmd)}"><span>${esc(item.label || item.cmd)}</span><code>${esc(item.cmd)}</code></button>`,
            )
            .join('');
          return `<div class="catalogue-group"><span class="muted small">${esc(group)}</span>${rows}</div>`;
        })
        .join('');
      $$('[data-catalogue]').forEach((button) =>
        button.addEventListener('click', () =>
          triggerCommand(button.dataset.catalogue, {}, { hold: /shutdown|reboot|logout|esp\.|kill/.test(button.dataset.catalogue) }),
        ),
      );
    }
    const count = $('#catalogue-count');
    if (count) count.textContent = `${catalogue.length} commands`;
  }

  function renderConnection(status) {
    const box = $('#set-connection');
    if (!box) return;
    box.innerHTML = `
      <div><span>Server</span><strong>${esc(state.base.replace(/^https?:\/\//, '') || location.host)}</strong></div>
      <div><span>Token</span><strong>${state.token ? `${state.token.slice(0, 6)}…` : 'none'}</strong></div>
      <div><span>Round trip</span><strong>${state.latency == null ? '—' : `${state.latency} ms`}</strong></div>
      <div><span>Mode</span><strong>${state.demo ? 'demo' : isNative() ? 'mobile' : 'desktop'}</strong></div>
      <div><span>ESP32 fallback</span><strong>${espConfig().base ? esc(espConfig().base.replace(/^https?:\/\//, '')) : 'not set'}</strong></div>
      <div><span>Agent uptime</span><strong>${status.agent && status.agent.startedAt ? fmtUptime((Date.now() - new Date(status.agent.startedAt).getTime()) / 1000) : '—'}</strong></div>`;
  }

  /* ─────────────────────────── activity ─────────────────────────── */

  function pushLog(entry) {
    state.log.push(entry);
    if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
    appendLogLine(entry);
    renderFeed();
  }

  function appendLogLine(entry) {
    const term = $('#terminal');
    if (!term) return;
    if (state.level !== 'all' && entry.level !== state.level) return;
    const empty = term.querySelector('.terminal-empty');
    if (empty) empty.remove();
    const line = document.createElement('div');
    line.className = `line is-${entry.level}`;
    line.dataset.level = entry.level;
    line.innerHTML = `<time>${timeOf(entry.at)}</time><span class="src">${esc(entry.source)}</span><span class="txt">${esc(entry.message)}</span>`;
    term.appendChild(line);
    while (term.children.length > 400) term.removeChild(term.firstChild);
    if (state.view === 'activity' || term.scrollHeight - term.scrollTop - term.clientHeight < 120) {
      term.scrollTop = term.scrollHeight;
    }
  }

  function renderLog() {
    const term = $('#terminal');
    if (!term) return;
    term.innerHTML = '';
    const items = state.log.filter((entry) => state.level === 'all' || entry.level === state.level);
    if (!items.length) {
      term.innerHTML = '<div class="terminal-empty">Nothing here yet.</div>';
      return;
    }
    for (const entry of items) appendLogLine(entry);
    term.scrollTop = term.scrollHeight;
  }

  function renderFeed() {
    const feed = $('#feed-mini');
    if (!feed) return;
    const items = state.log.slice(-8).reverse();
    if (!items.length) {
      feed.innerHTML = '<li><span class="msg">No activity yet.</span></li>';
      return;
    }
    feed.innerHTML = items
      .map(
        (entry) =>
          `<li class="${entry.level === 'warn' ? 'is-warn' : entry.level === 'error' ? 'is-error' : ''}">
            <span class="lvl"></span><time>${timeOf(entry.at)}</time><span class="msg">${esc(entry.message)}</span></li>`,
      )
      .join('');
  }

  /* ─────────────────────────── macros ─────────────────────────── */

  async function loadMacros() {
    try {
      const result = await api('/api/macros');
      if (!result.ok) return;
      state.macros = result.data || {};
      const list = $('#macro-list');
      if (!list) return;
      const names = Object.keys(state.macros);
      if (!names.length) {
        list.innerHTML = '<li class="macro-empty">No macros yet. Chain commands into one tap — e.g. “Wake, unlock, open Spotify”.</li>';
        return;
      }
      list.innerHTML = names
        .map(
          (name) => `<li class="macro">
            <div class="macro-info"><strong>${esc(name)}</strong><span>${esc(state.macros[name].description || `${(state.macros[name].steps || []).length} steps`)}</span></div>
            <button class="btn btn-sm btn-primary" data-macro-run="${esc(name)}">Run</button>
            <button class="mini-x" data-macro-del="${esc(name)}" title="Delete">${icon('trash')}</button>
          </li>`,
        )
        .join('');
      $$('[data-macro-run]').forEach((btn) =>
        btn.addEventListener('click', () => {
          btn.classList.add('is-busy');
          run('macro.run', { name: btn.dataset.macroRun }).finally(() => btn.classList.remove('is-busy'));
        }),
      );
      $$('[data-macro-del]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const name = btn.dataset.macroDel;
          if (state.demo) {
            toast('Demo mode: macros are read-only', 'info');
            return;
          }
          await api(`/api/macros/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast(`Deleted ${name}`, 'ok');
          loadMacros();
        }),
      );
    } catch {
      /* offline — keep what we have */
    }
  }

  function openMacroBuilder() {
    state.pendingMacroSteps = [];
    $('#macro-name').value = '';
    $('#macro-desc').value = '';
    const select = $('#macro-cmd');
    select.innerHTML = (state.catalogue || [])
      .map((item) => `<option value="${esc(item.cmd)}">${esc(item.group)} · ${esc(item.label || item.cmd)}</option>`)
      .join('');
    renderMacroSteps();
    $('#macro-modal').classList.remove('hidden');
  }

  function renderMacroSteps() {
    const box = $('#macro-steps');
    if (!state.pendingMacroSteps.length) {
      box.innerHTML = '<div class="macro-empty small">Add the commands to run, in order.</div>';
      return;
    }
    box.innerHTML = state.pendingMacroSteps
      .map(
        (step, index) =>
          `<div class="macro-step"><span class="mono">${index + 1}. ${esc(step.cmd)}</span>
            <span class="grow"></span>
            <button class="mini-x" data-step-remove="${index}">${icon('x')}</button></div>`,
      )
      .join('');
    $$('[data-step-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.pendingMacroSteps.splice(Number(btn.dataset.stepRemove), 1);
        renderMacroSteps();
      }),
    );
  }

  /* ─────────────────────────── pairing ─────────────────────────── */

  async function loadPairing() {
    const pre = $('#pair-code');
    if (!pre) return;
    try {
      const result = await api('/api/pairing');
      if (!result.ok) {
        pre.textContent = 'Unavailable';
        return;
      }
      const data = result.data;
      pre.dataset.raw = [
        `wifi_ssid   = <your 2.4 GHz SSID>`,
        `agent_host  = ${data.agent_host}`,
        `agent_port  = ${data.agent_port}`,
        `psk         = ${data.psk}`,
        `power_pin   = ${data.power_pin}`,
        `reset_pin   = ${data.reset_pin}`,
        `device_id   = ${data.device_id}`,
      ].join('\n');
      pre.textContent = pre.dataset.raw;
      $('#pair-port').textContent = data.agent_port;
    } catch {
      pre.textContent = 'Could not load pairing info';
    }
  }

  /* ─────────────────────────── actions ─────────────────────────── */

  async function patchPolicy(patch) {
    if (state.demo) {
      state.status.policy = { ...state.status.policy, ...patch };
      render(state.status);
      toast('Policy updated (demo)', 'ok', 1800);
      return;
    }
    const result = await api('/api/policy', { method: 'POST', body: { patch } });
    if (result.ok) {
      state.status.policy = result.data;
      render(state.status);
      toast('Saved', 'ok', 1600);
    } else {
      toast(result.message || 'Could not save policy', 'err');
    }
  }

  /** Hold-to-confirm: 1.1 s of continuous press, cancellable any time. */
  function confirmHold({ title, text }) {
    return new Promise((resolve) => {
      const modal = $('#confirm-modal');
      const button = $('#confirm-hold');
      const fill = button.querySelector('i');
      $('#confirm-title').textContent = title;
      $('#confirm-text').textContent = text;
      fill.style.width = '0%';
      modal.classList.remove('hidden');
      let raf = null;
      let startedAt = 0;
      let done = false;

      const cleanup = () => {
        cancelAnimationFrame(raf);
        button.removeEventListener('pointerdown', down);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        modal.classList.add('hidden');
      };
      const tick = () => {
        const pct = Math.min(100, ((performance.now() - startedAt) / 1100) * 100);
        fill.style.width = `${pct}%`;
        if (pct >= 100 && !done) {
          done = true;
          cleanup();
          resolve(true);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      const down = (event) => {
        event.preventDefault();
        startedAt = performance.now();
        raf = requestAnimationFrame(tick);
      };
      const up = () => {
        if (done) return;
        cancelAnimationFrame(raf);
        fill.style.width = '0%';
      };
      button.addEventListener('pointerdown', down);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      $('#confirm-cancel').onclick = () => {
        cleanup();
        resolve(false);
      };
      modal.onclick = (event) => {
        if (event.target === modal) {
          cleanup();
          resolve(false);
        }
      };
    });
  }

  const HOLD_COPY = {
    'system.shutdown': ['Shut down the PC?', 'Windows gets a 30 second countdown. The ESP32 can power it back on.'],
    'system.reboot': ['Restart the PC?', 'Anything unsaved will be lost after the countdown.'],
    'system.logout': ['Log out?', 'The current session ends immediately.'],
    'system.sleep': ['Put the PC to sleep?', 'The ESP32 bridge stays awake so you can wake it again.'],
    'esp.power': ['Use the hardware relay?', 'This cuts power like pressing the case button — the OS does not get to shut down cleanly.'],
    'esp.reset': ['Press the reset button?', 'The PC restarts as if you pressed the case button.'],
    'app.kill': ['Force-quit the app?', 'Unsaved work in that app is lost.'],
  };

  async function triggerCommand(cmd, args = {}, { hold = false, button = null } = {}) {
    if (!state.connected && !state.demo) {
      toast('Not connected to the agent', 'err');
      return;
    }
    if (hold) {
      const [title, text] = HOLD_COPY[cmd] || [`Run ${cmd}?`, 'This changes the state of your PC.'];
      const ok = await confirmHold({ title, text });
      if (!ok) return;
      args = { ...args, confirm: true };
    }
    if (button) button.classList.add('is-busy');
    try {
      await run(cmd, args);
    } finally {
      if (button) button.classList.remove('is-busy');
    }
  }

  /* ─────────────────────────── palette ─────────────────────────── */

  function paletteItems(query) {
    const q = query.trim().toLowerCase();
    const base = (state.catalogue.length ? state.catalogue : demoCatalogue()).map((item) => ({
      cmd: item.cmd,
      label: item.label || item.cmd,
      group: item.group,
      run: () => triggerCommand(item.cmd, {}, { hold: /shutdown|reboot|logout|esp\.|kill/.test(item.cmd) }),
    }));
    const extra = [
      { label: 'Capture screenshot', group: 'Action', cmd: 'screen.screenshot', run: () => triggerCommand('screen.screenshot') },
      { label: 'Go to overview', group: 'Navigate', cmd: 'view', run: () => setView('dashboard') },
      { label: 'Go to activity log', group: 'Navigate', cmd: 'view', run: () => setView('activity') },
      { label: 'Go to settings', group: 'Navigate', cmd: 'view', run: () => setView('settings') },
      { label: 'Copy pairing snippet', group: 'Action', cmd: 'pairing', run: async () => {
        const pre = $('#pair-code');
        if (!pre.dataset.raw) await loadPairing();
        const ok = await copyText($('#pair-code').dataset.raw || '');
        toast(ok ? 'Pairing snippet copied' : 'Could not copy', ok ? 'ok' : 'err');
      } },
    ];
    const all = [...base, ...extra];
    if (!q) return all.slice(0, 12);
    return all.filter((item) => `${item.label} ${item.cmd} ${item.group}`.toLowerCase().includes(q)).slice(0, 12);
  }

  function openPalette() {
    $('#palette').classList.remove('hidden');
    const field = $('#palette-field');
    field.value = '';
    state.paletteIndex = 0;
    renderPalette('');
    setTimeout(() => field.focus(), 30);
  }

  function renderPalette(query) {
    state.paletteItems = paletteItems(query);
    const list = $('#palette-list');
    if (!state.paletteItems.length) {
      list.innerHTML = '<li class="palette-empty">No matching command</li>';
      return;
    }
    list.innerHTML = state.paletteItems
      .map(
        (item, index) =>
          `<li class="${index === state.paletteIndex ? 'is-active' : ''}" data-index="${index}">
            ${icon('bolt')}<span>${esc(item.label)}</span><small>${esc(item.group || '')}</small></li>`,
      )
      .join('');
    $$('#palette-list li[data-index]').forEach((li) =>
      li.addEventListener('click', () => {
        const item = state.paletteItems[Number(li.dataset.index)];
        closePalette();
        if (item) item.run();
      }),
    );
  }

  function closePalette() {
    $('#palette').classList.add('hidden');
  }

  function movePalette(delta) {
    if (!state.paletteItems.length) return;
    state.paletteIndex = (state.paletteIndex + delta + state.paletteItems.length) % state.paletteItems.length;
    renderPalette($('#palette-field').value);
  }

  /* ─────────────────────────── connection ─────────────────────────── */

  /* ── ESP32 fallback: power control with the agent stopped ── */
  const espConfig = () => ({
    base: (localStorage.getItem(STORE_ESP_BASE) || '').replace(/\/+$/, ''),
    token: localStorage.getItem(STORE_ESP_TOKEN) || '',
  });

  async function espStatus() {
    const { base } = espConfig();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/status`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function espPower(action) {
    const { base, token } = espConfig();
    if (!base || !token) {
      toast('Add the ESP32 address and power token first', 'err');
      return;
    }
    try {
      const res = await fetch(`${base}/power?action=${encodeURIComponent(action)}&t=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast(`Relay: ${action} sent`, 'ok');
        setTimeout(showOffline, 1200);
      } else {
        toast(data.error || 'The ESP32 rejected that request', 'err');
      }
    } catch {
      toast('Could not reach the ESP32', 'err');
    }
  }

  async function showOffline() {
    const status = await espStatus();
    $('#boot').classList.add('done');
    $('#app').classList.add('hidden');
    $('#setup').classList.add('hidden');
    $('#offline').classList.remove('hidden');
    const kv = $('#offline-kv');
    if (!status) {
      kv.innerHTML = '<div><span>ESP32</span><strong>unreachable</strong></div>';
      $('#offline-msg').textContent = 'Check the ESP32 address and token in the connection settings.';
      return;
    }
    kv.innerHTML = `
      <div><span>ESP32</span><strong>${esc(status.device || 'linked')}</strong></div>
      <div><span>PC power</span><strong>${esc(status.pc || 'unknown')}</strong></div>
      <div><span>Wi-Fi</span><strong>${status.rssi ? `${status.rssi} dBm` : '—'}</strong></div>
      <div><span>Firmware</span><strong>${esc(status.fw || '—')}</strong></div>
      <div><span>Tunnel</span><strong>${status.wg ? 'WireGuard up' : 'direct'}</strong></div>`;
    $('#offline-msg').textContent = 'Once the PC finishes booting the agent comes back automatically.';
  }

  function handleAuthFailure(err) {
    state.connected = false;
    localStorage.removeItem(STORE_TOKEN);
    showSetup(err.message);
  }

  async function refreshStatus() {
    try {
      const result = await api('/api/status');
      if (!result.ok) throw new Error(result.message || 'Status unavailable');
      render(result.data);
      banner('');
      return true;
    } catch (err) {
      state.connected = false;
      if (err.code === 'UNAUTHORISED') return false;
      const esp = await espStatus();
      if (esp && !state.demo) {
        showOffline();
        return false;
      }
      banner(`Lost contact with the agent — retrying. ${err.message}`, 'error');
      return false;
    }
  }

  function showSetup(message) {
    $('#boot').classList.add('done');
    $('#app').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    $('#setup-base').value = localStorage.getItem(STORE_BASE) || '';
    $('#setup-esp').value = localStorage.getItem(STORE_ESP_BASE) || '';
    $('#setup-esp-token').value = localStorage.getItem(STORE_ESP_TOKEN) || '';
    if (message) {
      const box = $('#setup-error');
      box.textContent = message;
      box.classList.remove('hidden');
    }
  }

  function startSse() {
    if (state.demo || !window.EventSource) return;
    try {
      const source = new EventSource(`${state.base}/api/events?t=${encodeURIComponent(state.token)}`);
      source.addEventListener('log', (event) => {
        try {
          pushLog(JSON.parse(event.data));
        } catch {
          /* ignore malformed frame */
        }
      });
      source.addEventListener('status', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!state.status) return;
          state.status.cpuPercent = data.cpuPercent;
          state.status.memory = data.memory;
          state.status.esp = data.esp;
          state.status.uptime = state.status.uptime;
          state.status.agent = { ...(state.status.agent || {}), counters: data.counters, lastCommand: data.lastCommand };
          render(state.status);
          banner('');
        } catch {
          /* ignore */
        }
      });
      source.onopen = () => banner('');
      source.onerror = () => {
        // EventSource retries by itself; only surface a hint.
        banner('Live updates paused — reconnecting…');
      };
    } catch {
      /* older WebView without EventSource: polling still works */
    }
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    if (params.has('t')) {
      localStorage.setItem(STORE_TOKEN, params.get('t'));
      params.delete('t');
      const rest = params.toString();
      history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
    }
    if (params.get('demo') === '1') localStorage.setItem(STORE_DEMO, '1');

    state.token = localStorage.getItem(STORE_TOKEN) || '';
    state.base = (localStorage.getItem(STORE_BASE) || (isNative() ? '' : location.origin)).replace(/\/+$/, '');
    state.demo = localStorage.getItem(STORE_DEMO) === '1' || !state.token;

    if (!state.base || (!state.token && !state.demo)) {
      if (state.demo) {
        await enterApp();
        return;
      }
      return showSetup();
    }
    await enterApp();
  }

  async function enterApp() {
    if (state.demo) {
      localStorage.setItem(STORE_DEMO, '1');
      const status = demoStatus();
      state.log = demoLog();
      state.catalogue = status.catalogue;
      state.macros = demoMacros;
      render(status);
      renderLog();
      renderFeed();
      $('#setup').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('done');
      setInterval(() => {
        const status2 = demoStatus();
        status2.cpuPercent = Math.max(6, Math.min(96, (state.status ? state.status.cpuPercent : 40) + (Math.random() * 18 - 9)));
        render(status2);
      }, 2600);
      return;
    }
    try {
      await refreshStatus();
      $('#setup').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('done');
      const log = await api('/api/log?limit=200');
      if (log.ok) {
        state.log = log.data || [];
        renderLog();
        renderFeed();
      }
      startSse();
    } catch (err) {
      if (err.code === 'UNAUTHORISED') return handleAuthFailure(err);
      showSetup(`Could not reach ${state.base}. ${err.message}`);
    }
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function wire() {
    $$('.nav-item').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
    $$('[data-goto]').forEach((item) => item.addEventListener('click', () => setView(item.dataset.goto)));
    $('#avatar').addEventListener('click', () => setView('settings'));
    $('#refresh-btn').addEventListener('click', async () => {
      await refreshStatus();
      toast('Refreshed', 'ok', 1200);
    });

    // command buttons
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cmd]');
      if (!button) return;
      let args = {};
      if (button.dataset.args) {
        try {
          args = JSON.parse(button.dataset.args);
        } catch {
          args = {};
        }
      }
      triggerCommand(button.dataset.cmd, args, { hold: button.dataset.hold === 'true', button });
    });

    // policy switches
    document.addEventListener('click', (event) => {
      const sw = event.target.closest('[data-policy]');
      if (!sw) return;
      const flag = sw.dataset.policy;
      const current = state.status && state.status.policy ? state.status.policy[flag] !== false : true;
      patchPolicy({ [flag]: !current });
    });

    // key buttons
    $$('[data-key]').forEach((button) =>
      button.addEventListener('click', () => run('input.key', { combo: button.dataset.key })),
    );

    // typing
    $('#type-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = $('#type-text').value;
      if (!text.trim()) return;
      const result = await run('input.type', { text });
      if (result.ok && $('#type-enter').checked) await run('input.key', { combo: 'enter' }, { quiet: true });
      if (result.ok) $('#type-text').value = '';
    });

    // log filters
    $$('#log-filters .chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.level = chip.dataset.level;
        $$('#log-filters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
        renderLog();
      }),
    );
    $('#log-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state.log, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sentinel-activity-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    $('#log-clear').addEventListener('click', () => {
      state.log = [];
      renderLog();
      renderFeed();
    });

    // settings
    $('#set-name-save').addEventListener('click', async () => {
      const name = $('#set-name').value.trim();
      if (!name) return;
      if (state.demo) return toast('Renamed (demo)', 'ok');
      const result = await api('/api/settings', { method: 'POST', body: { name } });
      if (result.ok) {
        toast('Name saved', 'ok');
        refreshStatus();
      }
    });
    $('#set-server').addEventListener('click', () => {
      localStorage.removeItem(STORE_TOKEN);
      showSetup();
    });
    $('#set-ping').addEventListener('click', async () => {
      const started = performance.now();
      await refreshStatus();
      toast(`Agent answered in ${Math.round(performance.now() - started)} ms`, 'ok');
    });
    $('#app-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = $('#app-name').value.trim();
      const path = $('#app-path').value.trim();
      if (!name || !path) return;
      if (state.demo) return toast('App added (demo)', 'ok');
      const result = await api('/api/apps', { method: 'POST', body: { name, path } });
      if (result.ok) {
        toast(`${name} allow-listed`, 'ok');
        $('#app-form').reset();
        refreshStatus();
      } else {
        toast(result.message || 'Could not add app', 'err');
      }
    });
    $('#rotate-keys').addEventListener('click', async () => {
      const ok = await confirmHold({ title: 'Rotate every key?', text: 'The ESP32 and all phones must be re-paired with the new key.' });
      if (!ok) return;
      if (state.demo) return toast('Keys rotated (demo)', 'ok');
      const result = await api('/api/keys', { method: 'POST', body: { confirm: true } });
      if (result.ok) {
        toast('New keys generated — re-pair your devices', 'ok', 6000);
        loadPairing();
      }
    });
    $('#forget-device').addEventListener('click', () => {
      localStorage.removeItem(STORE_TOKEN);
      localStorage.removeItem(STORE_BASE);
      localStorage.removeItem(STORE_DEMO);
      location.reload();
    });
    $('#pair-copy').addEventListener('click', async () => {
      const raw = $('#pair-code').dataset.raw || $('#pair-code').textContent;
      const ok = await copyText(raw);
      toast(ok ? 'Pairing snippet copied' : 'Could not copy — select the text manually', ok ? 'ok' : 'err');
    });
    $('#pair-rotate').addEventListener('click', () => $('#rotate-keys').click());

    // macros
    $('#macro-new').addEventListener('click', openMacroBuilder);
    $('#macro-close').addEventListener('click', () => $('#macro-modal').classList.add('hidden'));
    $('#macro-add-step').addEventListener('click', () => {
      const cmd = $('#macro-cmd').value;
      if (!cmd) return;
      if (state.pendingMacroSteps.length >= 12) return toast('That is enough steps for one macro', 'err');
      state.pendingMacroSteps.push({ cmd, args: {} });
      renderMacroSteps();
    });
    $('#macro-save').addEventListener('click', async () => {
      const name = $('#macro-name').value.trim();
      if (!name) return toast('Give the macro a name', 'err');
      if (!state.pendingMacroSteps.length) return toast('Add at least one step', 'err');
      if (state.demo) {
        state.macros[name] = { description: $('#macro-desc').value, steps: state.pendingMacroSteps };
        $('#macro-modal').classList.add('hidden');
        return loadMacros();
      }
      const result = await api('/api/macros', {
        method: 'POST',
        body: { name, description: $('#macro-desc').value, steps: state.pendingMacroSteps },
      });
      if (result.ok) {
        toast(`Saved macro ${name}`, 'ok');
        $('#macro-modal').classList.add('hidden');
        loadMacros();
      } else {
        toast(result.message || 'Could not save macro', 'err');
      }
    });

    // palette
    $('#palette-open').addEventListener('click', openPalette);
    $('#palette-field').addEventListener('input', (event) => {
      state.paletteIndex = 0;
      renderPalette(event.target.value);
    });
    $('#palette').addEventListener('click', (event) => {
      if (event.target.id === 'palette') closePalette();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
        return;
      }
      if ($('#palette').classList.contains('hidden')) return;
      if (event.key === 'Escape') closePalette();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        movePalette(1);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        movePalette(-1);
      }
      if (event.key === 'Enter') {
        const item = state.paletteItems[state.paletteIndex];
        closePalette();
        if (item) item.run();
      }
    });

    // modals
    $('#shot-close').addEventListener('click', () => $('#shot-modal').classList.add('hidden'));
    $('#shot-modal').addEventListener('click', (event) => {
      if (event.target.id === 'shot-modal') $('#shot-modal').classList.add('hidden');
    });

    // offline panel (agent down, ESP32 reachable)
    $$('[data-esp]').forEach((button) =>
      button.addEventListener('click', async () => {
        if (button.dataset.hold === 'true') {
          const ok = await confirmHold({ title: 'Power cycle the PC?', text: 'The relay cuts power the same way the case button does.' });
          if (!ok) return;
        }
        espPower(button.dataset.esp);
      }),
    );
    $('#offline-retry').addEventListener('click', async () => {
      const ok = await refreshStatus();
      if (ok) {
        $('#offline').classList.add('hidden');
        $('#app').classList.remove('hidden');
        startSse();
      } else {
        toast('The agent is still not answering', 'err');
      }
    });

    // setup screen
    $('#setup-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const base = $('#setup-base').value.trim().replace(/\/+$/, '');
      const token = $('#setup-token').value.trim();
      const espBase = $('#setup-esp').value.trim().replace(/\/+$/, '');
      const espToken = $('#setup-esp-token').value.trim();
      if (espBase) localStorage.setItem(STORE_ESP_BASE, espBase);
      else localStorage.removeItem(STORE_ESP_BASE);
      if (espToken) localStorage.setItem(STORE_ESP_TOKEN, espToken);
      else localStorage.removeItem(STORE_ESP_TOKEN);
      if (!base || !token) return;
      $('#setup-error').classList.add('hidden');
      state.base = base;
      state.token = token;
      state.demo = false;
      localStorage.setItem(STORE_BASE, base);
      localStorage.setItem(STORE_TOKEN, token);
      localStorage.removeItem(STORE_DEMO);
      try {
        const result = await api('/api/status');
        if (!result.ok) throw new Error(result.message || 'Agent refused the request');
        $('#setup').classList.add('hidden');
        $('#app').classList.remove('hidden');
        render(result.data);
        const log = await api('/api/log?limit=200');
        if (log.ok) {
          state.log = log.data || [];
          renderLog();
          renderFeed();
        }
        startSse();
        toast('Connected', 'ok');
      } catch (err) {
        if (err.code === 'UNAUTHORISED' || /token/i.test(err.message)) {
          const box = $('#setup-error');
          box.textContent = 'The agent rejected that token. Copy it again from Settings → Pairing.';
          box.classList.remove('hidden');
        } else {
          const status = await espStatus();
          if (status) {
            showOffline();
            return;
          }
          const box = $('#setup-error');
          box.textContent = `No answer from ${base}. Check the address, the port (7878) and that the agent is running.`;
          box.classList.remove('hidden');
        }
      }
    });
    $('#setup-demo').addEventListener('click', () => {
      state.demo = true;
      localStorage.setItem(STORE_DEMO, '1');
      enterApp();
    });

    window.addEventListener('online', () => {
      banner('Back online — refreshing', 'warn');
      setTimeout(refreshStatus, 600);
    });
    window.addEventListener('offline', () => banner('This device is offline', 'error'));

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.connected && !state.demo) refreshStatus();
    });
  }

  wire();
  boot();
  setView('dashboard');
})();
