import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createObservabilityService,
  ObservabilityError,
  observabilityContract,
} from '../modules/observability/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const REQUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESOURCE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function setup(options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'sf-observability-'));
  await chmod(directory, 0o700);
  let now = 1_700_000_000_000;
  const logs = [];
  const service = createObservabilityService({
    directory,
    clock: () => now,
    writeLog: record => logs.push(record),
    ...options,
  });
  return {
    directory,
    logs,
    service,
    setNow(value) {
      now = value;
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function context(tenantId = TENANT_A, requestId = REQUEST_A) {
  return { contractVersion: 1, tenantId, requestId };
}

function event(overrides = {}) {
  return {
    action: 'account.updated',
    outcome: 'success',
    resourceType: 'account',
    resourceId: RESOURCE_A,
    actorId: ACTOR_A,
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error =>
    error instanceof ObservabilityError && error.code === code);
}

test('emits structured logs with correlation IDs and drops sensitive and non-allowlisted fields', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);

  assert.equal(await fixture.service.log({
    level: 'info',
    event: 'request.completed',
    requestId: REQUEST_A,
    operation: 'account.read',
    status: 'ok',
    cookieHeader: 'cookie-sentinel',
    email: 'person@example.invalid',
    phone: '+12025550123',
    message: 'private message sentinel',
    operationDetail: 'private detail sentinel',
  }), true);
  assert.equal(fixture.logs.length, 1);
  assert.equal(fixture.logs[0].requestId, REQUEST_A);
  assert.equal(fixture.logs[0].redactedFields, 5);
  assert.doesNotMatch(JSON.stringify(fixture.logs), /cookie-sentinel|person@example|2025550123|private .*sentinel/u);

  await fixture.service.log({
    level: 'warn',
    event: 'request.invalid-correlation',
    requestId: 'private-user-name',
  });
  assert.match(fixture.logs[1].requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(observabilityContract.logging.redaction,
    'allowlisted-fields-only; sensitive-and-unknown-fields-dropped');
});

test('keeps liveness and readiness minimal when database or jobs checks fail', async t => {
  const fixture = await setup({
    checks: {
      database: async () => true,
      jobs: async () => { throw new Error('database password sentinel'); },
    },
  });
  t.after(fixture.dispose);

  assert.deepEqual(fixture.service.liveness(), { status: 'ok' });
  assert.deepEqual(await fixture.service.readiness(), {
    status: 'unavailable',
    checks: { database: 'ok', jobs: 'unavailable' },
  });
  assert.doesNotMatch(JSON.stringify(fixture.service.environmentDiagnostics()),
    /password|DATABASE_URL|sentinel/u);
  assert.deepEqual(Object.keys(fixture.service.environmentDiagnostics()).sort(),
    ['architecture', 'environment', 'nodeVersion', 'platform', 'uptimeSeconds']);
  assert.equal(fixture.service.metrics().counters.readiness_failures_total, 1);
});

test('times out dependency checks without exposing errors or secrets', async t => {
  const fixture = await setup({
    checks: { database: () => new Promise(() => {}) },
    limits: { checkTimeoutMs: 5 },
  });
  t.after(fixture.dispose);

  assert.deepEqual(await fixture.service.readiness(), {
    status: 'unavailable',
    checks: { database: 'unavailable' },
  });
});

test('tracks a bounded set of sanitized errors and metrics', async t => {
  const fixture = await setup({ limits: { maxRecentErrors: 2 } });
  t.after(fixture.dispose);

  fixture.service.recordError({ code: 'DATABASE_UNAVAILABLE', requestId: REQUEST_A });
  fixture.service.recordError({ code: 'cookie-sentinel', requestId: 'email@example.invalid' });
  fixture.service.recordError({ code: 'JOBS_UNAVAILABLE', requestId: REQUEST_B });
  const snapshot = fixture.service.metrics();

  assert.equal(snapshot.counters.errors_total, 3);
  assert.equal(snapshot.recentErrors.length, 2);
  assert.equal(snapshot.recentErrors[0].code, 'OTHER');
  assert.equal(snapshot.recentErrors[0].requestId.match(/^[0-9a-f-]{36}$/u)?.length, 1);
  assert.equal(snapshot.errorsByCode.OTHER, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /cookie-sentinel|email@example/u);
  assert.equal(snapshot.counters.requests_total, 0);
});

test('stores tenant-scoped append-only audit events in private files and checks read permission', async t => {
  const fixture = await setup({
    authorizeAuditRead: async readerContext => readerContext.tenantId === TENANT_A,
  });
  t.after(fixture.dispose);

  await fixture.service.audit.append(context(), event());
  await fixture.service.audit.append(context(TENANT_B, REQUEST_B), event({
    action: 'account.deleted',
  }));
  const records = await fixture.service.audit.read(context());
  assert.equal(records.length, 1);
  assert.equal(records[0].tenantId, TENANT_A);
  assert.equal(records[0].requestId, REQUEST_A);
  await expectCode(fixture.service.audit.read(context(TENANT_B, REQUEST_B)), 'AUDIT_READ_DENIED');
  await expectCode(fixture.service.audit.append(context(), event({
    resourceId: 'person@example.invalid',
  })), 'INVALID_INPUT');

  const auditDirectory = join(fixture.directory, 'audit');
  assert.equal((await stat(auditDirectory)).mode & 0o777, 0o700);
  const files = await readdir(auditDirectory);
  assert.equal(files.length, 1);
  assert.equal((await stat(join(auditDirectory, files[0]))).mode & 0o777, 0o600);
  const stored = await readFile(join(auditDirectory, files[0]), 'utf8');
  assert.doesNotMatch(stored, /cookie|email|person@example/u);
  assert.equal(fixture.service.metrics().counters.audit_events_total, 2);
});

test('rotates bounded audit files and applies retention during cleanup', async t => {
  const fixture = await setup({
    limits: {
      maxAuditFileBytes: 512,
      maxAuditFiles: 3,
      auditRetentionMs: 100,
    },
  });
  t.after(fixture.dispose);

  for (let index = 0; index < 8; index += 1) {
    await fixture.service.audit.append(context(), event());
  }
  const auditDirectory = join(fixture.directory, 'audit');
  let files = await readdir(auditDirectory);
  assert.ok(files.length <= 3);
  assert.ok(files.some(name => name === 'audit-current.jsonl'));
  assert.ok(files.some(name => name.startsWith('audit-') && name !== 'audit-current.jsonl'));

  fixture.setNow(1_700_000_000_200);
  await fixture.service.cleanup();
  files = await readdir(auditDirectory);
  assert.deepEqual(files, ['audit-current.jsonl']);
  assert.equal(fixture.service.metrics().counters.cleanup_runs_total, 1);
});

test('expires the active audit segment when every retained event is past its retention window', async t => {
  const fixture = await setup({
    authorizeAuditRead: async () => true,
    limits: { auditRetentionMs: 100 },
  });
  t.after(fixture.dispose);

  await fixture.service.audit.append(context(), event());
  fixture.setNow(1_700_000_000_200);
  await fixture.service.cleanup();

  assert.deepEqual(await fixture.service.audit.read(context()), []);
  assert.deepEqual(await readdir(join(fixture.directory, 'audit')), ['audit-current.jsonl']);
});

test('schedules cleanup as an idempotent jobs queue request without starting a worker', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const enqueued = [];
  const jobs = {
    async enqueue(input) {
      enqueued.push(input);
      return { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'queued' };
    },
  };

  const first = await fixture.service.scheduleCleanup({
    jobs,
    authorization: {
      cookieHeader: 'private-cookie-sentinel',
      tenantId: TENANT_A,
      requestId: REQUEST_A,
    },
    intervalMs: 60_000,
  });
  await fixture.service.scheduleCleanup({
    jobs,
    authorization: {
      cookieHeader: 'private-cookie-sentinel',
      tenantId: TENANT_A,
      requestId: REQUEST_A,
    },
    intervalMs: 60_000,
  });
  assert.deepEqual(first, {
    jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    status: 'queued',
  });
  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[0].idempotencyKey, enqueued[1].idempotencyKey);
  assert.equal(enqueued[0].type, 'observability.cleanup');
  assert.doesNotMatch(JSON.stringify(first), /cookie|sentinel/u);

  await expectCode(fixture.service.scheduleCleanup({
    jobs: { enqueue: async () => { throw new Error('private job failure sentinel'); } },
    authorization: {
      cookieHeader: 'private-cookie-sentinel',
      tenantId: TENANT_A,
      requestId: REQUEST_A,
    },
    intervalMs: 60_000,
  }), 'JOBS_UNAVAILABLE');
  assert.equal(fixture.service.createCleanupHandler instanceof Function, true);
});

test('fails closed when audit storage resolves through a symlink', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const outside = await mkdtemp(resolve(tmpdir(), 'sf-observability-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(fixture.directory, 'audit'));

  await expectCode(fixture.service.audit.append(context(), event()), 'UNSAFE_STORAGE');
  assert.deepEqual(await readdir(outside), []);
});
