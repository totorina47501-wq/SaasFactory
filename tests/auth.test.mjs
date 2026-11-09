import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  authContract,
  AuthModuleError,
  createAuthService,
} from '../modules/auth/index.mjs';
import { createPostgresAuthStore } from '../modules/auth/postgres-store.mjs';

const origin = 'https://auth.example.test';
const actor = '127.0.0.1';
const password = 'correct horse battery';

function fakeStore() {
  const state = {
    users: new Map(),
    sessions: new Map(),
    resets: new Map(),
    limits: new Map(),
    failUserLookup: false,
    beforeCreateSession: null,
  };
  const store = {
    async findUserByEmail(email) {
      if (state.failUserLookup) throw new Error('driver ******');
      const user = state.users.get(email);
      return user ? { id: user.id, email: user.email, passwordHash: user.passwordHash } : null;
    },
    async findUserById(id) {
      const user = [...state.users.values()].find(item => item.id === id);
      return user ? { id: user.id, email: user.email, passwordHash: user.passwordHash } : null;
    },
    async createUser(user) {
      if (state.users.has(user.email)) return false;
      state.users.set(user.email, { ...user });
      return true;
    },
    async createSessionIfPasswordHashMatches(session, expectedPasswordHash) {
      if (state.beforeCreateSession) await state.beforeCreateSession();
      const user = [...state.users.values()].find(item => item.id === session.userId);
      if (!user || user.passwordHash !== expectedPasswordHash) return false;
      state.sessions.set(session.tokenHash, { ...session });
      return true;
    },
    async findSessionByTokenHash(tokenHash) {
      const session = state.sessions.get(tokenHash);
      return session ? {
        userId: session.userId,
        csrfHash: session.csrfHash,
        expiresAt: session.expiresAt,
      } : null;
    },
    async deleteSessionByTokenHash(tokenHash) {
      state.sessions.delete(tokenHash);
    },
    async rotateSession(oldTokenHash, session) {
      if (!state.sessions.has(oldTokenHash)) return false;
      state.sessions.delete(oldTokenHash);
      state.sessions.set(session.tokenHash, { ...session });
      return true;
    },
    async deleteSessionsByUserId(userId) {
      for (const [hash, session] of state.sessions) {
        if (session.userId === userId) state.sessions.delete(hash);
      }
    },
    async createResetToken(reset) {
      state.resets.set(reset.tokenHash, { ...reset });
    },
    async revokeResetToken(tokenHash) {
      state.resets.delete(tokenHash);
    },
    async completePasswordReset({ tokenHash, passwordHash, now }) {
      const reset = state.resets.get(tokenHash);
      if (!reset || reset.expiresAt <= now) return false;
      const user = [...state.users.values()].find(item => item.id === reset.userId);
      if (!user) return false;
      user.passwordHash = passwordHash;
      for (const [hash, entry] of state.resets) {
        if (entry.userId === user.id) state.resets.delete(hash);
      }
      await store.deleteSessionsByUserId(user.id);
      return true;
    },
    async consumeRateLimit(key, limit, windowMs, now) {
      let entry = state.limits.get(key);
      if (!entry || entry.startedAt + windowMs <= now) {
        entry = { startedAt: now, count: 0 };
        state.limits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
  return { store, state };
}

function createService(options = {}) {
  const { store, state } = options.store ?? fakeStore();
  let now = options.now ?? Date.UTC(2026, 0, 1);
  const outbox = [];
  const service = createAuthService({
    store,
    origin: options.origin ?? origin,
    localResetChannel: options.channel ?? {
      kind: 'local',
      async deliver(message) {
        outbox.push(message);
      },
    },
    clock: () => now,
  });
  return {
    service,
    store,
    state,
    outbox,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

const credentials = (email = 'member@example.test', overrides = {}) => ({
  email,
  password,
  origin,
  rateLimitActor: actor,
  ...overrides,
});

function cookieValue(cookie) {
  return cookie.split(';', 1)[0];
}

async function registerAndLogin(service, email = 'member@example.test') {
  await service.register(credentials(email));
  return service.login(credentials(email));
}

function expectAuthCode(callback, code) {
  return assert.rejects(callback, error =>
    error instanceof AuthModuleError && error.code === code && error.message === code);
}

test('uses the versioned bounded scrypt profile and creates non-enumerable accounts', async () => {
  const ctx = createService();
  assert.deepEqual(authContract, {
    version: 1,
    passwordHash: {
      algorithm: 'scrypt',
      N: 32_768,
      r: 8,
      p: 1,
      keyLength: 64,
      maxmem: 64 * 1024 * 1024,
      saltBytes: 16,
    },
    sessionTtlMs: 12 * 60 * 60 * 1000,
    resetTtlMs: 30 * 60 * 1000,
    rateWindowMs: 15 * 60 * 1000,
  });
  assert.deepEqual(await ctx.service.register(credentials()), { accepted: true });
  assert.deepEqual(await ctx.service.register(credentials('MEMBER@example.test')), { accepted: true });
  assert.equal(ctx.state.users.size, 1);
  const storedHash = ctx.state.users.get('member@example.test').passwordHash;
  assert.match(storedHash, /^scrypt\$32768\$8\$1\$/u);
  assert.notEqual(storedHash, password);
  assert.notEqual((await ctx.service.register(credentials('another@example.test'))).accepted, false);
  assert.notEqual(ctx.state.users.get('another@example.test').passwordHash, storedHash);
});

test('login failures do not enumerate users or expose storage errors', async () => {
  const ctx = createService();
  await ctx.service.register(credentials());
  await expectAuthCode(
    () => ctx.service.login(credentials('member@example.test', { password: 'wrong password value' })),
    'AUTHENTICATION_FAILED',
  );
  await expectAuthCode(
    () => ctx.service.login(credentials('missing@example.test')),
    'AUTHENTICATION_FAILED',
  );
  ctx.state.failUserLookup = true;
  await expectAuthCode(() => ctx.service.login(credentials()), 'UNAVAILABLE');
});

test('sessions survive service reconstruction, store only token hashes, and use secure cookies', async () => {
  const ctx = createService();
  const login = await registerAndLogin(ctx.service);
  assert.deepEqual(login.user, { id: ctx.state.users.get('member@example.test').id });
  assert.match(login.setCookie, /^__Host-sf_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/u);
  const rawSessionToken = cookieValue(login.setCookie).split('=')[1];
  assert.equal([...ctx.state.sessions.keys()].includes(rawSessionToken), false);
  const storedSession = [...ctx.state.sessions.values()][0];
  assert.notEqual(storedSession.csrfHash, login.csrfToken);

  const secondService = createAuthService({
    store: ctx.store,
    origin,
    localResetChannel: { kind: 'local', deliver: async () => {} },
    clock: () => Date.UTC(2026, 0, 1),
  });
  assert.deepEqual(await secondService.currentUser({ cookieHeader: cookieValue(login.setCookie) }), login.user);
});

test('requires origin and CSRF checks, rotates sessions, and revokes logout cookies', async () => {
  const ctx = createService();
  const login = await registerAndLogin(ctx.service);
  const cookieHeader = cookieValue(login.setCookie);

  await expectAuthCode(
    () => ctx.service.rotateSession({ cookieHeader, csrfToken: 'A'.repeat(43), origin }),
    'INVALID_SESSION',
  );
  await expectAuthCode(
    () => ctx.service.logout({ cookieHeader, csrfToken: login.csrfToken, origin: 'https://evil.example' }),
    'ORIGIN_REJECTED',
  );
  assert.ok(await ctx.service.currentUser({ cookieHeader }));

  const rotated = await ctx.service.rotateSession({
    cookieHeader,
    csrfToken: login.csrfToken,
    origin,
  });
  assert.equal(await ctx.service.currentUser({ cookieHeader }), null);
  assert.deepEqual(await ctx.service.currentUser({ cookieHeader: cookieValue(rotated.setCookie) }), login.user);

  const loggedOut = await ctx.service.logout({
    cookieHeader: cookieValue(rotated.setCookie),
    csrfToken: rotated.csrfToken,
    origin,
  });
  assert.match(loggedOut.setCookie, /Max-Age=0/u);
  assert.equal(await ctx.service.currentUser({ cookieHeader: cookieValue(rotated.setCookie) }), null);
});

test('local password reset hides tokens, expires, is one-use, and revokes all sessions', async () => {
  const ctx = createService();
  const login = await registerAndLogin(ctx.service);
  const response = await ctx.service.requestPasswordReset({
    email: 'unknown@example.test',
    origin,
    rateLimitActor: actor,
  });
  assert.deepEqual(response, { accepted: true });
  assert.equal(ctx.outbox.length, 0);

  const resetResponse = await ctx.service.requestPasswordReset({
    email: 'member@example.test',
    origin,
    rateLimitActor: actor,
  });
  assert.deepEqual(resetResponse, { accepted: true });
  const expiredToken = ctx.outbox[0].token;
  assert.equal(JSON.stringify(resetResponse).includes(expiredToken), false);
  assert.ok([...ctx.state.resets.keys()].every(hash => hash !== expiredToken));
  ctx.advance(authContract.resetTtlMs + 1);
  await expectAuthCode(() => ctx.service.completePasswordReset({
    token: expiredToken,
    newPassword: 'new correct horse password',
    origin,
    rateLimitActor: actor,
  }), 'RESET_INVALID');

  await ctx.service.requestPasswordReset({
    email: 'member@example.test',
    origin,
    rateLimitActor: actor,
  });
  const usableToken = ctx.outbox[1].token;
  assert.deepEqual(await ctx.service.completePasswordReset({
    token: usableToken,
    newPassword: 'new correct horse password',
    origin,
    rateLimitActor: actor,
  }), { accepted: true });
  await expectAuthCode(() => ctx.service.completePasswordReset({
    token: usableToken,
    newPassword: 'another password value',
    origin,
    rateLimitActor: actor,
  }), 'RESET_INVALID');
  assert.equal(await ctx.service.currentUser({ cookieHeader: cookieValue(login.setCookie) }), null);
  await expectAuthCode(
    () => ctx.service.login(credentials('member@example.test')),
    'AUTHENTICATION_FAILED',
  );
  assert.ok(await ctx.service.login(credentials('member@example.test', {
    password: 'new correct horse password',
  })));
});

test('a concurrent password reset cannot create a session from the old password', async () => {
  const ctx = createService();
  await ctx.service.register(credentials());
  await ctx.service.requestPasswordReset({
    email: 'member@example.test',
    origin,
    rateLimitActor: actor,
  });
  let resetDuringLogin = true;
  ctx.state.beforeCreateSession = async () => {
    if (!resetDuringLogin) return;
    resetDuringLogin = false;
    await ctx.service.completePasswordReset({
      token: ctx.outbox[0].token,
      newPassword: 'new correct horse password',
      origin,
      rateLimitActor: actor,
    });
  };
  await expectAuthCode(() => ctx.service.login(credentials()), 'AUTHENTICATION_FAILED');
  assert.equal(ctx.state.sessions.size, 0);
  assert.ok(await ctx.service.login(credentials('member@example.test', {
    password: 'new correct horse password',
  })));
});

test('rate limits repeated login guesses and reset delivery without revealing account state', async () => {
  const ctx = createService();
  await ctx.service.register(credentials());
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await expectAuthCode(
      () => ctx.service.login(credentials('member@example.test', { password: 'wrong password value' })),
      'AUTHENTICATION_FAILED',
    );
  }
  await expectAuthCode(
    () => ctx.service.login(credentials('member@example.test', { password: 'wrong password value' })),
    'RATE_LIMITED',
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(await ctx.service.requestPasswordReset({
      email: 'member@example.test',
      origin,
      rateLimitActor: actor,
    }), { accepted: true });
  }
  const resetCount = ctx.outbox.length;
  assert.deepEqual(await ctx.service.requestPasswordReset({
    email: 'member@example.test',
    origin,
    rateLimitActor: actor,
  }), { accepted: true });
  assert.equal(ctx.outbox.length, resetCount);
});

test('rejects hostile inputs, duplicate cookies, insecure production origins, and remote reset channels', async () => {
  const ctx = createService();
  let getterCalled = false;
  const badInput = {};
  Object.defineProperty(badInput, 'email', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('must not run');
    },
  });
  await expectAuthCode(() => ctx.service.register(badInput), 'INVALID_INPUT');
  assert.equal(getterCalled, false);
  await expectAuthCode(
    () => ctx.service.register({ ...credentials(), unknown: true }),
    'INVALID_INPUT',
  );
  await expectAuthCode(
    () => ctx.service.register(credentials('bad-email')),
    'INVALID_INPUT',
  );
  assert.equal(await ctx.service.currentUser({
    cookieHeader: '__Host-sf_session=a; __Host-sf_session=b',
  }), null);
  assert.throws(() => createAuthService({
    store: ctx.store,
    origin: 'http://service.example.test',
    localResetChannel: { kind: 'local', deliver: async () => {} },
  }), error => error instanceof AuthModuleError && error.code === 'INVALID_CONFIGURATION');
  assert.throws(() => createAuthService({
    store: ctx.store,
    origin,
    localResetChannel: { kind: 'remote', deliver: async () => {} },
  }), error => error instanceof AuthModuleError && error.code === 'INVALID_RESET_CHANNEL');
  const local = createService({ origin: 'http://localhost:3000' });
  await local.service.register(credentials('member@example.test', { origin: 'http://localhost:3000' }));
  const localLogin = await local.service.login(credentials('member@example.test', {
    origin: 'http://localhost:3000',
  }));
  assert.match(localLogin.setCookie, /^sf_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/u);
});

test('PostgreSQL store uses fixed schema identifiers, bound values, and atomic reset/session operations', async () => {
  const calls = [];
  let currentPasswordHash = 'old-password-hash';
  const pool = {
    async connect() {
      return {
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (sql.includes('RETURNING attempts <= $2 AS allowed')) return { rows: [{ allowed: true }] };
          if (sql.includes('SELECT password_hash') && sql.includes('FOR UPDATE')) {
            return { rows: [{ password_hash: currentPasswordHash }] };
          }
          if (sql.includes('SELECT id FROM "app_auth".auth_users') && sql.includes('FOR UPDATE')) {
            return { rows: [{ id: 'user-id' }] };
          }
          if (sql.includes('DELETE FROM "app_auth".auth_sessions') && sql.includes('RETURNING user_id')) {
            return { rows: [{ user_id: 'user-id' }] };
          }
          if (sql.includes('DELETE FROM "app_auth".auth_password_resets') && sql.includes('RETURNING user_id')) {
            return { rows: [{ user_id: 'user-id' }] };
          }
          if (sql.includes('UPDATE "app_auth".auth_users')) return { rows: [{ id: 'user-id' }] };
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const store = createPostgresAuthStore({ pool, schemaName: 'app_auth' });
  assert.equal(await store.consumeRateLimit('hashed-bucket', 8, 900_000, 1_000), true);
  assert.equal(await store.purgeExpiredAuthData(1_000), 0);
  const session = {
    tokenHash: 'new-session-hash',
    userId: 'user-id',
    csrfHash: 'csrf-hash',
    createdAt: 1_000,
    expiresAt: 43_201_000,
  };
  assert.equal(await store.createSessionIfPasswordHashMatches(session, 'old-password-hash'), true);
  currentPasswordHash = 'new-password-hash';
  assert.equal(await store.createSessionIfPasswordHashMatches(session, 'old-password-hash'), false);
  assert.equal(await store.rotateSession('old-hash', {
    tokenHash: 'new-hash',
    userId: 'user-id',
    csrfHash: 'csrf-hash',
    createdAt: 1_000,
    expiresAt: 43_201_000,
  }), true);
  assert.equal(await store.completePasswordReset({
    tokenHash: 'reset-hash',
    passwordHash: 'scrypt-hash',
    now: 1_000,
  }), true);
  assert.ok(calls.every(call => call.sql.includes('"app_auth"') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)));
  assert.ok(calls.some(call => call.parameters.includes('hashed-bucket')));
  assert.ok(calls.some(call => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(calls.some(call => call.sql.includes('auth_sessions WHERE expires_at <=')));
  assert.throws(() => createPostgresAuthStore({ pool, schemaName: 'app"; DROP SCHEMA public;--' }), TypeError);
  assert.throws(() => createPostgresAuthStore({
    pool,
    schemaName: 'app_auth',
    unexpected: true,
  }), TypeError);

  const migration = readFileSync(new URL('../modules/auth/migrations/0001_local_authentication.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE auth_users/u);
  assert.match(migration, /CREATE TABLE auth_sessions/u);
  assert.match(migration, /CREATE TABLE auth_password_resets/u);
  assert.match(migration, /CREATE TABLE auth_rate_limits/u);
  assert.match(migration, /ON DELETE CASCADE/u);
  assert.doesNotMatch(migration, /\bDROP\b/iu);
});
