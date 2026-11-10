import { createHash } from 'node:crypto';

const CONTRACT_VERSION = 1;
const STORAGE_KEY = 'rag-lifecycle-v1/state';
const JOB_TYPE = 'rag.lifecycle';
const DEFAULTS = Object.freeze({
  batchSize: 32,
  maxAttempts: 3,
  maxChunksPerDocument: 5000,
  maxOperations: 10_000,
  maxWriteRetries: 3,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MODEL_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export class RagLifecycleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RagLifecycleError';
    this.code = code;
  }
}

function fail(code) {
  throw new RagLifecycleError(code);
}

function exactObject(value, allowed, required = allowed, errorCode = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail(errorCode);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
    result[key] = descriptor.value;
  }
  return result;
}

function safeInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateLimits(value = {}) {
  const input = exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...input };
  const maxima = {
    batchSize: 256,
    maxAttempts: 10,
    maxChunksPerDocument: 100_000,
    maxOperations: 100_000,
    maxWriteRetries: 10,
  };
  for (const [key, maximum] of Object.entries(maxima)) {
    if (!safeInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

function validateContext(value) {
  const context = exactObject(value, ['contractVersion', 'tenantId', 'requestId'],
    undefined, 'INVALID_TENANT_CONTEXT');
  if (context.contractVersion !== 1 || typeof context.tenantId !== 'string' ||
      !UUID.test(context.tenantId) || typeof context.requestId !== 'string' ||
      !SAFE_ID.test(context.requestId)) fail('INVALID_TENANT_CONTEXT');
  return Object.freeze({
    contractVersion: 1,
    tenantId: context.tenantId.toLowerCase(),
    requestId: context.requestId,
  });
}

function validateModel(value) {
  const model = exactObject(value, [
    'contractVersion', 'modelId', 'modelVersion', 'dimensions', 'fingerprint',
    'license', 'runtime', 'device', 'embedBatch',
  ]);
  if (model.contractVersion !== CONTRACT_VERSION ||
      typeof model.modelId !== 'string' || !MODEL_ID.test(model.modelId) ||
      typeof model.modelVersion !== 'string' || !model.modelVersion.isWellFormed() ||
      model.modelVersion.length < 1 || model.modelVersion.length > 64 ||
      !safeInteger(model.dimensions, 1, 8192) ||
      typeof model.fingerprint !== 'string' || !HASH.test(model.fingerprint) ||
      typeof model.license !== 'string' || !model.license.isWellFormed() ||
      model.license.length < 1 || model.license.length > 120 ||
      !['local', 'test'].includes(model.runtime) || model.device !== 'cpu' ||
      typeof model.embedBatch !== 'function' ||
      model.runtime === 'test' && !model.modelId.startsWith('test/') ||
      model.runtime === 'local' && model.modelId.startsWith('test/')) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    modelId: model.modelId,
    modelVersion: model.modelVersion,
    fingerprint: model.fingerprint,
    dimensions: model.dimensions,
    license: model.license,
    runtime: model.runtime,
    device: model.device,
    embedBatch: model.embedBatch,
  });
}

function validateMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SOURCE');
  const keys = Reflect.ownKeys(value);
  const metadata = exactObject(value, keys.filter(key => typeof key === 'string'),
    undefined, 'INVALID_SOURCE');
  if (Object.keys(metadata).length > 32) fail('INVALID_SOURCE');
  const result = Object.create(null);
  for (const [key, item] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !(typeof item === 'string' && item.isWellFormed() && item.length <= 500 ||
          typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item))) {
      fail('INVALID_SOURCE');
    }
    result[key] = item;
  }
  return Object.freeze(result);
}

function validateAcl(value) {
  const acl = exactObject(value, ['readerIds', 'roles']);
  const list = (items, pattern, maximum) => {
    if (!Array.isArray(items) || items.length > maximum ||
        Object.keys(items).length !== items.length ||
        items.some(item => typeof item !== 'string' || !pattern.test(item))) fail('INVALID_SOURCE');
    if (new Set(items).size !== items.length) fail('INVALID_SOURCE');
    return Object.freeze([...items]);
  };
  const readerIds = list(acl.readerIds, UUID, 100).map(id => id.toLowerCase());
  const roles = list(acl.roles, /^[a-z][a-z0-9-]{0,31}$/u, 32);
  if (!readerIds.length && !roles.length) fail('INVALID_SOURCE');
  return Object.freeze({ readerIds: Object.freeze(readerIds), roles });
}

