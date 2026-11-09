import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_EVENT = /^[a-z][a-z0-9._-]{0,63}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,47}$/u;
const SENSITIVE_FIELD = /(?:authorization|cookie|password|secret|token|email|phone|address|ip|user.?agent|payload|message|stack)/iu;
const SAFE_LOG_FIELDS = new Set(['operation', 'status', 'code', 'durationMs', 'count']);
const METRICS = Object.freeze([
  'requests_total',
  'errors_total',
  'readiness_failures_total',
  'audit_events_total',
  'cleanup_runs_total',
]);
const DEFAULT_LIMITS = Object.freeze({
  checkTimeoutMs: 1000,
  maxRecentErrors: 50,
  maxAuditFileBytes: 262144,
  maxAuditFiles: 10,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
});

export class ObservabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ObservabilityError';
    this.code = code;
  }
}

function fail(code) {
  throw new ObservabilityError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function nowValue(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(time) || time < 0) fail('UNAVAILABLE');
  return time;
}

function validateUuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
}

function validateSafeId(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(code);
  return value;
}

function validateAbsolutePath(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096 ||
      !path.isAbsolute(target) || path.resolve(target) !== target ||
      /[\0-\x1f\x7f]/u.test(target) ||
      target.split(path.sep).some(part => part === '.' || part === '..')) {
    fail('INVALID_CONFIGURATION');
  }
}

async function ensurePrivateDirectory(target) {
  validateAbsolutePath(target);
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('AUDIT_UNAVAILABLE');
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        if (createError.code !== 'EEXIST') fail('AUDIT_UNAVAILABLE');
      }
      info = await lstat(current).catch(() => null);
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
  }
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE');
  }
}

function validateLimits(limits = {}) {
  exactObject(limits, [
    'checkTimeoutMs',
    'maxRecentErrors',
    'maxAuditFileBytes',
    'maxAuditFiles',
    'auditRetentionMs',
  ], []);
  const result = { ...DEFAULT_LIMITS, ...limits };
  if (!Number.isSafeInteger(result.checkTimeoutMs) || result.checkTimeoutMs < 1 ||
      result.checkTimeoutMs > 5000 ||
      !Number.isSafeInteger(result.maxRecentErrors) || result.maxRecentErrors < 1 ||
      result.maxRecentErrors > 100 ||
      !Number.isSafeInteger(result.maxAuditFileBytes) || result.maxAuditFileBytes < 512 ||
      result.maxAuditFileBytes > 1024 * 1024 ||
      !Number.isSafeInteger(result.maxAuditFiles) || result.maxAuditFiles < 2 ||
      result.maxAuditFiles > 20 ||
      !Number.isSafeInteger(result.auditRetentionMs) || result.auditRetentionMs < 0 ||
      result.auditRetentionMs > 365 * 24 * 60 * 60 * 1000) {
    fail('INVALID_CONFIGURATION');
  }
  return result;
}

function validateContext(value) {
  exactObject(value, ['contractVersion', 'tenantId', 'requestId']);
  if (value.contractVersion !== CONTRACT_VERSION) fail('INVALID_INPUT');
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    tenantId: validateUuid(value.tenantId),
    requestId: validateUuid(value.requestId),
  });
}

function validateAuditEvent(value) {
  exactObject(value, ['action', 'outcome', 'resourceType', 'resourceId', 'actorId'],
    ['action', 'outcome', 'resourceType']);
  if (typeof value.action !== 'string' || !SAFE_EVENT.test(value.action) ||
      typeof value.outcome !== 'string' || !['success', 'failure', 'denied'].includes(value.outcome) ||
      typeof value.resourceType !== 'string' || !SAFE_EVENT.test(value.resourceType)) {
    fail('INVALID_INPUT');
  }
  const event = {
    action: value.action,
    outcome: value.outcome,
    resourceType: value.resourceType,
  };
  if (Object.hasOwn(value, 'resourceId')) event.resourceId = validateUuid(value.resourceId);
  if (Object.hasOwn(value, 'actorId')) event.actorId = validateUuid(value.actorId);
  return event;
}

