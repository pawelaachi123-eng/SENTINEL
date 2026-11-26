'use strict';

/**
 * Executive engine checks: bounded concurrency, priorities, deadlines, retries,
 * idempotency, durable workflow recovery, replanning, budgets and STOP.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkerPool, WorkflowEngine, Executive } = require('../core/executive');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-executive-'));
const results = [];
async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await test('a worker pool executes jobs and exposes bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const pool = new WorkerPool({
      dataDir: path.join(root, 'pool-basic'),
      size: 2,
      handlers: {
        work: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(30);
          active -= 1;
          return { ok: true };
        },
      },
    });
    pool.start();
    const jobs = Array.from({ length: 6 }, () => pool.submit({ kind: 'work' }));
    await Promise.all(jobs.map((job) => pool.wait(job.id)));
    assert.equal(peak, 2);
    assert.equal(pool.list({ status: 'succeeded' }).length, 6);
    await pool.stop();
    return `peak concurrency ${peak}`;
  });

  await test('priority and age determine the next queued job', async () => {
    const pool = new WorkerPool({ dataDir: path.join(root, 'pool-priority'), handlers: { work: async () => true } });
    const low = pool.submit({ kind: 'work', priority: 9 });
    const high = pool.submit({ kind: 'work', priority: 1 });
    const middle = pool.submit({ kind: 'work', priority: 5 });
    assert.equal(pool.next().id, high.id);
    pool.jobs.get(high.id).status = 'succeeded';
    assert.equal(pool.next().id, middle.id);
    pool.jobs.get(middle.id).status = 'succeeded';
    assert.equal(pool.next().id, low.id);
    return 'priority 1 before 5 before 9';
  });

  await test('idempotency keys deduplicate work across a restart', async () => {
    const directory = path.join(root, 'pool-idempotent');
    const pool = new WorkerPool({ dataDir: directory, handlers: { work: async () => ({ value: 7 }) } });
    pool.start();
    const first = pool.submit({ kind: 'work', idempotencyKey: 'same-request' });
    await pool.wait(first.id);
    const duplicate = pool.submit({ kind: 'work', idempotencyKey: 'same-request' });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.deduplicated, true);
    const restarted = new WorkerPool({ dataDir: directory, handlers: { work: async () => ({ value: 8 }) } });
    const afterRestart = restarted.submit({ kind: 'work', idempotencyKey: 'same-request' });
    assert.equal(afterRestart.id, first.id);
    await pool.stop();
    return 'one execution, two callers';
  });

  await test('deadlines abort a running job and mark it cancelled', async () => {
    const pool = new WorkerPool({
      dataDir: path.join(root, 'pool-deadline'),
      handlers: {
        slow: async (payload, { signal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
        }),
      },
    });
    pool.start();
    const job = pool.submit({ kind: 'slow', deadlineMs: 30 });
    const finished = await pool.wait(job.id);
    assert.equal(finished.status, 'cancelled');
    assert.match(finished.error.message, /deadline/);
    await pool.stop();
    return 'aborted at 30 ms';
  });

  await test('retries stop at the configured budget', async () => {
    let attempts = 0;
    const pool = new WorkerPool({ dataDir: path.join(root, 'pool-retry'), retryBaseMs: 2, handlers: { fail: async () => { attempts += 1; throw Object.assign(new Error('nope'), { code: 'NOPE' }); } } });
    pool.start();
    const job = pool.submit({ kind: 'fail', maxRetries: 2 });
    const finished = await pool.wait(job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(attempts, 3);
    assert.equal(finished.error.code, 'NOPE');
    await pool.stop();
    return '3 attempts';
  });

  await test('a running row from a dead process is recovered, never left running', () => {
    const directory = path.join(root, 'pool-recover');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'executive-pool.json'), JSON.stringify({
      version: 1,
      counters: {},
      jobs: [{ id: 'job_dead', kind: 'work', payload: {}, status: 'running', priority: 5, createdAt: new Date().toISOString(), attempts: 1 }],
    }));
    const pool = new WorkerPool({ dataDir: directory, handlers: { work: async () => true } });
    const job = pool.jobs.get('job_dead');
    assert.equal(job.status, 'queued');
    assert.equal(job.recovered, true);
    return 'requeued';
  });

  await test('a DAG runs only after dependencies and records every step', async () => {
    const engine = new WorkflowEngine({ dataDir: path.join(root, 'wf-dag') });
    const workflow = engine.create({ name: 'dag', steps: [{ id: 'a', tool: '__keep' }, { id: 'b', tool: '__keep', dependsOn: ['a'] }, { id: 'c', tool: '__keep', dependsOn: ['b'] }] });
    const order = [];
    const result = await engine.run(workflow.id, { invoke: async (step) => { order.push(step.id); return step.id; } });
    assert.equal(result.status, 'done');
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.ok(result.steps.every((step) => step.status === 'done'));
    return order.join('→');
  });

  await test('cycles, duplicate ids and unknown dependencies are rejected', () => {
    const engine = new WorkflowEngine({});
    assert.throws(() => engine.create({ steps: [{ id: 'a', tool: 'x', dependsOn: ['b'] }, { id: 'b', tool: 'x', dependsOn: ['a'] }] }), /cycle/);
    assert.throws(() => engine.create({ steps: [{ id: 'a', tool: 'x' }, { id: 'a', tool: 'x' }] }), /duplicate/);
    assert.throws(() => engine.create({ steps: [{ id: 'a', tool: 'x', dependsOn: ['missing'] }] }), /unknown/);
    assert.throws(() => engine.create({ steps: [{ id: 'a' }] }), /nothing to execute/);
    return 'invalid DAGs refused';
  });

  await test('step retries and replanning replace downstream work', async () => {
    const engine = new WorkflowEngine({ dataDir: path.join(root, 'wf-replan') });
    const workflow = engine.create({ name: 'replan', steps: [{ id: 'a', tool: 'x' }, { id: 'b', tool: 'x', dependsOn: ['a'], maxRetries: 0 }], budget: { steps: 4, ms: 10000 } });
    let bAttempts = 0;
    const result = await engine.run(workflow.id, {
      invoke: async (step) => {
        if (step.id === 'b') {
          bAttempts += 1;
          if (bAttempts === 1) throw Object.assign(new Error('transient'), { code: 'TRANSIENT' });
        }
        return step.id;
      },
      replan: () => [{ id: 'b2', tool: 'x', dependsOn: ['a'] }],
    });
    assert.equal(result.status, 'done');
    assert.ok(result.steps.some((step) => step.id === 'b2' && step.status === 'done'));
    assert.equal(result.replans.length, 1);
    return 'replaced with b2';
  });

  await test('step and workflow budgets are enforced', async () => {
    const engine = new WorkflowEngine({ dataDir: path.join(root, 'wf-budget') });
    const workflow = engine.create({ name: 'budget', steps: [{ id: 'a', tool: 'x' }, { id: 'b', tool: 'x', dependsOn: ['a'] }], budget: { steps: 1, ms: 10000 } });
    const result = await engine.run(workflow.id, { invoke: async (step) => step.id });
    assert.notEqual(result.status, 'done');
    assert.ok(result.steps.some((step) => step.error && step.error.code === 'BUDGET_EXCEEDED') || result.status === 'failed');
    const timed = engine.create({ name: 'time', steps: [{ id: 'slow', tool: 'x', deadlineMs: 20 }], budget: { steps: 2, ms: 5000 } });
    const timeout = await engine.run(timed.id, { invoke: async (payload, context) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, 300); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); }); }) });
    assert.equal(timeout.status, 'failed');
    return 'step budget and step deadline';
  });

  await test('cancelling a workflow aborts running steps and keeps completed ones', async () => {
    const engine = new WorkflowEngine({ dataDir: path.join(root, 'wf-cancel') });
    const workflow = engine.create({ name: 'cancel', steps: [{ id: 'done', tool: 'x' }, { id: 'slow', tool: 'x', dependsOn: ['done'] }] });
    const running = engine.run(workflow.id, {
      invoke: async (step, context) => {
        if (step.id === 'slow') return new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); }); });
        return 'ok';
      },
    });
    await delay(20);
    engine.cancel(workflow.id);
    const result = await running;
    assert.equal(result.status, 'cancelled');
    const completed = result.steps.find((step) => step.id === 'done');
    assert.equal(completed.status, 'done');
    return 'completed step preserved';
  });

  await test('workflow state is durable and completed steps are not re-executed', async () => {
    const directory = path.join(root, 'wf-durable');
    const engine = new WorkflowEngine({ dataDir: directory });
    const workflow = engine.create({ name: 'durable', steps: [{ id: 'a', tool: 'x' }, { id: 'b', tool: 'x', dependsOn: ['a'] }] });
    let calls = 0;
    await engine.run(workflow.id, { invoke: async (step) => { calls += 1; return step.id; } });
    assert.equal(calls, 2);
    const restarted = new WorkflowEngine({ dataDir: directory });
    const loaded = restarted.get(workflow.id);
    assert.equal(loaded.status, 'done');
    const again = await restarted.run(workflow.id, { invoke: async (step) => { calls += 1; return step.id; } });
    assert.equal(calls, 2);
    assert.equal(again.status, 'done');
    return 'no duplicate execution';
  });

  await test('a crash mid-step resumes from the journal', async () => {
    const directory = path.join(root, 'wf-crash');
    const engine = new WorkflowEngine({ dataDir: directory });
    const workflow = engine.create({ name: 'crash', steps: [{ id: 'a', tool: 'x' }, { id: 'b', tool: 'x', dependsOn: ['a'] }] });
    engine.workflows.get(workflow.id).steps[0].status = 'running';
    engine.persist();
    const restarted = new WorkflowEngine({ dataDir: directory });
    const steps = restarted.get(workflow.id).steps;
    assert.equal(steps[0].status, 'ready');
    assert.equal(steps[0].recovered, true);
    const result = await restarted.run(workflow.id, { invoke: async (step) => step.id });
    assert.equal(result.status, 'done');
    return 'requeued and completed';
  });

  await test('STOP cancels worker jobs and workflows together', async () => {
    const executive = new Executive({ dataDir: path.join(root, 'exec-stop'), poolSize: 1 });
    executive.register('slow', async (payload, { signal }) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }); }));
    executive.start();
    const job = executive.submit({ kind: 'slow' });
    await delay(10);
    const workflow = executive.workflows.create({ name: 'stop', steps: [{ id: 'slow', tool: 'x' }] });
    const running = executive.workflows.run(workflow.id, { invoke: async (payload, context) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); }); }) });
    await delay(10);
    await executive.stop('STOP test');
    const [jobResult, workflowResult] = await Promise.allSettled([executive.pool.wait(job.id), running]);
    assert.equal(jobResult.status, 'fulfilled');
    assert.equal(jobResult.value.status, 'cancelled');
    assert.equal((workflowResult.status === 'fulfilled' ? workflowResult.value.status : executive.workflows.get(workflow.id).status), 'cancelled');
    return 'jobs and workflows cancelled';
  });

  await test('the executive status distinguishes queued, running and finished work', async () => {
    const executive = new Executive({ dataDir: path.join(root, 'exec-status'), poolSize: 1 });
    executive.register('noop', async () => ({ ok: true }));
    executive.start();
    const job = executive.submit({ kind: 'noop' });
    await executive.pool.wait(job.id);
    const status = executive.status();
    assert.equal(status.pool.counts.succeeded, 1);
    assert.match(status.honest, /no step is reported complete/);
    await executive.stop();
    return 'counts';
  });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} executive checks passed.`);
  if (failed.length) process.exitCode = 1;
})();
