import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createJobsService, JobsModuleError, jobsContract } from '../modules/jobs/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'request-1',
});

function tenancy() {
  return {
    async resolveTenantContext(input) {
      const tenantId = input.cookieHeader === 'tenant-a' ? TENANT_A :
        input.cookieHeader === 'tenant-b' ? TENANT_B : null;
      if (!tenantId || input.tenantId !== tenantId) throw new Error('denied');
      return { contractVersion: 1, tenantId, requestId: input.requestId };
    },
  };
}

async function setup({ limits = {}, clock = () => Date.now(), notify } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'sf-jobs-'));
  await chmod(directory, 0o700);
  const service = createJobsService({ directory, tenancy: tenancy(), limits, clock, notify });
  return {
    directory,
    service,
    createService: options => createJobsService({
      directory, tenancy: tenancy(), limits, clock, ...options,
    }),
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function enqueueInput(overrides = {}) {
  return {
    ...auth(),
    type: 'report.generate',
    idempotencyKey: 'request-key-1',
    payload: { count: 2, options: { mode: 'local' } },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error =>
    error instanceof JobsModuleError && error.code === code);
}

test('persists jobs, enforces idempotency, and never starts work on enqueue', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  let executions = 0;
  const first = await fixture.service.enqueue(enqueueInput());
  assert.equal(first.status, 'queued');
  assert.equal(executions, 0);

  const restored = fixture.createService();
  const duplicate = await restored.enqueue(enqueueInput({
    payload: { options: { mode: 'local' }, count: 2 },
  }));
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(await restored.get({ ...auth(), jobId: first.id }), first);
  await expectCode(restored.enqueue(enqueueInput({ payload: { count: 3 } })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(jobsContract.version, 1);
  assert.equal(jobsContract.execution, 'explicit-start-only');
  assert.ok(await readFile(resolve(fixture.directory, 'jobs-v1.json'), 'utf8'));

  await restored.runOnce({ handlers: {
    'report.generate': async () => { executions += 1; },
  } });
  assert.equal(executions, 1);
  assert.equal((await restored.get({ ...auth(), jobId: first.id })).status, 'succeeded');
});

test('rejects invalid tenant access, sensitive payload fields, accessors, and oversize payloads', async t => {
  const fixture = await setup({ limits: { maxPayloadBytes: 64 } });
  t.after(fixture.dispose);
  await expectCode(fixture.service.enqueue(enqueueInput({
    extra: 'unknown',
  })), 'INVALID_INPUT');
  await expectCode(fixture.service.enqueue(enqueueInput({
    ...auth(TENANT_B),
    cookieHeader: 'tenant-a',
  })), 'TENANT_ACCESS_DENIED');
  await expectCode(fixture.service.enqueue(enqueueInput({
    payload: { access_token: 'synthetic-not-a-secret' },
  })), 'INVALID_PAYLOAD');
  await expectCode(fixture.service.enqueue(enqueueInput({
    payload: { content: 'x'.repeat(100) },
  })), 'PAYLOAD_TOO_LARGE');

  let getterCalled = false;
  const payload = {};
  Object.defineProperty(payload, 'value', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'unsafe';
    },
  });
  await expectCode(fixture.service.enqueue(enqueueInput({ payload })), 'INVALID_PAYLOAD');
  assert.equal(getterCalled, false);
  assert.deepEqual(await fixture.service.list(auth()), []);
});

test('isolates jobs and event notifications by authorized tenant without exposing payloads', async t => {
  const notified = [];
  const fixture = await setup({ notify: event => notified.push(event) });
  t.after(fixture.dispose);
  const jobA = await fixture.service.enqueue(enqueueInput());
  const jobB = await fixture.service.enqueue(enqueueInput({
    ...auth(TENANT_B),
    idempotencyKey: 'request-key-2',
    payload: { value: 'tenant-b' },
  }));
  await expectCode(fixture.service.get({ ...auth(TENANT_B), jobId: jobA.id }), 'NOT_FOUND');
  assert.deepEqual((await fixture.service.list(auth())).map(job => job.id), [jobA.id]);
  assert.deepEqual((await fixture.service.list(auth(TENANT_B))).map(job => job.id), [jobB.id]);
  const events = await fixture.service.events(auth());
  assert.equal(events.length, 1);
  assert.equal(Object.hasOwn(events[0], 'tenantId'), false);
  assert.equal(Object.hasOwn(events[0], 'payload'), false);
  assert.ok(notified.every(event => !Object.hasOwn(event, 'tenantId') &&
    !Object.hasOwn(event, 'payload')));
});

