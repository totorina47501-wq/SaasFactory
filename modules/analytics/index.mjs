import { aggregateGrowth } from '../../growth/core/metrics.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUBJECT_PATTERN = /^[a-f0-9]{64}$/u;
const FEATURE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/u;
const EVENT_TYPES = Object.freeze(['feature.used', 'visit', 'signup', 'trial']);
const DEFAULT_LIMITS = Object.freeze({
  retentionDays: 30,
  minGroupSize: 5,
  maxEventsPerDay: 10000,
  maxEventsPerTenant: 10000,
});

export class AnalyticsModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AnalyticsModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new AnalyticsModuleError(code);
}

function exactObject(value, expected, required = expected) {
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

function validateContext(value) {
  try {
    exactObject(value, ['contractVersion', 'tenantId', 'requestId']);
  } catch {
    fail('INVALID_TENANT_CONTEXT');
  }
  if (value.contractVersion !== 1 || typeof value.tenantId !== 'string' ||
      !UUID_PATTERN.test(value.tenantId) || typeof value.requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.requestId)) {
    fail('INVALID_TENANT_CONTEXT');
  }
  return Object.freeze({
    contractVersion: 1,
    tenantId: value.tenantId.toLowerCase(),
    requestId: value.requestId,
  });
}

function validateSubjectKey(value) {
  if (typeof value !== 'string' || !SUBJECT_PATTERN.test(value)) fail('INVALID_SUBJECT');
  return value;
}

function validateNow(clock) {
  let now;
  try {
    now = clock();
  } catch {
    fail('UNAVAILABLE');
  }
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function validateTimestamp(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('INVALID_INPUT');
  }
  return Date.parse(value);
}

function validateConfiguration(configuration) {
  exactObject(configuration, [
    'authorize', 'checkConsent', 'clock', 'features', 'limits', 'setConsent', 'store',
  ], ['authorize', 'checkConsent', 'features', 'setConsent', 'store']);
  if (typeof configuration.authorize !== 'function' ||
      typeof configuration.checkConsent !== 'function' ||
      typeof configuration.setConsent !== 'function' ||
      !Array.isArray(configuration.features) || configuration.features.length === 0 ||
      configuration.features.some(feature => typeof feature !== 'string' ||
        !FEATURE_PATTERN.test(feature)) ||
      new Set(configuration.features).size !== configuration.features.length) {
    fail('INVALID_CONFIGURATION');
  }
  const limits = { ...DEFAULT_LIMITS };
  if (configuration.limits !== undefined) {
    exactObject(configuration.limits, Object.keys(DEFAULT_LIMITS), []);
    for (const [key, value] of Object.entries(configuration.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'minGroupSize' ? 5 : 1)) {
        fail('INVALID_CONFIGURATION');
      }
      limits[key] = value;
    }
  }
  if (limits.retentionDays > 365 || limits.minGroupSize > 1000 ||
      limits.maxEventsPerDay > 100000 || limits.maxEventsPerTenant > 10000) {
    fail('INVALID_CONFIGURATION');
  }
  if (configuration.clock !== undefined && typeof configuration.clock !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  return {
    authorize: configuration.authorize,
    checkConsent: configuration.checkConsent,
    setConsent: configuration.setConsent,
    clock: configuration.clock ?? Date.now,
    features: new Set(configuration.features),
    limits,
  };
}

function dashboardMetrics(context, now, rows, retentionMs, limits) {
  const retained = rows.filter(row => row.recordedAt >= now - retentionMs);
  const distinctSubjects = new Set(retained.map(row => row.subjectKey));
  if (distinctSubjects.size < limits.minGroupSize) {
    return Object.freeze({
      schemaVersion: 1,
      tenantId: context.tenantId,
      generatedAt: new Date(now).toISOString(),
      suppressed: true,
      totalEvents: null,
      features: Object.freeze([]),
      growthFunnel: null,
    });
  }
  const byFeature = new Map();
  for (const row of retained) {
    const key = `${row.eventType}:${row.featureId}`;
    const group = byFeature.get(key) ?? { count: 0, subjects: new Set() };
    group.count += 1;
    group.subjects.add(row.subjectKey);
    byFeature.set(key, group);
  }
  const suppressedEventTypes = new Set([...byFeature]
    .filter(([, group]) => group.subjects.size < limits.minGroupSize)
    .map(([key]) => key.slice(0, key.indexOf(':'))));
  const hasSuppressedGroups = suppressedEventTypes.size > 0;
  const features = [...byFeature]
    .filter(([, group]) => group.subjects.size >= limits.minGroupSize)
    .map(([key, group]) => {
      const [eventType, featureId] = key.split(':');
      return Object.freeze({ eventType, featureId, count: group.count });
    })
    .sort((a, b) => a.eventType.localeCompare(b.eventType) ||
      a.featureId.localeCompare(b.featureId));
  const growthWindowRows = retained.filter(row =>
    Date.parse(row.occurredAt) >= now - 90 * 86400000);
  const growthEvents = growthWindowRows
    .filter(row => ['visit', 'signup', 'trial'].includes(row.eventType))
    .map(row => ({
      id: row.eventId,
      tenantId: row.tenantId,
      subjectKey: row.subjectKey,
      kind: row.eventType,
      source: row.source ?? 'direct',
      occurredAt: row.occurredAt,
      consent: true,
    }));
  const growth = aggregateGrowth({
    tenantId: context.tenantId,
    events: growthEvents,
    asOf: new Date(now).toISOString(),
  });
  const growthFunnel = Object.freeze(Object.fromEntries(
    Object.entries(growth.counts)
      .filter(([name]) => {
        const eventType = { visits: 'visit', signups: 'signup', trials: 'trial' }[name];
        if (!eventType || suppressedEventTypes.has(eventType)) return false;
        const subjects = new Set(growthWindowRows
          .filter(row => row.eventType === eventType)
          .map(row => row.subjectKey));
        return subjects.size >= limits.minGroupSize;
      }),
  ));
  return Object.freeze({
    schemaVersion: 1,
    tenantId: context.tenantId,
    generatedAt: new Date(now).toISOString(),
    suppressed: hasSuppressedGroups,
    totalEvents: hasSuppressedGroups ? null : retained.length,
    features: Object.freeze(features),
    growthFunnel,
  });
}