function validateStoredAuditRecord(value) {
  try {
    exactObject(value, [
      'eventId',
      'recordedAt',
      'tenantId',
      'requestId',
      'action',
      'outcome',
      'resourceType',
      'resourceId',
      'actorId',
    ], ['eventId', 'recordedAt', 'tenantId', 'requestId', 'action', 'outcome', 'resourceType']);
    if (!UUID.test(value.eventId) || !Number.isFinite(Date.parse(value.recordedAt)) ||
        new Date(value.recordedAt).toISOString() !== value.recordedAt) fail('INVALID_INPUT');
    validateUuid(value.tenantId);
    validateUuid(value.requestId);
    validateAuditEvent(Object.fromEntries(
      Object.entries(value).filter(([key]) =>
        ['action', 'outcome', 'resourceType', 'resourceId', 'actorId'].includes(key)),
    ));
    return value;
  } catch {
    fail('AUDIT_UNAVAILABLE');
  }
}

function auditFilePath(directory, name) {
  return path.join(directory, name);
}

async function auditFiles(directory, maxBytes) {
  const names = await readdir(directory).catch(() => fail('AUDIT_UNAVAILABLE'));
  const files = [];
  for (const name of names) {
    if (name !== 'audit-current.jsonl' && !/^audit-\d{13}-[0-9a-f-]{36}\.jsonl$/u.test(name)) continue;
    const filePath = auditFilePath(directory, name);
    const info = await lstat(filePath).catch(() => fail('AUDIT_UNAVAILABLE'));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        info.size > maxBytes) fail('UNSAFE_STORAGE');
    files.push({ name, filePath, size: info.size, timestamp: Number(name.slice(6, 19)) });
  }
  files.sort((left, right) => left.timestamp - right.timestamp ||
    left.name.localeCompare(right.name));
  for (const file of files) {
    if (file.name === 'audit-current.jsonl') file.timestamp = Number.MAX_SAFE_INTEGER;
  }
  files.sort((left, right) => left.timestamp - right.timestamp ||
    left.name.localeCompare(right.name));
  return files;
}

async function createAuditFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.close();
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code !== 'EEXIST') fail('AUDIT_UNAVAILABLE');
  }
}

