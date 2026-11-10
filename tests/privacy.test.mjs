import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createPrivacyService,
  PrivacyError,
  privacyContract,
} from '../modules/privacy/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST = 'request-privacy';
const NOW = Date.UTC(2026, 10, 10);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const targetKey = target => `${target.type}:${target.id ?? ''}`;

function createStore() {
  const states = new Map();
  return {
    async get(context, key) {
      const current = states.get(`${context.tenantId}:${key}`);
      return current === undefined ? undefined : structuredClone(current);
    },
    async put(context, key, value, expectedVersion) {
      const storageKey = `${context.tenantId}:${key}`;
      const current = states.get(storageKey);
      if ((current?.version) !== expectedVersion) {
        const error = new Error('conflict');
        error.code = 'CONFLICT';
        throw error;
      }
      const version = (current?.version ?? 0) + 1;
      states.set(storageKey, { version, value: structuredClone(value) });
      return version;
    },
  };
}

function createJobs() {
  const jobs = new Map();
  let nextId = 1;
  return {
    async enqueue(input) {
      const existing = [...jobs.values()].find(job =>
        job.tenantId === input.tenantId && job.idempotencyKey === input.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
      const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
      jobs.set(id, {
        id,
        tenantId: input.tenantId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        payload: structuredClone(input.payload),
        status: 'queued',
      });
      return { id, status: 'queued' };
    },
    async get(input) {
      const job = jobs.get(input.jobId);
      if (!job || job.tenantId !== input.tenantId) throw new Error('not found');
      return { id: job.id, status: job.status };
    },
    async runOnce({ type, handlers }) {
      const job = [...jobs.values()].find(entry => entry.status === 'queued');
      if (!job) return false;
      job.status = 'running';
      const handler = handlers[type];
      try {
        await handler({
          tenantContext: {
            contractVersion: 1,
            tenantId: job.tenantId,
            requestId: job.requestId,
          },
          payload: structuredClone(job.payload),
        });
        job.status = 'succeeded';
      } catch {
        job.status = 'failed';
      }
      return true;
    },
  };
}

function fixture(options = {}) {
  let now = NOW;
  const records = new Map([
    [`${TENANT_A}:user:${USER_A}`, [{ id: 'a1', email: 'a@example.test' }]],
    [`${TENANT_A}:user:${USER_B}`, [{ id: 'a2', email: 'b@example.test' }]],
    [`${TENANT_B}:user:${USER_A}`, [{ id: 'b1', email: 'a@example.test' }]],
  ]);
  const vectors = new Map([
    [`${TENANT_A}:user:${USER_A}`, ['vector-a']],
    [`${TENANT_A}:user:${USER_B}`, ['vector-b']],
    [`${TENANT_B}:user:${USER_A}`, ['vector-c']],
  ]);
  let vectorFailures = options.vectorFailures ?? 0;
  const sources = [
    {
      id: 'documents',
      enabled: true,
      async export({ tenantContext, target }) {
        if (target.type === 'tenant') {
          return [...records.entries()]
            .filter(([key]) => key.startsWith(`${tenantContext.tenantId}:`))
            .flatMap(([, value]) => value);
        }
        return records.get(`${tenantContext.tenantId}:${targetKey(target)}`) ?? [];
      },
      async erase({ tenantContext, target }) {
        if (target.type === 'tenant') {
          for (const key of records.keys()) {
            if (key.startsWith(`${tenantContext.tenantId}:`)) records.delete(key);
          }
          return 2;
        }
        const key = `${tenantContext.tenantId}:${targetKey(target)}`;
        const count = records.get(key)?.length ?? 0;
        records.delete(key);
        return count;
      },
      async prune({ cutoff }) {
        return cutoff < NOW ? 1 : 0;
      },
    },
    {
      id: 'vectors',
      enabled: true,
      async export({ tenantContext, target }) {
        if (target.type === 'tenant') {
          return [...vectors.entries()]
            .filter(([key]) => key.startsWith(`${tenantContext.tenantId}:`))
            .flatMap(([, value]) => value.map(id => ({ id })));
        }
        return (vectors.get(`${tenantContext.tenantId}:${targetKey(target)}`) ?? [])
          .map(id => ({ id }));
      },
      async erase({ tenantContext, target }) {
        if (vectorFailures > 0) {
          vectorFailures -= 1;
          throw new Error('temporary vector index failure');
        }
        if (target.type === 'tenant') {
          let count = 0;
          for (const [key, value] of vectors.entries()) {
            if (key.startsWith(`${tenantContext.tenantId}:`)) {
              count += value.length;
              vectors.delete(key);
            }
          }
          return count;
        }
        const key = `${tenantContext.tenantId}:${targetKey(target)}`;
        const count = vectors.get(key)?.length ?? 0;
        vectors.delete(key);
        return count;
      },
    },
  ];
  const service = createPrivacyService({
    auth: {
      async currentUser({ cookieHeader }) {
        if (cookieHeader === 'user-a') return { id: USER_A };
        if (cookieHeader === 'user-b') return { id: USER_B };
        return null;
      },
    },
    tenancy: {
      async resolveTenantContext({ cookieHeader, tenantId, requestId }) {
        if (!['user-a', 'user-b'].includes(cookieHeader) ||
            ![TENANT_A, TENANT_B].includes(tenantId)) throw new Error('denied');
        return { contractVersion: 1, tenantId, requestId };
      },
    },
    authorize: async ({ tenantContext, userId, action }) =>
      userId === USER_A && tenantContext.tenantId === TENANT_A &&
      ['privacy:export', 'privacy:erase', 'privacy:retention:run',
        'privacy:operation:read'].includes(action),
    sources,
    store: createStore(),
    jobs: createJobs(),
    retention: [{ sourceId: 'documents', retentionMs: 86400000 }],
    limits: options.limits,
    clock: () => now,
  });
  return {
    service,
    records,
    vectors,
    setTime(value) {
      now = value;
    },
  };
}

function input(cookieHeader = 'user-a', tenantId = TENANT_A, extras = {}) {
  return {
    cookieHeader,
    tenantId,
    requestId: REQUEST,
    ...extras,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof PrivacyError && error.code === code);
}

test('exports a versioned contract and validates enabled adapters and options', () => {
  assert.equal(privacyContract.contractVersion, 1);
  assert.throws(() => createPrivacyService({
    auth: { currentUser: async () => ({ id: USER_A }) },
    tenancy: { resolveTenantContext: async () => ({}) },
    authorize: async () => true,
    store: createStore(),
    jobs: createJobs(),
    sources: [{ id: 'missing-erase', enabled: true, export: async () => [] }],
  }), error => error.code === 'INVALID_CONFIGURATION');
  const { service } = fixture();
  assert.equal(typeof service.runOnce, 'function');
  assert.equal(typeof service.retryErasure, 'function');
});

test('exports only the authenticated user data with verifiable source and manifest hashes', async () => {
  const { service } = fixture();
  const result = await service.exportData(input('user-a', TENANT_A, { scope: 'user' }));
  assert.deepEqual(result.data.documents, [{ email: 'a@example.test', id: 'a1' }]);
  assert.deepEqual(result.data.vectors, [{ id: 'vector-a' }]);
  assert.deepEqual(result.inventory.map(item => item.sourceId), ['documents', 'vectors']);
  assert.equal(result.inventory[0].sha256, digest(JSON.stringify(result.data.documents)));
  const { integrity: _integrity, ...manifest } = result;
  assert.equal(result.integrity.algorithm, 'sha256');
  assert.equal(result.integrity.digest, digest(JSON.stringify(manifest)));
  assert.equal(Object.isFrozen(result.data.documents[0]), true);
  await expectCode(service.exportData(input('user-b', TENANT_A, {
    scope: 'user',
    subjectId: USER_A,
  })), 'ACCESS_DENIED');
});

test('tenant export requires authorization and is limited to that tenant', async () => {
  const { service } = fixture();
  const result = await service.exportData(input('user-a', TENANT_A, { scope: 'tenant' }));
  assert.deepEqual(result.data.documents.map(row => row.id), ['a1', 'a2']);
  assert.equal(result.tenantId, TENANT_A);
  await expectCode(service.exportData(input('user-b', TENANT_A, { scope: 'tenant' })),
    'ACCESS_DENIED');
});

test('erasure persists status, removes vector records, and does not cross tenant boundaries', async () => {
  const { service, vectors, records } = fixture();
  const accepted = await service.requestErasure(input('user-a', TENANT_A, {
    scope: 'user',
    idempotencyKey: 'erase-my-account',
  }));
  assert.equal(accepted.status, 'queued');
  await expectCode(service.getOperation(input('user-b', TENANT_A, {
    operationId: accepted.operationId,
  })), 'ACCESS_DENIED');
  assert.equal(await service.runOnce(), true);
  const completed = await service.getOperation(input('user-a', TENANT_A, {
    operationId: accepted.operationId,
  }));
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.steps, { documents: 'succeeded', vectors: 'succeeded' });
  assert.equal(vectors.has(`${TENANT_A}:user:${USER_A}`), false);
  assert.equal(records.has(`${TENANT_A}:user:${USER_A}`), false);
  assert.equal(vectors.has(`${TENANT_A}:user:${USER_B}`), true);
  assert.equal(vectors.has(`${TENANT_B}:user:${USER_A}`), true);
  await expectCode(service.getOperation(input('user-a', TENANT_B, {
    operationId: accepted.operationId,
  })), 'OPERATION_NOT_FOUND');
});

