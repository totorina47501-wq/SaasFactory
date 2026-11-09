import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createEntitlementsService,
  createMemoryEntitlementsStore,
  createPostgresEntitlementsStore,
  EntitlementsModuleError,
  entitlementsContract,
  runEntitlementsMigrations,
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

test('preserves idempotent reservation retries when an override changes', async () => {
  const { service } = fixture({ planId: 'free' });
  await service.setQuotaOverride(context(), 'api.requests', 5);
  const original = await service.reserve(context(), 'api.requests', 1, 'mutable-limit-retry');

  await service.setQuotaOverride(context(), 'api.requests', 10);
  const retry = await service.reserve(context(), 'api.requests', 1, 'mutable-limit-retry');

  assert.equal(retry.id, original.id);
  assert.equal(retry.status, 'reserved');
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

test('uses a tenant-scoped PostgreSQL transaction for atomic reservations', async () => {
  const calls = [];
  let released = false;
  const reservationId = '33333333-3333-4333-8333-333333333333';
  const pool = {
    async connect() {
      return {
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes('FROM entitlements_reservations') &&
              sql.includes('idempotency_key = $4')) return { rows: [] };
          if (sql.includes('SELECT period_end_at, used, reserved')) {
            return { rows: [{ period_end_at: 20, used: 1, reserved: 2 }] };
          }
          if (sql.includes('INSERT INTO entitlements_reservations')) {
            return {
              rows: [{
                reservation_id: reservationId,
                quota_id: 'api.requests',
                period_start_at: 10,
                period_end_at: 20,
                amount: 3,
                status: 'reserved',
              }],
            };
          }
          return { rows: [] };
        },
        release() {
          released = true;
        },
      };
    },
  };
  const store = createPostgresEntitlementsStore({ pool, schemaName: 'app_test' });
  const reservation = await store.reserve({
    tenantId: TENANT_A,
    quotaId: 'api.requests',
    periodStartAt: 10,
    periodEndAt: 20,
    amount: 3,
    limit: 10,
    idempotencyKey: 'postgres-reserve',
    reservationId,
    fingerprint: 'api.requests:10:20:3:10',
  });

  assert.equal(reservation.id, reservationId);
  assert.equal(reservation.status, 'reserved');
  assert.ok(calls.some(call =>
    call.sql.includes("set_config('app.tenant_id', $1, true)") &&
    call.parameters[0] === TENANT_A));
  assert.ok(calls.some(call => call.sql.includes('pg_advisory_xact_lock')));
  assert.ok(calls.some(call => call.sql.includes('reserved = reserved + $4')));
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(released, true);
});

test('rejects unsafe PostgreSQL configuration and declares forced tenant RLS', () => {
  assert.throws(() => createPostgresEntitlementsStore({ pool: {}, schemaName: 'app_test' }),
    error => error instanceof EntitlementsModuleError && error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => createPostgresEntitlementsStore({
    pool: { connect() {} },
    schemaName: 'public',
  }), error => error instanceof EntitlementsModuleError && error.code === 'INVALID_CONFIGURATION');

  let getterCalled = false;
  const hostile = { schemaName: 'app_test' };
  Object.defineProperty(hostile, 'pool', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('must not run');
    },
  });
  assert.throws(() => createPostgresEntitlementsStore(hostile), error =>
    error instanceof EntitlementsModuleError && error.code === 'INVALID_CONFIGURATION');
  assert.equal(getterCalled, false);

  const migration = readFileSync(
    new URL('../modules/entitlements/migrations/0001_tenant_entitlements.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /UNIQUE \(tenant_id, quota_id, period_start_at, idempotency_key\)/u);
  assert.equal((migration.match(/ENABLE ROW LEVEL SECURITY/gu) ?? []).length, 3);
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/gu) ?? []).length, 3);
  assert.doesNotMatch(migration, /\bDROP\b/iu);
});

test('includes existing module migration history without rerunning dependency migrations', async () => {
  const moduleMigrations = [
    ['auth', '0001_local_authentication', '../modules/auth/migrations/0001_local_authentication.sql'],
    ['billing-simulated', '0001_local_billing', '../modules/billing-simulated/migrations/0001_local_billing.sql'],
    ['mfa', '0001_local_mfa', '../modules/mfa/migrations/0001_local_mfa.sql'],
    ['tenancy', '0001_local_tenancy', '../modules/tenancy/migrations/0001_local_tenancy.sql'],
  ].map(([moduleId, id, file]) => ({
    module_id: moduleId,
    version: 1,
    id,
    checksum: createHash('sha256')
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest('hex'),
  }));
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql.includes('SELECT module_id, version, id, checksum')) {
            return { rows: moduleMigrations };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  const migrations = await runEntitlementsMigrations(pool, 'app_test');

  assert.ok(migrations.some(entry =>
    entry.moduleId === 'entitlements' && entry.id === '0001_tenant_entitlements'));
  assert.equal(calls.includes(readFileSync(
    new URL('../modules/auth/migrations/0001_local_authentication.sql', import.meta.url),
    'utf8',
  )), false);
  assert.equal(calls.at(-1), 'COMMIT');
});
