import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = 30 * DAY_MS;
const TRIAL_MS = 14 * DAY_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const STATES = Object.freeze(['trialing', 'active', 'past_due', 'canceled']);
const EVENT_STATES = Object.freeze({
  'subscription.active': 'active',
  'subscription.past_due': 'past_due',
  'subscription.canceled': 'canceled',
});
const PLANS = Object.freeze([
  Object.freeze({ id: 'free', name: 'Free', amountCents: 0, currency: 'USD', simulated: true }),
  Object.freeze({ id: 'pro', name: 'Pro', amountCents: 1200, currency: 'USD', simulated: true }),
  Object.freeze({ id: 'business', name: 'Business', amountCents: 4900, currency: 'USD', simulated: true }),
]);

export class BillingModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BillingModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new BillingModuleError(code);
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

function validateUuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(code);
  return value.toLowerCase();
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value;
}

function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value;
}

function validatePlan(value) {
  const plan = PLANS.find(candidate => candidate.id === value);
  if (!plan) fail('INVALID_PLAN');
  return plan;
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function validateEvent(value) {
  exactInput(value, ['version', 'id', 'type', 'tenantId', 'subscriptionId', 'occurredAt']);
  if (value.version !== 1 || typeof value.id !== 'string' || !ID_PATTERN.test(value.id) ||
      typeof value.type !== 'string' || !Object.hasOwn(EVENT_STATES, value.type) ||
      !Number.isSafeInteger(value.occurredAt) ||
      value.occurredAt < 0) fail('INVALID_EVENT');
  return Object.freeze({
    version: 1,
    id: value.id,
    type: value.type,
    tenantId: validateUuid(value.tenantId, 'INVALID_EVENT'),
    subscriptionId: validateUuid(value.subscriptionId, 'INVALID_EVENT'),
    occurredAt: value.occurredAt,
  });
}

function eventText(event) {
  return JSON.stringify(validateEvent(event));
}

function signatureFor(event, signingKey) {
  return createHmac('sha256', signingKey).update(eventText(event), 'utf8').digest('hex');
}

export function signBillingEvent(event, signingKey) {
  if (typeof signingKey !== 'string' || Buffer.byteLength(signingKey, 'utf8') < 16) {
    fail('INVALID_CONFIGURATION');
  }
  return signatureFor(event, signingKey);
}

function validSignature(event, signature, signingKey) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/u.test(signature)) return false;
  const expected = Buffer.from(signatureFor(event, signingKey), 'hex');
  const received = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, received);
}

