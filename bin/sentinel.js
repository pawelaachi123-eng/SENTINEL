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
  sentinel brief [--json]                 dzienny briefing: terminy, zadania, cele, zgody
  sentinel calendar [status|upcoming|add <opis>|import <plik.ics>] [--at ISO] [--days N]
  sentinel proactive [status]             reguły proaktywne (opt-in, bez podsłuchu)
  sentinel tasks [--json]                 recent tasks and their steps
  sentinel automations [list|run <id>|remove <id>]
  sentinel voice transcribe <file> [--lang pl]
  sentinel voice speak "<text>"
  sentinel status [--json]                this machine and the AI stack
  sentinel runtime [profil]               idle / balanced / deep / gaming
    neural [status|discover|route <zadanie>]  modele: metadane, możliwości, routing
    lab [status|classify <tekst>]              laboratorium: metryki, aktywny model
    train --approve <imię>                     trening małego klasyfikatora na CPU
    sentiment [status|train|promote <id>|classify <tekst>] [--approve <imię>]
                                             kompaktowy transformer: trening/ewaluacja
    research [list|start <pytanie>|add <id> <plik>|report <id>]  sesje badawcze z cytatami
    hypercore [status|goals|conflicts|focus]  typowany stan poznawczy i uwaga
    reranker [status|train|promote <id>|rerank <q> <kandydaci...>]  reranker z NDCG
    specialists [status|train <zadanie>|promote <zadanie> <id>|predict <zadanie> <tekst>]
                                             siedem małych modeli: narzędzia, routing, pamięć, złożoność,
                                             podobieństwo, ważność kontekstu, ryzyko błędu
    specialists similarity <q> <fragment> | context <q> <fragment> | failure <uprawnienie>
    comm [status|consent <dest>|grant <token>|call <dest> <tekst>|sms <dest> <tekst>]
                                             połączenia/SMS tylko za zgodą; mock domyślnie
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
    else if (arg === '--approve') out.approve = argv[++index] || 'cli-operator';
    else if (arg === '--consent') out.consent = argv[++index];
    else if (arg === '--budget') out.budget = Number(argv[++index]);
    else if (arg === '--at') out.at = argv[++index];
    else if (arg === '--days') out.days = Number(argv[++index]);
    else if (arg === '--file') out.file = argv[++index];
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

      case 'brief': {
        const briefing = agent.briefing.generate({ horizonHours: args.max || 24 });
        if (args.json) console.log(JSON.stringify(briefing, null, 2));
        else process.stdout.write(`${briefing.text}\n`);
        return done(0);
      }

      case 'calendar': {
        const action = rest[0] || 'upcoming';
        if (action === 'status') {
          const status = agent.calendar.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else console.log(`${status.events} wydarzeń · ${status.upcoming24h} w ciągu 24 h · źródła: ${status.sources.join(', ') || 'brak'}`);
          return done(0);
        }
        if (action === 'add') {
          const summary = rest.slice(1).join(' ').trim();
          if (!summary) {
            console.error(red('użycie: sentinel calendar add <opis> --at 2026-11-23T09:00:00Z'));
            return done(2);
          }
          const result = agent.calendar.add({ summary, start: args.at || new Date().toISOString(), durationMs: 3600000 }, { source: 'cli' });
          if (!result.ok) {
            console.error(red(`${result.code}: ${result.message}`));
            return done(1);
          }
          console.log(green(`dodano: ${result.event.summary} — ${new Date(result.event.start).toISOString()}`));
          return done(0);
        }
        if (action === 'import') {
          if (!args.file) {
            console.error(red('użycie: sentinel calendar import <plik.ics>'));
            return done(2);
          }
          const result = agent.calendar.importIcs(fs.readFileSync(args.file, 'utf8'));
          console.log(`${result.imported || 0} nowych, ${result.updated || 0} zaktualizowanych, ${result.unchanged || 0} bez zmian, ${result.errors.length} błędów`);
          for (const error of result.errors) console.error(amber(`  linia ${error.line}: ${error.reason}`));
          return done(result.ok ? 0 : 1);
        }
        const days = Math.max(0.01, args.days || 7);
        const now = Date.now();
        const events = agent.calendar.upcoming({ from: now, to: now + days * 86400000, limit: 100 });
        if (args.json) console.log(JSON.stringify(events, null, 2));
        else if (!events.length) console.log(dim('brak wydarzeń w tym zakresie'));
        else for (const event of events) console.log(`  ${new Date(event.start).toISOString().slice(0, 16).replace('T', ' ')}  ${event.summary}${event.occurrence ? ' (powtarza się)' : ''}`);
        return done(0);
      }

      case 'proactive': {
        const status = agent.proactive.status();
        if (args.json) console.log(JSON.stringify(status, null, 2));
        else {
          console.log(`reguły: ${status.counts.enabled}/${status.counts.rules} aktywnych · dostarczono dzisiaj ${status.counts.deliveredToday}`);
          console.log(`  limity: ${status.limits.maxPerHour}/h, ${status.limits.maxPerDay}/dzień · ciche godziny: ${status.quietHours ? status.quietHours.join('-') : 'brak'}`);
          for (const rule of status.rules) console.log(`  ${rule.id} · ${rule.event} · ${rule.name} · kanały ${rule.channels.join(',')}`);
          console.log(dim(`  ${status.honesty}`));
        }
        return done(0);
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

      case 'lab':
      case 'train': {
        const action = command === 'train' ? 'train' : rest[0] || 'status';
        if (action === 'status') {
          const status = agent.lab.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('laboratorium neuronowe'));
            console.log(`  dataset: ${status.dataset.items} przykładów, ${status.dataset.labels.length} intencji, ${status.dataset.version} (${status.dataset.provenance})`);
            console.log(`  aktywne: ${status.active ? `${status.active.experimentId} · test ${status.active.metrics.accuracy} · baseline ${status.active.metrics.baseline || '?'}` : 'brak (wytrenuj i promuj)'}`);
            for (const experiment of status.experiments.slice(0, 8)) console.log(`  ${experiment.id} · ${experiment.status} · test ${experiment.accuracy} vs baseline ${experiment.baseline} · ${experiment.artifact.bytes} B`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'train') {
          if (!args.approve) {
            console.error(red('trening wymaga jawnej zgody: sentinel train --approve <twoje-imie>'));
            return done(4);
          }
          console.log(dim(`  trenuję na CPU (seed ${args.seed || 7}); to mały MLP, nie LoRA`));
          const result = agent.lab.trainIntent({ approvedBy: args.approve, epochs: args.max || 40 });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message || ''}`));
            return done(4);
          }
          const experiment = result.experiment;
          if (args.json) console.log(JSON.stringify(experiment, null, 2));
          else {
            console.log(green(`✓ ${experiment.id} · ${experiment.status}`));
            console.log(`  test: ${experiment.metrics.accuracy} (baseline ${experiment.baseline.accuracy}, delta ${experiment.delta}), macro-F1 ${experiment.metrics.macroF1}`);
            console.log(`  epoki: ${experiment.training.epochsRun}, najlepsza: ${experiment.training.bestEpoch}, loss walidacyjny ${experiment.training.bestValidationLoss}`);
            console.log(`  checkpoint: ${experiment.artifact.path} (${experiment.artifact.bytes} B, sha256 ${experiment.artifact.checksum.slice(0, 16)}…)`);
            console.log(dim('  nic nie jest aktywne bez: sentinel lab promote <id> --approve <imię>'));
          }
          return done(0);
        }
        if (action === 'promote' || action === 'rollback') {
          if (!args.approve) {
            console.error(red(`operacja ${action} wymaga --approve <imię>`));
            return done(4);
          }
          const result = action === 'promote' ? agent.lab.promote(rest[1], { approvedBy: args.approve }) : agent.lab.rollback({ approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message || ''}`));
            return done(4);
          }
          console.log(green(`✓ ${action}: ${result.active.experimentId}`));
          return done(0);
        }
        if (action === 'classify') {
          const text = rest.slice(1).join(' ');
          if (!text) {
            console.error(red('użycie: sentinel lab classify <tekst>'));
            return done(4);
          }
          const result = agent.lab.classify(text);
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(`${result.intent} ${dim(`(pewność ${result.confidence})`)}`);
            console.log(dim(`  model ${result.model.experimentId}`));
          }
          return done(0);
        }
        console.error(red(`nieznana akcja lab: ${action}`));
        return done(4);
      }

      case 'executive': {
        const engine = agent.executive;
        const action = rest[0] || 'status';
        engine.start();
        if (action === 'status') {
          const status = engine.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('silnik wykonawczy'));
            console.log(`  pula: ${status.pool.running}/${status.pool.size} · kolejka ${status.pool.queued} · joby ${JSON.stringify(status.pool.counts)}`);
            console.log(`  workflow: ${JSON.stringify(status.workflows.counts)} · retry ${status.workflows.counters.retried} · replan ${status.workflows.counters.replanned}`);
            for (const workflow of status.workflows.workflows) console.log(`  ${workflow.id} ${workflow.status} · ${workflow.steps.filter((step) => step.status === 'done').length}/${workflow.steps.length}`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'jobs') {
          const jobs = engine.pool.list({ limit: args.max || 30 });
          if (args.json) console.log(JSON.stringify(jobs, null, 2));
          else for (const job of jobs) console.log(`  ${job.id} ${job.kind} ${job.status} attempts ${job.attempts}${job.error ? ` · ${job.error.code}` : ''}`);
          return done(0);
        }
        if (action === 'submit') {
          const kind = rest[1];
          if (!kind) { console.error(red('użycie: sentinel executive submit <kind> [--payload JSON]')); return done(4); }
          const payload = args.payload ? JSON.parse(args.payload) : {};
          const job = engine.submit({ kind, payload, priority: args.priority || 5 });
          console.log(green(`✓ ${job.id} ${job.status}`));
          return done(0);
        }
        if (action === 'cancel') {
          if (!rest[1]) { console.error(red('użycie: sentinel executive cancel <job-id|workflow-id>')); return done(4); }
          const result = engine.workflows.get(rest[1]) ? engine.workflows.cancel(rest[1]) : engine.pool.cancel(rest[1]);
          console.log(result.ok ? green(`✓ ${result.status}`) : red(result.code));
          return done(result.ok ? 0 : 4);
        }
        if (action === 'workflows') {
          const rows = engine.workflows.list({ limit: args.max || 20 });
          if (args.json) console.log(JSON.stringify(rows, null, 2));
          else for (const workflow of rows) console.log(`  ${workflow.id} ${workflow.status} · ${workflow.usage.steps}/${workflow.budget.steps} kroków · ${workflow.name}`);
          return done(0);
        }
        if (action === 'workflow') {
          if (!rest[1] || !require('node:fs').existsSync(rest[1])) { console.error(red('użycie: sentinel executive workflow <plan.json>')); return done(4); }
          const plan = JSON.parse(require('node:fs').readFileSync(rest[1], 'utf8'));
          const workflow = engine.workflows.create({ name: plan.name || rest[1], steps: plan.steps, budget: plan.budget || {} });
          console.log(green(`✓ ${workflow.id} · ${workflow.steps.length} kroków`));
          const result = await engine.workflows.run(workflow.id, {
            invoke: async (step, context) => {
              if (step.agent) throw Object.assign(new Error('agent steps need a runner'), { code: 'NO_AGENT_RUNNER' });
              const outcome = await agent.tools.execute(step.tool, step.args, { source: 'workflow', signal: context.signal });
              if (!outcome.ok) throw Object.assign(new Error(outcome.message || outcome.code), { code: outcome.code || 'TOOL_FAILED' });
              return outcome.data;
            },
          });
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(`${result.status}: ${result.steps.filter((step) => step.status === 'done').length}/${result.steps.length} gotowych`);
            for (const step of result.steps) console.log(`  ${step.id} ${step.status} attempts ${step.attempts}${step.error ? ` · ${step.error.code}` : ''}`);
          }
          return done(result.status === 'done' ? 0 : 5);
        }
        if (action === 'stop') {
          const result = await engine.stop('stopped from the CLI');
          console.log(green(`✓ zatrzymano ${result.pool.counts.cancelled || 0} zadań i ${result.workflows.counts.cancelled || 0} workflow`));
          return done(0);
        }
        console.error(red(`nieznana akcja executive: ${action}`));
        return done(4);
      }

      case 'coding': {
        const index = agent.codeIndex;
        const engine = agent.refactorEngine;
        const action = rest[0] || 'stats';
        const ensure = () => { if (!index.stats().files) index.scan(); };
        if (action === 'stats') {
          ensure();
          const stats = index.stats();
          if (args.json) console.log(JSON.stringify(stats, null, 2));
          else {
            console.log(bold('indeks kodu'));
            console.log(`  pliki ${stats.files} · symbole ${stats.symbols} (${stats.uniqueSymbols} unikalnych) · importy ${stats.imports} · wywołania ${stats.calls}`);
            console.log(`  języki: ${Object.entries(stats.languages).map(([k, v]) => `${k} ${v}`).join(' · ')} · błędy parsowania ${stats.errorFiles}`);
            console.log(dim('  parsery pokrywają praktyczne podzbiory gramatyk i zgłaszają błędy zamiast zgadywać.'));
          }
          return done(0);
        }
        if (action === 'search') {
          if (!rest[1]) { console.error(red('użycie: sentinel coding search <query>')); return done(4); }
          ensure();
          const rows = index.search(rest.slice(1).join(' '), { limit: args.max || 30 });
          if (args.json) console.log(JSON.stringify(rows, null, 2));
          else for (const row of rows) {
            const first = row.definitions[0] || {};
            console.log(`  ${first.file || '?'}:${first.line || '?'} ${first.kind || 'symbol'} ${row.name}${first.container ? ` (${first.container})` : ''} · ${row.definitions.length} definicji`);
          }
          return done(0);
        }
        if (action === 'bugs') {
          ensure();
          const rows = index.bugs({ file: rest[1] || null, limit: args.max || 100 });
          if (args.json) console.log(JSON.stringify(rows, null, 2));
          else for (const row of rows) console.log(`  ${row.file}:${row.line} ${row.severity} ${row.rule} · ${row.message}`);
          return done(0);
        }
        if (action === 'impact') {
          if (!rest[1]) { console.error(red('użycie: sentinel coding impact <file|symbol>')); return done(4); }
          ensure();
          const result = index.impact(rest[1].includes('/') || rest[1].includes('.') ? { file: rest[1], depth: Number(args.depth) || 3 } : { symbol: rest[1], depth: Number(args.depth) || 3 });
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(bold('wpływ zmiany'));
            for (const file of result.files || []) console.log(`  ${file.relative || file.file || file}`);
            console.log(dim(`  ${result.count === undefined ? (result.files || []).length : result.count} plik(ów)`));
          }
          return done(0);
        }
        if (action === 'rename') {
          if (!rest[1] || !args.to) { console.error(red('użycie: sentinel coding rename <symbol> --to <new-name> [--apply --approval <hash> --by <osoba>]')); return done(4); }
          ensure();
          try {
            const proposal = engine.rename({ symbol: rest[1], to: args.to, limit: args.max || 500 });
            if (!proposal.ok) { console.error(red(`weryfikacja nie powiodła się: ${JSON.stringify(proposal.verification)}`)); return done(4); }
            if (!args.apply) {
              if (args.json) console.log(JSON.stringify(proposal, null, 2));
              else {
                console.log(green(`✓ propozycja: ${proposal.files} plik(ów), ${proposal.replacements} zamian`));
                console.log(`  hash zatwierdzenia: ${proposal.approvalHash}`);
                console.log(dim('  zastosowanie: powtórz z --apply --approval <hash> --by <osoba>'));
              }
              return done(0);
            }
            const applied = engine.apply(proposal.patches, { approvedBy: args.by || 'cli', approvalHash: args.approval });
            if (args.json) console.log(JSON.stringify(applied, null, 2));
            else if (applied.ok) console.log(green(`✓ zastosowano w ${applied.files.join(', ')}`));
            else console.error(red(`${applied.code}: ${applied.message || ''}`));
            return done(applied.ok ? 0 : 4);
          } catch (err) { console.error(red(err.message)); return done(4); }
        }
        console.error(red(`nieznana akcja coding: ${action}`));
        return done(4);
      }

      case 'training': {
        const tl = agent.trainingLab;
        const action = rest[0] || 'status';
        if (action === 'status') {
          const status = tl.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('laboratorium treningu (CPU)'));
            console.log(`  datasety: ${status.datasets.length} · adaptery: ${status.adapters.length} · aktywny: ${status.activeAdapter ? status.activeAdapter.id : 'brak'}`);
            console.log(`  kolejka: ${status.queue.counts.queued} czeka, ${status.queue.counts.running} działa, ${status.queue.counts.failed} błędów`);
            for (const adapter of status.adapters.slice(0, 8)) console.log(`  ${adapter.kind.padEnd(10)} ${adapter.id} ${adapter.metrics ? JSON.stringify(adapter.metrics) : 'bez metryk'}`);
            console.log(dim(`  ${status.scope}`));
          }
          return done(0);
        }
        if (action === 'dataset') {
          const name = rest[1];
          const file = rest[2];
          if (!name || !file) { console.error(red('użycie: sentinel training dataset <nazwa> <plik.jsonl>')); return done(4); }
          if (!require('node:fs').existsSync(file)) { console.error(red(`nie ma pliku ${file}`)); return done(4); }
          const rows = require('node:fs').readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
          const created = tl.createDataset({ name, rows, source: file, personalData: Boolean(args.personal), approvedBy: args.approve || null });
          console.log(green(`✓ ${created.name} v${created.version}: ${created.rows} wierszy, sha256 ${created.sha256.slice(0, 16)}…`));
          return done(0);
        }
        if (action === 'datasets') {
          const rows = tl.listDatasets();
          if (args.json) console.log(JSON.stringify(rows, null, 2));
          else for (const row of rows) console.log(`  ${row.name} v${row.version} · ${row.rows} wierszy · ${row.sha256.slice(0, 12)}…${row.personalData ? ' · dane osobowe' : ''}`);
          return done(0);
        }
        if (action === 'lora' || action === 'qlora') {
          if (!rest[1]) { console.error(red(`użycie: sentinel training ${action} <dataset> [--rank 2] [--max 120]`)); return done(4); }
          const result = action === 'lora'
            ? tl.trainLora({ dataset: rest[1], rank: args.rank || 2, epochs: args.max || 120, sourceDataset: args.source || null })
            : tl.trainQlora({ dataset: rest[1], rank: args.rank || 2, epochs: args.max || 120, sourceDataset: args.source || null });
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(green(`✓ ${result.adapter.id}`));
            console.log(`  adaptacja: ${result.evaluation.adapted.accuracy} vs zamrożona baza ${result.evaluation.frozen.accuracy} · trenowalne ${result.trainableParameters}`);
            if (result.quantization) console.log(`  4-bit: błąd W1 ${result.quantization.w1RelativeError}, W2 ${result.quantization.w2RelativeError}`);
          }
          return done(0);
        }
        if (action === 'distill') {
          if (!rest[1]) { console.error(red('użycie: sentinel training distill <dataset>')); return done(4); }
          const result = tl.distill({ dataset: rest[1], epochs: args.max || 100 });
          console.log(green(`✓ destylacja: ${result.distilled.evaluation.accuracy} vs ${result.plain.evaluation.accuracy} (nauczyciel ${result.teacher.evaluation.accuracy})`));
          console.log(dim(`  adapter ${result.adapter.id}`));
          return done(0);
        }
        if (action === 'preference') {
          const result = tl.preference({ count: args.max || 120, epochs: 80 });
          console.log(green(`✓ preferencje: ${result.test.accuracy} (baseline ${result.baseline.accuracy}, delta ${result.delta})`));
          return done(0);
        }
        if (action === 'gpt') {
          const text = rest.slice(1).join(' ');
          if (!text) { console.error(red('użycie: sentinel training gpt <tekst treningowy>')); return done(4); }
          const result = tl.trainGpt({ texts: [text], epochs: args.max || 8, name: args.name || 'cli' });
          console.log(green(`✓ loss ${result.report.final.trainLoss.toFixed(4)} · perplexity ${result.report.final.trainPerplexity.toFixed(2)}`));
          console.log(`  checkpoint ${result.checkpoint.file} (${result.checkpoint.sha256.slice(0, 16)}…)`);
          console.log(`  próbka: ${result.sample.text.slice(0, 120)}`);
          return done(0);
        }
        if (action === 'hpo') {
          if (!rest[1]) { console.error(red('użycie: sentinel training hpo <dataset>')); return done(4); }
          const result = tl.hpo({ dataset: rest[1], budget: args.max || 4 });
          console.log(result.ok ? green(`✓ najlepsze ${JSON.stringify(result.best.params)} → ${result.best.score}`) : red('brak trafień'));
          for (const trial of result.trials) console.log(`  ${JSON.stringify(trial.params)} → ${trial.ok ? trial.score : trial.error.code} (${trial.durationMs} ms)`);
          return done(0);
        }
        if (action === 'adapters') {
          const rows = tl.listAdapters({ limit: 30 });
          if (args.json) console.log(JSON.stringify(rows, null, 2));
          else for (const adapter of rows) console.log(`  ${adapter.active ? '●' : '○'} ${adapter.id} · ${adapter.kind} · ${adapter.metrics ? JSON.stringify(adapter.metrics) : 'bez metryk'}`);
          return done(0);
        }
        if (action === 'compare') {
          const ids = rest.slice(1);
          if (ids.length < 2) { console.error(red('użycie: sentinel training compare <id> <id>')); return done(4); }
          const result = tl.compareAdapters(ids);
          console.log(args.json ? JSON.stringify(result, null, 2) : `najlepszy: ${result.best}`);
          return done(result.ok ? 0 : 4);
        }
        if (action === 'promote' || action === 'rollback') {
          if (!args.approve) { console.error(red(`${action} wymaga --approve <imię>`)); return done(4); }
          const result = action === 'promote' ? tl.promoteAdapter(rest[1], { approvedBy: args.approve }) : tl.rollbackAdapter({ approvedBy: args.approve, to: rest[1] || null });
          if (!result.ok) { console.error(red(`✗ ${result.code}: ${result.message || ''}`)); return done(4); }
          console.log(green(`✓ aktywny: ${result.active.id}`));
          return done(0);
        }
        if (action === 'queue') {
          const status = tl.queueStatus();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(`${status.counts.queued} czeka · ${status.counts.running} działa · ${status.counts.succeeded} gotowych · ${status.counts.failed} błędów · ${status.counts.cancelled} anulowanych`);
            for (const job of status.recent) console.log(`  ${job.id} ${job.kind} ${job.status} ${job.checkpoint ? `checkpoint ${job.checkpoint}` : ''}`);
          }
          return done(0);
        }
        if (action === 'cancel') {
          if (!rest[1]) { console.error(red('użycie: sentinel training cancel <id>')); return done(4); }
          const result = tl.cancel(rest[1]);
          console.log(result.ok ? green(`✓ ${result.status}`) : red(result.code));
          return done(result.ok ? 0 : 4);
        }
        console.error(red(`nieznana akcja training: ${action}`));
        return done(4);
      }

      case 'research': {
        const action = rest[0] || 'list';
        if (action === 'list') {
          const status = agent.research.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(`${status.sessions} sesji, ${status.sources} źródeł`);
            for (const session of agent.research.list({ limit: 20 })) console.log(`  ${session.id} · ${session.status} · ${session.sources} źródeł · ${session.question}`);
          }
          return done(0);
        }
        if (action === 'start') {
          const question = rest.slice(1).join(' ');
          if (!question) {
            console.error(red('użycie: sentinel research start <pytanie>'));
            return done(4);
          }
          const started = agent.research.start({ question, online: Boolean(args.approve && args.online), approvedBy: args.approve || null });
          if (!started.ok) {
            console.error(red(`✗ ${started.code}: ${started.message || ''}`));
            return done(4);
          }
          console.log(green(`✓ ${started.session.id}`));
          for (const item of started.session.subquestions) console.log(`  ${item.id}: ${item.question}`);
          return done(0);
        }
        if (action === 'add') {
          if (!rest[1] || !rest[2]) {
            console.error(red('użycie: sentinel research add <id> <plik-w-workspace>'));
            return done(4);
          }
          const added = agent.research.addSource(rest[1], { file: path.resolve(rest.slice(2).join(' ')) });
          if (!added.ok) {
            console.error(red(`✗ ${added.code}: ${added.message || ''}`));
            return done(4);
          }
          console.log(green(`✓ ${added.source.title}: ${added.source.lines} linii`));
          return done(0);
        }
        if (action === 'report') {
          const report = agent.research.synthesize(rest[1]);
          if (!report.ok) {
            console.error(red(`✗ ${report.code}: ${report.message || ''}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(report.structured, null, 2));
          else process.stdout.write(report.report);
          return done(0);
        }
        console.error(red(`nieznana akcja research: ${action}`));
        return done(4);
      }

      case 'hypercore': {
        const action = rest[0] || 'status';
        if (action === 'status') {
          const status = agent.hypercore.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('cognitive hypercore'));
            console.log(`  cele ${status.counts.goals} (aktywne ${status.counts.activeGoals}) · przekonania ${status.counts.beliefs} · hipotezy ${status.counts.hypotheses} · sprzeczności ${status.counts.openConflicts}`);
            console.log(`  budżet: ${status.budgets.contextTokens} tokenów, ${status.budgets.toolCalls} narzędzi, głębokość ${status.budgets.reasoningDepth}`);
            for (const item of status.nextAttention) console.log(`  uwaga ${item.weight}: ${item.kind} — ${item.label}`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'goals') {
          const goals = agent.hypercore.inspect('goal').items;
          if (args.json) console.log(JSON.stringify(goals, null, 2));
          else for (const goal of goals) console.log(`${goal.id} · ${goal.status} · p${goal.priority} · ${goal.description}`);
          return done(0);
        }
        if (action === 'conflicts') {
          const conflicts = agent.hypercore.inspect('conflict').items.filter((conflict) => conflict.status === 'open');
          if (args.json) console.log(JSON.stringify(conflicts, null, 2));
          else {
            if (!conflicts.length) console.log('brak otwartych sprzeczności');
            for (const conflict of conflicts) console.log(`${conflict.id} · ${conflict.key}: ${JSON.stringify(conflict.left.value)} vs ${JSON.stringify(conflict.right.value)} (nie rozwiązano)`);
          }
          return done(0);
        }
        if (action === 'focus') {
          const result = agent.hypercore.focus({ tokenBudget: args.budget || 1024, reason: 'cli' });
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else {
            for (const item of result.items) console.log(`${item.kind} ${item.weight} · ${item.label}`);
            console.log(dim(`  ~${result.trace.estimatedTokens} tokenów (szacunek), pominięto ${result.trace.dropped}`));
          }
          return done(0);
        }
        console.error(red(`nieznana akcja hypercore: ${action}`));
        return done(4);
      }

      case 'sentiment': {
        const action = rest[0] || 'status';
        if (action === 'status') {
          const status = agent.lab.sentimentStatus();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('kompaktowy transformer — sentyment'));
            console.log(`  dataset: ${status.dataset.items} zdań, ${status.dataset.labels.length} klas (${status.dataset.provenance})`);
            console.log(`  aktywne: ${status.active ? `test ${status.active.metrics.accuracy} vs baseline ${status.active.baseline.accuracy}, N=${status.active.metrics.cases}` : 'brak'}`);
            for (const experiment of status.experiments.slice(0, 5)) console.log(`  ${experiment.id} · ${experiment.status} · test ${experiment.accuracy} vs ${experiment.baseline} · gate ${experiment.gate.passed}`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'train') {
          if (!args.approve) {
            console.error(red('trening wymaga: sentinel sentiment train --approve <imię>'));
            return done(4);
          }
          console.log(dim('  trenuję jednoblokowy transformer na CPU; to nie jest model językowy'));
          const result = agent.lab.trainSentiment({ approvedBy: args.approve, epochs: args.max || 8 });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result.experiment, null, 2));
          else {
            console.log(green(`✓ ${result.experiment.id} · test ${result.experiment.metrics.accuracy} vs baseline ${result.experiment.baseline.accuracy}`));
            console.log(`  ${result.experiment.metrics.cases} przypadków testowych, macro-F1 ${result.experiment.metrics.macroF1}, epoki ${result.experiment.training.history.length}`);
            console.log(dim(`  checkpoint: ${result.experiment.artifact.path}; promocja: sentinel sentiment promote <id> --approve <imię>`));
          }
          return done(0);
        }
        if (action === 'promote') {
          if (!args.approve) {
            console.error(red('promocja wymaga --approve <imię>'));
            return done(4);
          }
          const result = agent.lab.promoteSentiment(rest[1], { approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          console.log(green(`✓ aktywny transformer: ${result.active.experimentId}`));
          return done(0);
        }
        if (action === 'classify') {
          const text = rest.slice(1).join(' ');
          if (!text) {
            console.error(red('użycie: sentinel sentiment classify <tekst>'));
            return done(4);
          }
          const result = agent.lab.classifySentiment(text);
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${result.label} ${dim(`(pewność ${result.probabilities[0].probability})`)}`);
          return done(0);
        }
        console.error(red(`nieznana akcja sentiment: ${action}`));
        return done(4);
      }

      case 'specialists': {
        const action = rest[0] || 'status';
        const tasks = ['tools', 'routing', 'relevance', 'complexity', 'semantic', 'context', 'failure'];
        if (action === 'status') {
          const status = agent.specialists.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('specjaliści 7.0'));
            for (const entry of status.specialists) {
              const active = entry.active ? `${entry.active.metrics.accuracy} vs baseline ${entry.active.baseline.accuracy}` : 'brak aktywnego modelu';
              console.log(`  ${entry.task.padEnd(16)} ${String(entry.dataset.items).padStart(4)} przykładów · ${entry.labels.length} klas · ${active}`);
            }
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'train') {
          if (!args.approve) {
            console.error(red('trening wymaga: sentinel specialists train <tools|routing|relevance|complexity> --approve <imię>'));
            return done(4);
          }
          const task = rest[1] || 'tools';
          if (!tasks.includes(task)) {
            console.error(red(`nieznany specjalista: ${task}`));
            return done(4);
          }
          const result = agent.specialists.train(task, { approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result.experiment, null, 2));
          else {
            console.log(green(`✓ ${result.experiment.id} · dokładność ${result.experiment.metrics.accuracy} vs baseline ${result.experiment.baseline.accuracy}`));
            console.log(dim(`  bramka: ${result.experiment.gate.passed ? 'zaliczona' : 'odrzucona'}; promocja: sentinel specialists promote ${task} ${result.experiment.id} --approve <imię>`));
          }
          return done(0);
        }
        if (action === 'promote') {
          if (!args.approve) {
            console.error(red('promocja wymaga --approve <imię>'));
            return done(4);
          }
          const task = rest[1];
          const id = rest[2];
          if (!task || !id) {
            console.error(red('użycie: sentinel specialists promote <zadanie> <id> --approve <imię>'));
            return done(4);
          }
          const result = agent.specialists.promote(task, id, { approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          console.log(green(`✓ aktywny model ${task}: ${result.active.experimentId}`));
          return done(0);
        }
        if (action === 'similarity' || action === 'context') {
          const query = rest[1];
          const passage = rest.slice(2).join(' ');
          if (!query || !passage) {
            console.error(red(`użycie: sentinel specialists ${action} <pytanie> <fragment>`));
            return done(4);
          }
          const result = action === 'similarity'
            ? agent.specialists.semanticSimilarity({ query, passage })
            : agent.specialists.contextImportance({ query, chunk: passage });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${blue(result.label)} ${dim(`pewność ${result.confidence} · kalibracja T=${result.temperature}`)}`);
          return done(0);
        }
        if (action === 'failure') {
          const result = agent.specialists.failureRisk({ permission: rest[1] || 'read', requiresNetwork: rest.includes('--network'), recentFailures: Number(rest[2]) || 0 });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${blue(result.label)} ${dim(`pewność ${result.confidence} · kalibracja T=${result.temperature}`)}`);
          return done(0);
        }
        if (action === 'predict') {
          const task = rest[1] || 'tools';
          const text = rest.slice(2).join(' ');
          if (!text) {
            console.error(red('użycie: sentinel specialists predict <tools|routing|complexity> <tekst>'));
            return done(4);
          }
          const result = task === 'complexity' ? agent.specialists.complexity(text) : task === 'relevance' ? { ok: false, code: 'BAD_INPUT', message: 'użyj narzędzia specialists.predict z polem memory' } : agent.specialists.predict(task, text);
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${blue(result.label)} ${dim(`pewność ${result.confidence}${result.usedFallback ? ' · baseline' : ''}`)}`);
          return done(0);
        }
        console.error(red(`nieznana akcja specialists: ${action}`));
        return done(4);
      }

      case 'reranker': {
        const action = rest[0] || 'status';
        if (action === 'status') {
          const status = agent.reranker.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(bold('reranker retrieval'));
            console.log(`  dataset: ${status.dataset.candidates} par z ${status.dataset.cases} pytań (${status.dataset.provenance})`);
            console.log(`  aktywne: ${status.active ? `NDCG@3 ${status.active.metrics.ndcgAt3} vs baseline ${status.active.baseline.ndcgAt3}` : 'brak'}`);
            for (const experiment of status.experiments.slice(0, 5)) console.log(`  ${experiment.id} · ${experiment.status} · NDCG ${experiment.ndcgAt3} vs ${experiment.baseline} · gate ${experiment.gate.passed}`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'train') {
          if (!args.approve) {
            console.error(red('trening wymaga: sentinel reranker train --approve <imię>'));
            return done(4);
          }
          const result = agent.reranker.train({ approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result.experiment, null, 2));
          else {
            console.log(green(`✓ ${result.experiment.id} · NDCG@3 ${result.experiment.metrics.ndcgAt3} vs baseline ${result.experiment.baseline.ndcgAt3}`));
            console.log(dim(`  bramka: ${result.experiment.gate.passed ? 'zaliczona' : 'odrzucona'}; promocja: sentinel reranker promote <id> --approve <imię>`));
          }
          return done(0);
        }
        if (action === 'promote') {
          if (!args.approve) {
            console.error(red('promocja wymaga --approve <imię>'));
            return done(4);
          }
          const result = agent.reranker.promote(rest[1], { approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          console.log(green(`✓ aktywny reranker: ${result.active.experimentId}`));
          return done(0);
        }
        if (action === 'rerank') {
          const query = rest[1];
          const candidates = rest.slice(2);
          if (!query || !candidates.length) {
            console.error(red('użycie: sentinel reranker rerank "<pytanie>" "<kandydat1>" "<kandydat2>"'));
            return done(4);
          }
          const result = agent.reranker.rerank({ query, candidates });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else for (const [index, entry] of result.ranked.entries()) console.log(`${index + 1}. ${entry.score} · ${entry.doc}`);
          return done(0);
        }
        console.error(red(`nieznana akcja reranker: ${action}`));
        return done(4);
      }

      case 'comm':
      case 'communication': {
        const action = rest[0] || 'status';
        if (action === 'status') {
          const status = agent.communication.status();
          if (args.json) console.log(JSON.stringify(status, null, 2));
          else {
            console.log(`provider: ${status.provider.name} · live: ${status.liveCalls} · enabled: ${status.enabled}`);
            console.log(`  dzisiaj: ${status.today.calls} połączeń, ${status.today.messages} wiadomości, ~${status.today.estimatedCost} USD`);
            for (const entry of agent.communication.history.slice(-10)) console.log(`  ${entry.id} · ${entry.channel} · ${entry.status}${entry.simulated ? ' (symulacja)' : ''}`);
            console.log(dim(`  ${status.honest}`));
          }
          return done(0);
        }
        if (action === 'consent') {
          const destination = rest[1];
          if (!destination) {
            console.error(red('użycie: sentinel comm consent <+48...>'));
            return done(4);
          }
          const result = agent.communication.requestConsent({ destination, reason: rest.slice(2).join(' ') || 'cli' });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          console.log(green(`✓ zgoda wymagana: ${result.consent.token}`));
          console.log(dim(`  zatwierdź: sentinel comm grant ${result.consent.token} --approve <twoje-imie>`));
          return done(0);
        }
        if (action === 'grant') {
          if (!args.approve) {
            console.error(red('zgoda wymaga --approve <twoje-imie>'));
            return done(4);
          }
          const result = agent.communication.grantConsent(rest[1], { approvedBy: args.approve });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          console.log(green(`✓ zgoda dla ${result.consent.destination} do ${new Date(result.consent.expiresAt).toISOString()}`));
          return done(0);
        }
        if (action === 'call' || action === 'sms') {
          const destination = rest[1];
          const text = rest.slice(2).join(' ');
          if (!destination || !text || !args.consent) {
            console.error(red(`użycie: sentinel comm ${action} <+48...> "<tekst>" --consent <token>`));
            return done(4);
          }
          const result = action === 'call'
            ? await agent.communication.call({ to: destination, message: text, consentToken: args.consent })
            : await agent.communication.sendSms({ to: destination, text, consentToken: args.consent });
          if (!result.ok) {
            console.error(red(`✗ ${result.code}: ${result.message}`));
            return done(4);
          }
          if (args.json) console.log(JSON.stringify(result, null, 2));
          else console.log(green(`✓ ${result.communication.status}${result.communication.simulated ? ' (symulacja)' : ''}`));
          return done(0);
        }
        console.error(red(`nieznana akcja comm: ${action}`));
        return done(4);
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
