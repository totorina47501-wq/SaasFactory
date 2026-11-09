import { randomUUID } from 'node:crypto';
import { EntitlementsModuleError, fail } from './errors.mjs';
import { FEATURES, PLAN_FEATURES, PLAN_QUOTAS, QUOTAS } from './contract.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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
      !REQUEST_PATTERN.test(value.requestId)) fail('INVALID_TENANT_CONTEXT');
  return Object.freeze({
    contractVersion: 1,
    tenantId: value.tenantId.toLowerCase(),
    requestId: value.requestId,
  });
}

function validateId(value, known, errorCode = 'UNKNOWN_FEATURE') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_INPUT');
  if (!Object.hasOwn(known, value)) fail(errorCode);
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

function freePeriod(now) {
  const date = new Date(now);
  const periodStartAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const periodEndAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { periodStartAt, periodEndAt };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createMemoryEntitlementsStore() {
  const usage = new Map();
  const reservations = new Map();
  const idempotency = new Map();
  const overrides = new Map();
  const tenantLocks = new Map();

  async function serialize(tenantId, operation) {
    const previous = tenantLocks.get(tenantId) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    tenantLocks.set(tenantId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tenantLocks.get(tenantId) === current) tenantLocks.delete(tenantId);
    }
  }

  const usageKey = (tenantId, quotaId, periodStartAt) =>
    `${tenantId}:${quotaId}:${periodStartAt}`;
  const reservationKey = (tenantId, reservationId) => `${tenantId}:${reservationId}`;
  const idempotencyKey = (tenantId, quotaId, periodStartAt, key) =>
    `${tenantId}:${quotaId}:${periodStartAt}:${key}`;
  const overrideKey = (tenantId, targetId) => `${tenantId}:${targetId}`;

  return Object.freeze({
    async getOverride({ tenantId, targetId }) {
      return clone(overrides.get(overrideKey(tenantId, targetId)));
    },

    async setOverride({ tenantId, targetId, kind, value }) {
      return serialize(tenantId, () => {
        const override = Object.freeze({ kind, value });
        overrides.set(overrideKey(tenantId, targetId), override);
        return clone(override);
      });
    },

    async clearOverride({ tenantId, targetId }) {
      return serialize(tenantId, () => overrides.delete(overrideKey(tenantId, targetId)));
    },

    async reserve(input) {
      return serialize(input.tenantId, () => {
        const key = idempotencyKey(
          input.tenantId, input.quotaId, input.periodStartAt, input.idempotencyKey,
        );
        const existingId = idempotency.get(key);
        if (existingId) {
          const existing = reservations.get(reservationKey(input.tenantId, existingId));
          if (existing.fingerprint !== input.fingerprint) fail('IDEMPOTENCY_CONFLICT');
          return clone(existing);
        }
        const keyForUsage = usageKey(input.tenantId, input.quotaId, input.periodStartAt);
        const counters = usage.get(keyForUsage) ?? { used: 0, reserved: 0 };
        if (counters.used + counters.reserved + input.amount > input.limit) fail('LIMIT_EXCEEDED');
        const reservation = Object.freeze({
          id: input.reservationId,
          quotaId: input.quotaId,
          periodStartAt: input.periodStartAt,
          periodEndAt: input.periodEndAt,
          amount: input.amount,
          status: 'reserved',
          fingerprint: input.fingerprint,
        });
        counters.reserved += input.amount;
        usage.set(keyForUsage, counters);
        reservations.set(reservationKey(input.tenantId, reservation.id), reservation);
        idempotency.set(key, reservation.id);
        return clone(reservation);
      });
    },

    async consume({ tenantId, reservationId }) {
      return serialize(tenantId, () => {
        const key = reservationKey(tenantId, reservationId);
        const reservation = reservations.get(key);
        if (!reservation) fail('RESERVATION_NOT_FOUND');
        if (reservation.status === 'consumed') return clone(reservation);
        if (reservation.status === 'refunded') fail('RESERVATION_FINALIZED');
        const counters = usage.get(usageKey(tenantId, reservation.quotaId, reservation.periodStartAt));
        if (!counters || counters.reserved < reservation.amount) fail('UNAVAILABLE');
        counters.reserved -= reservation.amount;
        counters.used += reservation.amount;
        const consumed = Object.freeze({ ...reservation, status: 'consumed' });
        reservations.set(key, consumed);
        return clone(consumed);
      });
    },

    async refund({ tenantId, reservationId }) {
      return serialize(tenantId, () => {
        const key = reservationKey(tenantId, reservationId);
        const reservation = reservations.get(key);
        if (!reservation) fail('RESERVATION_NOT_FOUND');
        if (reservation.status === 'refunded') return clone(reservation);
        const counters = usage.get(usageKey(tenantId, reservation.quotaId, reservation.periodStartAt));
        if (!counters) fail('UNAVAILABLE');
        if (reservation.status === 'reserved') {
          if (counters.reserved < reservation.amount) fail('UNAVAILABLE');
          counters.reserved -= reservation.amount;
        } else {
          if (counters.used < reservation.amount) fail('UNAVAILABLE');
          counters.used -= reservation.amount;
        }
        const refunded = Object.freeze({ ...reservation, status: 'refunded' });
        reservations.set(key, refunded);
        return clone(refunded);
      });
    },
  });
}

