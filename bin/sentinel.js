#!/usr/bin/env node
'use strict';

/**
 * SENTINEL command line.
 *
 * The same brain the UI talks to, for people who live in a terminal, and for
 * scripts: every command has a --json mode that prints one object and exits with
 * a meaningful status.
 *
 *   sentinel ask "jaki mam GPU?"          one question, streamed answer
 *   sentinel ask "..." --deep --speak     plan, then read the answer aloud
 *   sentinel chat                         interactive session
 *   sentinel doctor [--fix]               diagnose, optionally repair
 *   sentinel memory list|search|add|forget
 *   sentinel index <path>                 add documents to the knowledge base
 *   sentinel models [--benchmark]
 *   sentinel agents | tools [query] | tasks | automations
 *   sentinel voice transcribe <file> | speak "text"
 *   sentinel status
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (COLORS ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const dim = paint('2');
const bold = paint('1');
const blue = paint('38;5;75');
const green = paint('38;5;79');
const red = paint('38;5;203');
const amber = paint('38;5;215');
const stageLabel = (stage) => ({ thinking: 'myślę', recall: 'pamięć', routing: 'routing', planning: 'plan', working: 'praca', composing: 'składam', verifying: 'weryfikacja', reflecting: 'refleksja', degraded: 'bez modelu', cancelled: 'stop', done: 'gotowe' }[stage] || stage);

const HELP = `SENTINEL ${require('../package.json').version} — your own assistant for this machine

  sentinel ask "<question>" [options]     ask once and print the answer
      --fast | --balanced | --deep        reasoning mode (default: config)
      --json                              machine-readable result
      --speak                             read the answer aloud (needs TTS)
      --no-stream                         print the answer once, without stages
  sentinel chat                           interactive session (Ctrl-D to leave)
  sentinel doctor [--json] [--fix]        diagnose; --fix asks before repairing
  sentinel memory [list|search <q>|add <text>|forget <id>]
  sentinel index <file-or-folder> [--tags a,b] [--max 300]
  sentinel models [--benchmark]           providers, installed models, speed
  sentinel agents [--json]                the specialist roster
  sentinel tools [query] [--json]         every tool the assistant may call
  sentinel tasks [--json]                 recent tasks and their steps
  sentinel automations [list|run <id>|remove <id>]
  sentinel voice transcribe <file> [--lang pl]
  sentinel voice speak "<text>"
  sentinel status [--json]                this machine and the AI stack
  sentinel runtime [profil]               idle / balanced / deep / gaming
    neural [status|discover|route <zadanie>]  modele: metadane, możliwości, routing
  sentinel graph [zapytanie]              knowledge graph stats or a multi-hop query
  sentinel org [zdolność]                 organisation chart or a delegation preview
  sentinel mcp [status|connect|disconnect] [serwer]   opt-in MCP servers
  sentinel benchmark [--json]             measured latency and memory of this install
  sentinel test [--all] [--json]          run the deterministic test suites
  sentinel backup [list|<label>]          back up config, memory and database
  sentinel rollback [--config]            restore the newest backup (kept, not deleted)
  sentinel update [--check]               compare with the latest release
  sentinel migrate                        migrate the store and report integrity
  sentinel serve [--open]                 start the agent (same as sentinel-agent)

  Global: --home <dir> to use a different data directory, --help, --version
`;

function parse(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if (arg === '--speak') out.speak = true;
    else if (arg === '--fix') out.fix = true;
    else if (arg === '--benchmark') out.benchmark = true;
    else if (arg === '--no-stream') out.noStream = true;
    else if (arg === '--fast') out.mode = 'fast';
    else if (arg === '--balanced') out.mode = 'balanced';
    else if (arg === '--deep') out.mode = 'deep';
    else if (arg === '--open') out.open = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--home') out.home = argv[++index];
    else if (arg === '--lang' || arg === '--language') out.lang = argv[++index];
    else if (arg === '--tags') out.tags = String(argv[++index] || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    else if (arg === '--max') out.max = Number(argv[++index]);
    else out._.push(arg);
  }
  return out;
}

const args = parse(process.argv.slice(2));

if (args.home) process.env.SENTINEL_HOME = path.resolve(args.home);
if (args.version) {
  console.log(require('../package.json').version);
  process.exit(0);
}
if (args.help || (!args._.length && !args.version)) {
  console.log(HELP);
  process.exit(0);
}

const command = args._.shift();
const rest = args._;

const fail = (message, code = 1) => {
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(red(`✗ ${message}`));
  process.exit(code);
};

/* ── result helpers ────────────────────────────────────────────────────── */

