import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createJobsService } from '../modules/jobs/index.mjs';
import {
  createRagLifecycleService,
  RagLifecycleError,
  ragLifecycleContract,
} from '../modules/rag-lifecycle/index.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_DOCUMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA = 'a'.repeat(64);
const TENANT_INPUT = Object.freeze({
  cookieHeader: 'tenant-a',
  tenantId: TENANT_ID,
  requestId: 'request-1',
});

function tenancy() {
  return {
    async resolveTenantContext(input) {
      if (input.cookieHeader !== 'tenant-a' || input.tenantId !== TENANT_ID) throw new Error('denied');
      return { contractVersion: 1, tenantId: TENANT_ID, requestId: input.requestId };
    },
  };
}

function makeDocument({
  id = DOCUMENT_ID,
  sourceId = 'guide',
  version = 1,
  sha256 = SHA,
  chunks = ['one', 'two', 'three'],
  modelMetadata = { category: 'guide' },
  acl = { readerIds: [USER_ID], roles: [] },
} = {}) {
  let offset = 0;
  return {
    id,
    sourceId,
    fileName: 'guide.txt',
    format: 'txt',
    version,
    sha256,
    text: chunks.join(' '),
    pageCount: 1,
    createdAt: 1,
    chunks: chunks.map((text, index) => {
      const startOffset = offset;
      offset += text.length;
      return {
        index,
        sourceId,
        fileName: 'guide.txt',
        page: null,
        startOffset,
        endOffset: offset,
        sha256,
        text,
      };
    }),
    metadata: modelMetadata,
    acl,
  };
}

function createStore() {
  const values = new Map();
  return {
    values,
    async get(context, key) {
      const value = values.get(`${context.tenantId}:${key}`);
      return value ? structuredClone(value) : undefined;
    },
    async put(context, key, value, expectedVersion) {
      const storageKey = `${context.tenantId}:${key}`;
      const current = values.get(storageKey);
      if (current?.version !== expectedVersion) {
        const error = new Error('conflict');
        error.code = 'CONFLICT';
        throw error;
      }
      const version = (current?.version ?? 0) + 1;
      values.set(storageKey, { value: structuredClone(value), version });
      return version;
    },
  };
}

function createRepository() {
  const documents = new Map();
  function record(tenantContext, documentId) {
    const key = `${tenantContext.tenantId}:${documentId}`;
    if (!documents.has(key)) {
      documents.set(key, { fencingToken: 0, generations: new Map(), active: null });
    }
    return documents.get(key);
  }
  return {
    documents,
    async writeBatch(input) {
      const document = record(input.tenantContext, input.documentId);
      if (document.fencingToken > input.fencingToken ||
          document.tombstoneFence >= input.fencingToken) {
        const error = new Error('stale fence');
        error.code = 'STALE_FENCE';
        throw error;
      }
      document.fencingToken = input.fencingToken;
      const generation = document.generations.get(input.generationId) ?? {
        fencingToken: input.fencingToken,
        batches: new Map(),
        model: input.model,
      };
      generation.batches.set(input.batchNumber, structuredClone(input.chunks));
      document.generations.set(input.generationId, generation);
    },
    async activateGeneration(input) {
      const document = record(input.tenantContext, input.documentId);
      if (document.fencingToken > input.fencingToken ||
          document.tombstoneFence >= input.fencingToken) {
        const error = new Error('stale fence');
        error.code = 'STALE_FENCE';
        throw error;
      }
      const generation = document.generations.get(input.generationId);
      if (!generation) throw new Error('generation missing');
      document.fencingToken = input.fencingToken;
      document.active = {
        ...structuredClone(input),
        chunks: [...generation.batches.entries()]
          .sort(([left], [right]) => left - right)
          .flatMap(([, chunks]) => chunks),
        cacheEntries: 1,
      };
      document.generations = new Map([[input.generationId, generation]]);
    },
    async discardGeneration(input) {
      const document = record(input.tenantContext, input.documentId);
      if (document.fencingToken <= input.fencingToken) {
        document.generations.delete(input.generationId);
      }
    },
    async deleteDocument(input) {
      const document = record(input.tenantContext, input.documentId);
      if (input.fencingToken >= document.fencingToken) {
        document.fencingToken = input.fencingToken;
        document.tombstoneFence = input.fencingToken;
        document.active = null;
        document.generations.clear();
      }
    },
    async getStats({ tenantContext }) {
      const values = [...documents.entries()]
        .filter(([key]) => key.startsWith(`${tenantContext.tenantId}:`))
        .map(([, document]) => document);
      const generations = values.flatMap(document => [...document.generations.values()]);
      const chunks = generations.flatMap(generation =>
        [...generation.batches.values()].flat());
      const active = values.filter(document => document.active !== null);
      return {
        documents: active.length,
        chunks: active.reduce((count, document) => count + document.active.chunks.length, 0),
        vectors: active.reduce((count, document) => count + document.active.chunks.length, 0),
        caches: active.reduce((count, document) => count + document.active.cacheEntries, 0),
      };
    },
  };
}