test('bounds retries with exponential backoff and emits sanitized failure events', async t => {
  let now = 1000;
  const fixture = await setup({
    clock: () => now,
    limits: { retryBaseMs: 20, retryMaxMs: 40 },
  });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput({ maxAttempts: 2 }));
  const handler = async () => {
    const error = new Error('sensitive driver message');
    error.code = 'SYNTHETIC_FAILURE';
    throw error;
  };
  await fixture.service.runOnce({ handlers: { 'report.generate': handler } });
  let current = await fixture.service.get({ ...auth(), jobId: job.id });
  assert.equal(current.status, 'queued');
  assert.equal(current.attempt, 1);
  assert.equal(current.errorCode, 'SYNTHETIC_FAILURE');
  assert.equal(current.availableAt, now + 20);
  assert.equal(await fixture.service.runOnce({ handlers: { 'report.generate': handler } }), false);

  now += 20;
  await fixture.service.runOnce({ handlers: { 'report.generate': handler } });
  current = await fixture.service.get({ ...auth(), jobId: job.id });
  assert.equal(current.status, 'failed');
  assert.equal(current.attempt, 2);
  assert.equal(current.errorCode, 'SYNTHETIC_FAILURE');
  const events = await fixture.service.events(auth());
  assert.ok(events.some(event => event.type === 'job.retrying'));
  assert.ok(events.some(event => event.type === 'job.failed'));
  assert.ok(!JSON.stringify(events).includes('sensitive driver message'));
});

test('requeues an expired lease after a simulated worker crash', async t => {
  let now = 5000;
  const fixture = await setup({ clock: () => now, limits: { leaseMs: 100 } });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput());
  const queuePath = resolve(fixture.directory, 'jobs-v1.json');
  const state = JSON.parse(await readFile(queuePath, 'utf8'));
  state.jobs[job.id].status = 'running';
  state.jobs[job.id].attempt = 1;
  state.jobs[job.id].lease = { token: randomUUID(), expiresAt: now + 1 };
  await writeFile(queuePath, JSON.stringify(state), { mode: 0o600 });
  now += 2;

  await fixture.service.runOnce({ handlers: {
    'report.generate': async ({ attempt }) => assert.equal(attempt, 2),
  } });
  const recovered = await fixture.service.get({ ...auth(), jobId: job.id });
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.attempt, 2);
  assert.ok((await fixture.service.events(auth())).some(event => event.type === 'job.retrying'));
});

test('fails closed on a corrupt queue file', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput());
  const queuePath = resolve(fixture.directory, 'jobs-v1.json');
  const state = JSON.parse(await readFile(queuePath, 'utf8'));
  state.jobs[job.id].status = 'unknown';
  await writeFile(queuePath, JSON.stringify(state), { mode: 0o600 });
  await expectCode(fixture.service.list(auth()), 'CORRUPT_QUEUE');
});