function validateContext(value, tenantId, requestId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_TENANT_CONTEXT');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some(key =>
    !['contractVersion', 'tenantId', 'requestId'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail('INVALID_TENANT_CONTEXT');
  if (value.contractVersion !== 1 || validateUuid(value.tenantId, 'INVALID_TENANT_CONTEXT') !== tenantId ||
      value.requestId !== requestId) fail('INVALID_TENANT_CONTEXT');
  return Object.freeze({ contractVersion: 1, tenantId, requestId });
}

export function createMemoryBillingStore() {
  const subscriptions = new Map();
  const invoices = new Map();
  const histories = new Map();
  const starts = new Map();
  const renewals = new Map();
  const processedEvents = new Set();
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

  function tenantList(map, tenantId) {
    if (!map.has(tenantId)) map.set(tenantId, []);
    return map.get(tenantId);
  }

  function addHistory(tenantId, event) {
    tenantList(histories, tenantId).push(Object.freeze({ ...event }));
  }

  return Object.freeze({
    async startSubscription({ subscription, idempotencyKey, fingerprint }) {
      return serialize(subscription.tenantId, () => {
        const startKey = `${subscription.tenantId}:${idempotencyKey}`;
        const previous = starts.get(startKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
          return clone(previous.subscription);
        }
        if (subscriptions.has(subscription.tenantId)) fail('SUBSCRIPTION_EXISTS');
        subscriptions.set(subscription.tenantId, clone(subscription));
        starts.set(startKey, { fingerprint, subscription: clone(subscription) });
        addHistory(subscription.tenantId, {
          id: randomUUID(),
          type: 'subscription.started',
          occurredAt: subscription.createdAt,
          subscriptionId: subscription.id,
          planId: subscription.planId,
          status: subscription.status,
        });
        return clone(subscription);
      });
    },

    async getSubscription(tenantId) {
      return clone(subscriptions.get(tenantId) ?? null);
    },

    async listInvoices(tenantId) {
      return clone(tenantList(invoices, tenantId));
    },

    async cancelSubscription({ tenantId, now }) {
      return serialize(tenantId, () => {
        const subscription = subscriptions.get(tenantId);
        if (!subscription) fail('NOT_FOUND');
        if (subscription.status === 'canceled' || subscription.cancelAtPeriodEnd) {
          return clone(subscription);
        }
        subscription.cancelAtPeriodEnd = true;
        subscription.updatedAt = now;
        subscription.version += 1;
        addHistory(tenantId, {
          id: randomUUID(),
          type: 'subscription.cancel_scheduled',
          occurredAt: now,
          subscriptionId: subscription.id,
          status: subscription.status,
        });
        return clone(subscription);
      });
    },

    async renewSubscription({ tenantId, now, idempotencyKey, invoiceId }) {
      return serialize(tenantId, () => {
        const renewalKey = `${tenantId}:${idempotencyKey}`;
        if (renewals.has(renewalKey)) return clone(renewals.get(renewalKey));
        const subscription = subscriptions.get(tenantId);
        if (!subscription) fail('NOT_FOUND');
        if (subscription.status === 'canceled') {
          const result = Object.freeze({ status: 'canceled', subscription: clone(subscription), invoice: null });
          renewals.set(renewalKey, result);
          return clone(result);
        }
        if (now < subscription.currentPeriodEnd) fail('NOT_DUE');
        if (subscription.cancelAtPeriodEnd) {
          subscription.status = 'canceled';
          subscription.cancelAtPeriodEnd = false;
          subscription.updatedAt = now;
          subscription.version += 1;
          addHistory(tenantId, {
            id: randomUUID(),
            type: 'subscription.canceled',
            occurredAt: now,
            subscriptionId: subscription.id,
            status: 'canceled',
          });
          const result = Object.freeze({ status: 'canceled', subscription: clone(subscription), invoice: null });
          renewals.set(renewalKey, result);
          return clone(result);
        }
        const periodStartAt = subscription.currentPeriodEnd;
        const periodEndAt = periodStartAt + PERIOD_MS;
        const plan = validatePlan(subscription.planId);
        const invoice = plan.amountCents === 0 ? null : Object.freeze({
          id: invoiceId,
          tenantId,
          subscriptionId: subscription.id,
          number: `DEMO-${invoiceId}`,
          amountCents: plan.amountCents,
          currency: plan.currency,
          status: 'demo',
          paymentRequired: false,
          periodStartAt,
          periodEndAt,
          issuedAt: now,
          simulated: true,
        });
        subscription.status = 'active';
        subscription.trialEndAt = null;
        subscription.currentPeriodStartAt = periodStartAt;
        subscription.currentPeriodEnd = periodEndAt;
        subscription.updatedAt = now;
        subscription.version += 1;
        if (invoice) tenantList(invoices, tenantId).push(invoice);
        addHistory(tenantId, {
          id: randomUUID(),
          type: 'subscription.renewed',
          occurredAt: now,
          subscriptionId: subscription.id,
          status: subscription.status,
          invoiceId: invoice?.id ?? null,
        });
        const result = Object.freeze({ status: 'renewed', subscription: clone(subscription), invoice });
        renewals.set(renewalKey, result);
        return clone(result);
      });
    },

    async applyEvent({ event }) {
      return serialize(event.tenantId, () => {
        const eventKey = `${event.tenantId}:${event.id}`;
        if (processedEvents.has(eventKey)) {
          return Object.freeze({
            duplicate: true,
            stale: false,
            subscription: clone(subscriptions.get(event.tenantId) ?? null),
          });
        }
        const subscription = subscriptions.get(event.tenantId);
        if (!subscription || subscription.id !== event.subscriptionId) fail('NOT_FOUND');
        const stale = event.occurredAt <= subscription.updatedAt;
        if (!stale) {
          subscription.status = EVENT_STATES[event.type];
          subscription.cancelAtPeriodEnd = subscription.status === 'canceled'
            ? false
            : subscription.cancelAtPeriodEnd;
          subscription.updatedAt = event.occurredAt;
          subscription.version += 1;
        }
        processedEvents.add(eventKey);
        addHistory(event.tenantId, {
          id: event.id,
          type: event.type,
          occurredAt: event.occurredAt,
          subscriptionId: event.subscriptionId,
          status: EVENT_STATES[event.type],
          stale,
        });
        return Object.freeze({ duplicate: false, stale, subscription: clone(subscription) });
      });
    },

    async getHistory(tenantId) {
      return clone(tenantList(histories, tenantId));
    },
  });
}

export function createBillingService(configuration) {
  exactInput(configuration, ['store', 'tenancy', 'signingKey', 'clock'],
    ['store', 'tenancy', 'signingKey']);
  const { store, tenancy, signingKey } = configuration;
  if (typeof signingKey !== 'string' || Buffer.byteLength(signingKey, 'utf8') < 16 ||
      !store || ['startSubscription', 'getSubscription', 'listInvoices', 'cancelSubscription',
        'renewSubscription', 'applyEvent', 'getHistory'].some(method => typeof store[method] !== 'function') ||
      !tenancy || typeof tenancy.resolveTenantContext !== 'function') fail('INVALID_CONFIGURATION');
  const clock = configuration.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  async function tenantContext(input) {
    if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192) {
      fail('INVALID_SESSION');
    }
    const tenantId = validateUuid(input.tenantId, 'INVALID_INPUT');
    const requestId = validateRequestId(input.requestId);
    let result;
    try {
      result = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId,
        requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    return validateContext(result, tenantId, requestId);
  }

  async function runStore(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BillingModuleError) throw error;
      fail('UNAVAILABLE');
    }
  }

  return Object.freeze({
    listPlans() {
      return clone(PLANS);
    },

    async startSubscription(input) {
      exactInput(input,
        ['cookieHeader', 'tenantId', 'requestId', 'planId', 'trial', 'idempotencyKey'],
        ['cookieHeader', 'tenantId', 'requestId', 'planId', 'idempotencyKey']);
      const context = await tenantContext(input);
      const plan = validatePlan(input.planId);
      const trial = input.trial ?? false;
      if (typeof trial !== 'boolean') fail('INVALID_INPUT');
      if (trial && plan.id === 'free') fail('INVALID_TRIAL');
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
      const now = validateNow(clock);
      const trialEndAt = trial ? now + TRIAL_MS : null;
      const subscription = Object.freeze({
        id: randomUUID(),
        tenantId: context.tenantId,
        planId: plan.id,
        status: trial ? 'trialing' : 'active',
        trialEndAt,
        currentPeriodStartAt: now,
        currentPeriodEnd: trialEndAt ?? now + PERIOD_MS,
        cancelAtPeriodEnd: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
        simulated: true,
      });
      return runStore(() => store.startSubscription({
        subscription,
        idempotencyKey,
        fingerprint: `${plan.id}:${trial}`,
      }));
    },

    async getSubscription(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await tenantContext(input);
      return runStore(() => store.getSubscription(context.tenantId));
    },

    async listInvoices(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await tenantContext(input);
      return runStore(() => store.listInvoices(context.tenantId));
    },

    async getHistory(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await tenantContext(input);
      return runStore(() => store.getHistory(context.tenantId));
    },

    async cancelSubscription(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await tenantContext(input);
      return runStore(() => store.cancelSubscription({
        tenantId: context.tenantId,
        now: validateNow(clock),
      }));
    },

    async renewSubscription(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'idempotencyKey']);
      const context = await tenantContext(input);
      const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
      return runStore(() => store.renewSubscription({
        tenantId: context.tenantId,
        now: validateNow(clock),
        idempotencyKey,
        invoiceId: randomUUID(),
      }));
    },

    async processEvent(input) {
      exactInput(input, ['event', 'signature']);
      const event = validateEvent(input.event);
      if (!validSignature(event, input.signature, signingKey)) fail('INVALID_SIGNATURE');
      return runStore(() => store.applyEvent({ event }));
    },
  });
}

export const billingContract = Object.freeze({
  version: 1,
  provider: 'none',
  persistence: 'in-memory-demo-adapter',
  plans: PLANS,
  states: STATES,
  periodMs: PERIOD_MS,
  trialMs: TRIAL_MS,
  invoices: 'simulated-no-payment',
  events: 'local-hmac-sha256',
});
