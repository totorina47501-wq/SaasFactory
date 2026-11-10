import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBackup,
  DatabaseOperationsError,
  restoreBackup,
} from '../../modules/database-operations/index.mjs';
import { createJobsService, JobsModuleError } from '../../modules/jobs/index.mjs';
import { createObservabilityService } from '../../modules/observability/index.mjs';
import {
  createDeterministicTestEmbedder,
  createRagSearchService,
  RagSearchError,
} from '../../modules/rag-search/index.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = 'operations-exercise';
const connection = {
  host: '127.0.0.1',
  port: 55432,
  user: 'factory_test',
  password: 'synthetic-only-password',
  database: 'factory_test',
};
const migrations = {
  serverVersion: '16.15',
  core: [{ version: 1, id: '0001_synthetic', checksum: 'a'.repeat(64) }],
  modules: [],
};
const syntheticDatabase = {
  records: [{ id: 'record-1', value: 'synthetic-record' }],
};

function tenancy() {
  return {
    async resolveTenantContext(input) {
      if (input.cookieHeader !== 'synthetic-tenant' || input.tenantId !== TENANT_ID) {
        throw new Error('denied');
      }
      return { contractVersion: 1, tenantId: TENANT_ID, requestId: input.requestId };
    },
  };
}

function jobInput(overrides = {}) {
  return {
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    type: 'report.generate',
    idempotencyKey: 'restore-report',
    payload: { reportId: 'synthetic-report' },
    ...overrides,
  };
}

function jobAccessInput(jobId) {
  return {
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    jobId,
  };
}

function tenantInput() {
  return {
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
  };
}

