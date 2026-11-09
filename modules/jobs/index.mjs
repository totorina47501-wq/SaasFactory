import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const FILE_NAME = 'jobs-v1.json';
const LOCK_NAME = 'jobs-v1.lock';
const SAFE_TYPE = /^[a-z][a-z0-9._-]{0,63}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|private.?key|api.?key)/iu;
const DEFAULTS = Object.freeze({
  maxQueueSize: 1000,
  maxWorkers: 2,
  maxAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  leaseMs: 30000,
  maxTimeoutMs: 300000,
  maxCpuBudgetMs: 60000,
  maxMemoryBudgetBytes: 512 * 1024 * 1024,
  maxPayloadBytes: 65536,
  maxEvents: 1000,
  maxStorageBytes: 64 * 1024 * 1024,
  lockWaitMs: 5000,
  staleLockMs: 60000,
});
const JOB_FIELDS = [
  'id', 'tenantId', 'requestId', 'type', 'idempotencyKey', 'payload', 'payloadHash',
  'status', 'attempt', 'maxAttempts', 'createdAt', 'availableAt', 'updatedAt', 'lease',
  'cancelRequestedAt', 'timeoutMs', 'cpuBudgetMs', 'memoryBudgetBytes', 'errorCode',
  'resourceUsage',
];

export class JobsModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JobsModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new JobsModuleError(code);
}

function exactInput(value, expected, required = expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializePayload(value, maxBytes) {
  if (!plainRecord(value)) fail('INVALID_PAYLOAD');
  const seen = new Set();
  function inspect(entry, depth = 0) {
    if (depth > 32) fail('INVALID_PAYLOAD');
    if (entry === null || ['string', 'boolean'].includes(typeof entry)) return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail('INVALID_PAYLOAD');
      return;
    }
    if (typeof entry !== 'object' || seen.has(entry)) fail('INVALID_PAYLOAD');
    if (!Array.isArray(entry) && !plainRecord(entry)) fail('INVALID_PAYLOAD');
    seen.add(entry);
    let arrayKeys = 0;
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(entry) && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__' || SENSITIVE_KEY.test(key)) {
        fail('INVALID_PAYLOAD');
      }
      if (Array.isArray(entry)) {
        if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= entry.length) fail('INVALID_PAYLOAD');
        arrayKeys += 1;
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_PAYLOAD');
      inspect(descriptor.value, depth + 1);
    }
    if (Array.isArray(entry) && arrayKeys !== entry.length) fail('INVALID_PAYLOAD');
    seen.delete(entry);
  }
  inspect(value);
  function canonical(entry) {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (plainRecord(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map(key => [key, canonical(entry[key])]));
    }
    return entry;
  }
  let serialized;
  try {
    serialized = JSON.stringify(canonical(value));
  } catch {
    fail('INVALID_PAYLOAD');
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    fail('PAYLOAD_TOO_LARGE');
  }
  return serialized;
}