test('retries an interrupted erasure without repeating completed steps', async () => {
  const { service, vectors } = fixture({ vectorFailures: 1 });
  const accepted = await service.requestErasure(input('user-a', TENANT_A, {
    scope: 'user',
    idempotencyKey: 'erase-and-resume',
  }));
  await service.runOnce();
  const failed = await service.getOperation(input('user-a', TENANT_A, {
    operationId: accepted.operationId,
  }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps.documents, 'succeeded');
  assert.equal(failed.steps.vectors, 'pending');
  const retried = await service.retryErasure(input('user-a', TENANT_A, {
    operationId: accepted.operationId,
  }));
  assert.equal(retried.generation, 2);
  await service.runOnce();
  const completed = await service.getOperation(input('user-a', TENANT_A, {
    operationId: accepted.operationId,
  }));
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.steps.documents, 'succeeded');
  assert.equal(vectors.has(`${TENANT_A}:user:${USER_A}`), false);
});

test('applies configurable retention cutoffs only through authorized tenant adapters', async () => {
  const { service } = fixture();
  const result = await service.runRetention(input('user-a', TENANT_A));
  assert.deepEqual(result.results, [{
    sourceId: 'documents',
    cutoff: NOW - 86400000,
    deletedCount: 1,
  }]);
  await expectCode(service.runRetention(input('user-b', TENANT_A)), 'ACCESS_DENIED');
});

test('fails closed on unknown fields, unauthorized tenant erasure, and oversized exports', async () => {
  const fixtureResult = fixture();
  await expectCode(fixtureResult.service.exportData({
    ...input(),
    scope: 'user',
    ignored: true,
  }), 'INVALID_INPUT');
  await expectCode(fixtureResult.service.requestErasure(input('user-b', TENANT_A, {
    scope: 'tenant',
    idempotencyKey: 'unauthorized-tenant-delete',
  })), 'ACCESS_DENIED');

  const tooLarge = fixture({
    limits: { maxExportBytes: 16 },
  });
  await expectCode(tooLarge.service.exportData(input('user-a', TENANT_A, { scope: 'user' })),
    'EXPORT_LIMIT');
});
