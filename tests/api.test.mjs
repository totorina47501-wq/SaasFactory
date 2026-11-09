import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  apiContract,
  createApiService,
  createMemoryApiStore,
  createOpenApiDocument,
  createPostgresApiStore,
  runApiMigrations,
} from '../modules/api/index.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'local-only-test-secret-with-at-least-32-bytes';

function fixture({ authorize = async () => true, rateLimit = 120 } = {}) {
  let now = 1_800_000_000_000;
  const store = createMemoryApiStore();
  const reservations = [];
  const entitlements = {
    async check(context, featureId) {
      assert.equal(context.contractVersion, 1);
      assert.equal(featureId, 'api.access');
      return { allowed: true };
    },
    async reserve(context, quotaId, amount, idempotencyKey) {
      assert.equal(context.tenantId, TENANT);
      assert.equal(quotaId, 'api.requests');
      assert.equal(amount, 1);
      reservations.push(idempotencyKey);
      return { id: `${reservations.length}` };
    },
    async consume() {},
    async refund() {},
  };
  const service = createApiService({
    store,
    auth: { async currentUser({ cookieHeader }) {
      return cookieHeader === 'session=valid' ? { id: ACTOR } : null;
    } },
    entitlements,
    authorize,
    async listMembers(input) {
      assert.equal(input.tenantId, TENANT);
      assert.equal(input.actorId, ACTOR);
      return { items: [{ id: MEMBER, email: 'member@example.test', role: 'member' }], nextCursor: null };
    },
    webhookSecret: SECRET,
    clock: () => now,
    rateLimit,
  });
  return {
    service,
    store,
    reservations,
    setTime(value) { now = value; },
  };
}

async function createKey(service, scopes = ['members:read', 'webhooks:simulate', 'webhooks:verify']) {
  const result = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT}/api-keys`,
    headers: { cookie: 'session=valid' },
    body: { name: 'local integration', scopes, expiresAt: null },
    requestId: 'key-create-1',
  });
  assert.equal(result.status, 201);
  return result.body;
}

test('exposes versioned routes and generates strict OpenAPI from the route catalogue', () => {
  const document = createOpenApiDocument();
  assert.equal(apiContract.version, 1);
  assert.equal(document.openapi, '3.1.0');
  assert.ok(document.paths['/v1/tenants/{tenantId}/members'].get);
  assert.deepEqual(
    document.paths['/v1/tenants/{tenantId}/api-keys'].post.requestBody.content['application/json']
      .schema,
    { $ref: '#/components/schemas/ApiKeyCreateRequest' },
  );
  assert.equal(document.components.schemas.ApiKeyCreateRequest.additionalProperties, false);
  assert.equal(document.components.schemas.ApiKeyCreateRequest.properties.scopes.uniqueItems, true);
  assert.equal(document.paths['/v1/webhooks/verify'].post.operationId, 'verifyWebhook');
});

test('issues one-time random API keys, hashes their stored credentials, and lists only metadata', async () => {
  const { service, store } = fixture();
  const created = await createKey(service);
  assert.match(created.token, /^sfk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.scopes.includes('members:read'), true);

  const listed = await service.dispatch({
    method: 'GET',
    path: `/v1/tenants/${TENANT}/api-keys`,
    headers: { cookie: 'session=valid' },
  });
  assert.equal(listed.status, 200);
  assert.equal(Object.hasOwn(listed.body.items[0], 'token'), false);

  const record = await store.findApiKeyById(created.id);
  assert.equal(record.tokenHash, createHash('sha256').update(created.token).digest('hex'));
  assert.notEqual(record.tokenHash, created.token);
});

test('checks current tenant permission, enforces pagination and tenant-scoped membership responses', async () => {
  const { service } = fixture();
  const key = await createKey(service);
  const response = await service.dispatch({
    method: 'GET',
    path: `/v1/tenants/${TENANT}/members`,
    headers: { authorization: 'Bearer ' + key.token },
    query: { limit: 1 },
    requestId: 'members-1',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].id, MEMBER);
  assert.equal(response.body.items.length, 1);

  const oversized = await service.dispatch({
    method: 'GET',
    path: `/v1/tenants/${TENANT}/members`,
    headers: { authorization: 'Bearer ' + key.token },
    query: { limit: apiContract.maxPageSize + 1 },
  });
  assert.equal(oversized.status, 400);

  let denyMemberRead = false;
  const denied = fixture({
    authorize: async ({ permission }) => !(denyMemberRead && permission === 'member.read'),
  });
  const deniedKey = await createKey(denied.service);
  denyMemberRead = true;
  const deniedResponse = await denied.service.dispatch({
    method: 'GET',
    path: `/v1/tenants/${TENANT}/members`,
    headers: { authorization: 'Bearer ' + deniedKey.token },
  });
  assert.equal(deniedResponse.status, 403);
});

test('rejects unknown fields, invalid keys, wrong tenants, and revoked credentials', async () => {
  const { service } = fixture();
  const injected = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT}/api-keys`,
    headers: { cookie: 'session=valid' },
    body: { name: 'key', scopes: ['members:read'], expiresAt: null, isAdmin: true },
  });
  assert.equal(injected.status, 400);

  const key = await createKey(service, ['members:read']);
  const wrongTenant = await service.dispatch({
    method: 'GET',
    path: '/v1/tenants/44444444-4444-4444-8444-444444444444/members',
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(wrongTenant.status, 404);

  const revoked = await service.dispatch({
    method: 'DELETE',
    path: `/v1/tenants/${TENANT}/api-keys/${key.id}`,
    headers: { cookie: 'session=valid' },
  });
  assert.equal(revoked.status, 200);
  const rejected = await service.dispatch({
    method: 'GET',
    path: `/v1/tenants/${TENANT}/members`,
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, 'API_KEY_REVOKED');
});

test('persists rate-limit decisions through the store and rejects duplicate or malformed headers', async () => {
  const { service, reservations } = fixture({ rateLimit: 1 });
  const key = await createKey(service, ['members:read']);
  const request = {
    method: 'GET',
    path: `/v1/tenants/${TENANT}/members`,
    headers: { authorization: 'Bearer ' + key.token },
  };
  assert.equal((await service.dispatch(request)).status, 200);
  const limited = await service.dispatch(request);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal(reservations.length, 2);

  const duplicateHeader = await service.dispatch({
    ...request,
    headers: { authorization: 'Bearer ' + key.token, Authorization: 'Bearer ' + key.token },
  });
  assert.equal(duplicateHeader.status, 400);
});

test('signs and verifies local webhook simulations once without accepting replays', async () => {
  const { service } = fixture();
  const key = await createKey(service, ['webhooks:simulate', 'webhooks:verify']);
  const simulated = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT}/webhooks/simulate`,
    headers: { authorization: 'Bearer ' + key.token },
    body: { event: 'member.created', payload: { memberId: MEMBER, nested: { ok: true } } },
  });
  assert.equal(simulated.status, 200);

  const verifyRequest = {
    method: 'POST',
    path: '/v1/webhooks/verify',
    headers: { authorization: 'Bearer ' + key.token },
    body: { ...simulated.body },
  };
  assert.deepEqual((await service.dispatch(verifyRequest)).body, {
    verified: true,
    event: 'member.created',
  });
  const replay = await service.dispatch(verifyRequest);
  assert.equal(replay.status, 409);

  const tampered = await service.dispatch({
    ...verifyRequest,
    body: { ...simulated.body, payload: { memberId: 'attacker' } },
  });
  assert.equal(tampered.status, 400);

  const forbidden = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT}/webhooks/simulate`,
    headers: { authorization: 'Bearer ' + key.token },
    body: { event: 'https.request', payload: { url: 'http://127.0.0.1' } },
  });
  assert.equal(forbidden.status, 200);
  assert.equal(forbidden.body.signature.startsWith('sha256='), true);
  assert.equal(Object.hasOwn(forbidden.body, 'response'), false);
});