function validateTenantContext(context) {
  if (!plainRecord(context)) fail('INVALID_TENANT_CONTEXT');
  const keys = Reflect.ownKeys(context);
  if (keys.length !== 3 || keys.some(key => !['contractVersion', 'tenantId', 'requestId'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(context, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail('INVALID_TENANT_CONTEXT');
  const { contractVersion, tenantId, requestId } = Object.fromEntries(keys.map(key =>
    [key, Object.getOwnPropertyDescriptor(context, key).value]));
  if (contractVersion !== 1 || typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId) ||
      typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(requestId)) {
    fail('INVALID_TENANT_CONTEXT');
  }
  return { tenantId: tenantId.toLowerCase(), requestId };
}

function validateConfiguration(configuration) {
  exactInput(configuration, [
    'directory', 'tenancy', 'limits', 'clock', 'notify',
  ], ['directory', 'tenancy']);
  if (typeof configuration.directory !== 'string' || !isAbsolute(configuration.directory) ||
      !configuration.tenancy || typeof configuration.tenancy.resolveTenantContext !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = { ...DEFAULTS };
  if (configuration.limits !== undefined) {
    exactInput(configuration.limits, Object.keys(DEFAULTS), []);
    for (const [key, value] of Object.entries(configuration.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_CONFIGURATION');
      limits[key] = value;
    }
  }
  if (limits.retryMaxMs < limits.retryBaseMs ||
      limits.maxTimeoutMs > 24 * 60 * 60 * 1000 ||
      limits.maxPayloadBytes > 1024 * 1024 ||
      limits.maxQueueSize > 100000 ||
      limits.maxStorageBytes > 1024 * 1024 * 1024 ||
      limits.maxWorkers > 128 ||
      limits.maxAttempts > 20) fail('INVALID_CONFIGURATION');
  if (configuration.clock !== undefined && typeof configuration.clock !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  if (configuration.notify !== undefined && typeof configuration.notify !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  return {
    directory: resolve(configuration.directory),
    tenancy: configuration.tenancy,
    limits,
    clock: configuration.clock ?? Date.now,
    notify: configuration.notify,
  };
}

async function ensurePrivateDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
  }
  let info;
  let canonical;
  try {
    info = await lstat(directory);
    canonical = await realpath(directory);
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== directory ||
      (info.mode & 0o077) !== 0) fail('UNSAFE_STORAGE_DIRECTORY');
}

async function readLock(lockPath, staleLockMs) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      if (Date.now() - info.mtimeMs > staleLockMs) return 'stale';
      return 'active';
    }
    if (!Number.isSafeInteger(owner.pid) || typeof owner.token !== 'string') {
      return Date.now() - info.mtimeMs > staleLockMs ? 'stale' : 'active';
    }
    try {
      process.kill(owner.pid, 0);
      return 'active';
    } catch (error) {
      if (error?.code === 'EPERM') return 'active';
      return 'stale';
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function acquireLock(lockPath, limits) {
  const token = randomUUID();
  const started = Date.now();
  while (Date.now() - started <= limits.lockWaitMs) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      await handle.sync();
      return {
        async release() {
          try {
            const contents = JSON.parse(await readFile(lockPath, 'utf8'));
            if (contents.token === token) await unlink(lockPath);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          } finally {
            await handle.close();
          }
        },
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      if (error?.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
      const status = await readLock(lockPath, limits.staleLockMs).catch(() => 'active');
      if (status === 'stale') {
        try {
          await unlink(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') fail('STORAGE_UNAVAILABLE');
        }
      } else {
        await delay(10);
      }
    }
  }
  fail('QUEUE_BUSY');
}

function emptyState() {
  return { version: 1, jobs: {}, events: [] };
}

function validateState(state, limits) {
  if (!plainRecord(state) || Object.keys(state).sort().join(',') !== 'events,jobs,version' ||
      state.version !== 1 || !plainRecord(state.jobs) || !Array.isArray(state.events) ||
      state.events.length > limits.maxEvents) {
    fail('CORRUPT_QUEUE');
  }
  for (const [id, job] of Object.entries(state.jobs)) {
    if (!plainRecord(job) || Object.keys(job).sort().join(',') !== [...JOB_FIELDS].sort().join(',') ||
        id !== job.id || !UUID_PATTERN.test(id) || typeof job.tenantId !== 'string' ||
        !UUID_PATTERN.test(job.tenantId) || typeof job.requestId !== 'string' ||
        !SAFE_TYPE.test(job.type) || typeof job.idempotencyKey !== 'string' ||
        !SAFE_IDEMPOTENCY_KEY.test(job.idempotencyKey) || typeof job.payloadHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(job.payloadHash) ||
        !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status) ||
        !Number.isSafeInteger(job.attempt) || !Number.isSafeInteger(job.maxAttempts) ||
        job.attempt < 0 || job.attempt > job.maxAttempts ||
        job.maxAttempts > limits.maxAttempts ||
        !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.availableAt) ||
        !Number.isSafeInteger(job.updatedAt) ||
        !Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1 ||
        job.timeoutMs > limits.maxTimeoutMs ||
        !Number.isSafeInteger(job.cpuBudgetMs) || job.cpuBudgetMs < 1 ||
        job.cpuBudgetMs > limits.maxCpuBudgetMs ||
        !Number.isSafeInteger(job.memoryBudgetBytes) || job.memoryBudgetBytes < 1 ||
        job.memoryBudgetBytes > limits.maxMemoryBudgetBytes ||
        (job.errorCode !== null &&
          (typeof job.errorCode !== 'string' || !ERROR_CODE.test(job.errorCode))) ||
        (job.cancelRequestedAt !== null && !Number.isSafeInteger(job.cancelRequestedAt)) ||
        (job.status === 'running') !== plainRecord(job.lease) ||
        (job.lease !== null && job.lease !== undefined &&
          (Object.keys(job.lease).sort().join(',') !== 'expiresAt,token' ||
           typeof job.lease.token !== 'string' || !UUID_PATTERN.test(job.lease.token) ||
           !Number.isSafeInteger(job.lease.expiresAt))) ||
        (job.resourceUsage !== null && job.resourceUsage !== undefined &&
          (!plainRecord(job.resourceUsage) ||
           Object.keys(job.resourceUsage).sort().join(',') !== 'measurement,processCpuMs,processRssBytes' ||
           !Number.isSafeInteger(job.resourceUsage.processCpuMs) ||
           !Number.isSafeInteger(job.resourceUsage.processRssBytes) ||
           typeof job.resourceUsage.measurement !== 'string'))) fail('CORRUPT_QUEUE');
    let payloadText;
    try {
      payloadText = serializePayload(job.payload, limits.maxPayloadBytes);
    } catch {
      fail('CORRUPT_QUEUE');
    }
    if (createHash('sha256').update(payloadText, 'utf8').digest('hex') !== job.payloadHash) {
      fail('CORRUPT_QUEUE');
    }
  }
  for (const event of state.events) {
    if (!plainRecord(event) || Object.keys(event).sort().join(',') !==
        ['jobId', 'tenantId', 'type', 'occurredAt', 'attempt'].sort().join(',') ||
        !state.jobs[event.jobId] || !UUID_PATTERN.test(event.tenantId) ||
        state.jobs[event.jobId].tenantId !== event.tenantId ||
        !/^job\.[a-z-]+$/u.test(event.type) || !Number.isSafeInteger(event.occurredAt) ||
        !Number.isSafeInteger(event.attempt)) fail('CORRUPT_QUEUE');
  }
  return state;
}

async function readState(filePath, limits) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    fail('STORAGE_UNAVAILABLE');
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE');
  }
  if (info.size > limits.maxStorageBytes) fail('STORAGE_LIMIT');
  try {
    return validateState(JSON.parse(await readFile(filePath, 'utf8')), limits);
  } catch (error) {
    if (error instanceof JobsModuleError) throw error;
    fail('CORRUPT_QUEUE');
  }
}

async function writeState(directory, filePath, state, limits) {
  const temporary = resolve(directory, `.jobs-v1-${randomUUID()}.tmp`);
  let handle;
  try {
    const contents = JSON.stringify(state);
    if (Buffer.byteLength(contents, 'utf8') > limits.maxStorageBytes) fail('STORAGE_LIMIT');
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof JobsModuleError) throw error;
    fail('STORAGE_UNAVAILABLE');
  }
}

function publicJob(job) {
  return Object.freeze({
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    availableAt: job.availableAt,
    updatedAt: job.updatedAt,
    errorCode: job.errorCode,
    resourceUsage: job.resourceUsage,
  });
}

function publicEvent(event) {
  return Object.freeze({
    jobId: event.jobId,
    type: event.type,
    occurredAt: event.occurredAt,
    attempt: event.attempt,
  });
}

function validateHandlers(handlers) {
  if (!plainRecord(handlers)) fail('INVALID_INPUT');
  for (const key of Reflect.ownKeys(handlers)) {
    if (typeof key !== 'string' || !SAFE_TYPE.test(key)) fail('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function') fail('INVALID_INPUT');
  }
}

export function createJobsService(configuration) {
  const config = validateConfiguration(configuration);
  const { directory, tenancy, limits, clock, notify } = config;
  const filePath = resolve(directory, FILE_NAME);
  const lockPath = resolve(directory, LOCK_NAME);
  const activeControllers = new Map();
  const listeners = new Set();

  async function authorizedContext(input) {
    if (typeof input.cookieHeader !== 'string' || typeof input.tenantId !== 'string' ||
        typeof input.requestId !== 'string') fail('INVALID_INPUT');
    let result;
    try {
      result = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    return validateTenantContext(result);
  }

  async function update(operation) {
    await ensurePrivateDirectory(directory);
    const lock = await acquireLock(lockPath, limits);
    let events = [];
    try {
      const state = await readState(filePath, limits);
      const result = await operation(state, event => {
        state.events.push(event);
        if (state.events.length > limits.maxEvents) {
          state.events.splice(0, state.events.length - limits.maxEvents);
        }
        events.push(event);
      });
      await writeState(directory, filePath, state, limits);
      return { result, events };
    } finally {
      await lock.release();
    }
  }

  function publish(events) {
    for (const event of events) {
      const safe = publicEvent(event);
      for (const listener of listeners) {
        try {
          Promise.resolve(listener(safe)).catch(() => {});
        } catch {
          // Notification failures must not affect durable queue state.
        }
      }
      try {
        Promise.resolve(notify?.(safe)).catch(() => {});
      } catch {
        // Notification failures must not affect durable queue state.
      }
    }
  }

  function addEvent(state, job, type, now) {
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      type,
      occurredAt: now,
      attempt: job.attempt,
    };
  }

  function record(state, job, type, now, emit) {
    job.updatedAt = now;
    emit(addEvent(state, job, type, now));
  }

  function recoverExpired(state, now, emit) {
    for (const job of Object.values(state.jobs)) {
      if (job.status !== 'running' || job.lease.expiresAt > now) continue;
      job.lease = null;
      if (job.cancelRequestedAt !== null) {
        job.status = 'cancelled';
        job.errorCode = null;
        record(state, job, 'job.cancelled', now, emit);
      } else if (job.attempt >= job.maxAttempts) {
        job.status = 'failed';
        job.errorCode = 'LEASE_EXPIRED';
        record(state, job, 'job.failed', now, emit);
      } else {
        job.status = 'queued';
        job.availableAt = now;
        job.errorCode = 'LEASE_EXPIRED';
        record(state, job, 'job.retrying', now, emit);
      }
    }
  }

  async function claim(type) {
    const { result, events } = await update((state, emit) => {
      const now = validateNow(clock);
      recoverExpired(state, now, emit);
      const active = Object.values(state.jobs).filter(job => job.status === 'running').length;
      if (active >= limits.maxWorkers) return null;
      const job = Object.values(state.jobs)
        .filter(entry => entry.status === 'queued' && entry.availableAt <= now &&
          (type === undefined || entry.type === type))
        .sort((left, right) => left.availableAt - right.availableAt ||
          left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
      if (!job) return null;
      const token = randomUUID();
      job.status = 'running';
      job.attempt += 1;
      job.lease = { token, expiresAt: now + limits.leaseMs };
      job.errorCode = null;
      record(state, job, 'job.started', now, emit);
      return { id: job.id, leaseToken: token, type: job.type, tenantId: job.tenantId,
        requestId: job.requestId, payload: job.payload, timeoutMs: job.timeoutMs,
        cpuBudgetMs: job.cpuBudgetMs, memoryBudgetBytes: job.memoryBudgetBytes, attempt: job.attempt };
    });
    publish(events);
    return result;
  }

  async function heartbeat(id, token) {
    const { result, events } = await update((state, emit) => {
      const job = state.jobs[id];
      if (!job || job.status !== 'running' || job.lease?.token !== token) return null;
      const now = validateNow(clock);
      if (job.cancelRequestedAt !== null) return { cancel: true };
      job.lease.expiresAt = now + limits.leaseMs;
      job.updatedAt = now;
      return { cancel: false };
    });
    publish(events);
    return result;
  }

  async function finalize(claimed, errorCode, resourceUsage) {
    const { events } = await update((state, emit) => {
      const job = state.jobs[claimed.id];
      if (!job || job.status !== 'running' || job.lease?.token !== claimed.leaseToken) return;
      const now = validateNow(clock);
      job.lease = null;
      job.resourceUsage = resourceUsage ?? null;
      if (job.cancelRequestedAt !== null) {
        job.status = 'cancelled';
        job.errorCode = null;
        record(state, job, 'job.cancelled', now, emit);
      } else if (errorCode) {
        if (job.attempt < job.maxAttempts) {
          const backoff = Math.min(limits.retryMaxMs, limits.retryBaseMs * (2 ** (job.attempt - 1)));
          job.status = 'queued';
          job.availableAt = now + backoff;
          job.errorCode = errorCode;
          record(state, job, 'job.retrying', now, emit);
        } else {
          job.status = 'failed';
          job.errorCode = errorCode;
          record(state, job, 'job.failed', now, emit);
        }
      } else {
        job.status = 'succeeded';
        job.errorCode = null;
        record(state, job, 'job.succeeded', now, emit);
      }
    });
    publish(events);
  }

  async function execute(claimed, handler) {
    const controller = new AbortController();
    activeControllers.set(claimed.id, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new JobsModuleError('JOB_TIMEOUT'));
    }, claimed.timeoutMs);
    const heartbeatInterval = Math.max(10, Math.floor(limits.leaseMs / 3));
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(async () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        const lease = await heartbeat(claimed.id, claimed.leaseToken);
        if (!lease || lease.cancel) controller.abort(new JobsModuleError(
          lease?.cancel ? 'JOB_CANCELLED' : 'LEASE_LOST'));
      } catch {
        controller.abort(new JobsModuleError('LEASE_LOST'));
      } finally {
        heartbeatInFlight = false;
      }
    }, heartbeatInterval);
    const cpuStart = process.cpuUsage();
    let errorCode;
    try {
      await handler(Object.freeze({
        jobId: claimed.id,
        tenantContext: Object.freeze({
          contractVersion: 1,
          tenantId: claimed.tenantId,
          requestId: claimed.requestId,
        }),
        payload: Object.freeze(claimed.payload),
        signal: controller.signal,
        attempt: claimed.attempt,
        limits: Object.freeze({
          timeoutMs: claimed.timeoutMs,
          cpuBudgetMs: claimed.cpuBudgetMs,
          memoryBudgetBytes: claimed.memoryBudgetBytes,
          cpuMemoryEnforcedByOs: false,
        }),
      }));
      if (timedOut) errorCode = 'JOB_TIMEOUT';
      else if (controller.signal.aborted) {
        errorCode = controller.signal.reason?.code === 'JOB_CANCELLED' ? undefined : 'LEASE_LOST';
      }
    } catch (error) {
      if (timedOut) errorCode = 'JOB_TIMEOUT';
      else if (controller.signal.aborted &&
          controller.signal.reason?.code === 'JOB_CANCELLED') errorCode = undefined;
      else if (controller.signal.aborted) errorCode = 'LEASE_LOST';
      else errorCode = ERROR_CODE.test(error?.code ?? '') ? error.code : 'JOB_FAILED';
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeatTimer);
      activeControllers.delete(claimed.id);
    }
    const cpu = process.cpuUsage(cpuStart);
    const resourceUsage = Object.freeze({
      processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      processRssBytes: process.memoryUsage().rss,
      measurement: 'process-wide; advisory, not an OS-enforced per-job limit',
    });
    const exceedsBudget = resourceUsage.processCpuMs > claimed.cpuBudgetMs ||
      resourceUsage.processRssBytes > claimed.memoryBudgetBytes;
    if (exceedsBudget) {
      const { events } = await update((state, emit) => {
        const job = state.jobs[claimed.id];
        if (job?.status === 'running' && job.lease?.token === claimed.leaseToken) {
          emit(addEvent(state, job, 'job.resource-budget-exceeded', validateNow(clock)));
        }
      });
      publish(events);
    }
    await finalize(claimed, errorCode, resourceUsage);
  }

  async function runClaimed(input) {
    const claimed = await claim(input?.type);
    if (!claimed) return false;
    const handler = input.handlers[claimed.type];
    if (typeof handler !== 'function') {
      await finalize(claimed, 'HANDLER_UNAVAILABLE', undefined);
      return true;
    }
    await execute(claimed, handler);
    return true;
  }

  return Object.freeze({
    contract: jobsContract,

    async enqueue(input) {
      exactInput(input, [
        'cookieHeader', 'tenantId', 'requestId', 'type', 'idempotencyKey', 'payload',
        'maxAttempts', 'timeoutMs', 'cpuBudgetMs', 'memoryBudgetBytes',
      ], [
        'cookieHeader', 'tenantId', 'requestId', 'type', 'idempotencyKey', 'payload',
      ]);
      const context = await authorizedContext(input);
      if (typeof input.type !== 'string' || !SAFE_TYPE.test(input.type) ||
          typeof input.idempotencyKey !== 'string' ||
          !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail('INVALID_INPUT');
      const payloadText = serializePayload(input.payload, limits.maxPayloadBytes);
      const payloadHash = createHash('sha256').update(payloadText, 'utf8').digest('hex');
      const maxAttempts = input.maxAttempts ?? limits.maxAttempts;
      const timeoutMs = input.timeoutMs ?? limits.maxTimeoutMs;
      const cpuBudgetMs = input.cpuBudgetMs ?? limits.maxCpuBudgetMs;
      const memoryBudgetBytes = input.memoryBudgetBytes ?? limits.maxMemoryBudgetBytes;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
          maxAttempts > limits.maxAttempts || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
          timeoutMs > limits.maxTimeoutMs || !Number.isSafeInteger(cpuBudgetMs) ||
          cpuBudgetMs < 1 || cpuBudgetMs > limits.maxCpuBudgetMs ||
          !Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes < 1 ||
          memoryBudgetBytes > limits.maxMemoryBudgetBytes) fail('INVALID_INPUT');
      const { result, events } = await update((state, emit) => {
        const existing = Object.values(state.jobs).find(job =>
          job.tenantId === context.tenantId && job.idempotencyKey === input.idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash || existing.type !== input.type) {
            fail('IDEMPOTENCY_CONFLICT');
          }
          return publicJob(existing);
        }
        const current = Object.values(state.jobs).filter(job =>
          ['queued', 'running'].includes(job.status)).length;
        if (current >= limits.maxQueueSize) fail('QUEUE_FULL');
        const now = validateNow(clock);
        const job = {
          id: randomUUID(),
          tenantId: context.tenantId,
          requestId: context.requestId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          payload: JSON.parse(payloadText),
          payloadHash,
          status: 'queued',
          attempt: 0,
          maxAttempts,
          createdAt: now,
          availableAt: now,
          updatedAt: now,
          lease: null,
          cancelRequestedAt: null,
          timeoutMs,
          cpuBudgetMs,
          memoryBudgetBytes,
          errorCode: null,
          resourceUsage: null,
        };
        state.jobs[job.id] = job;
        emit(addEvent(state, job, 'job.queued', now));
        return publicJob(job);
      });
      publish(events);
      return result;
    },

    async get(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'jobId']);
      const context = await authorizedContext(input);
      const { result } = await update(state => {
        const job = state.jobs[input.jobId];
        if (!job || job.tenantId !== context.tenantId) fail('NOT_FOUND');
        return publicJob(job);
      });
      return result;
    },

    async list(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await authorizedContext(input);
      const { result } = await update(state => Object.values(state.jobs)
        .filter(job => job.tenantId === context.tenantId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(publicJob));
      return Object.freeze(result);
    },

    async events(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await authorizedContext(input);
      const { result } = await update(state => state.events
        .filter(event => event.tenantId === context.tenantId)
        .map(publicEvent));
      return Object.freeze(result);
    },

    async cancel(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'jobId']);
      const context = await authorizedContext(input);
      const { result, events } = await update((state, emit) => {
        const job = state.jobs[input.jobId];
        if (!job || job.tenantId !== context.tenantId) fail('NOT_FOUND');
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.cancelRequestedAt = validateNow(clock);
          record(state, job, 'job.cancelled', job.cancelRequestedAt, emit);
        } else if (job.status === 'running' && job.cancelRequestedAt === null) {
          job.cancelRequestedAt = validateNow(clock);
          record(state, job, 'job.cancel-requested', job.cancelRequestedAt, emit);
        }
        return publicJob(job);
      });
      activeControllers.get(input.jobId)?.abort(new JobsModuleError('JOB_CANCELLED'));
      publish(events);
      return result;
    },

    async runOnce(input) {
      exactInput(input, ['handlers', 'type'], ['handlers']);
      validateHandlers(input.handlers);
      if (input.type !== undefined && (typeof input.type !== 'string' || !SAFE_TYPE.test(input.type))) {
        fail('INVALID_INPUT');
      }
      return runClaimed(input);
    },

    async run(input) {
      exactInput(input, ['handlers', 'concurrency', 'pollIntervalMs', 'signal'], ['handlers']);
      validateHandlers(input.handlers);
      const concurrency = input.concurrency ?? limits.maxWorkers;
      const pollIntervalMs = input.pollIntervalMs ?? 250;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
          !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 ||
          (input.signal !== undefined && !(input.signal instanceof AbortSignal))) fail('INVALID_INPUT');
      const workers = Math.min(concurrency, limits.maxWorkers);
      const worker = async () => {
        while (!input.signal?.aborted) {
          const didWork = await runClaimed({ handlers: input.handlers });
          if (!didWork) await delay(pollIntervalMs, undefined, { signal: input.signal }).catch(() => {});
        }
      };
      const promises = Array.from({ length: workers }, () => worker());
      await Promise.all(promises);
    },

    subscribe(listener) {
      if (typeof listener !== 'function') fail('INVALID_INPUT');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

  });
}

export const jobsContract = Object.freeze({
  version: 1,
  states: Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  persistence: 'local-json-atomic-replace',
  execution: 'explicit-start-only',
  limitEnforcement: Object.freeze({
    queueSize: 'enforced',
    maxWorkers: 'enforced-across-local-processes',
    payloadBytes: 'enforced',
    cpuBudgetMs: 'process-wide-advisory',
    memoryBudgetBytes: 'process-rss-advisory',
    timeoutMs: 'cooperative-abort-signal',
    operatingSystemQuotaDetected: false,
  }),
});
