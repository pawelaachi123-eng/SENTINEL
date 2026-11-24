#!/usr/bin/env node
'use strict';

/**
 * Measurements, not marketing.
 *
 * Everything here is executed on this machine in this run: boot, deterministic
 * answer latency, semantic interpretation, memory retrieval, graph traversal and
 * executor throughput. No tokens/s is reported because no model is called — the
 * providers are disabled so the numbers describe the deterministic core and
 * cannot be mistaken for inference benchmarks.
 *
 * Output: docs/bench-4.0.json and a short table on stdout.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../core/agent');
const { Executor } = require('../core/executor');
const { TaskManager } = require('../core/tasks');
const { ApprovalQueue } = require('../core/security/approvals');
const { EventBus } = require('../core/events');

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

async function time(fn, iterations = 1) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    const value = await fn(index);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    samples.push(ms);
    if (index === iterations - 1) return { samples, value };
  }
  return { samples, value: null };
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-bench-'));
  process.env.SENTINEL_HOME = home;
  const bootStart = process.hrtime.bigint();
  const agent = new Agent();
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;
  for (const name of ['ollama', 'lmstudio', 'llamacpp', 'external']) agent.config.set(`ai.providers.${name}.enabled`, false);
  agent.llm.buildProviders();
  const report = {
    version: require('../package.json').version,
    at: new Date().toISOString(),
    environment: {
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
      cores: os.cpus().length,
      memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      gpu: agent.runtime.hardware.gpu ? agent.runtime.hardware.gpu.name : 'not detected in this sandbox',
      note: 'Linux container, no GPU passthrough. Windows figures must be measured on the target machine; these are not.',
    },
    measurements: {},
    limits: [],
  };
  try {
    report.measurements.boot = { ms: Number(bootMs.toFixed(1)), what: 'constructing the agent, opening the store and building subsystems' };

    const arithmetic = await time(async (index) => {
      const questions = ['ile to 6*7', '2+2*2', 'pierwiastek z 144', '15% ze 200', '100 / 8'];
      return agent.brain.ask({ text: questions[index % questions.length], mode: 'fast' });
    }, 10);
    report.measurements.arithmetic = {
      iterations: arithmetic.samples.length,
      p50: percentile(arithmetic.samples, 50),
      p95: percentile(arithmetic.samples, 95),
      max: percentile(arithmetic.samples, 100),
      what: 'full brain.ask through routing, the mathematics agent and math.eval; providers disabled',
      example: arithmetic.value && arithmetic.value.text,
    };

    const semantics = await time(async (index) => {
      const texts = ['jaki jest stauts systemu', 'a co z procesorem?', 'wyłącz komputer', 'gdzie jest plik konfiguracji', 'what is the weather'];
      return agent.semantics.interpret({ text: texts[index % texts.length], mode: 'fast', history: [] });
    }, 60);
    report.measurements.semantics = {
      iterations: semantics.samples.length,
      p50: percentile(semantics.samples, 50),
      p95: percentile(semantics.samples, 95),
      what: 'deterministic interpretation only (spelling, language, references); model pass is skipped without a provider',
    };

    const filler = 'notatka o projekcie Atlas i konfiguracji sytemu na komputerze z RTX 4060 Ti';
    for (let index = 0; index < 150; index += 1) {
      agent.memory.remember({ text: `${filler} numer ${index}`, kind: 'episodic', scope: 'bench' });
    }
    for (let index = 0; index < 40; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await agent.knowledge.indexText({ title: `Dokument ${index}`, text: `${filler} treść dokumentu ${index}`, source: `bench-${index}` });
    }
    const recall = await time(() => agent.memory.recall('konfiguracja Atlas RTX', { limit: 5 }), 30);
    const retrieval = await time(() => agent.knowledge.search('konfiguracja Atlas RTX', { limit: 5 }), 30);
    report.measurements.memory = {
      records: 150,
      p50: percentile(recall.samples, 50),
      p95: percentile(recall.samples, 95),
      what: 'written to a temporary store in this run, then recalled 30 times',
    };
    report.measurements.retrieval = {
      documents: 40,
      p50: percentile(retrieval.samples, 50),
      p95: percentile(retrieval.samples, 95),
      what: 'knowledge search over 40 generated documents; lexical + hashed embeddings, not a model',
    };

    for (let index = 0; index < 200; index += 1) {
      const node = agent.graph.upsertNode({ type: 'concept', label: `bench node ${index}`, source: 'bench' });
      if (index > 0) {
        const previous = agent.graph.find(`bench node ${index - 1}`);
        if (previous) agent.graph.link(previous, node, 'related', { source: 'bench' });
      }
    }
    const graph = await time(() => agent.graph.contextFor('bench node 42', { limit: 6, depth: 2 }), 40);
    report.measurements.graph = {
      nodes: agent.graph.stats().nodes,
      edges: agent.graph.stats().edges,
      p50: percentile(graph.samples, 50),
      p95: percentile(graph.samples, 95),
      what: '200-node chain, bounded two-hop expansion with seed matching',
    };

    const tasks = new TaskManager({ store: agent.store });
    const calls = [];
    const tools = {
      tools: new Map([['bench.echo', { name: 'bench.echo', permission: 'read' }]]),
      async execute(name, args) {
        calls.push({ name, args });
        return { ok: true, data: { echoed: args && args.n }, text: 'ok' };
      },
    };
    const executor = new Executor({
      tasks,
      dispatcher: { route: () => ({ primary: null }), createRuntime: (options) => ({ ...options, toolLog: [], results: {} }), runAgent: async () => ({ ok: true, text: '' }) },
      tools,
      approvals: new ApprovalQueue({ log: null }),
      agents: { agents: new Map() },
      events: new EventBus({ capacity: 50 }),
      log: null,
    });
    // A fresh task per iteration: re-running a finished task would measure the
    // early-exit path, not the executor.
    const execution = await time(() => {
      const task = tasks.create({ title: 'bench', steps: Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, title: `step ${index}`, tool: 'bench.echo', args: { n: index } })) });
      return executor.run(task.id);
    }, 5);
    report.measurements.executor = {
      stepsPerRun: 5,
      runs: execution.samples.length,
      p50: percentile(execution.samples, 50),
      p95: percentile(execution.samples, 95),
      status: [...tasks.tasks.values()].every((entry) => entry.status === 'done') ? 'done' : 'mixed',
      what: 'five read-only tool steps through the real DAG executor (persistence, transitions, batching)',
    };

    report.limits = [
      'No model was called; latency here is the deterministic core, not inference.',
      'Linux container without a GPU: VRAM figures must be measured on the target Windows machine.',
      'Memory and retrieval numbers use hashed embeddings, not nomic-embed-text.',
      'Boot time is a single construction, not a cold start of Windows services.',
    ];
    const target = path.join(__dirname, '..', 'docs', 'bench-4.0.json');
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    for (const [name, value] of Object.entries(report.measurements)) {
      const latency = value.p50 !== undefined ? `p50 ${value.p50} ms, p95 ${value.p95} ms` : `${value.ms} ms`;
      console.log(`${name.padEnd(12)} ${latency}`);
    }
    console.log(`written: ${target}`);
    return 0;
  } finally {
    agent.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`benchmark failed: ${err.message}`);
    process.exitCode = 2;
  });