function createModel(modelVersion = '1.0.0', dimensions = 8) {
  return {
    contractVersion: 1,
    modelId: 'test/hash-bag',
    modelVersion,
    dimensions,
    fingerprint: (modelVersion === '1.0.0' ? '1' : '2').repeat(64),
    license: 'MIT (test implementation)',
    runtime: 'test',
    device: 'cpu',
    async embedBatch(texts) {
      return texts.map(text => {
        const vector = Array(dimensions).fill(0);
        for (const character of text) vector[character.charCodeAt(0) % dimensions] += 1;
        if (vector.every(value => value === 0)) vector[0] = 1;
        return vector;
      });
    },
  };
}

async function setup(t, {
  documents = [makeDocument()],
  models = [createModel()],
  limits = { batchSize: 2 },
  beforeBatch,
  authorize = async () => true,
} = {}) {
  let now = 1000;
  const directory = await mkdtemp(resolve(tmpdir(), 'sf-rag-lifecycle-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = tenancy();
  const jobs = createJobsService({
    directory,
    tenancy: auth,
    limits: { retryBaseMs: 1, retryMaxMs: 1 },
    clock: () => now,
  });
  const store = createStore();
  const repository = createRepository();
  const sourceDocuments = new Map(documents.map(document =>
    [`${document.id}:${document.version}`, document]));
  const service = createRagLifecycleService({
    tenancy: auth,
    store,
    jobs,
    repository: {
      ...repository,
      async writeBatch(input) {
        await beforeBatch?.(input);
        return repository.writeBatch(input);
      },
    },
    loadDocument: async ({ documentId, version }) => {
      const document = sourceDocuments.get(`${documentId}:${version}`);
      if (!document) throw new Error('source unavailable');
      return structuredClone(document);
    },
    authorize,
    models,
    limits,
    clock: () => now,
  });
  return {
    service,
    jobs,
    store,
    repository,
    sourceDocuments,
    advance() { now += 10; },
  };
}

function indexInput(overrides = {}) {
  return {
    ...TENANT_INPUT,
    documentId: DOCUMENT_ID,
    sourceId: 'guide',
    version: 1,
    sha256: SHA,
    idempotencyKey: 'index-guide-v1',
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error =>
    error instanceof RagLifecycleError && error.code === code);
}

test('exports a versioned contract and validates every operation fail-closed', async t => {
  const fixture = await setup(t);
  assert.equal(fixture.service.contract, ragLifecycleContract);
  assert.equal(ragLifecycleContract.contractVersion, 1);
  assert.deepEqual(ragLifecycleContract.operations, ['index', 'reindex', 'delete']);
  await expectCode(fixture.service.indexDocument(indexInput({ unexpected: true })), 'INVALID_INPUT');
  await expectCode(fixture.service.indexDocument(indexInput({ modelId: 'remote/model' })), 'UNKNOWN_MODEL');
  await expectCode(fixture.service.indexDocument(indexInput({
    cookieHeader: 'tenant-b',
  })), 'TENANT_ACCESS_DENIED');

  const denied = await setup(t, { authorize: async () => false });
  await expectCode(denied.service.indexDocument(indexInput()), 'ACCESS_DENIED');
});

test('indexes documents in resumable idempotent batches and retains source provenance', async t => {
  const fixture = await setup(t);
  const queued = await fixture.service.indexDocument(indexInput());
  const duplicate = await fixture.service.indexDocument(indexInput());
  assert.equal(duplicate.jobId, queued.jobId);
  assert.equal(await fixture.service.runOnce(), true);

  const operation = await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: queued.operationId,
  });
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.processedBatches, 2);
  const active = fixture.repository.documents.get(`${TENANT_ID}:${DOCUMENT_ID}`).active;
  assert.equal(active.chunks.length, 3);
  assert.equal(active.chunks[0].startOffset, 0);
  assert.equal(active.chunks[2].endOffset, 11);
  assert.deepEqual(active.provenance.map(chunk => chunk.sha256), [SHA, SHA, SHA]);
  assert.equal(active.model.modelVersion, '1.0.0');
  assert.deepEqual(await fixture.service.stats(TENANT_INPUT), {
    contractVersion: 1,
    documents: 1,
    chunks: 3,
    vectors: 3,
    caches: 1,
    pendingOperations: 0,
    failedOperations: 0,
    recordedErrors: 0,
  });
});