export function createObservabilityService(options) {
  exactObject(options, [
    'directory',
    'checks',
    'authorizeAuditRead',
    'writeLog',
    'clock',
    'limits',
  ], ['directory']);
  validateAbsolutePath(options.directory);
  const limits = validateLimits(options.limits);
  const clock = options.clock ?? Date.now;
  const writeLog = options.writeLog ?? (record => process.stdout.write(`${JSON.stringify(record)}\n`));
  if (typeof clock !== 'function' || typeof writeLog !== 'function') fail('INVALID_CONFIGURATION');

  const checks = options.checks ?? {};
  exactObject(checks, ['database', 'jobs'], []);
  for (const check of Object.values(checks)) {
    if (typeof check !== 'function') fail('INVALID_CONFIGURATION');
  }
  const authorizeAuditRead = options.authorizeAuditRead;
  if (authorizeAuditRead !== undefined && typeof authorizeAuditRead !== 'function') {
    fail('INVALID_CONFIGURATION');
  }

  const counters = Object.fromEntries(METRICS.map(name => [name, 0]));
  const errors = [];
  const errorCodes = new Map();
  const pendingChecks = new Map();
  const auditDirectory = path.join(options.directory, 'audit');
  let auditQueue = Promise.resolve();

  function recordError(input) {
    exactObject(input, ['code', 'requestId'], ['code']);
    const safeCode = typeof input.code === 'string' && SAFE_CODE.test(input.code)
      ? input.code
      : 'OTHER';
    const requestId = input.requestId ?? randomUUID();
    const safeRequestId = typeof requestId === 'string' && UUID.test(requestId)
      ? requestId.toLowerCase()
      : randomUUID();
    counters.errors_total += 1;
    const key = errorCodes.has(safeCode) || errorCodes.size < 32 ? safeCode : 'OTHER';
    errorCodes.set(key, (errorCodes.get(key) ?? 0) + 1);
    errors.push({
      timestamp: new Date(nowValue(clock)).toISOString(),
      code: key,
      requestId: safeRequestId,
    });
    if (errors.length > limits.maxRecentErrors) errors.splice(0, errors.length - limits.maxRecentErrors);
    return Object.freeze({ code: key, requestId: safeRequestId });
  }

  function safeLogRecord(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT');
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
    const descriptors = new Map();
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
      descriptors.set(key, descriptor.value);
    }
    if (!descriptors.has('level') || !descriptors.has('event')) fail('INVALID_INPUT');
    const level = descriptors.get('level');
    const event = descriptors.get('event');
    if (!['debug', 'info', 'warn', 'error'].includes(level) ||
        typeof event !== 'string' || !SAFE_EVENT.test(event)) fail('INVALID_INPUT');
    const redacted = [];
    const output = {
      timestamp: new Date(nowValue(clock)).toISOString(),
      level,
      event,
      requestId: typeof descriptors.get('requestId') === 'string' &&
        UUID.test(descriptors.get('requestId'))
        ? descriptors.get('requestId').toLowerCase()
        : randomUUID(),
    };
    for (const [key, value] of descriptors) {
      if (['level', 'event', 'requestId'].includes(key)) continue;
      if (!SAFE_LOG_FIELDS.has(key) || SENSITIVE_FIELD.test(key)) {
        redacted.push(key);
        continue;
      }
      if (key === 'durationMs' || key === 'count') {
        if (!Number.isFinite(value) || value < 0) {
          redacted.push(key);
          continue;
        }
      } else {
        const pattern = key === 'code' ? SAFE_CODE : SAFE_EVENT;
        if (typeof value !== 'string' || !pattern.test(value)) {
          redacted.push(key);
          continue;
        }
      }
      output[key] = value;
    }
    if (redacted.length) output.redactedFields = redacted.length;
    return output;
  }

  async function rotateExpiredCurrent() {
    const currentPath = auditFilePath(auditDirectory, 'audit-current.jsonl');
    let info = await lstat(currentPath).catch(error =>
      error.code === 'ENOENT' ? null : fail('AUDIT_UNAVAILABLE'));
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        info.size > limits.maxAuditFileBytes) fail('UNSAFE_STORAGE');
    let records;
    try {
      records = (await readFile(currentPath, 'utf8')).split('\n').filter(Boolean)
        .map(line => validateStoredAuditRecord(JSON.parse(line)));
    } catch {
      fail('AUDIT_UNAVAILABLE');
    }
    if (!records.length) return;
    const currentTime = nowValue(clock);
    const latestEventTime = Math.max(...records.map(record => Date.parse(record.recordedAt)));
    if (currentTime - latestEventTime <= limits.auditRetentionMs) return;
    const archivePath = auditFilePath(
      auditDirectory,
      `audit-${String(latestEventTime).padStart(13, '0')}-${randomUUID()}.jsonl`,
    );
    await rename(currentPath, archivePath).catch(() => fail('AUDIT_UNAVAILABLE'));
    await createAuditFile(currentPath);
  }

  async function pruneAuditFiles() {
    const currentTime = nowValue(clock);
    const files = await auditFiles(auditDirectory, limits.maxAuditFileBytes);
    const archives = files.filter(file => file.name !== 'audit-current.jsonl');
    const expired = archives.filter(file => currentTime - file.timestamp > limits.auditRetentionMs);
    for (const file of expired) {
      await unlink(file.filePath).catch(() => fail('AUDIT_UNAVAILABLE'));
    }
    const kept = archives.filter(file => !expired.includes(file));
    const archiveLimit = limits.maxAuditFiles - 1;
    for (const file of kept.slice(0, Math.max(0, kept.length - archiveLimit))) {
      await unlink(file.filePath).catch(() => fail('AUDIT_UNAVAILABLE'));
    }
  }

  async function appendAudit(contextValue, eventValue) {
    const context = validateContext(contextValue);
    const event = validateAuditEvent(eventValue);
    await ensurePrivateDirectory(auditDirectory);
    const recordedAt = new Date(nowValue(clock)).toISOString();
    const record = Object.freeze({
      eventId: randomUUID(),
      recordedAt,
      tenantId: context.tenantId,
      requestId: context.requestId,
      ...event,
    });
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > limits.maxAuditFileBytes) fail('AUDIT_LIMIT');

    const currentPath = auditFilePath(auditDirectory, 'audit-current.jsonl');
    let info = await lstat(currentPath).catch(error =>
      error.code === 'ENOENT' ? null : fail('AUDIT_UNAVAILABLE'));
    if (info && (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        info.size > limits.maxAuditFileBytes)) fail('UNSAFE_STORAGE');
    if (!info) {
      await createAuditFile(currentPath);
      info = await lstat(currentPath).catch(() => fail('AUDIT_UNAVAILABLE'));
    }
    if (info.size + bytes > limits.maxAuditFileBytes) {
      const archivePath = auditFilePath(
        auditDirectory,
        `audit-${String(nowValue(clock)).padStart(13, '0')}-${randomUUID()}.jsonl`,
      );
      await rename(currentPath, archivePath).catch(() => fail('AUDIT_UNAVAILABLE'));
      await createAuditFile(currentPath);
    }
    await pruneAuditFiles();

    let handle;
    try {
      handle = await open(currentPath, constants.O_WRONLY | constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } catch {
      fail('AUDIT_UNAVAILABLE');
    } finally {
      await handle?.close().catch(() => {});
    }
    counters.audit_events_total += 1;
    return Object.freeze({ eventId: record.eventId, recordedAt });
  }

  async function performCleanup() {
    await ensurePrivateDirectory(auditDirectory);
    await rotateExpiredCurrent();
    await pruneAuditFiles();
    const cutoff = nowValue(clock) - limits.auditRetentionMs;
    let removedErrors = 0;
    for (let index = errors.length - 1; index >= 0; index -= 1) {
      if (Date.parse(errors[index].timestamp) < cutoff) {
        errors.splice(index, 1);
        removedErrors += 1;
      }
    }
    counters.cleanup_runs_total += 1;
    return Object.freeze({ removedErrors, retainedErrors: errors.length });
  }

  function cleanup() {
    const operation = auditQueue.then(performCleanup);
    auditQueue = operation.catch(() => {});
    return operation;
  }

  async function readAuditRecords(contextValue) {
    const context = validateContext(contextValue);
    if (typeof authorizeAuditRead !== 'function') fail('AUDIT_READ_DENIED');
    let allowed = false;
    try {
      allowed = await authorizeAuditRead(context);
    } catch {
      allowed = false;
    }
    if (allowed !== true) fail('AUDIT_READ_DENIED');
    await ensurePrivateDirectory(auditDirectory);
    const files = await auditFiles(auditDirectory, limits.maxAuditFileBytes);
    const records = [];
    for (const file of files) {
      let contents;
      try {
        contents = await readFile(file.filePath, 'utf8');
      } catch {
        fail('AUDIT_UNAVAILABLE');
      }
      for (const line of contents.split('\n')) {
        if (!line) continue;
        let record;
        try {
          record = validateStoredAuditRecord(JSON.parse(line));
        } catch {
          fail('AUDIT_UNAVAILABLE');
        }
        if (record.tenantId === context.tenantId) records.push(record);
      }
    }
    return Object.freeze(records.slice(-1000).map(record => Object.freeze(record)));
  }

  function readAudit(contextValue) {
    let context;
    try {
      context = validateContext(contextValue);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = auditQueue.then(() => readAuditRecords(context));
    auditQueue = operation.catch(() => {});
    return operation;
  }

  async function scheduleCleanup(input) {
    exactObject(input, ['jobs', 'authorization', 'intervalMs']);
    if (!input.jobs || typeof input.jobs.enqueue !== 'function' ||
        !Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000 ||
        input.intervalMs > 24 * 60 * 60 * 1000) fail('INVALID_INPUT');
    exactObject(input.authorization, ['cookieHeader', 'tenantId', 'requestId']);
    if (typeof input.authorization.cookieHeader !== 'string' ||
        input.authorization.cookieHeader.length > 8192) fail('INVALID_INPUT');
    const tenantId = validateUuid(input.authorization.tenantId);
    const requestId = validateSafeId(input.authorization.requestId);
    const slot = Math.floor(nowValue(clock) / input.intervalMs);
    try {
      const job = await input.jobs.enqueue({
        cookieHeader: input.authorization.cookieHeader,
        tenantId,
        requestId,
        type: 'observability.cleanup',
        idempotencyKey: `observability-cleanup-${slot}`,
        payload: {},
      });
      if (!job || !UUID.test(job.id)) fail('JOBS_UNAVAILABLE');
      return Object.freeze({ jobId: job.id.toLowerCase(), status: job.status });
    } catch {
      fail('JOBS_UNAVAILABLE');
    }
  }

  async function readiness() {
    const results = {};
    for (const name of ['database', 'jobs']) {
      if (typeof checks[name] !== 'function') continue;
      if (pendingChecks.has(name)) {
        results[name] = 'unavailable';
        continue;
      }
      let timeout;
      const controller = new AbortController();
      const checkPromise = Promise.resolve().then(() =>
        checks[name]({ signal: controller.signal }));
      pendingChecks.set(name, checkPromise);
      const clearPending = () => {
        if (pendingChecks.get(name) === checkPromise) pendingChecks.delete(name);
      };
      checkPromise.then(clearPending, clearPending);
      try {
        const result = await Promise.race([
          checkPromise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('timeout')), limits.checkTimeoutMs);
          }),
        ]);
        results[name] = result === true ? 'ok' : 'unavailable';
      } catch {
        controller.abort();
        results[name] = 'unavailable';
      } finally {
        clearTimeout(timeout);
      }
    }
    const ready = Object.values(results).every(value => value === 'ok');
    if (!ready) counters.readiness_failures_total += 1;
    return Object.freeze({ status: ready ? 'ok' : 'unavailable', checks: Object.freeze(results) });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    liveness() {
      return Object.freeze({ status: 'ok' });
    },
    readiness,
    environmentDiagnostics() {
      return Object.freeze({
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        environment: ['development', 'test', 'production'].includes(process.env.NODE_ENV)
          ? process.env.NODE_ENV
          : 'unspecified',
        uptimeSeconds: Math.floor(process.uptime()),
      });
    },
    log(input) {
      const record = safeLogRecord(input);
      try {
        const result = writeLog(Object.freeze(record));
        if (result && typeof result.then === 'function') {
          return result.then(() => true, () => false);
        }
        return true;
      } catch {
        return false;
      }
    },
    recordError,
    recordRequest() {
      counters.requests_total += 1;
      return counters.requests_total;
    },
    metrics() {
      return Object.freeze({
        counters: Object.freeze({ ...counters }),
        errorsByCode: Object.freeze(Object.fromEntries(errorCodes)),
        recentErrors: Object.freeze(errors.map(error => Object.freeze({ ...error }))),
      });
    },
    audit: Object.freeze({
      append(context, event) {
        let safeContext;
        let safeEvent;
        try {
          safeContext = validateContext(context);
          safeEvent = validateAuditEvent(event);
        } catch (error) {
          return Promise.reject(error);
        }
        const operation = auditQueue.then(() => appendAudit(safeContext, safeEvent));
        auditQueue = operation.catch(() => {});
        return operation;
      },
      read: readAudit,
    }),
    cleanup,
    createCleanupHandler() {
      return async ({ signal } = {}) => {
        if (signal?.aborted) fail('INTERRUPTED');
        const result = await cleanup();
        return result;
      };
    },
    scheduleCleanup,
  });
}

export const observabilityContract = Object.freeze({
  version: CONTRACT_VERSION,
  storage: 'local-private-append-only-jsonl',
  metrics: METRICS,
  logging: Object.freeze({
    format: 'json-lines',
    correlationId: 'uuid',
    redaction: 'allowlisted-fields-only; sensitive-and-unknown-fields-dropped',
  }),
  healthChecks: Object.freeze(['liveness', 'readiness']),
  remoteMonitoring: false,
});
