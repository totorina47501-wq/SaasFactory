import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createDeterministicTestEmbedder,
  createRagSearchService,
  RagSearchError,
  ragSearchContract,
} from '../modules/rag-search/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'request-1';

function document(id, sourceId, text, version = 1) {
  const sha256 = createHash('sha256').update(text).digest('hex');
  return {
    id,
    sourceId,
    fileName: `${sourceId}.txt`,
    format: 'txt',
    version,
    sha256,
    text,
    pageCount: 1,
    createdAt: 1,
    deduplicated: false,
    chunks: [{
      index: 0,
      sourceId,
      fileName: `${sourceId}.txt`,
      page: null,
      startOffset: 0,
      endOffset: text.length,
      sha256,
      text,
    }],
  };
}

function createHarness({ embedder, limits, authorizeDocument } = {}) {
  const values = new Map();
  const store = {
    async get(context, key) {
      const current = values.get(`${context.tenantId}:${key}`);
      return current ? structuredClone(current) : undefined;
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
  const tenancy = {
    async resolveTenantContext({ cookieHeader, tenantId, requestId }) {
      if (!['alice', 'bob'].includes(cookieHeader) ||
          ![TENANT_A, TENANT_B].includes(tenantId) ||
          tenantId === TENANT_B && cookieHeader !== 'bob') throw new Error('denied');
      return { contractVersion: 1, tenantId, requestId };
    },
  };
  const service = createRagSearchService({
    tenancy,
    store,
    embedder: embedder ?? createDeterministicTestEmbedder(),
    limits,
    authorizeDocument: authorizeDocument ?? (async ({ cookieHeader, document: record }) =>
      record.acl.readerIds.includes(cookieHeader === 'alice' ? ALICE : BOB)),
  });
  return { service, values };
}

function indexInput(doc, options = {}) {
  return {
    cookieHeader: options.cookieHeader ?? 'alice',
    tenantId: options.tenantId ?? TENANT_A,
    requestId: REQUEST_ID,
    document: doc,
    metadata: options.metadata ?? { category: 'guide' },
    acl: options.acl ?? { readerIds: [ALICE], roles: [] },
  };
}

function searchInput(overrides = {}) {
  return {
    cookieHeader: 'alice',
    tenantId: TENANT_A,
    requestId: REQUEST_ID,
    query: 'access control authorization',
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof RagSearchError && error.code === code);
}

test('indexes ingestion output locally and returns ranked citations with measured synthetic relevance', async () => {
  const { service } = createHarness();
  const relevant = document('10000000-0000-4000-8000-000000000001',
    'access-guide', 'Access control authorization policy for member accounts');
  const unrelated = document('20000000-0000-4000-8000-000000000002',
    'travel-guide', 'Kayak routes and seaside travel packing advice');
  await service.indexDocument(indexInput(relevant));
  await service.indexDocument(indexInput(unrelated, {
    metadata: { category: 'travel' },
    acl: { readerIds: [ALICE], roles: [] },
  }));

  const result = await service.search(searchInput({ minScore: 0.6 }));
  assert.equal(result.contractVersion, ragSearchContract.contractVersion);
  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].citation.documentId, relevant.id);
  assert.equal(result.results[0].citation.sourceId, 'access-guide');
  assert.equal(result.results[0].citation.sha256, relevant.sha256);
  assert.equal(result.results[0].citation.chunkIndex, 0);
  assert.ok(result.results[0].score >= 0.6);
  assert.deepEqual((await service.search(searchInput({
    query: 'access control authorization',
    mode: 'lexical',
    filters: { category: 'travel' },
  }))).results, []);
});

test('preserves source chunk text and offsets while normalizing ranking tokens', async () => {
  const { service } = createHarness();
  const sourceText = 'Ａccess control policy';
  const source = document('15000000-0000-4000-8000-000000000001', 'unicode-guide', sourceText);
  await service.indexDocument(indexInput(source));
  const result = await service.search(searchInput({
    query: 'access control',
    mode: 'lexical',
  }));
  assert.equal(result.results[0].text, sourceText);
  assert.equal(result.results[0].citation.startOffset, 0);
  assert.equal(result.results[0].citation.endOffset, sourceText.length);
});

test('applies document ACLs and tenant isolation before returning search results', async () => {
  const { service, values } = createHarness();
  const privateDoc = document('30000000-0000-4000-8000-000000000003',
    'alice-private', 'access control notes');
  await service.indexDocument(indexInput(privateDoc));
  assert.deepEqual((await service.search(searchInput({
    cookieHeader: 'bob',
    query: 'access control',
  }))).results, []);
  assert.deepEqual((await service.search(searchInput({
    cookieHeader: 'bob',
    tenantId: TENANT_B,
    query: 'access control',
  }))).results, []);

  const unauthorized = indexInput(document('40000000-0000-4000-8000-000000000004',
    'bob-private', 'access control secrets'), {
    acl: { readerIds: [BOB], roles: [] },
  });
  await expectCode(service.indexDocument(unauthorized), 'DOCUMENT_ACCESS_DENIED');
  assert.equal(values.size, 1);
});