test('retries an interrupted batch idempotently and records sanitized errors', async t => {
  let interrupted = false;
  const fixture = await setup(t, {
    beforeBatch: async ({ batchNumber }) => {
      if (batchNumber === 1 && !interrupted) {
        interrupted = true;
        const error = new Error('synthetic interruption details');
        error.code = 'BATCH_INTERRUPTED';
        throw error;
      }
    },
  });
  const queued = await fixture.service.indexDocument(indexInput());
  await fixture.service.runOnce();
  let operation = await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: queued.operationId,
  });
  assert.equal(operation.status, 'queued');
  assert.equal(operation.errorCount, 1);
  assert.equal(operation.lastError, 'BATCH_INTERRUPTED');
  assert.equal(Object.hasOwn(operation, 'error'), false);

  fixture.advance();
  await fixture.service.runOnce();
  operation = await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: queued.operationId,
  });
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.processedBatches, 2);
  assert.equal(fixture.repository.documents.get(`${TENANT_ID}:${DOCUMENT_ID}`).active.chunks.length, 3);
});

test('deletion fences an in-flight index, atomically revokes visibility, and removes vectors and caches', async t => {
  let startEmbedding;
  let releaseEmbedding;
  const embeddingStarted = new Promise(resolveStarted => { startEmbedding = resolveStarted; });
  const embeddingGate = new Promise(resolveGate => { releaseEmbedding = resolveGate; });
  const model = createModel();
  const blockedModel = {
    ...model,
    async embedBatch(texts) {
      startEmbedding();
      await embeddingGate;
      return model.embedBatch(texts);
    },
  };
  const fixture = await setup(t, { models: [blockedModel] });
  const index = await fixture.service.indexDocument(indexInput());
  const indexing = fixture.service.runOnce();
  await embeddingStarted;

  const deletion = await fixture.service.deleteDocument({
    ...TENANT_INPUT,
    documentId: DOCUMENT_ID,
    idempotencyKey: 'delete-guide',
  });
  await fixture.service.runOnce();
  releaseEmbedding();
  await indexing;

  const status = await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: index.operationId,
  });
  assert.equal(status.status, 'superseded');
  assert.equal(await fixture.service.runOnce(), false);
  const deleted = await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: deletion.operationId,
  });
  assert.equal(deleted.status, 'succeeded');
  assert.deepEqual(await fixture.service.stats(TENANT_INPUT), {
    contractVersion: 1,
    documents: 0,
    chunks: 0,
    vectors: 0,
    caches: 0,
    pendingOperations: 0,
    failedOperations: 0,
    recordedErrors: 0,
  });
});

test('model rotation activates a complete new generation without mixing versions', async t => {
  const firstModel = createModel('1.0.0');
  const secondModel = {
    ...createModel('2.0.0'),
    modelId: 'test/rotated',
    fingerprint: '3'.repeat(64),
  };
  const fixture = await setup(t, { models: [firstModel, secondModel] });
  const first = await fixture.service.indexDocument(indexInput());
  await fixture.service.runOnce();
  const rotation = await fixture.service.reindexDocument(indexInput({
    idempotencyKey: 'reindex-guide-model-2',
    modelId: secondModel.modelId,
  }));
  await fixture.service.runOnce();

  const active = fixture.repository.documents.get(`${TENANT_ID}:${DOCUMENT_ID}`).active;
  assert.equal(active.model.modelVersion, '2.0.0');
  assert.equal(active.chunks.length, 3);
  assert.equal((await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: first.operationId,
  })).status, 'succeeded');
  assert.equal((await fixture.service.getOperation({
    ...TENANT_INPUT,
    operationId: rotation.operationId,
  })).status, 'succeeded');
  assert.equal(fixture.repository.documents.get(`${TENANT_ID}:${DOCUMENT_ID}`).generations.size, 1);
});

test('refuses corrupt durable state rather than silently rebuilding it', async t => {
  const fixture = await setup(t);
  fixture.store.values.set(`${TENANT_ID}:rag-lifecycle-v1/state`, {
    value: { contractVersion: 99, documents: {}, operations: {} },
    version: 1,
  });
  await expectCode(fixture.service.stats(TENANT_INPUT), 'CORRUPT_STATE');
});
