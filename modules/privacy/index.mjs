import { createHash } from 'node:crypto';

const CONTRACT_VERSION = 1;
const STORAGE_KEY = 'privacy-v1/state';
const JOB_TYPE = 'privacy.erasure';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STATUSES = Object.freeze(['queued', 'running', 'retrying', 'succeeded', 'failed']);
const DEFAULT_LIMITS = Object.freeze({
  maxExportBytes: 2 * 1024 * 1024,
  maxExportRecords: 10000,
  maxOperations: 5000,
  maxWriteRetries: 5,
});
const HARD_LIMITS = Object.freeze({
  maxExportBytes: 16 * 1024 * 1024,
  maxExportRecords: 100000,
  maxOperations: 100000,
  maxWriteRetries: 20,
});

export class PrivacyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrivacyError';
    this.code = code;
  }
}

function fail(code) {
  throw new PrivacyError(code);
}

function exactObject(value, allowed, required = allowed, errorCode = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail(errorCode);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
  }
  return value;
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateId(value, pattern = UUID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function normalizeJson(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > state.maxNodes || depth > 32) fail('EXPORT_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail('INVALID_EXPORT_DATA');

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail('INVALID_EXPORT_DATA');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 ||
        keys.some(key => key !== 'length' &&
          (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= value.length))) fail('INVALID_EXPORT_DATA');
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('INVALID_EXPORT_DATA');
      }
      result.push(normalizeJson(descriptor.value, state, depth + 1));
    }
    return result;
  }

  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_EXPORT_DATA');
  const result = {};
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) fail('INVALID_EXPORT_DATA');
  for (const key of keys.sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail('INVALID_EXPORT_DATA');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('INVALID_EXPORT_DATA');
    }
    result[key] = normalizeJson(descriptor.value, state, depth + 1);
  }
  return result;
}

function normalizeRecords(value, limits) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > limits.maxExportRecords) fail('INVALID_EXPORT_DATA');
  const state = { nodes: 0, maxNodes: limits.maxExportRecords * 64 };
  const records = normalizeJson(value, state);
  return { records, json: JSON.stringify(records) };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateTarget(value, userId) {
  exactObject(value, ['scope', 'subjectId'], ['scope']);
  if (value.scope === 'user') {
    if (value.subjectId !== undefined && validateId(value.subjectId) !== userId) {
      fail('ACCESS_DENIED');
    }
    return Object.freeze({ type: 'user', id: userId });
  }
  if (value.scope === 'tenant' && value.subjectId === undefined) {
    return Object.freeze({ type: 'tenant', id: null });
  }
  fail('INVALID_INPUT');
}

function validateState(value, sourceIds, limits) {
  exactObject(value, ['contractVersion', 'operations']);
  if (value.contractVersion !== CONTRACT_VERSION || value.operations === null ||
      typeof value.operations !== 'object' || Array.isArray(value.operations) ||
      Object.getPrototypeOf(value.operations) !== Object.prototype) fail('CORRUPT_STATE');
  const operationIds = Object.keys(value.operations);
  if (operationIds.length > limits.maxOperations) fail('CORRUPT_STATE');
  for (const id of operationIds) {
    if (!/^[a-f0-9]{40}$/u.test(id)) fail('CORRUPT_STATE');
    const operation = exactObject(value.operations[id], [
      'id', 'idempotencyKeyHash', 'payloadHash', 'target', 'status', 'steps',
      'counts', 'generation', 'jobId', 'createdAt', 'updatedAt', 'lastError',
    ], undefined, 'CORRUPT_STATE');
    if (operation.id !== id || !HASH.test(operation.idempotencyKeyHash) ||
        !HASH.test(operation.payloadHash) || !STATUSES.includes(operation.status) ||
        !safeInteger(operation.generation, 1) ||
        !(operation.jobId === null || typeof operation.jobId === 'string' && UUID.test(operation.jobId)) ||
        !safeInteger(operation.createdAt) || !safeInteger(operation.updatedAt) ||
        !(operation.lastError === null || operation.lastError === 'SOURCE_ERASURE_FAILED') ||
        operation.target === null || typeof operation.target !== 'object') fail('CORRUPT_STATE');
    exactObject(operation.target, ['type', 'id']);
    if (!['user', 'tenant'].includes(operation.target.type) ||
        (operation.target.type === 'user' && !UUID.test(operation.target.id)) ||
        (operation.target.type === 'tenant' && operation.target.id !== null)) fail('CORRUPT_STATE');
    exactObject(operation.steps, sourceIds, sourceIds, 'CORRUPT_STATE');
    exactObject(operation.counts, sourceIds, sourceIds, 'CORRUPT_STATE');
    for (const sourceId of Object.keys(operation.steps)) {
      if (!['pending', 'running', 'succeeded'].includes(operation.steps[sourceId]) ||
          !safeInteger(operation.counts[sourceId])) fail('CORRUPT_STATE');
    }
  }
  return value;
}

