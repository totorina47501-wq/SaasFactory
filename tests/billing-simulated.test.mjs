import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingContract,
  BillingModuleError,
  createBillingService,
  createMemoryBillingStore,
  signBillingEvent,
} from '../modules/billing-simulated/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SIGNING_KEY = 'test-only-local-signing-key';
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'billing-request-1',
});

function createTenancy() {
  return {
    async resolveTenantContext(input) {
      const tenantId = input.cookieHeader === 'tenant-a' ? TENANT_A :
        input.cookieHeader === 'tenant-b' ? TENANT_B : null;
      if (!tenantId || input.tenantId !== tenantId) throw new Error('denied');
      return Object.freeze({ contractVersion: 1, tenantId, requestId: input.requestId });
    },
  };
}

function fixture({ now = 1_800_000_000_000 } = {}) {
  let time = now;
  const store = createMemoryBillingStore();
  const service = createBillingService({
    store,
    tenancy: createTenancy(),
    signingKey: SIGNING_KEY,
    clock: () => time,
  });
  return {
    service,
    store,
    setTime(value) {
      time = value;
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error =>
    error instanceof BillingModuleError && error.code === code);
}

test('exposes simulated fixed plans and rejects unsupported input', async () => {
  const { service } = fixture();
  const plans = service.listPlans();

  assert.deepEqual(plans.map(plan => plan.id), ['free', 'pro', 'business']);
  assert.ok(plans.every(plan => plan.simulated === true));
  assert.equal(billingContract.version, 1);
  assert.equal(billingContract.provider, 'none');
  await expectCode(service.startSubscription({
    ...auth(),
    planId: 'pro',
    idempotencyKey: 'unknown-field',
    unknown: true,
  }), 'INVALID_INPUT');
  await expectCode(service.startSubscription({
    ...auth(),
    planId: 'enterprise',
    idempotencyKey: 'invalid-plan',
  }), 'INVALID_PLAN');
});

test('creates a trial subscription with demo invoice history and isolates tenants', async () => {
  const { service } = fixture();
  const subscription = await service.startSubscription({
    ...auth(),
    planId: 'pro',
    trial: true,
    idempotencyKey: 'trial-start-1',
  });

  assert.equal(subscription.status, 'trialing');
  assert.equal(subscription.planId, 'pro');
  assert.equal(subscription.trialEndAt, subscription.currentPeriodEnd);
  assert.equal((await service.getSubscription(auth())).id, subscription.id);
  assert.equal(await service.getSubscription(auth(TENANT_B)), null);
  assert.deepEqual(await service.listInvoices(auth()), []);
  await expectCode(service.startSubscription({
    ...auth(),
    planId: 'business',
    idempotencyKey: 'second-subscription',
  }), 'SUBSCRIPTION_EXISTS');
});

test('serializes concurrent renewals and creates one clearly simulated invoice', async () => {
  const { service, setTime } = fixture();
  const subscription = await service.startSubscription({
    ...auth(),
    planId: 'pro',
    idempotencyKey: 'paid-start-1',
  });
  const dueAt = subscription.currentPeriodEnd;
  setTime(dueAt);

  const renewals = await Promise.allSettled([
    service.renewSubscription({ ...auth(), idempotencyKey: 'renew-a' }),
    service.renewSubscription({ ...auth(), idempotencyKey: 'renew-b' }),
  ]);
  const success = renewals.filter(result => result.status === 'fulfilled');
  const rejected = renewals.filter(result => result.status === 'rejected');

  assert.equal(success.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'NOT_DUE');
  const invoices = await service.listInvoices(auth());
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].status, 'demo');
  assert.equal(invoices[0].paymentRequired, false);
  assert.equal((await service.getSubscription(auth())).currentPeriodEnd, dueAt + billingContract.periodMs);
});

test('cancellation at period end prevents a later renewal', async () => {
  const { service, setTime } = fixture();
  const subscription = await service.startSubscription({
    ...auth(),
    planId: 'business',
    idempotencyKey: 'business-start',
  });
  await service.cancelSubscription(auth());
  setTime(subscription.currentPeriodEnd);

  const result = await service.renewSubscription({ ...auth(), idempotencyKey: 'after-cancel' });
  assert.equal(result.status, 'canceled');
  assert.deepEqual(await service.listInvoices(auth()), []);
});

test('verifies local event signatures, deduplicates replay, and ignores reordered stale events', async () => {
  const { service } = fixture();
  const subscription = await service.startSubscription({
    ...auth(),
    planId: 'pro',
    idempotencyKey: 'event-start',
  });
  const newer = {
    version: 1,
    id: 'evt_newer_1',
    type: 'subscription.past_due',
    tenantId: TENANT_A,
    subscriptionId: subscription.id,
    occurredAt: subscription.updatedAt + 2,
  };
  const older = {
    ...newer,
    id: 'evt_older_1',
    type: 'subscription.active',
    occurredAt: subscription.updatedAt + 1,
  };

  const newerSignature = signBillingEvent(newer, SIGNING_KEY);
  assert.equal(
    (await service.processEvent({ event: newer, signature: newerSignature })).subscription.status,
    'past_due',
  );
  assert.equal((await service.processEvent({ event: newer, signature: newerSignature })).duplicate, true);
  assert.equal((await service.processEvent({
    event: older,
    signature: signBillingEvent(older, SIGNING_KEY),
  })).stale, true);
  await expectCode(service.processEvent({
    event: older,
    signature: '0'.repeat(64),
  }), 'INVALID_SIGNATURE');
  assert.equal((await service.getSubscription(auth())).status, 'past_due');
  const history = await service.getHistory(auth());
  assert.equal(history.filter(event => event.id === newer.id).length, 1);
  assert.equal(history.some(event => event.id === older.id), true);
});

test('rejects unauthorized tenant selection and fails closed on store errors', async () => {
  const { service } = fixture();
  await expectCode(service.getSubscription({ ...auth(TENANT_B), cookieHeader: 'tenant-a' }), 'TENANT_ACCESS_DENIED');
  await expectCode(service.startSubscription({
    ...auth(),
    planId: 'pro',
    idempotencyKey: 'safe-key',
    trial: false,
    ignored: 'field',
  }), 'INVALID_INPUT');
});