function createSearchService(indexPath) {
  return createRagSearchService({
    tenancy: tenancy(),
    embedder: createDeterministicTestEmbedder({ dimensions: 8 }),
    authorizeDocument: async () => true,
    store: {
      async get(context, key) {
        try {
          const records = JSON.parse(await readFile(indexPath, 'utf8'));
          return records[`${context.tenantId}:${key}`];
        } catch (error) {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      },
      async put(context, key, value, expectedVersion) {
        let records = {};
        try {
          records = JSON.parse(await readFile(indexPath, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const storageKey = `${context.tenantId}:${key}`;
        const current = records[storageKey];
        if (current?.version !== expectedVersion) {
          const error = new Error('conflict');
          error.code = 'CONFLICT';
          throw error;
        }
        const version = (current?.version ?? 0) + 1;
        records[storageKey] = { value: structuredClone(value), version };
        await writeFile(indexPath, JSON.stringify(records), { mode: 0o600 });
        return version;
      },
    },
  });
}

function syntheticDocument() {
  const text = 'Synthetic recovery index record';
  const sha256 = createHash('sha256').update(text).digest('hex');
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceId: 'synthetic-guide',
    fileName: 'synthetic-guide.txt',
    format: 'txt',
    version: 1,
    sha256,
    text,
    pageCount: 1,
    createdAt: 1,
    chunks: [{
      index: 0,
      sourceId: 'synthetic-guide',
      fileName: 'synthetic-guide.txt',
      page: null,
      startOffset: 0,
      endOffset: text.length,
      sha256,
      text,
    }],
  };
}

function databaseRunner({ onCommand } = {}) {
  const calls = [];
  const restoredDatabases = new Map();
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (onCommand) {
      const result = await onCommand({ command, args, calls });
      if (result !== undefined) return result;
    }
    if (command === 'psql') return `${JSON.stringify(migrations)}\n`;
    if (command === 'pg_dump') {
      const destination = args.find(arg => arg.startsWith('--file=')).slice('--file='.length);
      await writeFile(destination, JSON.stringify(syntheticDatabase));
    }
    if (command === 'pg_restore' && args[0] === '--list') return 'synthetic archive';
    if (command === 'createdb') restoredDatabases.set(args.at(-1), null);
    if (command === 'pg_restore' && args.includes('--exit-on-error')) {
      const target = args[args.indexOf('--dbname') + 1];
      const archive = JSON.parse(await readFile(args.at(-1), 'utf8'));
      restoredDatabases.set(target, archive);
    }
    return '';
  };
  return { runner, calls, restoredDatabases };
}

async function setupDirectories(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-operations-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const jobs = path.join(app, 'jobs');
  const index = path.join(app, 'index');
  const logs = path.join(app, 'logs');
  await mkdir(app);
  await Promise.all([mkdir(jobs, { mode: 0o700 }), mkdir(index, { mode: 0o700 })]);
  return { root, app, jobs, index, logs };
}

async function copyAppState(app, destination) {
  await cp(app, destination, { recursive: true, errorOnExist: true, force: false });
}

test('backs up and restores the complete synthetic local app, rotated logs, pending jobs and search index', async t => {
  const started = process.hrtime.bigint();
  const initialRss = process.memoryUsage().rss;
  const { root, app, jobs: jobsDirectory, index, logs } = await setupDirectories(t);
  const auth = tenancy();
  const jobs = createJobsService({ directory: jobsDirectory, tenancy: auth });
  const pending = await jobs.enqueue(jobInput());

  const budgetProbe = await jobs.enqueue(jobInput({
    type: 'resource.probe',
    idempotencyKey: 'resource-probe',
    maxAttempts: 1,
    cpuBudgetMs: 1,
    memoryBudgetBytes: 1,
  }));
  await jobs.runOnce({ type: 'resource.probe', handlers: {
    'resource.probe': async () => {
      const boundedAllocation = Buffer.alloc(1024 * 1024);
      const stopAt = process.hrtime.bigint() + 5_000_000n;
      while (process.hrtime.bigint() < stopAt) boundedAllocation[0] += 1;
    },
  } });
  assert.equal((await jobs.get(jobAccessInput(budgetProbe.id))).status, 'succeeded');
  assert.ok((await jobs.events(tenantInput()))
    .some(event => event.type === 'job.resource-budget-exceeded'));

  let now = 1_000;
  const observability = createObservabilityService({
    directory: logs,
    clock: () => now,
    authorizeAuditRead: async context => context.tenantId === TENANT_ID,
    limits: { maxAuditFileBytes: 512, maxAuditFiles: 3, auditRetentionMs: 100 },
  });
  for (let count = 0; count < 8; count += 1) {
    await observability.audit.append({
      contractVersion: 1,
      tenantId: TENANT_ID,
      requestId: USER_ID,
    }, {
      action: 'account.updated',
      outcome: 'success',
      resourceType: 'account',
      resourceId: USER_ID,
      actorId: USER_ID,
    });
  }
  const retainedLogCount = (await readdir(path.join(logs, 'audit'))).length;
  assert.ok(retainedLogCount <= 3);
  assert.ok(retainedLogCount > 1, 'audit rotation should create retained segments');
  const retainedAuditCount = (await observability.audit.read({
    contractVersion: 1,
    tenantId: TENANT_ID,
    requestId: USER_ID,
  })).length;

  const search = createSearchService(path.join(index, 'index-v1.json'));
  await search.indexDocument({
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    document: syntheticDocument(),
    metadata: { category: 'synthetic' },
    acl: { readerIds: [USER_ID], roles: [] },
  });

  const sourceBackup = path.join(root, 'database-backup');
  const database = databaseRunner();
  await createBackup({
    connection,
    schemaName: 'atelier_app',
    destination: sourceBackup,
    runner: database.runner,
    clock: () => new Date('2026-11-10T00:00:00.000Z'),
  });
  const bundle = path.join(root, 'backup-bundle');
  await mkdir(bundle, { mode: 0o700 });
  await cp(sourceBackup, path.join(bundle, 'database'), { recursive: true });
  await copyAppState(app, path.join(bundle, 'app'));

  await writeFile(path.join(jobsDirectory, 'jobs-v1.json'), '{corrupted live state', { mode: 0o600 });
  await writeFile(path.join(index, 'index-v1.json'), '{corrupted live index', { mode: 0o600 });
  await rm(logs, { recursive: true, force: true });

  const restoredApp = path.join(root, 'restored-app');
  const restoredBundleApp = path.join(bundle, 'app');
  await cp(restoredBundleApp, restoredApp, { recursive: true, errorOnExist: true, force: false });
  const restoredDatabase = databaseRunner();
  const databaseRestore = await restoreBackup({
    connection,
    backupDirectory: path.join(bundle, 'database'),
    targetDatabase: 'restore_operations',
    runner: restoredDatabase.runner,
  });
  assert.equal(databaseRestore.targetDatabase, 'restore_operations');
  assert.deepEqual(restoredDatabase.restoredDatabases.get('restore_operations'), syntheticDatabase);

  const restoredJobs = createJobsService({
    directory: path.join(restoredApp, 'jobs'),
    tenancy: auth,
  });
  assert.equal((await restoredJobs.get(jobAccessInput(pending.id))).status, 'queued');
  await restoredJobs.runOnce({ handlers: {
    'report.generate': async ({ payload }) => assert.equal(payload.reportId, 'synthetic-report'),
  } });
  assert.equal((await restoredJobs.get(jobAccessInput(pending.id))).status, 'succeeded');

  const restoredSearch = createSearchService(path.join(restoredApp, 'index', 'index-v1.json'));
  const results = await restoredSearch.search({
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    query: 'synthetic recovery index',
    mode: 'lexical',
  });
  assert.equal(results.results[0].citation.sourceId, 'synthetic-guide');

  now += 200;
  const restoredObservability = createObservabilityService({
    directory: path.join(restoredApp, 'logs'),
    clock: () => now,
    authorizeAuditRead: async context => context.tenantId === TENANT_ID,
    limits: { maxAuditFileBytes: 512, maxAuditFiles: 3, auditRetentionMs: 100 },
  });
  assert.equal((await restoredObservability.audit.read({
    contractVersion: 1,
    tenantId: TENANT_ID,
    requestId: USER_ID,
  })).length, retainedAuditCount);
  await restoredObservability.cleanup();
  assert.deepEqual(await readdir(path.join(restoredApp, 'logs', 'audit')), [
    'audit-current.jsonl',
  ]);
  assert.equal((await restoredObservability.audit.read({
    contractVersion: 1,
    tenantId: TENANT_ID,
    requestId: USER_ID,
  })).length, 0);

  t.diagnostic(JSON.stringify({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    syntheticAppBytes: (await readFile(path.join(bundle, 'database', 'backup.pgdump'))).byteLength +
      (await readFile(path.join(bundle, 'app', 'jobs', 'jobs-v1.json'))).byteLength +
      (await readFile(path.join(bundle, 'app', 'index', 'index-v1.json'))).byteLength,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    rssDeltaBytes: process.memoryUsage().rss - initialRss,
    retainedAuditSegments: retainedLogCount,
    restoredJobs: 1,
    restoredIndexResults: results.results.length,
  }));
});

test('rejects a corrupted archive and a simulated full-volume backup without partial output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-operations-failures-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDirectory = path.join(root, 'backup');
  const original = databaseRunner();
  await createBackup({
    connection,
    schemaName: 'atelier_app',
    destination: backupDirectory,
    runner: original.runner,
  });
  await writeFile(path.join(backupDirectory, 'backup.pgdump'), 'corrupted', { mode: 0o600 });
  const restore = databaseRunner();
  await assert.rejects(restoreBackup({
    connection,
    backupDirectory,
    targetDatabase: 'restore_corrupt',
    runner: restore.runner,
  }), error => error instanceof DatabaseOperationsError &&
    error.code === 'BACKUP_INTEGRITY_FAILED');
  assert.equal(restore.calls.length, 0, 'corruption must fail before invoking restore tools');

  const fullVolume = databaseRunner({
    onCommand: async ({ command, args }) => {
      if (command !== 'pg_dump') return undefined;
      const partialArchive = args.find(arg => arg.startsWith('--file=')).slice('--file='.length);
      await writeFile(partialArchive, 'partial', { mode: 0o600 });
      const error = new Error('synthetic full volume');
      error.code = 'ENOSPC';
      throw error;
    },
  });
  const failedDestination = path.join(root, 'full-volume');
  await assert.rejects(createBackup({
    connection,
    schemaName: 'atelier_app',
    destination: failedDestination,
    runner: fullVolume.runner,
  }), error => error instanceof DatabaseOperationsError && error.code === 'BACKUP_FAILED');
  await assert.rejects(readFile(failedDestination), { code: 'ENOENT' });
});

test('fails closed on storage exhaustion and corrupt indexes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-operations-resource-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = createJobsService({
    directory: root,
    tenancy: tenancy(),
    limits: { maxStorageBytes: 1 },
  });
  await assert.rejects(jobs.enqueue(jobInput()), error =>
    error instanceof JobsModuleError && error.code === 'STORAGE_LIMIT');

  const queueDirectory = path.join(root, 'corrupt-queue');
  await mkdir(queueDirectory, { mode: 0o700 });
  const queue = createJobsService({ directory: queueDirectory, tenancy: tenancy() });
  await queue.enqueue(jobInput());
  await writeFile(path.join(queueDirectory, 'jobs-v1.json'), '{invalid', { mode: 0o600 });
  await assert.rejects(queue.list({
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
  }), error =>
    error instanceof JobsModuleError && error.code === 'CORRUPT_QUEUE');

  const indexPath = path.join(root, 'corrupt-index.json');
  await writeFile(indexPath, JSON.stringify({
    [`${TENANT_ID}:rag-search-v1/index`]: { version: 1, value: { contractVersion: 99 } },
  }), { mode: 0o600 });
  const search = createSearchService(indexPath);
  await assert.rejects(search.search({
    cookieHeader: 'synthetic-tenant',
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    query: 'synthetic',
  }), error => error instanceof RagSearchError && error.code === 'CORRUPT_INDEX');
});
