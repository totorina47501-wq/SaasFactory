import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createMfaService,
  createTotpCode,
  MfaModuleError,
  mfaContract,
} from '../modules/mfa/index.mjs';
import { createPostgresMfaStore, runMfaMigrations } from '../modules/mfa/postgres-store.mjs';

const userId = 'c41b1b94-38df-4a2d-a2be-9715e374824e';
const otherUserId = 'ee779a68-a338-4d7f-9f62-7ca7b1178326';
const actor = '127.0.0.1';
const password = 'correct horse battery';
const encryptionKey = Buffer.alloc(32, 0x5a);
const now = 1_800_000_000_000;

function fakeStore() {
  const state = {
    authenticators: new Map(),
    recoveryCodes: new Map(),
    limits: new Map(),
  };
  const store = {
    async beginEnrollment(id, encryptedSecret) {
      const current = state.authenticators.get(id);
      if (current?.enabled) return false;
      state.authenticators.set(id, {
        pendingSecret: encryptedSecret,
        secret: null,
        lastAcceptedStep: null,
        enabled: false,
      });
      return true;
    },
    async getAuthenticator(id) {
      const record = state.authenticators.get(id);
      return record ? { ...record } : null;
    },
    async activateEnrollment({ userId: id, lastAcceptedStep, recoveryCodeHashes }) {
      const record = state.authenticators.get(id);
      if (!record?.pendingSecret || record.enabled) return false;
      record.secret = record.pendingSecret;
      record.pendingSecret = null;
      record.lastAcceptedStep = lastAcceptedStep;
      record.enabled = true;
      state.recoveryCodes.set(id, new Set(recoveryCodeHashes));
      return true;
    },
    async consumeTotpStep(id, step) {
      const record = state.authenticators.get(id);
      if (!record?.enabled || step <= record.lastAcceptedStep) return false;
      record.lastAcceptedStep = step;
      return true;
    },
    async consumeRecoveryCode(id, hash) {
      const codes = state.recoveryCodes.get(id);
      if (!state.authenticators.get(id)?.enabled || !codes?.delete(hash)) return false;
      return true;
    },
    async disableMfa({ userId: id, step, recoveryCodeHash }) {
      const record = state.authenticators.get(id);
      if (!record?.enabled) return false;
      if (step !== null) {
        if (step <= record.lastAcceptedStep) return false;
      } else if (!state.recoveryCodes.get(id)?.delete(recoveryCodeHash)) {
        return false;
      }
      record.pendingSecret = null;
      record.secret = null;
      record.lastAcceptedStep = null;
      record.enabled = false;
      state.recoveryCodes.delete(id);
      return true;
    },
    async consumeRateLimit(bucket, limit, windowMs, timestamp) {
      let entry = state.limits.get(bucket);
      if (!entry || entry.startedAt + windowMs <= timestamp) {
        entry = { startedAt: timestamp, attempts: 0 };
        state.limits.set(bucket, entry);
      }
      entry.attempts += 1;
      return entry.attempts <= limit;
    },
  };
  return { store, state };
}

function createService(options = {}) {
  const { store, state } = options.context ?? fakeStore();
  let timestamp = options.now ?? now;
  const service = createMfaService({
    store,
    encryptionKey: options.encryptionKey ?? encryptionKey,
    reauthenticate: options.reauthenticate ?? (async ({ userId: id, password: supplied }) =>
      /^[0-9a-f-]{36}$/iu.test(id) && supplied === password),
    clock: () => timestamp,
  });
  return {
    service,
    store,
    state,
    advance(milliseconds) {
      timestamp += milliseconds;
    },
  };
}

function expectMfaCode(callback, code) {
  return assert.rejects(callback, error =>
    error instanceof MfaModuleError && error.code === code && error.message === code);
}

const enrollmentInput = (id = userId, overrides = {}) => ({
  userId: id,
  password,
  rateLimitActor: actor,
  ...overrides,
});