test('updates metadata and ACL for the same document version without recomputing vectors', async () => {
  const { service } = createHarness();
  const source = document('35000000-0000-4000-8000-000000000003',
    'shared-guide', 'access control policy');
  await service.indexDocument(indexInput(source));
  const update = await service.indexDocument(indexInput(source, {
    cookieHeader: 'bob',
    metadata: { category: 'restricted' },
    acl: { readerIds: [BOB], roles: [] },
  }));
  assert.equal(update.indexed, false);
  assert.equal(update.updated, true);
  assert.deepEqual((await service.search(searchInput({
    query: 'access control',
  }))).results, []);
  const bobResults = await service.search(searchInput({
    cookieHeader: 'bob',
    query: 'access control',
    filters: { category: 'restricted' },
  }));
  assert.equal(bobResults.results[0].citation.documentId, source.id);
});

test('uses bounded batched embeddings and caches by tenant and model fingerprint', async () => {
  const base = createDeterministicTestEmbedder({ dimensions: 32 });
  let calls = 0;
  const embedder = Object.freeze({
    ...base,
    async embedBatch(texts) {
      calls += 1;
      return base.embedBatch(texts);
    },
  });
  const { service } = createHarness({ embedder, limits: { batchSize: 1 } });
  const first = document('50000000-0000-4000-8000-000000000005',
    'first', 'access control one');
  const second = document('60000000-0000-4000-8000-000000000006',
    'second', 'access control two');
  await service.indexDocument(indexInput(first));
  await service.indexDocument(indexInput(second));
  const afterIndex = calls;
  assert.ok(afterIndex >= 2);
  await service.search(searchInput({ query: 'access control', mode: 'vector' }));
  const afterFirstQuery = calls;
  await service.search(searchInput({ query: 'access control', mode: 'vector' }));
  assert.equal(calls, afterFirstQuery);
});

test('fails closed on invalid embeddings, model dimension changes, and corrupt durable indexes', async () => {
  const base = createDeterministicTestEmbedder({ dimensions: 16 });
  const invalidEmbedder = Object.freeze({
    ...base,
    async embedBatch(texts) {
      return texts.map(() => Array(16).fill(0));
    },
  });
  const invalid = createHarness({ embedder: invalidEmbedder });
  await expectCode(invalid.service.indexDocument(indexInput(document(
    '70000000-0000-4000-8000-000000000007', 'invalid', 'access control'))), 'INVALID_EMBEDDING');
  assert.equal(invalid.values.size, 0);

  const harness = createHarness({ embedder: base });
  await harness.service.indexDocument(indexInput(document(
    '80000000-0000-4000-8000-000000000008', 'stored', 'access control')));
  const otherModel = createHarness({ embedder: createDeterministicTestEmbedder({ dimensions: 32 }) });
  otherModel.values.set(...harness.values.entries().next().value);
  await expectCode(otherModel.service.search(searchInput()), 'EMBEDDING_MODEL_MISMATCH');

  const entry = harness.values.entries().next().value;
  entry[1].value.documents[0].chunks[0].vector = Array(16).fill(0);
  harness.values.set(entry[0], entry[1]);
  await expectCode(harness.service.search(searchInput()), 'CORRUPT_INDEX');
});

test('returns no matches for irrelevant queries and rejects malformed inputs or missing authorization', async () => {
  const harness = createHarness();
  const validDoc = document(
    '90000000-0000-4000-8000-000000000009', 'access', 'access control policy');
  const malformedDoc = structuredClone(validDoc);
  malformedDoc.chunks[0].text = 'tampered document text';
  await expectCode(harness.service.indexDocument(indexInput(malformedDoc)), 'INVALID_DOCUMENT');
  await harness.service.indexDocument(indexInput(validDoc));
  assert.deepEqual((await harness.service.search(searchInput({
    query: 'quantum zebra',
    mode: 'lexical',
  }))).results, []);
  await expectCode(harness.service.search(searchInput({ surprise: true })), 'INVALID_INPUT');
  await expectCode(harness.service.search(searchInput({ tenantId: TENANT_B, query: 'x' })),
    'TENANT_ACCESS_DENIED');

  const denied = createHarness({ authorizeDocument: async () => { throw new Error('ACL unavailable'); } });
  await expectCode(denied.service.indexDocument(indexInput(document(
    'a0000000-0000-4000-8000-00000000000a', 'denied', 'denied content'))),
  'DOCUMENT_ACCESS_DENIED');
});