test('cancels queued and running work through tenant authorization', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const queued = await fixture.service.enqueue(enqueueInput());
  const cancelled = await fixture.service.cancel({ ...auth(), jobId: queued.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(await fixture.service.runOnce({ handlers: { 'report.generate': async () => assert.fail() } }),
    false);

  const running = await fixture.service.enqueue(enqueueInput({ idempotencyKey: 'running-job' }));
  let started;
  const hasStarted = new Promise(resolveStarted => { started = resolveStarted; });
  const work = fixture.service.runOnce({ handlers: {
    'report.generate': ({ signal }) => new Promise(resolveWork => {
      signal.addEventListener('abort', () => resolveWork(), { once: true });
      started();
    }),
  } });
  await hasStarted;
  await fixture.service.cancel({ ...auth(), jobId: running.id });
  await work;
  assert.equal((await fixture.service.get({ ...auth(), jobId: running.id })).status, 'cancelled');
});

test('enforces queue and cross-instance worker limits', async t => {
  const fixture = await setup({ limits: { maxQueueSize: 1, maxWorkers: 1 } });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput());
  await expectCode(fixture.service.enqueue(enqueueInput({ idempotencyKey: 'second' })), 'QUEUE_FULL');
  const secondWorker = fixture.createService();
  let finish;
  let started;
  const hasStarted = new Promise(resolveStarted => { started = resolveStarted; });
  const work = fixture.service.runOnce({ handlers: {
    'report.generate': () => new Promise(resolveWork => {
      finish = resolveWork;
      started();
    }),
  } });
  await hasStarted;
  assert.equal(await secondWorker.runOnce({ handlers: { 'report.generate': async () => {} } }), false);
  finish();
  await work;
  assert.equal((await fixture.service.get({ ...auth(), jobId: job.id })).status, 'succeeded');
});

test('serializes concurrent recovery of a stale filesystem lock', async t => {
  const fixture = await setup({ limits: { maxWorkers: 2 } });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput());
  await writeFile(resolve(fixture.directory, 'jobs-v1.lock'), JSON.stringify({
    pid: 2147483647,
    token: randomUUID(),
    createdAt: 0,
  }), { mode: 0o600 });
  const secondWorker = fixture.createService();
  let executions = 0;
  const release = [];
  const handler = () => {
    executions += 1;
    return new Promise(resolveWork => release.push(resolveWork));
  };
  const firstWork = fixture.service.runOnce({ handlers: { 'report.generate': handler } });
  const secondWork = secondWorker.runOnce({ handlers: { 'report.generate': handler } });
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal(executions, 1);
  for (const resolveWork of release) resolveWork();
  await Promise.all([firstWork, secondWork]);
  assert.equal((await fixture.service.get({ ...auth(), jobId: job.id })).status, 'succeeded');
});

test('signals timeouts and reports that CPU and memory budgets are advisory', async t => {
  const fixture = await setup({ limits: { maxTimeoutMs: 100, leaseMs: 100 } });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput({
    maxAttempts: 1,
    timeoutMs: 20,
    cpuBudgetMs: 1,
    memoryBudgetBytes: 1,
  }));
  let signalReceived = false;
  await fixture.service.runOnce({ handlers: {
    'report.generate': ({ signal, limits: receivedLimits }) => {
      assert.equal(receivedLimits.cpuMemoryEnforcedByOs, false);
      return new Promise(resolveWork => signal.addEventListener('abort', () => {
        signalReceived = true;
        resolveWork();
      }, { once: true }));
    },
  } });
  const failed = await fixture.service.get({ ...auth(), jobId: job.id });
  assert.equal(signalReceived, true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'JOB_TIMEOUT');
  assert.ok((await fixture.service.events(auth()))
    .some(event => event.type === 'job.resource-budget-exceeded'));
  assert.equal(jobsContract.limitEnforcement.cpuBudgetMs, 'process-wide-advisory');
  assert.equal(jobsContract.limitEnforcement.operatingSystemQuotaDetected, false);
});

test('rejects unsafe runtime bounds and prevents timestamp overflow', async t => {
  const fixture = await setup({
    clock: () => Number.MAX_SAFE_INTEGER - 1,
    limits: { leaseMs: 100 },
  });
  t.after(fixture.dispose);
  const job = await fixture.service.enqueue(enqueueInput());
  await expectCode(fixture.service.runOnce({ handlers: { 'report.generate': async () => {} } }),
    'TIME_RANGE');
  assert.equal((await fixture.service.get({ ...auth(), jobId: job.id })).status, 'queued');

  assert.throws(() => fixture.createService({ limits: { leaseMs: Number.MAX_SAFE_INTEGER } }),
    error => error instanceof JobsModuleError && error.code === 'INVALID_CONFIGURATION');
});