async function enableMfa(service, id = userId, overrides = {}) {
  const enrollment = await service.beginEnrollment(enrollmentInput(id, overrides));
  const code = createTotpCode(enrollment.secret, now);
  const result = await service.confirmEnrollment(enrollmentInput(id, { code, ...overrides }));
  return { enrollment, recoveryCodes: result.recoveryCodes };
}

test('matches RFC 6238 SHA-1 test vectors and publishes bounded contract settings', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [20_000_000_000_000, '279037'],
  ].map(([timestamp]) => createTotpCode(secret, timestamp)),
  ['287082', '081804', '050471', '005924', '353130']);
  assert.deepEqual(mfaContract, {
    version: 1,
    algorithm: 'TOTP-RFC6238-SHA1',
    digits: 6,
    periodSeconds: 30,
    allowedDriftSteps: 1,
    recoveryCodeCount: 10,
    rateWindowMs: 900_000,
    identityAttemptsPerOperation: { enroll: 5, confirm: 8, verify: 8, disable: 8 },
  });
});

test('rejects missing app encryption keys, invalid configuration, and unknown fields', () => {
  const { store } = fakeStore();
  assert.throws(() => createMfaService({
    store,
    encryptionKey: Buffer.alloc(31),
    reauthenticate: async () => true,
  }), error => error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => createMfaService({
    store,
    encryptionKey: encryptionKey.toString('base64url'),
    reauthenticate: async () => true,
  }), error => error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => createMfaService({
    store,
    encryptionKey,
    reauthenticate: async () => true,
    unexpected: true,
  }), error => error.code === 'INVALID_INPUT');
});

test('enrollment requires reauthentication and stores an authenticated encrypted secret', async () => {
  const ctx = createService({ reauthenticate: async () => false });
  await expectMfaCode(
    () => ctx.service.beginEnrollment(enrollmentInput()),
    'REAUTH_FAILED',
  );
  assert.equal(ctx.state.authenticators.size, 0);

  const enabled = createService();
  const enrollment = await enabled.service.beginEnrollment(enrollmentInput());
  const pending = enabled.state.authenticators.get(userId).pendingSecret;
  assert.match(enrollment.otpauthUrl, /^otpauth:\/\/totp\/SaaSFactory%3A/u);
  assert.notEqual(pending, enrollment.secret);
  assert.ok(pending.startsWith('v1.'));
  assert.throws(() => createTotpCode(enrollment.secret, -1), error =>
    error.code === 'INVALID_INPUT');
  await expectMfaCode(
    () => enabled.service.confirmEnrollment(enrollmentInput(userId, { code: '000000' })),
    'INVALID_CODE',
  );
  assert.equal(enabled.state.authenticators.get(userId).enabled, false);
});

test('confirms TOTP, bounds drift, prevents replay, and limits verification attempts', async () => {
  const ctx = createService();
  const { enrollment, recoveryCodes } = await enableMfa(ctx.service);
  assert.equal(recoveryCodes.length, 10);
  assert.equal(new Set(recoveryCodes).size, 10);
  assert.ok(recoveryCodes.every(code => /^[A-Za-z0-9_-]{22}$/u.test(code)));
  assert.equal(ctx.state.authenticators.get(userId).enabled, true);
  assert.notEqual(ctx.state.authenticators.get(userId).secret, enrollment.secret);

  ctx.advance(30_000);
  const firstCode = createTotpCode(enrollment.secret, now + 30_000);
  assert.deepEqual(await ctx.service.verify({
    userId, code: firstCode, rateLimitActor: actor,
  }), { verified: true, factor: 'totp' });
  await expectMfaCode(
    () => ctx.service.verify({ userId, code: firstCode, rateLimitActor: actor }),
    'INVALID_CODE',
  );
  ctx.advance(30_000);
  const nextCode = createTotpCode(enrollment.secret, now + 60_000);
  assert.deepEqual(await ctx.service.verify({
    userId, code: nextCode, rateLimitActor: actor,
  }), { verified: true, factor: 'totp' });
  ctx.advance(90_000);
  await expectMfaCode(
    () => ctx.service.verify({
      userId,
      code: createTotpCode(enrollment.secret, now),
      rateLimitActor: actor,
    }),
    'INVALID_CODE',
  );

  const drift = createService();
  const { enrollment: driftEnrollment } = await enableMfa(drift.service, otherUserId);
  assert.deepEqual(await drift.service.verify({
    userId: otherUserId,
    code: createTotpCode(driftEnrollment.secret, now + 30_000),
    rateLimitActor: actor,
  }), { verified: true, factor: 'totp' });
  await expectMfaCode(
    () => drift.service.verify({
      userId: otherUserId,
      code: createTotpCode(driftEnrollment.secret, now + 60_000),
      rateLimitActor: actor,
    }),
    'INVALID_CODE',
  );

  const limited = createService();
  const enabled = await enableMfa(limited.service);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await expectMfaCode(
      () => limited.service.verify({ userId, code: 'not-a-code', rateLimitActor: actor }),
      'INVALID_CODE',
    );
  }
  await expectMfaCode(
    () => limited.service.verify({
      userId, code: enabled.recoveryCodes[0], rateLimitActor: actor,
    }),
    'RATE_LIMITED',
  );
});