function validateDocument(value, reference, limits) {
  const source = exactObject(value, [
    'id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'text',
    'pageCount', 'createdAt', 'chunks', 'deduplicated', 'metadata', 'acl',
  ], [
    'id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'chunks',
    'metadata', 'acl',
  ], 'INVALID_SOURCE');
  if (source.id !== reference.documentId || source.sourceId !== reference.sourceId ||
      source.version !== reference.version || source.sha256 !== reference.sha256 ||
      !HASH.test(source.sha256) || typeof source.fileName !== 'string' ||
      !source.fileName || source.fileName.length > 255 ||
      /[/\\\u0000-\u001f\u007f]/u.test(source.fileName) ||
      !['txt', 'markdown', 'html', 'pdf', 'docx'].includes(source.format) ||
      !Array.isArray(source.chunks) || source.chunks.length < 1 ||
      source.chunks.length > limits.maxChunksPerDocument ||
      Object.keys(source.chunks).length !== source.chunks.length) fail('INVALID_SOURCE');
  const chunks = source.chunks.map((value, position) => {
    const chunk = exactObject(value, [
      'index', 'sourceId', 'fileName', 'page', 'startOffset', 'endOffset', 'sha256', 'text',
    ], undefined, 'INVALID_SOURCE');
    if (chunk.index !== position || chunk.sourceId !== source.sourceId ||
        chunk.fileName !== source.fileName ||
        !(chunk.page === null || safeInteger(chunk.page, 1)) ||
        !safeInteger(chunk.startOffset, 0) || !safeInteger(chunk.endOffset, 1) ||
        chunk.startOffset >= chunk.endOffset || typeof chunk.text !== 'string' ||
        !chunk.text.isWellFormed() || !chunk.text.trim() ||
        chunk.sha256 !== source.sha256) fail('INVALID_SOURCE');
    return Object.freeze({ ...chunk });
  });
  return Object.freeze({
    id: source.id,
    sourceId: source.sourceId,
    version: source.version,
    sha256: source.sha256,
    fileName: source.fileName,
    format: source.format,
    pageCount: source.pageCount,
    createdAt: source.createdAt,
    chunks: Object.freeze(chunks),
    metadata: validateMetadata(source.metadata),
    acl: validateAcl(source.acl),
  });
}

function emptyState() {
  return { contractVersion: CONTRACT_VERSION, documents: {}, operations: {} };
}

