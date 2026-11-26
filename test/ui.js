#!/usr/bin/env node
'use strict';

/**
 * UI integration test.
 *
 * It loads the real ui/index.html + ui/transport.js + ui/app.js into jsdom,
 * points them at a real agent, and drives the interface the way a person does:
 * press Connect with nothing filled in, pair with a wrong key, pair properly,
 * open the shutdown confirmation, hit a policy block, walk the tabs.
 *
 * That is how the "I press connect and nothing happens" class of bug is caught
 * before it ships again.
 *
 * jsdom is a devDependency: `npm install` once, then `node test/ui.js`.
 * Without it the file exits 0 with a note so the offline test suite still runs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let JSDOM;
try {
  ({ JSDOM } = require(path.join(root, 'node_modules', 'jsdom')));
} catch {
  try {
    ({ JSDOM } = require('jsdom'));
  } catch {
    console.log('jsdom is not installed — skipping the UI test (npm install jsdom to enable it).');
    process.exit(0);
  }
}

const { createAgent } = require('../core/agent');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
const transportSrc = fs.readFileSync(path.join(root, 'ui', 'transport.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(root, 'ui', 'ai.js'), 'utf8');

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
}

function makePage(url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no Web Crypto or fetch of its own; give it the real ones.
  Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  // A browser resolves relative URLs and accepts its own AbortSignal; Node's
  // fetch does neither, so the shim does exactly that translation.
  window.fetch = (input, init = {}) => {
    const target = typeof input === 'string' && input.startsWith('/') ? new URL(input, url).href : input;
    const options = { ...init };
    if (options.signal && !(options.signal instanceof globalThis.AbortSignal)) delete options.signal;
    return globalThis.fetch(target, options);
  };
  // jsdom has no canvas backend; the orb must degrade quietly to a static stage.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.eval(transportSrc);
  window.eval(appSrc);
  window.eval(aiSrc);
  return dom;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-ui-'));
  const agent = createAgent({ configPath: path.join(home, 'config.json') });
  agent.config.merge({ ports: { ui: 0, link: 0 } });
  agent.start();
  // Boot time varies on shared CI runners; wait for the real health endpoint
  // instead of assuming a fixed delay.
  let port = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(100);
    const address = agent.http.server.address();
    if (!address) continue;
    port = address.port;
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok && agent.aiReady) break;
    } catch { /* the socket is not accepting yet */ }
  }
  if (!port) throw new Error('the agent did not start listening');
  const psk = agent.config.get('psk');
  const hostname = os.hostname();

  try {
    const dom = makePage(`http://127.0.0.1:${port}/`);
    const { window } = dom;
    const doc = window.document;
    const submit = () => doc.getElementById('pair-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(120);

    check('pair screen is what you get on first run', !doc.getElementById('pair').hidden && doc.getElementById('app').hidden);

    submit();
    await sleep(80);
    const errorBox = doc.getElementById('pair-error');
    check(
      'pressing Connect with empty fields explains itself',
      !errorBox.hidden && /Enter an address/i.test(errorBox.textContent),
      errorBox.textContent.slice(0, 42),
    );

    // The old form used type="url", which silently refused "192.168.1.50:7878".
    doc.getElementById('pair-address').value = `127.0.0.1:${port}`;
    doc.getElementById('pair-key').value = 'a'.repeat(64);
    submit();
    await sleep(150);
    check(
      'a bare host:port is accepted and progress is visible immediately',
      !doc.getElementById('pair-steps').hidden && /Generating|Trying/.test(doc.getElementById('pair-steps').textContent),
    );

    await sleep(1700);
    check(
      'a wrong key produces an explanation',
      !errorBox.hidden && /pairing key does not match/i.test(errorBox.textContent),
      errorBox.textContent.replace(/\s+/g, ' ').slice(0, 60),
    );

    doc.getElementById('pair-key').value = psk;
    submit();
    await sleep(2600);
    check('the app opens after pairing', !doc.getElementById('app').hidden && doc.getElementById('pair').hidden);
    check('the agent name is shown', doc.getElementById('device-name').textContent === hostname, doc.getElementById('device-name').textContent);
    check('the pill reports a live encrypted link', /encrypted|ms/.test(doc.getElementById('link-pill-text').textContent));
    check('metrics render', doc.querySelectorAll('.metric').length >= 6, String(doc.querySelectorAll('.metric').length));
    check('quick actions render', doc.querySelectorAll('.qa').length >= 12, String(doc.querySelectorAll('.qa').length));
    check('the catalogue renders', doc.querySelectorAll('.cmd-chip').length >= 20, String(doc.querySelectorAll('.cmd-chip').length));
    check('the hero shows the machine', doc.getElementById('hero-host').textContent === hostname);

    check('the brain area renders something honest', doc.querySelectorAll('#insights .insight, #insights .insight-empty').length === 1,
      doc.getElementById('insights').textContent.replace(/\s+/g, ' ').slice(0, 50));

    doc.querySelector('[data-quick="system.shutdown"]').click();
    await sleep(120);
    check(
      'shutdown asks for confirmation',
      !doc.getElementById('sheet').hidden && /Shut down/.test(doc.getElementById('sheet-title').textContent),
      doc.getElementById('sheet-title').textContent,
    );
    doc.getElementById('sheet-close').click();
    await sleep(80);
    check('cancelling the sheet changes nothing', doc.getElementById('sheet').hidden);

    const killChip = Array.from(doc.querySelectorAll('.cmd-chip')).find((node) => node.title === 'app.kill');
    if (killChip) {
      killChip.click();
      await sleep(200);
      check('a policy block is explained', /Blocked by policy/i.test(doc.getElementById('toasts').textContent));
    } else {
      check('a policy block is explained', false, 'app.kill missing from the catalogue');
    }

    doc.querySelector('.tab[data-tab="devices"]').click();
    await sleep(150);
    check('the devices screen lists three cards', !doc.getElementById('screen-devices').hidden && doc.querySelectorAll('#devices .device').length === 3);

    doc.querySelector('.tab[data-tab="settings"]').click();
    await sleep(120);
    check('settings shows how the link is protected', /ST1 tunnel/.test(doc.getElementById('conn-kv').textContent));

    /* ── the assistant surface ─────────────────────────────────────────── */

    const token = agent.config.get('uiToken');
    const aiPage = makePage(`http://127.0.0.1:${port}/?t=${token}`);
    const aiDoc = aiPage.window.document;
    await sleep(700);

    check(
      'every assistant section has a tab and a screen',
      aiDoc.querySelectorAll('.tab').length === 15 && aiDoc.querySelectorAll('.screen').length === 15,
      `${aiDoc.querySelectorAll('.tab').length} tabs / ${aiDoc.querySelectorAll('.screen').length} screens`,
    );

    aiDoc.querySelector('.tab[data-tab="chat"]').click();
    await sleep(150);
    check(
      'the chat screen shows the orb and an invitation to ask',
      !aiDoc.getElementById('screen-chat').hidden &&
        Boolean(aiDoc.getElementById('orb')) &&
        /Zapytaj o cokolwiek/.test(aiDoc.getElementById('chat-messages').textContent),
    );

    const input = aiDoc.getElementById('chat-input');
    input.value = 'ile to 6*7';
    aiDoc.getElementById('chat-form').dispatchEvent(new aiPage.window.Event('submit', { bubbles: true, cancelable: true }));
    let answerText = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const bubbles = Array.from(aiDoc.querySelectorAll('.msg-assistant .msg-body')).map((node) => node.textContent);
      answerText = bubbles.join(' | ');
      if (/42/.test(answerText)) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
    }
    check('a question streams a real answer into the chat', /42/.test(answerText), answerText.slice(0, 80));
    check(
      'the answer carries its tool footnote',
      /math\.eval|Mathematics/.test(aiDoc.getElementById('chat-messages').textContent),
    );

    // A staged patch must render with its diff and never be written by proposing.
    const crypto = require('node:crypto');
    const workspace = require('../core/paths').workspaceDir();
    fs.mkdirSync(workspace, { recursive: true });
    const patchFile = path.join(workspace, `sentinel-ui-patch-${crypto.randomBytes(4).toString('hex')}.js`);
    fs.writeFileSync(patchFile, 'module.exports = 1;\n', 'utf8');
    const session = agent.patches.create({ file: patchFile, newText: 'module.exports = 7;\n', description: 'ui test' });
    agent.patches.verify(session.id);

    aiDoc.querySelector('.tab[data-tab="cognition"]').click();
    await sleep(700);
    const cognitionText = aiDoc.querySelector('[data-panel="cognition"]').textContent;
    check('the cognition panel shows the real brief of the last run', /Zamiar/.test(cognitionText) && /math/.test(cognitionText), cognitionText.slice(0, 90));
    const patchRow = aiDoc.querySelector('[data-panel="patches"] .patch-row');
    check('a staged patch shows its file, size and verification state', Boolean(patchRow) && /\+1 −1/.test(patchRow.textContent) && /weryfikacja OK/.test(patchRow.textContent), patchRow ? patchRow.textContent.slice(0, 100) : 'no patch row');
    const diffButton = Array.from(aiDoc.querySelectorAll('[data-panel="patches"] button')).find((button) => /diff/i.test(button.textContent));
    if (diffButton) diffButton.click();
    await sleep(400);
    check('the diff is readable and shows the real change', /-module\.exports = 1;/.test(aiDoc.querySelector('[data-panel="patches"] .patch-diff') ? aiDoc.querySelector('[data-panel="patches"] .patch-diff').textContent : ''), 'diff missing');
    check('proposing a patch did not write the target file', fs.readFileSync(patchFile, 'utf8') === 'module.exports = 1;\n');
    check('the event log shows typed events from the bus', aiDoc.querySelectorAll('[data-panel="eventlog"] .eventlog-row').length >= 3, `${aiDoc.querySelectorAll('[data-panel="eventlog"] .eventlog-row').length} events`);
    check('the reliability panel reports breaker state without inventing metrics', /bezpieczniki|Bezpieczniki|online|closed/i.test(aiDoc.querySelector('[data-panel="reliability"]').textContent), aiDoc.querySelector('[data-panel="reliability"]').textContent.slice(0, 90));

    await sleep(500);
    const runtimeText = aiDoc.querySelector('[data-panel="runtime"]').textContent;
    check('the runtime panel shows the active profile and real hardware', /Profil/.test(runtimeText) && /(RTX|nie wykryto|GPU)/.test(runtimeText), runtimeText.slice(0, 100));
    check('all four runtime profiles are offered', aiDoc.querySelectorAll('#runtime-profiles button').length === 4, `${aiDoc.querySelectorAll('#runtime-profiles button').length} profiles`);
    const graphText = aiDoc.querySelector('[data-panel="graph"]').textContent;
    check('the graph panel is fed by /api/graph', /Węzły|Węzły|Graf jest pusty/.test(graphText), graphText.slice(0, 100));
    const orgText = aiDoc.querySelector('[data-panel="org"]').textContent;
    check('the organisation panel reports the real roster', new RegExp(`${agent.agents.agents.size} agentów`).test(orgText), orgText.slice(0, 100));
    const mcpText = aiDoc.querySelector('[data-panel="mcp"]').textContent;
    check('the MCP panel reports that it is opt-in', /Wyłączone w ustawieniach/.test(mcpText), mcpText.slice(0, 100));

    aiDoc.querySelector('.tab[data-tab="models"]').click();
    await sleep(700);
    const labText = aiDoc.querySelector('[data-panel="lab"]').textContent;
    check('the learning-lab panel shows the real dataset and honesty note', /346 przykładów/.test(labText) && /synthetic/.test(labText), labText.slice(0, 140));
    check('the lab panel says nothing is active before promotion', /Brak aktywnego modelu/.test(labText), labText.slice(0, 140));
    check('the neural and research boxes are fed by real APIs', /Neural runtime/.test(labText) && /Sesje badawcze/.test(labText), labText.slice(0, 160));

    check('the models tab shows hypercore, reranker and communication state', /Hypercore poznawczy/.test(labText) && /Reranker/.test(labText) && /Komunikacja/.test(labText), labText.slice(0, 200));
    check('the models tab shows briefing and proactive state', /Briefing/.test(labText) && /Proaktywność/.test(labText), labText.slice(0, 240));
    check('the models tab shows specialist model state', /Specjaliści/.test(labText) && /aktywnych modeli/.test(labText), labText.slice(0, 280));
    check('the communication panel states that live calls are off by default', /live: false/.test(labText) && /mock/.test(labText), labText.slice(0, 220));
    const hyperUnauth = await globalThis.fetch(`http://127.0.0.1:${port}/api/hypercore`);
    check('the hypercore API rejects requests without the token', hyperUnauth.status === 401, `HTTP ${hyperUnauth.status}`);
    const commUnauth = await globalThis.fetch(`http://127.0.0.1:${port}/api/communication`);
    check('the communication API rejects requests without the token', commUnauth.status === 401, `HTTP ${commUnauth.status}`);
    const sentimentUnauth = await globalThis.fetch(`http://127.0.0.1:${port}/api/lab/sentiment`);
    check('the sentiment API rejects requests without the token', sentimentUnauth.status === 401, `HTTP ${sentimentUnauth.status}`);

    const unauth = await globalThis.fetch(`http://127.0.0.1:${port}/api/lab`);
    check('the lab API rejects requests without the token', unauth.status === 401, `HTTP ${unauth.status}`);
    const emptyClassify = await globalThis.fetch(`http://127.0.0.1:${port}/api/lab/classify?t=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }),
    });
    check('the classifier rejects empty input', emptyClassify.status === 400, `HTTP ${emptyClassify.status}`);
    const noModel = await globalThis.fetch(`http://127.0.0.1:${port}/api/lab/classify?t=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'sprawdz ile mam ramu' }),
    });
    const noModelBody = await noModel.json();
    check('classification without a promoted model refuses instead of guessing', noModelBody.data && noModelBody.data.code === 'NO_MODEL', JSON.stringify(noModelBody).slice(0, 120));

    aiDoc.querySelector('.tab[data-tab="memory"]').click();
    await sleep(500);
    check(
      'the memory panel loads real records over HTTP',
      /wspomnie/i.test(aiDoc.querySelector('[data-panel="memory"]').textContent),
      aiDoc.querySelector('[data-panel="memory"]').textContent.slice(0, 60),
    );

    aiDoc.querySelector('.tab[data-tab="diagnostics"]').click();
    await sleep(800);
    check(
      'diagnostics runs the doctor and shows checks',
      aiDoc.querySelectorAll('[data-panel="diagnostics"] .check').length >= 4,
      `${aiDoc.querySelectorAll('[data-panel="diagnostics"] .check').length} checks`,
    );

    const demo = makePage('http://127.0.0.1:1/?demo=1');
    await sleep(400);
    check(
      'demo mode labels itself as demo',
      !demo.window.document.getElementById('app').hidden && demo.window.document.getElementById('link-pill-text').textContent === 'demo',
    );
  } finally {
    agent.stop();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
  if (failed.length) {
    console.error('\nFailed:');
    for (const result of failed) console.error(`  - ${result.name}`);
    process.exit(1);
  }
  // The page keeps polling timers alive on purpose; the test is done.
  process.exit(0);
})().catch((err) => {
  console.error('UI test crashed:', err);
  process.exit(1);
});