function emptyState() {
  return { contractVersion: CONTRACT_VERSION, operations: {} };
}

function publicOperation(operation) {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    operationId: operation.id,
    target: Object.freeze({ ...operation.target }),
    status: operation.status,
    steps: Object.freeze({ ...operation.steps }),
    counts: Object.freeze({ ...operation.counts }),
    generation: operation.generation,
    jobId: operation.jobId,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createPrivacyService(configuration) {
  exactObject(configuration, [
    'auth', 'tenancy', 'authorize', 'sources', 'store', 'jobs', 'limits', 'retention', 'clock',
  ], ['auth', 'tenancy', 'authorize', 'sources', 'store', 'jobs']);
  const { auth, tenancy, authorize, sources, store, jobs } = configuration;
  if (!auth || typeof auth.currentUser !== 'function' ||
      !tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      typeof authorize !== 'function' || !store || typeof store.get !== 'function' ||
      typeof store.put !== 'function' || !jobs || typeof jobs.enqueue !== 'function' ||
      typeof jobs.runOnce !== 'function' || typeof jobs.get !== 'function' ||
      !Array.isArray(sources) || sources.length < 1 || sources.length > 32) {
    fail('INVALID_CONFIGURATION');
  }

  const sourceMap = new Map();
  for (const rawSource of sources) {
    const source = exactObject(rawSource, ['id', 'enabled', 'export', 'erase', 'prune'],
      ['id', 'enabled']);
    if (typeof source.id !== 'string' || !SOURCE_ID.test(source.id) ||
        typeof source.enabled !== 'boolean' || sourceMap.has(source.id) ||
        (source.enabled && (typeof source.export !== 'function' ||
          typeof source.erase !== 'function')) ||
        (source.export !== undefined && typeof source.export !== 'function') ||
        (source.erase !== undefined && typeof source.erase !== 'function') ||
        (source.prune !== undefined && typeof source.prune !== 'function')) {
      fail('INVALID_CONFIGURATION');
    }
    sourceMap.set(source.id, Object.freeze({ ...source }));
  }

  const retention = new Map();
  if (configuration.retention !== undefined) {
    if (!Array.isArray(configuration.retention) || configuration.retention.length > sourceMap.size) {
      fail('INVALID_CONFIGURATION');
    }
    for (const rawRule of configuration.retention) {
      const rule = exactObject(rawRule, ['sourceId', 'retentionMs']);
      if (typeof rule.sourceId !== 'string' || !sourceMap.has(rule.sourceId) ||
          !sourceMap.get(rule.sourceId).enabled ||
          typeof sourceMap.get(rule.sourceId).prune !== 'function' ||
          !safeInteger(rule.retentionMs, 1) || rule.retentionMs > 3650 * 24 * 60 * 60 * 1000 ||
          retention.has(rule.sourceId)) fail('INVALID_CONFIGURATION');
      retention.set(rule.sourceId, rule.retentionMs);
    }
  }

  const limits = { ...DEFAULT_LIMITS };
  if (configuration.limits !== undefined) {
    exactObject(configuration.limits, Object.keys(DEFAULT_LIMITS), []);
    for (const [key, value] of Object.entries(configuration.limits)) {
      if (!safeInteger(value, 1) || value > HARD_LIMITS[key]) fail('INVALID_CONFIGURATION');
      limits[key] = value;
    }
  }
  const clock = configuration.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  const enabledSources = [...sourceMap.values()].filter(source => source.enabled);
  if (enabledSources.length === 0) fail('INVALID_CONFIGURATION');
  const sourceIds = enabledSources.map(source => source.id);

  async function resolveAccess(input, action, target) {
    if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
        typeof input.requestId !== 'string' || !SAFE_ID.test(input.requestId)) fail('INVALID_INPUT');
    const tenantId = validateId(input.tenantId);
    let user;
    let rawContext;
    try {
      [user, rawContext] = await Promise.all([
        auth.currentUser({ cookieHeader: input.cookieHeader }),
        tenancy.resolveTenantContext({
          cookieHeader: input.cookieHeader,
          tenantId,
          requestId: input.requestId,
        }),
      ]);
    } catch {
      fail('ACCESS_DENIED');
    }
    if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) fail('ACCESS_DENIED');
    const userId = user.id.toLowerCase();
    const context = exactObject(rawContext, ['contractVersion', 'tenantId', 'requestId'],
      undefined, 'ACCESS_DENIED');
    if (context.contractVersion !== CONTRACT_VERSION ||
        typeof context.tenantId !== 'string' || context.tenantId.toLowerCase() !== tenantId ||
        context.requestId !== input.requestId) fail('ACCESS_DENIED');
    const tenantContext = Object.freeze({
      contractVersion: CONTRACT_VERSION,
      tenantId,
      requestId: input.requestId,
    });
    if (target.type === 'user' && target.id !== userId ||
        target.type === 'tenant' && await isAuthorized({
          tenantContext, userId, action, target,
        }) !== true) fail('ACCESS_DENIED');
    return { tenantContext, tenantId, userId };
  }

  async function isAuthorized(input) {
    try {
      return await authorize(input);
    } catch {
      return false;
    }
  }

  async function readState(tenantContext) {
    let stored;
    try {
      stored = await store.get(tenantContext, STORAGE_KEY);
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (stored === undefined) return { state: emptyState(), version: undefined };
    try {
      const record = exactObject(stored, ['value', 'version'], undefined, 'CORRUPT_STATE');
      if (!safeInteger(record.version, 1)) fail('CORRUPT_STATE');
      return {
        state: validateState(record.value, sourceIds, limits),
        version: record.version,
      };
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      fail('CORRUPT_STATE');
    }
  }

  async function mutate(tenantContext, callback) {
    for (let attempt = 0; attempt < limits.maxWriteRetries; attempt += 1) {
      const current = await readState(tenantContext);
      const next = structuredClone(current.state);
      const result = callback(next);
      try {
        const version = await store.put(tenantContext, STORAGE_KEY, next, current.version);
        if (!safeInteger(version, 1)) fail('STORAGE_UNAVAILABLE');
        return result;
      } catch (error) {
        if (error?.code === 'CONFLICT') continue;
        if (error instanceof PrivacyError) throw error;
        fail('STORAGE_UNAVAILABLE');
      }
    }
    fail('STORAGE_BUSY');
  }

  async function requireOperationAccess(input, operation, action) {
    const target = operation.target;
    return resolveAccess(input, action, target);
  }

  function getNow() {
    const now = clock();
    if (!safeInteger(now)) fail('INVALID_CONFIGURATION');
    return now;
  }

  function validateIdempotencyKey(value) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('INVALID_INPUT');
    return value;
  }

  async function enqueueOperation(input, access, operation) {
    const operationId = operation.operationId;
    let job;
    try {
      job = await jobs.enqueue({
        cookieHeader: input.cookieHeader,
        tenantId: access.tenantId,
        requestId: access.tenantContext.requestId,
        type: JOB_TYPE,
        idempotencyKey: `privacy:${operationId}:${operation.generation}`,
        payload: { operationId, generation: operation.generation },
      });
    } catch {
      fail('JOB_QUEUE_UNAVAILABLE');
    }
    if (!job || typeof job.id !== 'string' || !UUID.test(job.id)) fail('JOB_QUEUE_UNAVAILABLE');
    return mutate(access.tenantContext, state => {
      const current = state.operations[operationId];
      if (!current || current.generation !== operation.generation) fail('OPERATION_CONFLICT');
      current.jobId = job.id;
      current.updatedAt = getNow();
      return publicOperation(current);
    });
  }

  async function handleErasure({ tenantContext, payload }) {
    exactObject(payload, ['operationId', 'generation']);
    if (typeof payload.operationId !== 'string' ||
        !/^[a-f0-9]{40}$/u.test(payload.operationId) ||
        !safeInteger(payload.generation, 1)) fail('INVALID_JOB');
    if (!tenantContext || tenantContext.contractVersion !== CONTRACT_VERSION ||
        typeof tenantContext.tenantId !== 'string' || !UUID.test(tenantContext.tenantId) ||
        typeof tenantContext.requestId !== 'string' || !SAFE_ID.test(tenantContext.requestId)) {
      fail('INVALID_JOB');
    }
    const context = Object.freeze({ ...tenantContext, tenantId: tenantContext.tenantId.toLowerCase() });
    let operation = await mutate(context, state => {
      const current = state.operations[payload.operationId];
      if (!current || current.generation !== payload.generation) fail('OPERATION_NOT_FOUND');
      if (current.status === 'succeeded') return publicOperation(current);
      current.status = 'running';
      current.lastError = null;
      current.updatedAt = getNow();
      return publicOperation(current);
    });
    if (operation.status === 'succeeded') return;

    for (const source of enabledSources) {
      const step = operation.steps[source.id];
      if (step === 'succeeded') continue;
      await mutate(context, state => {
        const current = state.operations[operation.operationId];
        current.steps[source.id] = 'running';
        current.updatedAt = getNow();
      });
      try {
        const count = await source.erase({
          tenantContext: context,
          target: operation.target,
          operationId: operation.operationId,
        });
        if (!safeInteger(count)) fail('INVALID_SOURCE_RESULT');
        operation = await mutate(context, state => {
          const current = state.operations[operation.operationId];
          current.steps[source.id] = 'succeeded';
          current.counts[source.id] = count;
          current.updatedAt = getNow();
          return publicOperation(current);
        });
      } catch {
        await mutate(context, state => {
          const current = state.operations[operation.operationId];
          current.steps[source.id] = 'pending';
          current.status = 'retrying';
          current.lastError = 'SOURCE_ERASURE_FAILED';
          current.updatedAt = getNow();
        }).catch(() => {});
        throw new Error('SOURCE_ERASURE_FAILED');
      }
    }
    await mutate(context, state => {
      const current = state.operations[operation.operationId];
      current.status = 'succeeded';
      current.lastError = null;
      current.updatedAt = getNow();
    });
  }

  return Object.freeze({
    contract: privacyContract,

    async exportData(rawInput) {
      exactObject(rawInput, [
        'cookieHeader', 'tenantId', 'requestId', 'scope', 'subjectId',
      ], ['cookieHeader', 'tenantId', 'requestId', 'scope']);
      const user = await auth.currentUser({ cookieHeader: rawInput.cookieHeader }).catch(() => null);
      if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) fail('ACCESS_DENIED');
      const target = validateTarget({
        scope: rawInput.scope,
        ...(rawInput.subjectId === undefined ? {} : { subjectId: rawInput.subjectId }),
      }, user.id.toLowerCase());
      const access = await resolveAccess(rawInput, 'privacy:export', target);
      const data = Object.create(null);
      const inventory = [];
      let totalBytes = 0;
      let totalRecords = 0;
      for (const source of sourceMap.values()) {
        if (!source.enabled) {
          inventory.push(Object.freeze({ sourceId: source.id, enabled: false, recordCount: 0, sha256: null }));
          continue;
        }
        let rows;
        try {
          rows = await source.export({ tenantContext: access.tenantContext, target });
        } catch {
          fail('SOURCE_UNAVAILABLE');
        }
        const normalized = normalizeRecords(rows, limits);
        totalBytes += Buffer.byteLength(normalized.json, 'utf8');
        totalRecords += normalized.records.length;
        if (totalBytes > limits.maxExportBytes || totalRecords > limits.maxExportRecords) {
          fail('EXPORT_LIMIT');
        }
        data[source.id] = normalized.records;
        inventory.push(Object.freeze({
          sourceId: source.id,
          enabled: true,
          recordCount: normalized.records.length,
          sha256: digest(normalized.json),
        }));
      }
      const manifest = {
        contractVersion: CONTRACT_VERSION,
        tenantId: access.tenantId,
        target,
        inventory,
        data,
      };
      deepFreeze(data);
      return Object.freeze({
        ...manifest,
        inventory: Object.freeze(inventory),
        data: Object.freeze(data),
        integrity: Object.freeze({
          algorithm: 'sha256',
          digest: digest(JSON.stringify(manifest)),
        }),
      });
    },

    async requestErasure(rawInput) {
      exactObject(rawInput, [
        'cookieHeader', 'tenantId', 'requestId', 'scope', 'subjectId', 'idempotencyKey',
      ], ['cookieHeader', 'tenantId', 'requestId', 'scope', 'idempotencyKey']);
      const user = await auth.currentUser({ cookieHeader: rawInput.cookieHeader }).catch(() => null);
      if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) fail('ACCESS_DENIED');
      const target = validateTarget({
        scope: rawInput.scope,
        ...(rawInput.subjectId === undefined ? {} : { subjectId: rawInput.subjectId }),
      }, user.id.toLowerCase());
      const access = await resolveAccess(rawInput, 'privacy:erase', target);
      const idempotencyKey = validateIdempotencyKey(rawInput.idempotencyKey);
      const idempotencyKeyHash = digest(idempotencyKey);
      const payloadHash = digest(JSON.stringify({ target, sources: enabledSources.map(source => source.id) }));
      const operationId = digest(`${access.tenantId}\0${idempotencyKey}`).slice(0, 40);
      const operation = await mutate(access.tenantContext, state => {
        const existing = state.operations[operationId];
        if (existing) {
          if (existing.idempotencyKeyHash !== idempotencyKeyHash ||
              existing.payloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT');
          return publicOperation(existing);
        }
        if (Object.keys(state.operations).length >= limits.maxOperations) fail('OPERATION_LIMIT');
        const now = getNow();
        const steps = Object.fromEntries(enabledSources.map(source => [source.id, 'pending']));
        const counts = Object.fromEntries(enabledSources.map(source => [source.id, 0]));
        const next = {
          id: operationId,
          idempotencyKeyHash,
          payloadHash,
          target,
          status: 'queued',
          steps,
          counts,
          generation: 1,
          jobId: null,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        state.operations[operationId] = next;
        return publicOperation(next);
      });
      if (operation.jobId) return operation;
      return enqueueOperation(rawInput, access, operation);
    },

    async retryErasure(rawInput) {
      exactObject(rawInput, [
        'cookieHeader', 'tenantId', 'requestId', 'operationId',
      ]);
      if (typeof rawInput.operationId !== 'string' || !/^[a-f0-9]{40}$/u.test(rawInput.operationId)) {
        fail('INVALID_INPUT');
      }
      const snapshot = await readState(await resolveAccess(rawInput, 'privacy:operation:read', {
        type: 'user',
        id: (await auth.currentUser({ cookieHeader: rawInput.cookieHeader }))?.id?.toLowerCase(),
      }).then(access => access.tenantContext));
      const operation = snapshot.state.operations[rawInput.operationId];
      if (!operation) fail('OPERATION_NOT_FOUND');
      const access = await requireOperationAccess(rawInput, operation, 'privacy:erase');
      if (operation.jobId) {
        try {
          const job = await jobs.get({
            cookieHeader: rawInput.cookieHeader,
            tenantId: access.tenantId,
            requestId: access.tenantContext.requestId,
            jobId: operation.jobId,
          });
          if (job?.status === 'failed' || job?.status === 'cancelled') operation.status = 'failed';
        } catch {
          fail('JOB_STATUS_UNAVAILABLE');
        }
      }
      if (operation.status !== 'failed') fail('OPERATION_NOT_RETRYABLE');
      const queued = await mutate(access.tenantContext, state => {
        const current = state.operations[operation.id];
        if (current.generation !== operation.generation) return publicOperation(current);
        current.generation += 1;
        current.status = 'queued';
        current.jobId = null;
        current.lastError = null;
        current.updatedAt = getNow();
        return publicOperation(current);
      });
      if (queued.jobId) return queued;
      return enqueueOperation(rawInput, access, queued);
    },

    async getOperation(rawInput) {
      exactObject(rawInput, [
        'cookieHeader', 'tenantId', 'requestId', 'operationId',
      ]);
      if (typeof rawInput.operationId !== 'string' || !/^[a-f0-9]{40}$/u.test(rawInput.operationId)) {
        fail('INVALID_INPUT');
      }
      const access = await resolveAccess(rawInput, 'privacy:operation:read', {
        type: 'user',
        id: (await auth.currentUser({ cookieHeader: rawInput.cookieHeader }))?.id?.toLowerCase(),
      });
      const snapshot = await readState(access.tenantContext);
      let operation = snapshot.state.operations[rawInput.operationId];
      if (!operation) fail('OPERATION_NOT_FOUND');
      if (operation.target.type === 'user' && operation.target.id !== access.userId) {
        fail('ACCESS_DENIED');
      }
      if (operation.target.type === 'tenant' &&
          await isAuthorized({
            tenantContext: access.tenantContext,
            userId: access.userId,
            action: 'privacy:operation:read',
            target: operation.target,
          }) !== true) fail('ACCESS_DENIED');
      if (operation.jobId && ['queued', 'running', 'retrying'].includes(operation.status)) {
        try {
          const job = await jobs.get({
            cookieHeader: rawInput.cookieHeader,
            tenantId: access.tenantId,
            requestId: access.tenantContext.requestId,
            jobId: operation.jobId,
          });
          if (job?.status === 'failed' || job?.status === 'cancelled') {
            operation = await mutate(access.tenantContext, state => {
              const current = state.operations[operation.id];
              current.status = 'failed';
              current.updatedAt = getNow();
              return current;
            });
          }
        } catch {
          fail('JOB_STATUS_UNAVAILABLE');
        }
      }
      return publicOperation(operation);
    },

    async runOnce() {
      return jobs.runOnce({ type: JOB_TYPE, handlers: { [JOB_TYPE]: handleErasure } });
    },

    async runRetention(rawInput) {
      exactObject(rawInput, ['cookieHeader', 'tenantId', 'requestId', 'now'],
        ['cookieHeader', 'tenantId', 'requestId']);
      const target = Object.freeze({ type: 'tenant', id: null });
      const access = await resolveAccess(rawInput, 'privacy:retention:run', target);
      const now = rawInput.now ?? getNow();
      if (!safeInteger(now)) fail('INVALID_INPUT');
      const results = [];
      for (const [sourceId, retentionMs] of retention) {
        const source = sourceMap.get(sourceId);
        const cutoff = now - retentionMs;
        if (!Number.isSafeInteger(cutoff)) fail('INVALID_CONFIGURATION');
        try {
          const deletedCount = await source.prune({
            tenantContext: access.tenantContext,
            cutoff,
          });
          if (!safeInteger(deletedCount)) fail('INVALID_SOURCE_RESULT');
          results.push(Object.freeze({ sourceId, cutoff, deletedCount }));
        } catch (error) {
          if (error instanceof PrivacyError) throw error;
          fail('SOURCE_UNAVAILABLE');
        }
      }
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        tenantId: access.tenantId,
        results: Object.freeze(results),
      });
    },
  });
}

export const privacyContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: '1.0.0',
  storageKey: STORAGE_KEY,
  jobType: JOB_TYPE,
  exportFormat: 'versioned-json-with-source-sha256-and-manifest-sha256',
  jobStates: STATUSES,
  guarantees: Object.freeze([
    'fail-closed-user-and-tenant-authorization',
    'tenant-partitioned-idempotent-erasure-with-persisted-step-progress',
    'adapter-idempotency-required-for-crash-recovery',
    'retention-cutoffs-configurable-per-enabled-source',
  ]),
  defaultLimits: DEFAULT_LIMITS,
  networkRequired: false,
});