test('recovery codes are hashed, isolated per user, and atomically consumed once', async () => {
  const ctx = createService();
  const { recoveryCodes } = await enableMfa(ctx.service);
  const hashes = ctx.state.recoveryCodes.get(userId);
  assert.equal(hashes.size, 10);
  assert.ok(recoveryCodes.every(code =>
    !hashes.has(code) && hashes.has(
      createHash('sha256').update(code, 'utf8').digest('hex'),
    )));

  const { recoveryCodes: otherRecoveryCodes } = await enableMfa(ctx.service, otherUserId, {
    password: 'correct horse battery',
  });
  assert.notDeepEqual(otherRecoveryCodes, recoveryCodes);

  const checks = await Promise.allSettled([
    ctx.service.verify({ userId, code: recoveryCodes[0], rateLimitActor: actor }),
    ctx.service.verify({ userId, code: recoveryCodes[0], rateLimitActor: actor }),
  ]);
  assert.equal(checks.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(checks.filter(result => result.status === 'rejected' &&
    result.reason.code === 'INVALID_CODE').length, 1);
  await expectMfaCode(
    () => ctx.service.verify({ userId: otherUserId, code: recoveryCodes[1], rateLimitActor: actor }),
    'INVALID_CODE',
  );
  assert.deepEqual(await ctx.service.verify({
    userId, code: recoveryCodes[1], rateLimitActor: actor,
  }), { verified: true, factor: 'recovery' });
});

test('disabling requires fresh reauthentication and a valid factor, then revokes all recovery codes', async () => {
  const ctx = createService();
  const { enrollment, recoveryCodes } = await enableMfa(ctx.service);
  const code = createTotpCode(enrollment.secret, now);
  await expectMfaCode(
    () => ctx.service.disable(enrollmentInput(userId, { code, password: 'incorrect password' })),
    'REAUTH_FAILED',
  );
  await expectMfaCode(
    () => ctx.service.disable(enrollmentInput(userId, { code: '000000' })),
    'INVALID_CODE',
  );
  assert.equal(ctx.state.authenticators.get(userId).enabled, true);

  assert.deepEqual(await ctx.service.disable(enrollmentInput(userId, {
    code: recoveryCodes[0],
  })), { disabled: true });
  assert.equal(ctx.state.authenticators.get(userId).enabled, false);
  await expectMfaCode(
    () => ctx.service.verify({ userId, code: recoveryCodes[1], rateLimitActor: actor }),
    'INVALID_CODE',
  );
  assert.equal(ctx.state.recoveryCodes.has(userId), false);
});

test('rejects tampered encrypted secrets and malformed store state fail closed', async () => {
  const ctx = createService();
  const { enrollment } = await enableMfa(ctx.service);
  const record = ctx.state.authenticators.get(userId);
  record.secret = `${record.secret.slice(0, -1)}${record.secret.endsWith('A') ? 'B' : 'A'}`;
  await expectMfaCode(
    () => ctx.service.verify({
      userId,
      code: createTotpCode(enrollment.secret, now),
      rateLimitActor: actor,
    }),
    'UNAVAILABLE',
  );
  ctx.state.authenticators.set(userId, {
    pendingSecret: null,
    secret: 'bad',
    lastAcceptedStep: null,
    enabled: true,
  });
  await expectMfaCode(
    () => ctx.service.verify({ userId, code: '123456', rateLimitActor: actor }),
    'UNAVAILABLE',
  );
});

test('PostgreSQL adapter validates scope and uses atomic storage operations', async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes('RETURNING attempts <= $2 AS allowed')) return { rows: [{ allowed: true }] };
          if (sql.includes('RETURNING codes.user_id')) return { rows: [{ user_id: userId }] };
          if (sql.includes('SELECT last_accepted_step::double precision')) {
            return { rows: [{ last_accepted_step: 2 }] };
          }
          if (sql.includes('RETURNING user_id')) return { rows: [{ user_id: userId }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const store = createPostgresMfaStore({ pool, schemaName: 'app_auth' });
  const hashes = Array.from({ length: 10 }, (_, index) => String(index).padStart(64, '0'));
  assert.equal(await store.beginEnrollment(userId, 'v1.encrypted'), true);
  assert.equal(await store.activateEnrollment({
    userId, lastAcceptedStep: 10, recoveryCodeHashes: hashes, now,
  }), true);
  assert.equal(await store.consumeTotpStep(userId, 11), true);
  assert.equal(await store.consumeRecoveryCode(userId, hashes[0]), true);
  assert.equal(await store.disableMfa({
    userId, step: 12, recoveryCodeHash: null,
  }), true);
  assert.equal(await store.consumeRateLimit('a'.repeat(64), 8, 900_000, now), true);
  assert.ok(calls.every(call => call.sql.includes('"app_auth"') ||
    ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)));
  assert.ok(calls.some(call => call.sql.includes('last_accepted_step < $2')));
  assert.ok(calls.some(call => call.sql.includes('DELETE FROM "app_auth".mfa_recovery_codes') &&
    call.sql.includes('RETURNING codes.user_id')));
  assert.ok(calls.some(call => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(call => call.sql.includes('ON CONFLICT (bucket_hash)')));
  assert.ok(calls.every(call => !call.sql.includes(userId) && !call.sql.includes(hashes[0])));
  assert.throws(() => createPostgresMfaStore({ pool, schemaName: 'app"; DROP SCHEMA public;--' }), TypeError);
  assert.throws(() => createPostgresMfaStore({
    pool, schemaName: 'app_auth', unexpected: true,
  }), TypeError);

  const migration = readFileSync(new URL('../modules/mfa/migrations/0001_local_mfa.sql', import.meta.url), 'utf8');
  assert.match(migration, /REFERENCES auth_users/u);
  assert.match(migration, /code_hash TEXT NOT NULL/u);
  assert.doesNotMatch(migration, /\bDROP\b/iu);
});

test('MFA migrations register auth dependencies and MFA in one migration pass', async () => {
  const coreMigrations = new Map();
  const moduleMigrations = new Map();
  const pool = {
    async connect() {
      return {
        async query(sql, parameters = []) {
          if (sql.includes('SELECT version, id, checksum FROM schema_migrations')) {
            return { rows: [...coreMigrations.values()] };
          }
          if (sql.includes('SELECT module_id, version, id, checksum FROM module_migrations')) {
            return { rows: [...moduleMigrations.values()] };
          }
          if (sql.startsWith('INSERT INTO schema_migrations')) {
            const [version, id, checksum] = parameters;
            coreMigrations.set(version, { version, id, checksum });
          }
          if (sql.startsWith('INSERT INTO module_migrations')) {
            const [moduleId, version, id, checksum] = parameters;
            moduleMigrations.set(`${moduleId}:${version}`, {
              module_id: moduleId, version, id, checksum,
            });
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  await runMfaMigrations(pool, 'app_auth');
  assert.equal(moduleMigrations.get('auth:1').id, '0001_local_authentication');
  assert.equal(moduleMigrations.get('mfa:1').id, '0001_local_mfa');
});