test('validates PostgreSQL store configuration and uses durable hash, rate-limit and replay tables', async () => {
  assert.throws(() => createPostgresApiStore({
    pool: { connect() {} }, schemaName: 'public',
  }), TypeError);
  assert.throws(() => createPostgresApiStore({
    pool: { connect() {} }, schemaName: 'app_test', unexpected: true,
  }), TypeError);

  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          if (sql.includes('RETURNING attempts <= $2 AS allowed')) return { rows: [{ allowed: true }] };
          if (sql.includes('api_webhook_replays') && sql.includes('ON CONFLICT')) return { rowCount: 1, rows: [] };
          if (sql.includes('FROM "app_test".api_keys WHERE key_id')) {
            return { rows: [{
              key_id: ACTOR, tenant_id: TENANT, actor_id: ACTOR, name: 'key', scopes: ['members:read'],
              token_hash: 'a'.repeat(64), created_at: new Date(1000), expires_at: null, revoked_at: null,
            }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
  const store = createPostgresApiStore({ pool, schemaName: 'app_test' });
  await store.createApiKey({
    id: ACTOR, tenantId: TENANT, actorId: ACTOR, name: 'key',
    scopes: ['members:read'], tokenHash: 'a'.repeat(64),
    createdAt: 1000, expiresAt: null, revokedAt: null,
  });
  assert.equal((await store.findApiKeyById(ACTOR)).tokenHash, 'a'.repeat(64));
  assert.equal(await store.consumeRateLimit('b'.repeat(64), 1, 60_000, 1000), true);
  assert.equal(await store.consumeWebhookReplay(TENANT, 'a'.repeat(22), 2000, 1000), true);
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO "app_test".api_keys')));
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO "app_test".api_rate_limits')));
  assert.ok(calls.some(({ sql }) => sql.includes('INSERT INTO "app_test".api_webhook_replays')));

  const migration = readFileSync(
    new URL('../modules/api/migrations/0001_local_api.sql', import.meta.url), 'utf8',
  );
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/u);
  assert.match(migration, /PRIMARY KEY \(tenant_id, nonce\)/u);
  assert.doesNotMatch(migration, /\bDROP\b/iu);

  let releaseCalled = false;
  const migrationPool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('SELECT module_id, version, id, checksum FROM module_migrations')) {
            return { rows: [{
              module_id: 'api', version: 1, id: '0001_local_api',
              checksum: createHash('sha256').update(migration).digest('hex'),
            }] };
          }
          return { rows: [] };
        },
        release() { releaseCalled = true; },
      };
    },
  };
  const applied = await runApiMigrations(migrationPool, 'app_test');
  assert.ok(applied.some(entry => entry.moduleId === 'api' && entry.id === '0001_local_api'));
  assert.equal(releaseCalled, true);
});