function serializeTenant(locks, tenantId, operation) {
  const previous = locks.get(tenantId) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(tenantId, current);
  return previous.then(operation).finally(() => {
    release();
    if (locks.get(tenantId) === current) locks.delete(tenantId);
  });
}

export function createMemoryAnalyticsStore() {
  const events = new Map();
  const locks = new Map();
  const subjectLocks = new Map();

  function tenantEvents(tenantId) {
    let rows = events.get(tenantId);
    if (!rows) {
      rows = [];
      events.set(tenantId, rows);
    }
    return rows;
  }

  return Object.freeze({
    withTenantLock(tenantId, operation) {
      return serializeTenant(locks, tenantId, operation);
    },

    withSubjectLock(tenantId, subjectKey, operation) {
      return serializeTenant(subjectLocks, `${tenantId}:${subjectKey}`, operation);
    },

    async append(event, { now, limits }) {
      return serializeTenant(locks, event.tenantId, () => {
        const rows = tenantEvents(event.tenantId);
        const existing = rows.find(row => row.eventId === event.eventId);
        if (existing) {
          const { recordedAt: _recordedAt, ...existingEvent } = existing;
          const { recordedAt: _incomingRecordedAt, ...incomingEvent } = event;
          if (JSON.stringify(existingEvent) !== JSON.stringify(incomingEvent)) {
            fail('IDEMPOTENCY_CONFLICT');
          }
          return Object.freeze({ accepted: false, duplicate: true });
        }
        const dayStart = now - (now % 86400000);
        const dailyCount = rows.filter(row => row.recordedAt >= dayStart).length;
        if (dailyCount >= limits.maxEventsPerDay ||
            rows.length >= limits.maxEventsPerTenant) fail('QUOTA_EXCEEDED');
        rows.push(Object.freeze({ ...event }));
        return Object.freeze({ accepted: true, duplicate: false });
      });
    },

    async list(tenantId) {
      return (events.get(tenantId) ?? []).map(row => ({ ...row }));
    },

    async exportSubject(tenantId, subjectKey) {
      return (events.get(tenantId) ?? [])
        .filter(row => row.subjectKey === subjectKey)
        .map(row => ({ ...row }));
    },

    async deleteSubject(tenantId, subjectKey) {
      return serializeTenant(locks, tenantId, () => {
        const rows = tenantEvents(tenantId);
        const before = rows.length;
        events.set(tenantId, rows.filter(row => row.subjectKey !== subjectKey));
        return before - events.get(tenantId).length;
      });
    },

    async prune(now, retentionMs) {
      let removed = 0;
      for (const [tenantId, rows] of events) {
        await serializeTenant(locks, tenantId, () => {
          const retained = rows.filter(row => row.recordedAt >= now - retentionMs);
          removed += rows.length - retained.length;
          events.set(tenantId, retained);
        });
      }
      return removed;
    },
  });
}