export function createEntitlementsService(configuration) {
  exactObject(configuration,
    ['store', 'resolveSubscription', 'authorizeOverride', 'clock'],
    ['store', 'resolveSubscription']);
  const { store, resolveSubscription } = configuration;
  const methods = ['getOverride', 'setOverride', 'clearOverride', 'reserve', 'consume', 'refund'];
  if (!store || methods.some(method => typeof store[method] !== 'function') ||
      typeof resolveSubscription !== 'function') fail('INVALID_CONFIGURATION');
  if (configuration.authorizeOverride !== undefined &&
      typeof configuration.authorizeOverride !== 'function') fail('INVALID_CONFIGURATION');
  const clock = configuration.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  const authorizeOverride = configuration.authorizeOverride;

  async function runStore(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof EntitlementsModuleError) throw error;
      fail('UNAVAILABLE');
    }
  }

  async function resolvePlan(context, now) {
    let subscription;
    try {
      subscription = await resolveSubscription(context);
    } catch {
      fail('UNAVAILABLE');
    }
    if (subscription === null) return { planId: 'free', ...freePeriod(now) };
    exactObject(subscription, ['planId', 'status', 'periodStartAt', 'periodEndAt']);
    if (!Object.hasOwn(PLAN_FEATURES, subscription.planId) ||
        !['trialing', 'active', 'past_due', 'canceled'].includes(subscription.status) ||
        !Number.isSafeInteger(subscription.periodStartAt) ||
        !Number.isSafeInteger(subscription.periodEndAt) ||
        subscription.periodStartAt < 0 || subscription.periodStartAt >= subscription.periodEndAt) {
      fail('INVALID_SUBSCRIPTION');
    }
    if (subscription.status === 'past_due' || now < subscription.periodStartAt ||
        now >= subscription.periodEndAt) return { planId: 'free', ...freePeriod(now) };
    return {
      planId: subscription.planId,
      periodStartAt: subscription.periodStartAt,
      periodEndAt: subscription.periodEndAt,
    };
  }

  async function effectiveOverride(context, targetId) {
    return runStore(() => store.getOverride({ tenantId: context.tenantId, targetId }));
  }

  async function authorize(context, kind, targetId, value) {
    if (!authorizeOverride) fail('FORBIDDEN');
    let allowed;
    try {
      allowed = await authorizeOverride(Object.freeze({
        context,
        kind,
        targetId,
        value,
      }));
    } catch {
      fail('FORBIDDEN');
    }
    if (allowed !== true) fail('FORBIDDEN');
  }

  async function featureEnabled(context, planId, featureId) {
    const override = await effectiveOverride(context, featureId);
    if (override !== undefined && override !== null) {
      if (override.kind !== 'feature' || typeof override.value !== 'boolean') fail('UNAVAILABLE');
      return override.value;
    }
    return PLAN_FEATURES[planId][featureId];
  }

  async function quotaLimit(context, planId, quotaId) {
    const override = await effectiveOverride(context, quotaId);
    if (override !== undefined && override !== null) {
      if (override.kind !== 'quota' || !Number.isSafeInteger(override.value) || override.value < 0) {
        fail('UNAVAILABLE');
      }
      return override.value;
    }
    return PLAN_QUOTAS[planId][quotaId];
  }

  return Object.freeze({
    async check(inputContext, inputFeatureId) {
      const context = validateContext(inputContext);
      if (typeof inputFeatureId !== 'string' || !ID_PATTERN.test(inputFeatureId)) fail('INVALID_INPUT');
      if (!Object.hasOwn(PLAN_FEATURES.free, inputFeatureId)) {
        return Object.freeze({ allowed: false, reason: 'unknown' });
      }
      const featureId = inputFeatureId;
      const now = validateNow(clock);
      const { planId } = await resolvePlan(context, now);
      const allowed = await featureEnabled(context, planId, featureId);
      const limits = {};
      for (const [quotaId, definition] of Object.entries(QUOTAS)) {
        if (definition.featureId === featureId) {
          limits[quotaId] = await quotaLimit(context, planId, quotaId);
        }
      }
      return Object.freeze({
        allowed,
        reason: allowed ? 'granted' : 'disabled',
        limits: Object.freeze(limits),
      });
    },

    async reserve(inputContext, inputQuotaId, amount, idempotencyKey) {
      const context = validateContext(inputContext);
      const quotaId = validateId(inputQuotaId, QUOTAS, 'UNKNOWN_QUOTA');
      if (!Number.isSafeInteger(amount) || amount < 1 ||
          typeof idempotencyKey !== 'string' || !ID_PATTERN.test(idempotencyKey)) fail('INVALID_INPUT');
      const now = validateNow(clock);
      const { planId, periodStartAt, periodEndAt } = await resolvePlan(context, now);
      const featureId = QUOTAS[quotaId].featureId;
      if (!await featureEnabled(context, planId, featureId)) fail('FEATURE_DISABLED');
      const limit = await quotaLimit(context, planId, quotaId);
      const fingerprint = `${quotaId}:${periodStartAt}:${periodEndAt}:${amount}:${limit}`;
      return runStore(() => store.reserve({
        tenantId: context.tenantId,
        quotaId,
        periodStartAt,
        periodEndAt,
        amount,
        limit,
        idempotencyKey,
        reservationId: randomUUID(),
        fingerprint,
      }));
    },

    async consume(inputContext, inputReservationId) {
      const context = validateContext(inputContext);
      if (typeof inputReservationId !== 'string' || !UUID_PATTERN.test(inputReservationId)) {
        fail('INVALID_INPUT');
      }
      return runStore(() => store.consume({
        tenantId: context.tenantId,
        reservationId: inputReservationId.toLowerCase(),
      }));
    },

    async refund(inputContext, inputReservationId) {
      const context = validateContext(inputContext);
      if (typeof inputReservationId !== 'string' || !UUID_PATTERN.test(inputReservationId)) {
        fail('INVALID_INPUT');
      }
      return runStore(() => store.refund({
        tenantId: context.tenantId,
        reservationId: inputReservationId.toLowerCase(),
      }));
    },

    async setFeatureOverride(inputContext, inputFeatureId, enabled) {
      const context = validateContext(inputContext);
      const featureId = validateId(inputFeatureId, PLAN_FEATURES.free);
      if (typeof enabled !== 'boolean') fail('INVALID_INPUT');
      await authorize(context, 'feature', featureId, enabled);
      return runStore(() => store.setOverride({
        tenantId: context.tenantId,
        targetId: featureId,
        kind: 'feature',
        value: enabled,
      }));
    },

    async setQuotaOverride(inputContext, inputQuotaId, limit) {
      const context = validateContext(inputContext);
      const quotaId = validateId(inputQuotaId, QUOTAS);
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > Number.MAX_SAFE_INTEGER) {
        fail('INVALID_INPUT');
      }
      await authorize(context, 'quota', quotaId, limit);
      return runStore(() => store.setOverride({
        tenantId: context.tenantId,
        targetId: quotaId,
        kind: 'quota',
        value: limit,
      }));
    },

    async clearOverride(inputContext, inputTargetId) {
      const context = validateContext(inputContext);
      if (typeof inputTargetId !== 'string' ||
          (!Object.hasOwn(PLAN_FEATURES.free, inputTargetId) &&
           !Object.hasOwn(QUOTAS, inputTargetId))) fail('INVALID_INPUT');
      const override = await effectiveOverride(context, inputTargetId);
      if (override === undefined || override === null) return false;
      await authorize(context, 'clear', inputTargetId, null);
      return runStore(() => store.clearOverride({
        tenantId: context.tenantId,
        targetId: inputTargetId,
      }));
    },
  });
}

export const entitlementsContract = Object.freeze({
  version: 1,
  plans: Object.freeze(Object.keys(PLAN_FEATURES)),
  features: FEATURES,
  quotas: QUOTAS,
  planFeatures: PLAN_FEATURES,
  planQuotas: PLAN_QUOTAS,
  periodBasis: 'billing-period-or-utc-calendar-month',
  hardwareLimits: 'enforced-separately-by-jobs-runtime',
});

export { EntitlementsModuleError } from './errors.mjs';
export { createPostgresEntitlementsStore, runEntitlementsMigrations } from './postgres-store.mjs';