function printAnswer(answer, { streamed }) {
  if (streamed) process.stdout.write('\n');
  console.log(answer.text);
  const meta = [];
  if (answer.agentTitle) meta.push(answer.agentTitle);
  if (answer.model) meta.push(answer.model);
  if (answer.tools && answer.tools.length) meta.push(`${answer.tools.length} narzędzi`);
  if (answer.citations && answer.citations.length) meta.push(`${answer.citations.length} źródeł`);
  if (answer.verification && answer.verification.issues && answer.verification.issues.length) meta.push(`uwagi: ${answer.verification.issues.length}`);
  if (answer.degraded) meta.push('bez modelu');
  if (answer.ms) meta.push(`${(answer.ms / 1000).toFixed(1)} s`);
  console.log(dim(`\n  ${meta.join(' · ')}`));
  if (answer.citations && answer.citations.length) {
    for (const citation of answer.citations.slice(0, 5)) {
      console.log(dim(`  ${citation.id} ${citation.title ? `— ${citation.title}` : ''}${citation.excerpt ? `: ${String(citation.excerpt).slice(0, 120)}` : ''}`));
    }
  }
  if (answer.verification && answer.verification.issues && answer.verification.issues.length) {
    for (const issue of answer.verification.issues.slice(0, 4)) console.log(amber(`  ! ${issue}`));
  }
  if (answer.approvals && answer.approvals.length) {
    console.log(amber(`\n  ${answer.approvals.length} akcja(e) czekają na zgodę: sentinel approvals`));
  }
}

async function speak(agent, text) {
  try {
    await agent.voice.speak(text);
    return true;
  } catch (err) {
    console.error(amber(`  (nie mogę przeczytać na głos: ${err.code || err.message})`));
    return false;
  }
}

async function ask(agent, question, { onStage } = {}) {
  let printed = false;
  const answer = await agent.brain.ask({
    text: question,
    mode: args.mode || null,
    sessionId: 'cli',
    onToken: args.noStream
      ? null
      : (token) => {
          printed = true;
          process.stdout.write(token);
        },
    onStage: args.noStream || !process.stderr.isTTY
      ? null
      : (event) => {
          if (event.stage === 'working' || event.stage === 'planning') process.stderr.write(dim(`\r  ${stageLabel(event.stage)}…            `));
          if (event.stage === 'verifying') process.stderr.write(dim('\r  weryfikacja…        '));
          if (event.stage === 'done') process.stderr.write('\r                      \r');
          if (onStage) onStage(event);
        },
  });
  return { answer, printed };
}

/* ── commands ──────────────────────────────────────────────────────────── */

function loadAgent() {
  const { createAgent } = require('../core/agent');
  const agent = createAgent();
  if (!agent.aiReady) {
    console.error(amber(`Uwaga: stos AI nie wystartował (${agent.aiError}). Odpowiedzi będą ograniczone do narzędzi.`));
  }
  return agent;
}