export function createAnalyticsService(configuration) {
  const config = validateConfiguration(configuration);
  const store = configuration.store;
  const requiredStoreMethods = [
    'append', 'list', 'exportSubject', 'deleteSubject', 'prune',
    'withSubjectLock', 'withTenantLock',
  ];
  if (!store || requiredStoreMethods.some(method => typeof store[method] !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }

  const retentionMs = config.limits.retentionDays * 86400000;

  async function authorize(context, action, subjectKey) {
    let allowed;
    try {
      allowed = await config.authorize(Object.freeze({ context, action, subjectKey }));
    } catch {
      fail('FORBIDDEN');
    }
    if (allowed !== true) fail('FORBIDDEN');
  }

  async function hasConsent(context, subjectKey) {
    let granted;
    try {
      granted = await config.checkConsent(Object.freeze({ context, subjectKey }));
    } catch {
      fail('CONSENT_UNAVAILABLE');
    }
    if (granted !== true) fail('CONSENT_REQUIRED');
  }

  async function updateConsent(context, subjectKey, granted) {
    let updated;
    try {
      updated = await config.setConsent(Object.freeze({ context, subjectKey, granted }));
    } catch {
      fail('CONSENT_UNAVAILABLE');
    }
    if (updated !== true) fail('CONSENT_UNAVAILABLE');
  }

  async function runStore(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AnalyticsModuleError) throw error;
      fail('UNAVAILABLE');
    }
  }

  async function prune(now) {
    return runStore(() => store.prune(now, retentionMs));
  }

  async function prepare(input, action, fields) {
    exactObject(input, fields);
    const context = validateContext(input.context);
    const subjectKey = fields.includes('subjectKey') ? validateSubjectKey(input.subjectKey) : undefined;
    await authorize(context, action, subjectKey);
    return { context, subjectKey };
  }

  return Object.freeze({
    async track(input) {
      const { context, subjectKey } = await prepare(input, 'analytics.track',
        ['context', 'subjectKey', 'event']);
      exactObject(input.event,
        ['schemaVersion', 'eventId', 'eventType', 'featureId', 'occurredAt', 'source'],
        ['schemaVersion', 'eventId', 'eventType', 'featureId', 'occurredAt']);
      const { event } = input;
      if (event.schemaVersion !== 1 || typeof event.eventId !== 'string' ||
          !UUID_PATTERN.test(event.eventId) || !EVENT_TYPES.includes(event.eventType) ||
          typeof event.featureId !== 'string' || !config.features.has(event.featureId) ||
          (event.eventType !== 'feature.used' && event.source !== undefined &&
            (typeof event.source !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(event.source))) ||
          (event.eventType === 'feature.used' && event.source !== undefined)) {
        fail('INVALID_INPUT');
      }
      const occurredAt = validateTimestamp(event.occurredAt);
      const now = validateNow(config.clock);
      const cutoff = now - retentionMs;
      if (occurredAt > now || occurredAt < cutoff) fail('INVALID_INPUT');
      const record = Object.freeze({
        schemaVersion: 1,
        eventId: event.eventId.toLowerCase(),
        eventType: event.eventType,
        featureId: event.featureId,
        tenantId: context.tenantId,
        subjectKey,
        occurredAt: event.occurredAt,
        recordedAt: now,
        ...(event.source === undefined ? {} : { source: event.source }),
      });
      return runStore(() => store.withSubjectLock(
        context.tenantId, subjectKey, async () => {
          await hasConsent(context, subjectKey);
          await prune(now);
          return runStore(() => store.append(record, { now, limits: config.limits }));
        },
      ));
    },

    async dashboard(input) {
      const { context } = await prepare(input, 'analytics.read', ['context']);
      const now = validateNow(config.clock);
      await prune(now);
      return runStore(() => store.withTenantLock(context.tenantId, async () =>
        dashboardMetrics(
          context,
          now,
          await store.list(context.tenantId),
          retentionMs,
          config.limits,
        )));
    },

    async exportSubject(input) {
      const { context, subjectKey } = await prepare(input, 'analytics.export',
        ['context', 'subjectKey']);
      const now = validateNow(config.clock);
      await prune(now);
      return runStore(() => store.withSubjectLock(
        context.tenantId,
        subjectKey,
        () => store.exportSubject(context.tenantId, subjectKey),
      ));
    },

    async revokeConsent(input) {
      const { context, subjectKey } = await prepare(input, 'analytics.delete',
        ['context', 'subjectKey']);
      return runStore(() => store.withSubjectLock(
        context.tenantId, subjectKey, async () => {
          await updateConsent(context, subjectKey, false);
          return runStore(() => store.deleteSubject(context.tenantId, subjectKey));
        },
      ));
    },

    async grantConsent(input) {
      const { context, subjectKey } = await prepare(input, 'analytics.consent',
        ['context', 'subjectKey']);
      return runStore(() => store.withSubjectLock(
        context.tenantId, subjectKey, async () => {
          await updateConsent(context, subjectKey, true);
          await hasConsent(context, subjectKey);
          return true;
        },
      ));
    },

    async cleanup(input) {
      const { context } = await prepare(input, 'analytics.retention', ['context']);
      const now = validateNow(config.clock);
      return prune(now);
    },
  });
}

export const analyticsContract = Object.freeze({
  version: 1,
  eventSchemaVersion: 1,
  eventTypes: EVENT_TYPES,
  defaultLimits: DEFAULT_LIMITS,
  pseudonym: 'caller-supplied keyed SHA-256 digest; no raw identity accepted',
  dashboard: 'tenant-scoped aggregates only; groups below minGroupSize are omitted',
  storage: 'process-local memory reference adapter; volatile and not multi-process',
});
