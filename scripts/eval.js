#!/usr/bin/env node
'use strict';

/**
 * Evaluation runner.
 *
 *   node scripts/eval.js                 # deterministic core (no model, no network)
 *   node scripts/eval.js --live          # real provider; refuses if it is not healthy
 *   node scripts/eval.js --split heldout # one split only
 *   node scripts/eval.js --json out.json
 *
 * Deterministic mode disables every provider before anything runs, so a passing
 * result cannot be silently propped up by a local model. Live mode checks the
 * provider health first and exits 2 when nothing is available: an unexecuted
 * evaluation is reported as unexecuted, never as a pass.
 */

const fs = require('node:fs');
const { removeHome } = require('./lib/cleanup');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../core/agent');
const { EvaluationRunner, loadCases } = require('../core/evaluation');
const { looksSecret } = require('../core/memory/memory');

function parseArgs(argv) {
  const args = { live: false, split: 'all', json: null, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--split') args.split = argv[++index] || 'all';
    else if (arg === '--json') args.json = argv[++index] || null;
    else if (arg === '--limit') args.limit = Number(argv[++index]) || null;
    else if (arg === '--help') args.help = true;
  }
  return args;
}

function makeAsk(agent, live) {
  return async (entry) => {
    const input = String((entry.platformInput && entry.platformInput[process.platform]) || entry.input);
    switch (entry.adapter) {
      case 'tool': {
        if (!entry.tool) return { ok: false, text: 'tool case without a tool name' };
        const result = await agent.tools.execute(entry.tool, entry.args || {}, { source: 'eval' });
        const payload = result.data === undefined ? result : result.data;
        return { ok: Boolean(result.ok), text: JSON.stringify(payload), tools: [entry.tool], ms: result.ms };
      }
      case 'arithmetic': {
        if (!live) {
          // Deterministic arithmetic goes through the real brain; providers are
          // disabled, so a model cannot contribute.
          const answer = await agent.brain.ask({ text: entry.input, mode: 'fast' });
          return { ok: true, text: answer.text, tools: answer.tools || [], ms: answer.ms };
        }
        const answer = await agent.brain.ask({ text: entry.input, mode: 'balanced' });
        return { ok: true, text: answer.text, tools: answer.tools || [], ms: answer.ms };
      }
      case 'language': {
        const brief = await agent.semantics.interpret({ text: input, mode: 'fast', history: [] });
        return { ok: true, text: brief.language || 'unknown' };
      }
      case 'spelling': {
        const brief = await agent.semantics.interpret({ text: input, mode: 'fast', history: [] });
        return { ok: true, text: `${brief.resolvedText || ''} ${(brief.corrections || []).map((correction) => `${correction.from}->${correction.to}`).join(' ')}` };
      }
      case 'risk':
        return { ok: true, text: agent.cognitive.risk(input).level };
      case 'secret': {
        const found = looksSecret(input);
        return { ok: !found, text: found || 'no secret pattern', tools: [] };
      }
      case 'sandbox': {
        try {
          const resolved = agent.sandbox.resolve(input, { write: false });
          return { ok: true, text: resolved };
        } catch (err) {
          return { ok: true, text: `${err.code || 'BAD_PATH'} ${err.message}` };
        }
      }
      case 'toolPermission': {
        const tool = agent.tools.get(input);
        return { ok: Boolean(tool), text: tool ? tool.permission : 'unknown tool' };
      }
      case 'toolApproval': {
        const tool = agent.tools.get(input);
        return { ok: Boolean(tool), text: tool ? String(agent.tools.requiresApproval(tool.permission)) : 'deny' };
      }
      case 'semanticsKind': {
        const brief = await agent.semantics.interpret({ text: input, mode: 'fast', history: [] });
        return { ok: true, text: `${brief.strategy} ${brief.requestKind}` };
      }
      case 'semanticsRisk': {
        const brief = await agent.semantics.interpret({ text: input, mode: 'fast', history: [] });
        return { ok: true, text: brief.risk && brief.risk.level ? brief.risk.level : String(brief.risk) };
      }
      default:
        return { ok: false, text: `unknown adapter ${entry.adapter}` };
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/eval.js [--live] [--split all|train|heldout] [--limit N] [--json path]');
    return 0;
  }
  const cases = loadCases(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'cases.json'), 'utf8')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-eval-'));
  process.env.SENTINEL_HOME = home;
  const agent = new Agent();
  const mode = args.live ? 'live' : 'mock';
  try {
    if (args.live) {
      const health = await agent.llm.health({ force: true });
      const healthy = Object.values(health).filter((entry) => entry && entry.ok);
      if (!healthy.length) {
        console.error('live evaluation requested, but no provider is healthy. Nothing was evaluated.');
        return 2;
      }
    } else {
      // Hard-disable every provider: deterministic mode must not call a model.
      for (const name of ['ollama', 'lmstudio', 'llamacpp', 'external']) {
        agent.config.set(`ai.providers.${name}.enabled`, false);
      }
      agent.llm.buildProviders();
      agent.config.set('ai.offline', true);
    }
    const runner = new EvaluationRunner();
    const result = await runner.run({ cases, ask: makeAsk(agent, args.live), split: args.split, mode, label: 'core-cases', limit: args.limit });
    const output = { ...result, mode, label: args.live ? 'live agent' : 'deterministic core (providers disabled)' };
    console.log(`mode: ${mode} (${output.label})`);
    console.log(`cases: ${result.cases}, passed: ${result.passed}, failed: ${result.failed}, score: ${result.score}`);
    for (const entry of result.results.filter((row) => !row.ok)) console.log(`  ✗ ${entry.id}: ${entry.reasons.join('; ')}${entry.error ? ` (${entry.error})` : ''}`);
    console.log(`note: ${output.honest}`);
    if (args.json) {
      fs.mkdirSync(path.dirname(args.json), { recursive: true });
      fs.writeFileSync(args.json, `${JSON.stringify(output, null, 2)}\n`);
      console.log(`written: ${args.json}`);
    }
    return result.failed === 0 ? 0 : 1;
  } finally {
    await agent.stop?.();
    await removeHome(home, { agent });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`evaluation failed: ${err.message}`);
    process.exitCode = 3;
  });