async function main() {
  if (command === 'serve') {
    // Hand over to the long-running agent, sharing this process' args.
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'sentinel-agent.js'), ...(args.open ? ['--open'] : [])], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
  }

  const agent = loadAgent();
  const done = (code = 0) => {
    try {
      agent.stop();
    } catch {
      /* already stopped */
    }
    process.exit(code);
  };

  try {
    switch (command) {
      case 'ask': {
        const question = rest.join(' ').trim();
        if (!question) fail('what should I ask? e.g. sentinel ask "jaki mam GPU?"');
        const { answer, printed } = await ask(agent, question);
        if (args.json) console.log(JSON.stringify(answer, null, 2));
        else if (!printed) printAnswer(answer, { streamed: false });
        else {
          console.log();
          if (answer.tools && answer.tools.length) console.log(dim(`  ${answer.agentTitle || ''} · ${answer.tools.join(', ')}`));
        }
        if (args.speak && answer.text) await speak(agent, answer.text);
        return done(answer.text ? 0 : 2);
      }

      case 'chat': {
        console.log(bold('SENTINEL') + dim(` — ${agent.config.get('ai.mode') || 'balanced'} · Ctrl-D aby wyjść`));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: blue('› ') });
        const history = [];
        rl.prompt();
        for await (const line of rl) {
          const question = line.trim();
          if (!question) {
            rl.prompt();
            continue;
          }
          if (['exit', 'quit', 'q', ':q'].includes(question)) break;
          const started = Date.now();
          try {
            const { answer, printed } = await ask(agent, question);
            if (!printed && answer.text) console.log(answer.text);
            if (answer.tools && answer.tools.length) console.log(dim(`  ${(Date.now() - started) / 1000 | 0}s · ${answer.tools.join(', ')}`));
            history.push({ question, answer: answer.text });
          } catch (err) {
            console.error(red(`  ✗ ${err.message}`));
          }
          rl.prompt();
        }
        return done(0);
      }

      case 'doctor': {
        const report = await agent.healing.diagnose();
        if (args.json) {
          console.log(JSON.stringify(report, null, 2));
          return done(report.ok ? 0 : 3);
        }
        console.log(bold(report.summary));
        for (const check of report.checks) {
          const mark = check.ok ? green('✓') : red('✗');
          console.log(`  ${mark} ${check.id.padEnd(18)} ${dim(check.detail)}`);
          if (!check.ok && check.fix) console.log(`     ${amber(`→ ${check.fix}`)}`);
        }
        if (args.fix) {
          const proposal = await agent.healing.propose({ problem: 'doctor' });
          if (!proposal.proposed) {
            console.log(amber(`\n${proposal.reason}`));
            return done(report.ok ? 0 : 3);
          }
          console.log(bold('\nProponowana naprawa:'));
          for (const step of proposal.steps) console.log(`  • ${step.description}`);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise((resolve) => rl.question(amber('\nWykonać? [t/N] '), resolve));
          rl.close();
          if (!/^t(yes)?$/i.test(answer.trim())) {
            console.log(dim('Nic nie zmieniono.'));
            return done(report.ok ? 0 : 3);
          }
          const applied = await agent.healing.apply(proposal.id);
          console.log(applied.ok ? green('✓ naprawione') : red(`✗ ${applied.message || 'nie udało się'}`));
          return done(applied.ok ? 0 : 4);
        }
        return done(report.ok ? 0 : 3);
      }

      case 'memory': {
        const action = rest[0] || 'list';
        if (action === 'list') {
          const records = agent.memory.list({ limit: 40 });
          if (args.json) console.log(JSON.stringify(records, null, 2));
          else {
            const stats = agent.memory.stats();
            console.log(dim(`${stats.total} wspomnień · ${stats.store ? stats.store.driver : '?'}`));
            for (const record of records) console.log(`  ${dim(record.createdAt ? new Date(record.createdAt).toLocaleDateString() : '')} ${blue(record.kind.padEnd(11))} ${record.text.slice(0, 140)}`);
          }
          return done(0);
        }
        if (action === 'search') {
          const query = rest.slice(1).join(' ');
          if (!query) fail('what should I look for?');
          const hits = await agent.memory.recall(query, { limit: 10 });
          if (args.json) console.log(JSON.stringify(hits, null, 2));
          else for (const hit of hits) console.log(`  ${blue((hit.score || 0).toFixed(2).padStart(5))} ${((hit.record || hit).text || '').slice(0, 150)}`);
          return done(hits.length ? 0 : 5);
        }
        if (action === 'add') {
          const text = rest.slice(1).join(' ');
          if (!text) fail('nothing to remember');
          const result = await agent.memory.remember({ text, kind: 'long_term', importance: 0.75, source: 'cli' });
          if (result.rejected) fail(`refused: ${result.rejected}`);
          console.log(green(`✓ zapamiętane ${result.record.id}`));
          return done(0);
        }
        if (action === 'forget') {
          const id = rest[1];
          if (!id) fail('which memory? (sentinel memory list)');
          const forgotten = agent.memory.forget(id);
          console.log(forgotten ? green('✓ usunięte') : amber('nie ma takiego wspomnienia'));
          return done(forgotten ? 0 : 5);
        }
        return fail(`unknown memory action "${action}"`);
      }

      case 'index': {
        const target = rest[0];
        if (!target) fail('give me a file or a folder to index');
        const resolved = path.resolve(target.replace(/^~(?=$|[\\/])/, require('node:os').homedir()));
        if (!fs.existsSync(resolved)) fail(`${resolved} does not exist`);
        const started = Date.now();
        const result = await agent.knowledge.indexPath(resolved, { recursive: true, maxFiles: args.max || 300, tags: args.tags || [] });
        if (args.json) console.log(JSON.stringify(result, null, 2));
        else {
          const chunks = (result.documents || []).reduce((sum, doc) => sum + (doc.chunks || 0), 0);
          console.log(green(`✓ ${result.indexed} plików, ${chunks} fragmentów, ${result.skipped} pominiętych (${((Date.now() - started) / 1000).toFixed(1)} s)`));
          for (const detail of (result.details || []).slice(0, 5)) console.log(amber(`  ! ${detail.file}: ${detail.reason}`));
        }
        return done(0);
      }

      case 'models': {
        const status = await agent.llm.status();
        if (args.json && !args.benchmark) {
          console.log(JSON.stringify(status, null, 2));
          return done(status.providers && Object.values(status.providers).some((provider) => provider.ok) ? 0 : 6);
        }
        console.log(bold(`tryb: ${status.mode}`) + dim(` · zewnętrzne API: ${status.allowExternal ? 'tak' : 'nie'} · offline: ${status.offline ? 'tak' : 'nie'}`));
        for (const [name, provider] of Object.entries(status.providers || {})) {
          const mark = provider.ok ? green('✓') : red('✗');
          const detail = provider.ok ? `${(provider.models || []).length} modeli` : provider.error || 'brak odpowiedzi';
          console.log(`  ${mark} ${name.padEnd(10)} ${dim(detail)}`);
          if (provider.ok) for (const model of (provider.models || []).slice(0, 12)) console.log(dim(`      ${model.id}${model.size ? ` (${Math.round(model.size / 1e9)} GB)` : ''}`));
        }
        console.log(dim(`\n  klasy: ${Object.entries(status.models || {}).map(([name, model]) => `${name}=${model}`).join(' ')}`));
        if (args.benchmark) {
          const measure = await agent.llm.benchmark({ modelClass: args.mode || 'fast' });
          console.log(green(`\n  ${measure.model}: ${measure.firstTokenMs} ms do pierwszego tokenu, ${measure.tokensPerSecond} tok/s`));
        }
        const any = Object.values(status.providers || {}).some((provider) => provider.ok);
        if (!any) {
          const wanted = (status.models && (status.models.balanced || status.models.fast)) || 'qwen3.5:9b';
          console.log(amber(`\n  Żaden model nie odpowiada. Zainstaluj Ollama, potem: ollama pull ${wanted}`));
        }
        return done(any ? 0 : 6);
      }

      case 'agents': {
        const roster = agent.agents.list();
        if (args.json) console.log(JSON.stringify(roster, null, 2));
        else for (const entry of roster) console.log(`  ${blue(entry.id.padEnd(22))} ${dim(entry.role.padEnd(12))} ${entry.description}`);
        return done(0);
      }

      case 'tools': {
        const query = rest.join(' ').toLowerCase();
        const tools = agent.tools.list().filter((tool) => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query));
        if (args.json) console.log(JSON.stringify(tools, null, 2));
        else for (const tool of tools) console.log(`  ${blue(tool.name.padEnd(24))} ${dim(tool.permission.padEnd(10))} ${tool.description}`);
        if (!args.json) console.log(dim(`\n  ${tools.length} z ${agent.tools.list().length} narzędzi`));
        return done(tools.length ? 0 : 5);
      }

      case 'tasks': {
        const tasks = agent.tasks.list({ limit: 30 });
        if (args.json) console.log(JSON.stringify(tasks, null, 2));
        else if (!tasks.length) console.log(dim('brak zadań'));
        else for (const task of tasks) console.log(`  ${blue(task.id)} ${task.status.padEnd(10)} ${String(task.progress).padStart(3)}% ${task.title}`);
        return done(0);
      }

      case 'automations': {
        const action = rest[0] || 'list';
        if (action === 'list') {
          const items = agent.automation.list();
          if (args.json) console.log(JSON.stringify(items, null, 2));
          else if (!items.length) console.log(dim('brak automatyzacji'));
          else for (const item of items) console.log(`  ${blue(item.id)} ${(item.enabled ? green('on') : dim('off')).padEnd(3)} ${item.name} ${dim(`${item.trigger.type === 'daily' ? item.trigger.at : `co ${item.trigger.everyMinutes} min`} · ${item.runCount} przebiegów`)}`);
          return done(0);
        }
        if (action === 'run') {
          const result = await agent.automation.run(rest[1], { trigger: 'cli' });
          console.log(result.ok ? green('✓ uruchomione') : red(`✗ ${result.message}`));
          if (result.text) console.log(`\n${result.text}`);
          return done(result.ok ? 0 : 4);
        }
        if (action === 'remove') {
          const removed = agent.automation.remove(rest[1]);
          console.log(removed ? green('✓ usunięte') : amber('nie ma takiej automatyzacji'));
          return done(removed ? 0 : 5);
        }
        return fail(`unknown automations action "${action}"`);
      }

      case 'voice': {
        const action = rest[0];
        if (action === 'transcribe') {
          const file = rest[1];
          if (!file) fail('which file?');
          const result = await agent.voice.transcribe(path.resolve(file), { language: args.lang || 'auto' });
          console.log(result.text);
          return done(0);
        }
        if (action === 'speak') {
          const text = rest.slice(1).join(' ');
          if (!text) fail('what should I say?');
          const result = await agent.voice.speak(text);
          console.log(green(`✓ ${result.engine}${result.file ? ` → ${result.file}` : ''}`));
          return done(0);
        }
        const status = await agent.voice.status();
        if (args.json) console.log(JSON.stringify(status, null, 2));
        else console.log(JSON.stringify(status, null, 2));
        return done(status.stt && status.stt.available ? 0 : 6);
      }

      case 'benchmark': {
        const questions = ['ile to 17*23+4', 'oblicz 2^10', 'ile to 6*7'];
        const samples = [];
        for (const question of questions) {
          // eslint-disable-next-line no-await-in-loop
          const started = process.hrtime.bigint();
          // eslint-disable-next-line no-await-in-loop
          const answer = await agent.ask({ text: question, mode: 'fast' });
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          samples.push({ question, ms: Number(ms.toFixed(1)), correct: /\d/.test(answer.text) });
        }
        const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
        const report = {
          version: require('../package.json').version,
          deterministic: true,
          note: 'no model provider is measured here; these are the deterministic paths',
          samples,
          p50Ms: percentile(50),
          p95Ms: percentile(95),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          agents: agent.agents.list().length,
          tools: agent.tools.stats().implemented,
          toolsAvailable: agent.tools.stats().available,
          memoryRecords: agent.memory.stats().total,
          store: agent.store.stats(),
        };
        if (args.json) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(bold(`SENTINEL ${report.version} — benchmark`));
          for (const sample of samples) console.log(`  ${sample.question.padEnd(18)} ${String(sample.ms).padStart(8)} ms ${sample.correct ? green('✓') : red('✗')}`);
          console.log(`  p50 ${report.p50Ms} ms · p95 ${report.p95Ms} ms · RSS ${report.rssMb} MB`);
          console.log(dim(`  ${report.agents} agentów, ${report.toolsAvailable}/${report.tools} narzędzi dostępnych, ${report.memoryRecords} wspomnień, ${report.store.driver}${report.store.fts ? ' + FTS5' : ''}`));
          console.log(dim('  Model latency and tokens/s: sentinel models --benchmark (needs a running provider).'));
        }
        return done(samples.every((sample) => sample.correct) ? 0 : 4);
      }

      case 'test': {
        const { spawnSync } = require('node:child_process');
        const suites = args.all ? ['run.js', 'ui.js', 'ai.js', 'deep.js'] : ['run.js', 'deep.js'];
        let failedSuites = 0;
        for (const suite of suites) {
          const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'test', suite)], { stdio: args.json ? 'pipe' : 'inherit', encoding: 'utf8' });
          const ok = result.status === 0;
          if (!ok) failedSuites += 1;
          if (args.json) console.log(JSON.stringify({ suite, ok, status: result.status }));
          else console.log(ok ? green(`  ✓ ${suite}`) : red(`  ✗ ${suite}`));
        }
        return done(failedSuites ? 1 : 0);
      }

      case 'backup': {
        const action = rest[0] || null;
        if (action === 'list') {
          const backups = agent.healing.listBackups();
          if (args.json) console.log(JSON.stringify(backups, null, 2));
          else if (!backups.length) console.log(dim('brak kopii zapasowych'));
          else for (const entry of backups) console.log(`  ${blue(entry.name)} ${dim(entry.createdAt)} ${entry.files === null ? '' : `${entry.files} plików`}`);
          return done(0);
        }
        const { backupsDir } = require('../core/paths');
        const created = await agent.healing.backup(action ? path.join(backupsDir(), action) : null);
        console.log(green(`kopia zapasowa: ${created.path}`));
        console.log(dim(`  ${created.files.length} plik(ów), ${created.files.reduce((sum, entry) => sum + entry.bytes, 0)} B`));
        return done(0);
      }

      case 'rollback': {
        const only = args.config ? 'config' : 'any';
        const restored = await agent.healing.restoreLatest({ only });
        if (!restored) {
          console.error(red('brak kopii zapasowej do przywrócenia'));
          return done(3);
        }
        console.log(green(`przywrócono z ${restored.dir || restored.path || 'najnowszej kopii'}; poprzednie pliki zachowano z sufiksem .before-restore`));
        return done(0);
      }

      case 'update': {
        const current = require('../package.json').version;
        let latest = null;
        try {
          const response = await fetch('https://api.github.com/repos/pawelaachi123-eng/SENTINEL/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sentinel-cli' }, signal: AbortSignal.timeout(8000) });
          if (response.ok) latest = (await response.json()).tag_name || null;
        } catch {
          latest = null;
        }
        if (args.json) console.log(JSON.stringify({ current, latest, updateAvailable: Boolean(latest && latest.replace(/^v/, '') !== current) }));
        else if (!latest) console.log(amber(`nie mogę sprawdzić wydań (brak sieci). Zainstalowana wersja: ${current}`));
        else if (latest.replace(/^v/, '') === current) console.log(green(`najnowsza wersja: ${current}`));
        else {
          console.log(amber(`dostępna nowsza wersja: ${latest} (masz ${current})`));
          console.log('  aktualizacja jest świadoma i nigdy nie dzieje się po cichu:');
          console.log(`  1. pobierz ${latest} z https://github.com/pawelaachi123-eng/SENTINEL/releases`);
          console.log('  2. uruchom INSTALL_SENTINEL_FULL.ps1 -Source <folder> — skrypt robi kopię, wdraża etapowo i sprawdza zdrowie');
          console.log('  3. przy problemie: sentinel rollback');
        }
        return done(0);
      }

      case 'migrate': {
        const { migrate } = require('../core/memory/store');
        const report = migrate(agent.store, { log: { info: (topic, message) => console.log(dim(`${topic}: ${message}`)) } });
        const integrity = agent.memory.integrity();
        const knowledge = agent.knowledge.coverage();
        console.log(bold('migracja'));
        console.log(`  schemat: ${report.from} → ${report.to}${report.applied ? ' (zastosowano)' : ' (bez zmian)'}`);
        console.log(`  FTS5: ${agent.store.fts ? 'włączony' : 'niedostępny — używany indeks w pamięci'}`);
        console.log(`  pamięć: ${agent.memory.stats().total} rekordów, integralność ${integrity.ok ? green('OK') : red(`${integrity.problems.length} problemów`)}`);
        console.log(`  wiedza: ${knowledge.documents} dokumentów, ${knowledge.chunks} fragmentów, ${knowledge.stale} nieaktualnych`);
        return done(integrity.ok ? 0 : 4);
      }

      case 'runtime': {
        if (rest[0]) {
          const applied = await agent.runtime.apply(rest[0], { reason: 'cli' });
          if (!applied.ok) {
            console.error(red(`✗ ${applied.code}: ${applied.message}`));
            return done(4);
          }
          console.log(green(`✓ profil ${applied.profile}${applied.unloaded.length ? `, wyładowano ${applied.unloaded.filter((entry) => entry.ok).length}/${applied.unloaded.length} modeli` : ''}`));
        }
        const status = await agent.runtime.status();
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
          return done(0);
        }
        const hw = status.hardware;
        console.log(bold(`Profil ${status.profile}`) + dim(` — ${status.profileDetail.description}`));
        console.log(`  CPU  ${hw.cpu} · ${hw.cores} wątków · RAM ${hw.memoryGb} GB`);
        console.log(`  GPU  ${hw.gpu ? `${hw.gpu.name} · ${hw.gpu.vramGb} GB` : dim('nie wykryto')}`);
        console.log(`  model ${status.feasibility.model || '?'}${status.feasibility.estimate ? dim(` (~${status.feasibility.estimate.totalGb} GB, szacunek)`) : ''}`);
        console.log(`  w pamięci ${status.resident.supported ? (status.resident.models.map((model) => `${model.name} ${model.vramGb} GB`).join(', ') || dim('brak')) : dim(status.resident.reason || 'nie wiem')}`);
        console.log(dim(`  profile: ${status.profiles.map((entry) => entry.name).join(', ')}`));
        return done(0);
      }

      case 'graph': {
        const query = rest.join(' ').trim();
        if (query) {
          const result = agent.graph.contextFor(query, { limit: 8, depth: 2 });
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else if (!result.lines.length) console.log(dim('brak powiązań'));
          else for (const line of result.lines) console.log(`  ${line}`);
          return done(result.lines.length ? 0 : 5);
        }
        const stats = agent.graph.stats();
        if (args.json) {
          console.log(JSON.stringify(stats, null, 2));
          return done(0);
        }
        console.log(`${stats.nodes} węzłów · ${stats.edges} krawędzi`);
        console.log(dim(`  typy: ${Object.entries(stats.byType).map(([type, count]) => `${type} ${count}`).join(' · ') || 'brak'}`));
        return done(0);
      }

      case 'org': {
        const chart = rest[0] ? agent.org.planDelegation({ capability: rest.join(' ') }) : agent.org.chart();
        if (args.json) {
          console.log(JSON.stringify(chart, null, 2));
          return done(0);
        }
        if (rest[0]) {
          if (!chart.ok) {
            console.error(red(`✗ ${chart.message}`));
            return done(5);
          }
          console.log(`${bold(chart.lead)} (${chart.leadTier}) + ${chart.workers.map((worker) => worker.name).join(', ') || 'bez wsparcia'} · głębokość ${chart.depth}/${chart.maxDepth}`);
          return done(0);
        }
        console.log(`${chart.total} agentów · ${Object.entries(chart.counts).map(([tier, count]) => `${tier} ${count}`).join(' · ')}`);
        for (const [domain, info] of Object.entries(chart.domains)) console.log(`  ${domain.padEnd(14)} ${info.lead} ${dim(`(${info.members.join(', ')})`)}`);
        return done(0);
      }

      case 'neural': {
        const action = rest[0] || 'status';
        if (action === 'discover' || action === 'refresh') {
          const found = await agent.neural.discover({ force: true });
          if (args.json) console.log(JSON.stringify(found, null, 2));
          else console.log(green(`✓ ${found.found} modeli${found.errors.length ? `, ${found.errors.length} dostawców nie odpowiada` : ''}`));
          return done(found.errors.length && !found.found ? 4 : 0);
        }
        if (action === 'route') {
          const route = agent.neural.route({ task: rest[1] || 'reasoning' });
          if (args.json) console.log(JSON.stringify(route, null, 2));
          else console.log(route.ok ? green(`✓ ${route.ref} — ${route.reason}`) : red(`✗ ${route.code}: ${route.message}`));
          return done(route.ok ? 0 : 4);
        }
        const status = agent.neural.status();
        if (args.json) console.log(JSON.stringify(status, null, 2));
        else {
          console.log(`${status.models.length} modeli${status.cached ? ' (z cache)' : ''}${status.lastDiscovery ? `, odkryte ${status.lastDiscovery}` : ''}`);
          for (const model of status.models.slice(0, 30)) {
            console.log(`  ${model.provider}:${model.id} · ${model.kind} · ${model.parameters || 'rozmiar nieznany'} · ${model.quantization || 'kwantyzacja nieznana'} · kontekst ${model.contextLength || 'nieznany'}`);
          }
          console.log(dim('Pola nieznane są puste, nie zgadywane. Odśwież: sentinel neural discover'));
        }
        return done(0);
      }
      case 'mcp': {
        const action = rest[0] || 'status';
        if (action === 'connect' || action === 'disconnect') {
          const result = action === 'connect' ? await agent.mcp.connect(rest[1]) : await agent.mcp.disconnect(rest[1]);
          console.log(result.ok ? green(`✓ ${action}: ${rest[1]}`) : red(`✗ ${result.code}: ${result.message}`));
          return done(result.ok ? 0 : 4);
        }
        const status = agent.mcp.status();
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
          return done(0);
        }
        console.log(`${status.enabled ? green('włączone') : dim('wyłączone')} · protokół ${status.preferredVersion} · ${status.servers.length} serwerów`);
        for (const server of status.servers) console.log(`  ${server.id.padEnd(16)} ${server.status} ${dim(server.protocolVersion || '')} ${server.tools} narzędzi`);
        return done(0);
      }

      case 'status': {
        const snapshot = await agent.http.snapshot();
        const ai = agent.aiStatus();
        if (args.json) {
          console.log(JSON.stringify({ machine: snapshot, ai }, null, 2));
          return done(0);
        }
        console.log(bold(`${snapshot.hostname || require('node:os').hostname()} · ${snapshot.platformLabel || process.platform}`));
        console.log(`  CPU   ${String(snapshot.cpuPercent ?? '?').padStart(3)}%   RAM ${snapshot.memoryDetail ? `${snapshot.memoryDetail.percent}%` : '?'}   uptime ${snapshot.uptimeLabel || '?'}`);
        console.log(`  ESP32 ${snapshot.esp && snapshot.esp.connected ? green('połączony') : dim('offline')}`);
        const models = (ai.llm && ai.llm.models) || {};
        console.log(`  model ${Object.keys(models).length ? Object.entries(models).map(([name, model]) => `${name}=${model}`).join(' ') : dim('brak')}`);
        console.log(`  pamięć ${ai.memory ? ai.memory.total : 0} · wiedza ${ai.knowledge ? `${ai.knowledge.documents} dok / ${ai.knowledge.chunks} frag` : 0}`);
        console.log(`  narzędzia ${agent.tools.list().length} · agenci ${agent.agents.list().length}`);
        console.log(`  pytania ${ai.brain ? ai.brain.counters.questions : 0} · odpowiedzi ${ai.brain ? ai.brain.counters.answers : 0} · bez modelu ${ai.brain ? ai.brain.counters.noModel : 0}`);
        return done(0);
      }

      case 'approvals': {
        const pending = agent.approvals.list();
        if (args.json) console.log(JSON.stringify(pending, null, 2));
        else if (!pending.length) console.log(dim('nic nie czeka na zgodę'));
        else for (const approval of pending) console.log(`  ${blue(approval.id)} ${approval.tool} ${dim(approval.reason || '')}`);
        return done(0);
      }

      default:
        console.error(red(`unknown command "${command}"`));
        console.log(HELP);
        return done(2);
    }
  } catch (err) {
    if (args.json) console.log(JSON.stringify({ ok: false, code: err.code || 'FAILED', error: err.message }));
    else console.error(red(`✗ ${err.code ? `${err.code}: ` : ''}${err.message}`));
    return done(err.code === 'NOT_FOUND' ? 5 : 1);
  }
}

main();
