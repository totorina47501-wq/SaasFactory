import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntitlementsService,
  createMemoryEntitlementsStore,
  EntitlementsModuleError,
  entitlementsContract,
} from '../modules/entitlements/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const context = (tenantId = TENANT_A, requestId = 'request-1') =>
  Object.freeze({ contractVersion: 1, tenantId, requestId });

function fixture({
  planId = 'pro',
  status = 'active',
  periodStartAt = 1_799_971_200_000,
  periodEndAt = 1_802_563_200_000,
  now = 1_800_000_000_000,
  authorizeOverride = async () => true,
} = {}) {
  let time = now;
  const subscriptions = new Map([
    [TENANT_A, { planId, status, periodStartAt, periodEndAt }],
    [TENANT_B, { planId, status, periodStartAt, periodEndAt }],
  ]);
  const store = createMemoryEntitlementsStore();
  const service = createEntitlementsService({
    store,
    resolveSubscription: async tenantContext => subscriptions.get(tenantContext.tenantId) ?? null,
    authorizeOverride,
    clock: () => time,
  });
  return {
    service,
    store,
    subscriptions,
    setTime(value) {
      time = value;
    },
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof EntitlementsModuleError && error.code === code);
}

test('exposes versioned plan flags and quota budgets with fail-closed unknown features', async () => {
  const { service } = fixture({ planId: 'free' });

  assert.equal(entitlementsContract.version, 1);
  assert.deepEqual(entitlementsContract.plans, ['free', 'pro', 'business']);
  assert.equal((await service.check(context(), 'ai.generation')).allowed, false);
  assert.deepEqual(await service.check(context(), 'feature.not-listed'), {
    allowed: false,
    reason: 'unknown',
  });
  assert.equal((await service.check(context(), 'storage.private')).limits['storage.bytes'],
    100 * 1024 * 1024);
  await expectCode(
    service.reserve(context(), 'quota.not-listed', 1, 'unknown-quota'),
    'UNKNOWN_QUOTA',
  );
});

test('atomically enforces concurrent reservations and scopes idempotency by tenant and period', async () => {
  const { service } = fixture({ planId: 'free' });
  await service.setQuotaOverride(context(), 'api.requests', 5);

  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    service.reserve(context(), 'api.requests', 1, `concurrent-${index}`)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
  assert.equal(results.filter(result =>
    result.status === 'rejected' && result.reason.code === 'LIMIT_EXCEEDED').length, 5);

  const secondTenant = await service.reserve(context(TENANT_B), 'jobs.business-units', 1, 'same-key');
  const firstTenant = await service.reserve(context(), 'jobs.business-units', 1, 'same-key');
  assert.notEqual(firstTenant.id, secondTenant.id);
  await expectCode(
    service.consume(context(TENANT_B), firstTenant.id),
    'RESERVATION_NOT_FOUND',
  );
});

test('replays reservations, rejects changed idempotency requests, and refunds failed operations once', async () => {
  const { service } = fixture({ planId: 'free' });
  await service.setQuotaOverride(context(), 'api.requests', 3);

  const reservation = await service.reserve(context(), 'api.requests', 2, 'request-once');
  const replay = await service.reserve(context(), 'api.requests', 2, 'request-once');
  assert.equal(replay.id, reservation.id);
  await expectCode(
    service.reserve(context(), 'api.requests', 1, 'request-once'),
    'IDEMPOTENCY_CONFLICT',
  );

  assert.equal((await service.consume(context(), reservation.id)).status, 'consumed');
  assert.equal((await service.consume(context(), reservation.id)).status, 'consumed');
  assert.equal((await service.refund(context(), reservation.id)).status, 'refunded');
  assert.equal((await service.refund(context(), reservation.id)).status, 'refunded');
  assert.equal((await service.reserve(context(), 'api.requests', 3, 'retry-after-failure')).amount, 3);
  await expectCode(service.consume(context(), reservation.id), 'RESERVATION_FINALIZED');
});

test('starts a new quota window when billing renews and lowers caps on downgrade', async () => {
  const { service, subscriptions, setTime } = fixture({ planId: 'business' });
  await service.setQuotaOverride(context(), 'jobs.business-units', 100);
  const current = subscriptions.get(TENANT_A);

  await service.reserve(context(), 'jobs.business-units', 100, 'period-one');
  await expectCode(
    service.reserve(context(), 'jobs.business-units', 1, 'period-one-over'),
    'LIMIT_EXCEEDED',
  );
  subscriptions.set(TENANT_A, {
    planId: 'business',
    status: 'active',
    periodStartAt: current.periodEndAt,
    periodEndAt: current.periodEndAt + 30 * 24 * 60 * 60 * 1000,
  });
  setTime(current.periodEndAt);
  assert.equal((await service.reserve(context(), 'jobs.business-units', 1, 'period-two')).status,
    'reserved');

  subscriptions.set(TENANT_A, {
    planId: 'free',
    status: 'active',
    periodStartAt: current.periodEndAt,
    periodEndAt: current.periodEndAt + 30 * 24 * 60 * 60 * 1000,
  });
  await service.clearOverride(context(), 'jobs.business-units');
  await service.reserve(context(), 'jobs.business-units', 99, 'free-window-used');
  await expectCode(
    service.reserve(context(), 'jobs.business-units', 1, 'free-window-over'),
    'LIMIT_EXCEEDED',
  );
});

test('uses UTC windows independent of process timezone and rejects unexpected context fields', async t => {
  const { service } = fixture({
    planId: 'free',
    now: Date.UTC(2026, 10, 9, 0, 30),
  });
  const originalTimezone = process.env.TZ;
  t.after(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  process.env.TZ = 'Pacific/Honolulu';
  const honolulu = await service.reserve(context(), 'api.requests', 1, 'timezone-invariant');
  process.env.TZ = 'Europe/Paris';
  const paris = await service.reserve(context(), 'api.requests', 1, 'timezone-invariant');

  assert.equal(honolulu.periodStartAt, Date.UTC(2026, 10, 1));
  assert.equal(paris.id, honolulu.id);
  await expectCode(
    service.check({ ...context(), timezone: 'Pacific/Honolulu' }, 'api.access'),
    'INVALID_TENANT_CONTEXT',
  );
});

test('requires authorized overrides and fails closed if billing resolution is unavailable', async () => {
  const { service } = fixture({ planId: 'free', authorizeOverride: async () => false });
  await expectCode(
    service.setFeatureOverride(context(), 'ai.generation', true),
    'FORBIDDEN',
  );
  assert.equal((await service.check(context(), 'ai.generation')).allowed, false);

  const unavailable = createEntitlementsService({
    store: createMemoryEntitlementsStore(),
    resolveSubscription: async () => { throw new Error('private billing failure'); },
  });
  await expectCode(unavailable.check(context(), 'api.access'), 'UNAVAILABLE');
});
