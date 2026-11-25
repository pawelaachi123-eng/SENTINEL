#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency sanity check used by CI and by `npm run check`:
 *  - every JavaScript file parses
 *  - the UI references only assets that exist
 *  - the agent can boot, answer /api/health and serve the UI
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.pio', 'www', 'android', 'build'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('1. Syntax');
const jsFiles = walk(root).filter((file) => file.endsWith('.js') && !file.includes(`${path.sep}ui${path.sep}`));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${path.relative(root, file)}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`);
  }
}
const uiScripts = ['app.js', 'transport.js', 'ai.js', 'sw.js'].map((name) => path.join(root, 'ui', name));
for (const script of uiScripts) {
  try {
    execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
  } catch (err) {
    fail(`ui/${path.basename(script)}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`);
  }
}
console.log(`   checked ${jsFiles.length + uiScripts.length} files`);

console.log('2. Assets');
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
const refs = new Set();
for (const match of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) refs.add(match[1]);
for (const ref of refs) {
  const file = path.join(root, 'ui', ref.replace(/^\//, ''));
  if (!fs.existsSync(file)) fail(`ui/index.html references missing ${ref}`);
}
console.log(`   checked ${refs.size} references`);

console.log('3. Source-only delivery policy');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
const forbidden = [
  ['pkg executable build', /@yao-pkg\/pkg|pkg bin\//],
  ['electron-builder packaging', /electron-builder/],
  ['Android APK build', /assembleRelease|SENTINEL-android\.apk/],
  ['ESP32 firmware build', /pio run/],
  ['binary release publishing', /gh release upload/],
];
for (const [label, pattern] of forbidden) if (pattern.test(workflow)) fail(`workflow still performs ${label}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const script of ['build:exe', 'build:desktop', 'build:all']) if (packageJson.scripts[script]) fail(`package.json still exposes binary build script ${script}`);
if (!/^7\.2\.0$/.test(packageJson.version)) fail(`package.json version is ${packageJson.version}, expected 7.2.0`);
const installers = fs.readdirSync(root).filter((file) => file.endsWith('.ps1'));
if (installers.length !== 1) fail(`expected exactly one PowerShell installer, found ${installers.join(', ') || 'none'}`);
console.log(`   workflow is source-only; installer ${installers[0]}`);

console.log('4. Boot');
process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sentinel-check-'));
const { createAgent } = require('../core/agent');
const agent = createAgent();
// Ephemeral ports: the check must pass even if a real SENTINEL is running.
agent.config.merge({ ports: { ui: 0, link: 0 } });
agent.start();

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const port = agent.http.server.address().port;
  const token = agent.config.get('uiToken');
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  if (!health.ok) fail('health endpoint did not answer');
  const unauthorised = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.status);
  if (unauthorised !== 401) fail(`unauthenticated /api/status returned ${unauthorised}, expected 401`);
  const status = await fetch(`http://127.0.0.1:${port}/api/status?t=${token}`).then((r) => r.json());
  if (!status.ok || !status.data.hostname) fail('authorised status call failed');
  const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  if (!page.includes('SENTINEL')) fail('UI index did not load');
  const command = await fetch(`http://127.0.0.1:${port}/api/command?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'system.ping' }),
  }).then((r) => r.json());
  if (!command.ok) fail(`system.ping failed: ${command.message}`);
  const denied = await fetch(`http://127.0.0.1:${port}/api/command?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'system.shutdown', args: {} }),
  }).then((r) => r.json());
  if (denied.ok || denied.code !== 'CONFIRM_REQUIRED') fail('shutdown without confirm was not blocked');
  const unknown = await fetch(`http://127.0.0.1:${port}/api/command?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'secrets.dump' }),
  }).then((r) => r.json());
  if (unknown.ok) fail('unknown command was accepted');
  agent.stop();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