function validateState(value) {
  const state = exactObject(value, ['contractVersion', 'documents', 'operations'],
    undefined, 'CORRUPT_STATE');
  if (state.contractVersion !== CONTRACT_VERSION ||
      state.documents === null || typeof state.documents !== 'object' ||
      Array.isArray(state.documents) || state.operations === null ||
      typeof state.operations !== 'object' || Array.isArray(state.operations)) {
    fail('CORRUPT_STATE');
  }
  for (const [documentId, document] of Object.entries(state.documents)) {
    if (!UUID.test(documentId) || document === null || typeof document !== 'object' ||
        !safeInteger(document.fencingToken, 1) ||
        typeof document.operationId !== 'string' || !SAFE_ID.test(document.operationId)) {
      fail('CORRUPT_STATE');
    }
  }
  for (const [operationId, operation] of Object.entries(state.operations)) {
    if (!SAFE_ID.test(operationId) || operation === null || typeof operation !== 'object' ||
        !['index', 'reindex', 'delete'].includes(operation.type) ||
        !UUID.test(operation.documentId) || !safeInteger(operation.fencingToken, 1) ||
        !['queued', 'running', 'succeeded', 'failed', 'superseded'].includes(operation.status)) {
      fail('CORRUPT_STATE');
    }
  }
  return state;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function operationErrorCode(error) {
  return error instanceof RagLifecycleError ? error.code :
    ERROR_CODE.test(error?.code ?? '') ? error.code : 'PROCESSING_FAILED';
}

export function createRagLifecycleService(options) {
  const config = exactObject(options, [
    'tenancy', 'store', 'jobs', 'repository', 'loadDocument', 'authorize',
    'models', 'limits', 'clock',
  ], [
    'tenancy', 'store', 'jobs', 'repository', 'loadDocument', 'authorize', 'models',
  ]);
  const { tenancy, store, jobs, repository, loadDocument, authorize } = config;
  if (!tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      !store || typeof store.get !== 'function' || typeof store.put !== 'function' ||
      !jobs || typeof jobs.enqueue !== 'function' || typeof jobs.runOnce !== 'function' ||
      !repository || typeof repository.writeBatch !== 'function' ||
      typeof repository.activateGeneration !== 'function' ||
      typeof repository.discardGeneration !== 'function' ||
      typeof repository.deleteDocument !== 'function' ||
      typeof repository.getStats !== 'function' ||
      typeof loadDocument !== 'function' || typeof authorize !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const modelsInput = Array.isArray(config.models) ? config.models : null;
  if (!modelsInput || modelsInput.length < 1 || modelsInput.length > 16) fail('INVALID_CONFIGURATION');
  const models = new Map();
  for (const rawModel of modelsInput) {
    const model = validateModel(rawModel);
    if (models.has(model.modelId)) fail('INVALID_CONFIGURATION');
    models.set(model.modelId, model);
  }
  const limits = validateLimits(config.limits);
  const clock = config.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  async function resolveContext(input) {
    let rawContext;
    try {
      rawContext = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    const context = validateContext(rawContext);
    if (context.tenantId !== input.tenantId.toLowerCase() ||
        context.requestId !== input.requestId) fail('TENANT_ACCESS_DENIED');
    return context;
  }

  async function readState(context) {
    let stored;
    try {
      stored = await store.get(context, STORAGE_KEY);
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (stored === undefined) return { state: emptyState(), version: undefined };
    try {
      const record = exactObject(stored, ['value', 'version'], undefined, 'CORRUPT_STATE');
      if (!safeInteger(record.version, 1)) fail('CORRUPT_STATE');
      return { state: validateState(record.value), version: record.version };
    } catch (error) {
      if (error instanceof RagLifecycleError) throw error;
      fail('CORRUPT_STATE');
    }
  }

  async function mutate(context, callback) {
    for (let attempt = 0; attempt < limits.maxWriteRetries; attempt += 1) {
      const current = await readState(context);
      const next = structuredClone(current.state);
      const result = callback(next);
      try {
        const version = await store.put(context, STORAGE_KEY, next, current.version);
        if (!safeInteger(version, 1)) fail('STORAGE_UNAVAILABLE');
        return result;
      } catch (error) {
        if (error?.code === 'CONFLICT') continue;
        if (error instanceof RagLifecycleError) throw error;
        fail('STORAGE_UNAVAILABLE');
      }
    }
    fail('STORAGE_BUSY');
  }

  async function canPerform(context, input, operation) {
    let allowed;
    try {
      allowed = await authorize({
        tenantContext: context,
        operation,
        documentId: input.documentId,
        sourceId: input.sourceId,
      });
    } catch {
      fail('ACCESS_DENIED');
    }
    if (allowed !== true) fail('ACCESS_DENIED');
  }

  async function schedule(rawInput, type) {
    const input = exactObject(rawInput, [
      'cookieHeader', 'tenantId', 'requestId', 'documentId', 'sourceId',
      'version', 'sha256', 'idempotencyKey', 'modelId',
    ], type === 'delete'
      ? ['cookieHeader', 'tenantId', 'requestId', 'documentId', 'idempotencyKey']
      : ['cookieHeader', 'tenantId', 'requestId', 'documentId', 'sourceId',
        'version', 'sha256', 'idempotencyKey']);
    if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
        typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
        typeof input.requestId !== 'string' || !SAFE_ID.test(input.requestId) ||
        typeof input.documentId !== 'string' || !UUID.test(input.documentId) ||
        typeof input.idempotencyKey !== 'string' || !SAFE_ID.test(input.idempotencyKey)) {
      fail('INVALID_INPUT');
    }
    if (type !== 'delete' && (typeof input.sourceId !== 'string' ||
        !SAFE_ID.test(input.sourceId) || !safeInteger(input.version, 1) ||
        typeof input.sha256 !== 'string' || !HASH.test(input.sha256))) fail('INVALID_INPUT');
    input.documentId = input.documentId.toLowerCase();
    const model = type === 'delete' ? undefined :
      models.get(input.modelId ?? models.keys().next().value);
    if (type !== 'delete' && !model) fail('UNKNOWN_MODEL');
    const context = await resolveContext(input);
    await canPerform(context, input, type);
    const payloadHash = digest(JSON.stringify({
      type,
      documentId: input.documentId,
      sourceId: input.sourceId ?? null,
      version: input.version ?? null,
      sha256: input.sha256 ?? null,
      model: model ? [model.modelId, model.modelVersion, model.fingerprint] : null,
    }));
    const operationId = digest(`${context.tenantId}\0${input.idempotencyKey}`).slice(0, 40);
    const operation = await mutate(context, state => {
      const existing = state.operations[operationId];
      if (existing) {
        if (existing.payloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT');
        return existing;
      }
      if (Object.keys(state.operations).length >= limits.maxOperations) fail('OPERATION_LIMIT');
      const fencingToken = (state.documents[input.documentId]?.fencingToken ?? 0) + 1;
      const now = clock();
      if (!safeInteger(now, 0)) fail('INVALID_CONFIGURATION');
      const next = {
        id: operationId,
        type,
        documentId: input.documentId,
        sourceId: input.sourceId ?? null,
        version: input.version ?? null,
        sha256: input.sha256 ?? null,
        modelId: model?.modelId ?? null,
        modelVersion: model?.modelVersion ?? null,
        fingerprint: model?.fingerprint ?? null,
        fencingToken,
        payloadHash,
        status: 'queued',
        processedBatches: [],
        errorCount: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      state.documents[input.documentId] = { fencingToken, operationId };
      state.operations[operationId] = next;
      return next;
    });

    try {
      const job = await jobs.enqueue({
        cookieHeader: input.cookieHeader,
        tenantId: context.tenantId,
        requestId: context.requestId,
        type: JOB_TYPE,
        idempotencyKey: `rag-lifecycle:${operationId}`,
        payload: { operationId },
        maxAttempts: limits.maxAttempts,
      });
      if (type === 'delete' && await isCurrent(context, operation)) {
        try {
          await repository.deleteDocument({
            tenantContext: context,
            documentId: operation.documentId,
            fencingToken: operation.fencingToken,
            operationId: operation.id,
          });
        } catch {
          fail('DELETE_PENDING');
        }
      }
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        operationId,
        jobId: job.id,
        type: operation.type,
        status: operation.status,
        fencingToken: operation.fencingToken,
      });
    } catch {
      fail('JOB_QUEUE_UNAVAILABLE');
    }
  }

  async function isCurrent(context, operation) {
    const { state } = await readState(context);
    return state.documents[operation.documentId]?.operationId === operation.id &&
      state.documents[operation.documentId]?.fencingToken === operation.fencingToken;
  }

  async function updateOperation(context, operationId, callback) {
    return mutate(context, state => {
      const operation = state.operations[operationId];
      if (!operation) fail('OPERATION_NOT_FOUND');
      callback(operation, state);
      return operation;
    });
  }

  async function processJob({ tenantContext, payload, signal, attempt }) {
    const context = validateContext(tenantContext);
    const input = exactObject(payload, ['operationId']);
    if (typeof input.operationId !== 'string' || !SAFE_ID.test(input.operationId)) {
      fail('INVALID_JOB_PAYLOAD');
    }
    let { state } = await readState(context);
    const operation = state.operations[input.operationId];
    if (!operation) fail('OPERATION_NOT_FOUND');
    if (!await isCurrent(context, operation)) {
      await updateOperation(context, operation.id, current => {
        current.status = 'superseded';
        current.updatedAt = clock();
      });
      return;
    }
    await updateOperation(context, operation.id, current => {
      current.status = 'running';
      current.updatedAt = clock();
    });
    try {
      if (signal.aborted) return;
      if (operation.type === 'delete') {
        await repository.deleteDocument({
          tenantContext: context,
          documentId: operation.documentId,
          fencingToken: operation.fencingToken,
          operationId: operation.id,
        });
      } else {
        const model = models.get(operation.modelId);
        if (!model || model.modelVersion !== operation.modelVersion ||
            model.fingerprint !== operation.fingerprint) fail('UNKNOWN_MODEL');
        let loaded;
        try {
          loaded = await loadDocument({
            tenantContext: context,
            documentId: operation.documentId,
            version: operation.version,
            signal,
          });
        } catch {
          fail('SOURCE_UNAVAILABLE');
        }
        const source = validateDocument(loaded, operation, limits);
        const generationId = operation.id;
        const count = Math.ceil(source.chunks.length / limits.batchSize);
        for (let batchNumber = 0; batchNumber < count; batchNumber += 1) {
          if (signal.aborted) return;
          if (!await isCurrent(context, operation)) {
            await repository.discardGeneration({
              tenantContext: context,
              documentId: operation.documentId,
              generationId,
              fencingToken: operation.fencingToken,
            });
            await updateOperation(context, operation.id, current => {
              current.status = 'superseded';
              current.updatedAt = clock();
            });
            return;
          }
          const chunks = source.chunks.slice(
            batchNumber * limits.batchSize,
            (batchNumber + 1) * limits.batchSize,
          );
          let rawVectors;
          try {
            rawVectors = await model.embedBatch(chunks.map(chunk => chunk.text.normalize('NFKC')));
          } catch {
            fail('EMBEDDING_UNAVAILABLE');
          }
          if (!Array.isArray(rawVectors) || rawVectors.length !== chunks.length ||
              Object.keys(rawVectors).length !== rawVectors.length) fail('INVALID_EMBEDDING');
          const indexedChunks = chunks.map((chunk, index) => {
            const vector = rawVectors[index];
            if (!Array.isArray(vector) || vector.length !== model.dimensions ||
                Object.keys(vector).length !== vector.length ||
                vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
              fail('INVALID_EMBEDDING');
            }
            const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
            if (!Number.isFinite(magnitude) || magnitude === 0) fail('INVALID_EMBEDDING');
            return Object.freeze({
              ...chunk,
              vector: Object.freeze(vector.map(value => value / magnitude)),
            });
          });
          try {
            await repository.writeBatch({
              tenantContext: context,
              documentId: operation.documentId,
              generationId,
              fencingToken: operation.fencingToken,
              batchNumber,
              model: {
                modelId: model.modelId,
                modelVersion: model.modelVersion,
                fingerprint: model.fingerprint,
                dimensions: model.dimensions,
              },
              chunks: Object.freeze(indexedChunks),
            });
          } catch (error) {
            if (error?.code === 'STALE_FENCE') {
              await repository.discardGeneration({
                tenantContext: context,
                documentId: operation.documentId,
                generationId,
                fencingToken: operation.fencingToken,
              });
              await updateOperation(context, operation.id, current => {
                current.status = 'superseded';
                current.updatedAt = clock();
              });
              return;
            }
            throw error;
          }
          await updateOperation(context, operation.id, current => {
            if (!current.processedBatches.includes(batchNumber)) {
              current.processedBatches.push(batchNumber);
              current.processedBatches.sort((left, right) => left - right);
            }
            current.updatedAt = clock();
          });
        }
        if (!await isCurrent(context, operation)) {
          await repository.discardGeneration({
            tenantContext: context,
            documentId: operation.documentId,
            generationId,
            fencingToken: operation.fencingToken,
          });
          await updateOperation(context, operation.id, current => {
            current.status = 'superseded';
            current.updatedAt = clock();
          });
          return;
        }
        await repository.activateGeneration({
          tenantContext: context,
          documentId: operation.documentId,
          generationId,
          fencingToken: operation.fencingToken,
          source: {
            sourceId: source.sourceId,
            version: source.version,
            sha256: source.sha256,
            fileName: source.fileName,
            format: source.format,
            pageCount: source.pageCount,
            createdAt: source.createdAt,
          },
          metadata: source.metadata,
          acl: source.acl,
          model: {
            modelId: model.modelId,
            modelVersion: model.modelVersion,
            fingerprint: model.fingerprint,
            dimensions: model.dimensions,
          },
          provenance: source.chunks.map(({ index, sourceId, fileName, page, startOffset, endOffset, sha256 }) =>
            ({ index, sourceId, fileName, page, startOffset, endOffset, sha256 })),
        });
      }
      await updateOperation(context, operation.id, (current, latest) => {
        if (latest.documents[operation.documentId]?.operationId !== operation.id) {
          current.status = 'superseded';
        } else {
          current.status = 'succeeded';
          current.lastError = null;
        }
        current.updatedAt = clock();
      });
    } catch (error) {
      const code = operationErrorCode(error);
      if (operation.type !== 'delete') {
        try {
          await repository.discardGeneration({
            tenantContext: context,
            documentId: operation.documentId,
            generationId: operation.id,
            fencingToken: operation.fencingToken,
          });
        } catch {
          // A retry or the adapter's fenced reconciliation handles leftover staging data.
        }
      }
      await updateOperation(context, operation.id, current => {
        current.status = attempt >= limits.maxAttempts ? 'failed' : 'queued';
        current.errorCount += 1;
        current.lastError = code;
        current.updatedAt = clock();
      });
      throw new RagLifecycleError(code);
    }
  }

  function publicOperation(operation) {
    return Object.freeze({
      operationId: operation.id,
      type: operation.type,
      documentId: operation.documentId,
      sourceId: operation.sourceId,
      version: operation.version,
      modelId: operation.modelId,
      fencingToken: operation.fencingToken,
      status: operation.status,
      processedBatches: operation.processedBatches.length,
      errorCount: operation.errorCount,
      lastError: operation.lastError,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }

  return Object.freeze({
    contract: ragLifecycleContract,

    indexDocument(input) {
      return schedule(input, 'index');
    },

    reindexDocument(input) {
      return schedule(input, 'reindex');
    },

    deleteDocument(input) {
      return schedule(input, 'delete');
    },

    async runOnce() {
      return jobs.runOnce({ type: JOB_TYPE, handlers: { [JOB_TYPE]: processJob } });
    },

    async getOperation(rawInput) {
      const input = exactObject(rawInput, [
        'cookieHeader', 'tenantId', 'requestId', 'operationId',
      ]);
      if (typeof input.cookieHeader !== 'string' || typeof input.tenantId !== 'string' ||
          !UUID.test(input.tenantId) || typeof input.requestId !== 'string' ||
          !SAFE_ID.test(input.requestId) || typeof input.operationId !== 'string' ||
          !SAFE_ID.test(input.operationId)) fail('INVALID_INPUT');
      const context = await resolveContext(input);
      const { state } = await readState(context);
      const operation = state.operations[input.operationId];
      if (!operation) fail('OPERATION_NOT_FOUND');
      return publicOperation(operation);
    },

    async stats(rawInput) {
      const input = exactObject(rawInput, ['cookieHeader', 'tenantId', 'requestId']);
      if (typeof input.cookieHeader !== 'string' || typeof input.tenantId !== 'string' ||
          !UUID.test(input.tenantId) || typeof input.requestId !== 'string' ||
          !SAFE_ID.test(input.requestId)) fail('INVALID_INPUT');
      const context = await resolveContext(input);
      const { state } = await readState(context);
      let indexStats;
      try {
        indexStats = exactObject(await repository.getStats({ tenantContext: context }), [
          'documents', 'chunks', 'vectors', 'caches',
        ]);
      } catch {
        fail('INDEX_UNAVAILABLE');
      }
      for (const value of Object.values(indexStats)) {
        if (!safeInteger(value, 0)) fail('CORRUPT_INDEX_STATS');
      }
      const operations = Object.values(state.operations);
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        ...indexStats,
        pendingOperations: operations.filter(operation =>
          ['queued', 'running'].includes(operation.status)).length,
        failedOperations: operations.filter(operation => operation.status === 'failed').length,
        recordedErrors: operations.reduce((total, operation) => total + operation.errorCount, 0),
      });
    },
  });
}

export const ragLifecycleContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: '1.0.0',
  storageKey: STORAGE_KEY,
  jobType: JOB_TYPE,
  operations: Object.freeze(['index', 'reindex', 'delete']),
  guarantees: Object.freeze([
    'tenant-scoped-idempotent-jobs',
    'fenced-staging-batches-and-atomic-generation-activation',
    'atomic-delete-and-acl-revocation-through-repository-adapter',
    'source-provenance-preserved',
  ]),
  defaultLimits: DEFAULTS,
  networkRequired: false,
});
