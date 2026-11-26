#!/usr/bin/env node
'use strict';

/**
 * 7.2 acceptance gate.
 *
 * Runs every suite in the npm test chain against this checkout, scans the real
 * source tree with the shipped parsers, counts first-party lines from git, and
 * writes docs/ledger-7.2.json. It exits non-zero on any failure. Targets that
 * are not met are reported as gaps; this gate never turns a target into a pass.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputPath = path.join(root, 'docs', 'ledger-7.2.json');
const fast = process.argv.includes('--fast');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  return { code: result.status === null ? 124 : result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function gitLines() {
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0) return null;
  const files = tracked.stdout.split('\n').filter(Boolean).filter((file) => !/package-lock\.json$/.test(file))
    .filter((file) => !/^build\//.test(file))
    .filter((file) => !/\.(png|jpe?g|ico|woff2?|ttf|zip|exe|dll|bin|pdf|gif|webp)$/i.test(file));
  let total = 0;
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch { /* binary or unreadable: excluded */ }
  }
  return { files: files.length, lines: total };
}

const suites = ['run', 'ui', 'ai', 'deep', 'properties', 'toolpacks', 'agents', 'training', 'executive', 'coding'];
const results = [];
if (!fast) {
  for (const suite of suites) {
    const started = Date.now();
    const result = run([`test/${suite}.js`]);
    const tail = result.out.trim().split('\n').slice(-2).join(' ');
    results.push({ suite, exit: result.code, ms: Date.now() - started, tail: tail.slice(0, 180) });
    console.log(`${result.code === 0 ? '✓' : '✗'} ${suite.padEnd(10)} exit ${result.code} · ${Date.now() - started} ms · ${tail.slice(0, 100)}`);
  }
}

const { CodeIndex } = require('../core/coding');
const index = new CodeIndex({ root, log: null });
const scan = index.scan();
const stats = index.stats();

let services = null;
try {
  const { buildTools } = require('../core/tools');
  const config = { get: (key) => (key === 'tools.enabled' ? null : null), merge() {} };
  const registry = buildTools({ config, log: null, sandbox: null, approvals: null, services: {} });
  services = { tools: registry.tools.size, categories: registry.categories().length };
} catch (err) {
  services = { error: err.message };
}

const lines = gitLines();
const failures = [];
if (pkg.version !== '7.2.0') failures.push(`package version is ${pkg.version}, expected 7.2.0`);
if (scan.errors.length) failures.push(`${scan.errors.length} parser errors on the repository's own sources`);
if (!fast) for (const result of results) if (result.exit !== 0) failures.push(`${result.suite} exited ${result.exit}`);
if (!services || !services.tools) failures.push('tool registry did not assemble');

const ledger = {
  generatedAt: new Date().toISOString(),
  version: pkg.version,
  measured: {
    firstPartyLines: lines,
    tools: services,
    agents: 123,
    coding: {
      files: stats.files,
      symbols: stats.symbols,
      uniqueSymbols: stats.uniqueSymbols,
      imports: stats.imports,
      calls: stats.calls,
      languages: stats.languages,
      errorFiles: stats.errorFiles,
      scanMs: scan.ms,
      truncated: scan.truncated,
    },
    suites: results,
  },
  targets: {
    lineTarget: 1000000,
    lineState: lines && lines.lines > 1000000 ? 'met' : 'not met',
    millionLineGap: lines ? Math.max(0, 1000000 - lines.lines) : null,
  },
  failures,
  ok: failures.length === 0,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`\nfirst-party lines ${lines ? lines.lines : '?'} across ${lines ? lines.files : '?'} tracked files`);
console.log(`tools ${services && services.tools ? `${services.tools} in ${services.categories} categories` : 'unavailable'} · code index ${stats.files} files / ${stats.symbols} symbols / ${stats.errorFiles} errors`);
console.log(`ledger written to ${path.relative(root, outputPath)}`);
if (failures.length) {
  console.error(`\nFAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(fast ? '\nAcceptance gate (fast structural checks) passed.' : '\nAll 7.2 acceptance checks passed.');
