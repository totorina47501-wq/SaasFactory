import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_HASH = Object.freeze({ N: 32_768, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 });
const SALT_LENGTH = 16;
const TOKEN_LENGTH = 32;
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = Object.freeze({
  register: { identity: 5, actor: 20 },
  login: { identity: 8, actor: 50 },
  reset: { identity: 4, actor: 20 },
  'reset-complete': { identity: 10, actor: 10 },
});
const STORE_METHODS = [
  'findUserByEmail',
  'findUserById',
  'createUser',
  'createSession',
  'findSessionByTokenHash',
  'deleteSessionByTokenHash',
  'rotateSession',
  'deleteSessionsByUserId',
  'createResetToken',
  'revokeResetToken',
  'completePasswordReset',
  'consumeRateLimit',
];

export class AuthModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AuthModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new AuthModuleError(code);
}

function exactInput(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key))) fail('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function valueObject(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key)) ||
      expected.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_PATTERN.test(email) ||
      !email.isWellFormed()) {
    fail('INVALID_INPUT');
  }
  return email.toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== 'string' || !password.isWellFormed()) fail('INVALID_INPUT');
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 12 || bytes > 1024) fail('INVALID_INPUT');
  return password;
}

function validateActor(actor) {
  if (typeof actor !== 'string' || actor.length < 1 || actor.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/u.test(actor)) {
    fail('INVALID_INPUT');
  }
  return actor;
}

function validateOrigin(origin, configuredOrigin) {
  if (typeof origin !== 'string' || origin !== configuredOrigin) fail('ORIGIN_REJECTED');
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function token() {
  return randomBytes(TOKEN_LENGTH).toString('base64url');
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function sameDigest(candidate, expected) {
  const left = Buffer.from(digest(typeof candidate === 'string' ? candidate : ''), 'hex');
  const right = Buffer.from(typeof expected === 'string' && /^[a-f0-9]{64}$/u.test(expected)
    ? expected
    : '0'.repeat(64), 'hex');
  return timingSafeEqual(left, right) &&
    typeof candidate === 'string' &&
    typeof expected === 'string' &&
    /^[a-f0-9]{64}$/u.test(expected);
}

function canonicalOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 255) fail('INVALID_CONFIGURATION');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail('INVALID_CONFIGURATION');
  }
  const localHttp = parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((!localHttp && parsed.protocol !== 'https:') || parsed.origin !== origin ||
      parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash) {
    fail('INVALID_CONFIGURATION');
  }
  return { origin, secure: parsed.protocol === 'https:' };
}

function validateUser(user) {
  if (!valueObject(user, ['id', 'email', 'passwordHash']) ||
      typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(user.id) ||
      typeof user.email !== 'string' || typeof user.passwordHash !== 'string') {
    fail('UNAVAILABLE');
  }
  return user;
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = HASH_PATTERN.exec(encoded);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url');
  const key = Buffer.from(match[2], 'base64url');
  if (salt.length !== SALT_LENGTH || salt.toString('base64url') !== match[1] ||
      key.length !== PASSWORD_HASH.keyLength || key.toString('base64url') !== match[2]) {
    return null;
  }
  return { salt, key };
}

async function derivePassword(password, salt) {
  return scrypt(password, salt, PASSWORD_HASH.keyLength, {
    N: PASSWORD_HASH.N,
    r: PASSWORD_HASH.r,
    p: PASSWORD_HASH.p,
    maxmem: PASSWORD_HASH.maxmem,
  });
}

function cookieName(secure) {
  return secure ? '__Host-sf_session' : 'sf_session';
}

function sessionCookie(value, secure, maxAge) {
  const secureAttribute = secure ? '; Secure' : '';
  return `${cookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureAttribute}`;
}

function readCookie(header, secure) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const name = cookieName(secure);
  const matches = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) matches.push(part.slice(separator + 1).trim());
  }
  return matches.length === 1 && validToken(matches[0]) ? matches[0] : null;
}

function validateSessionRecord(session, now) {
  if (!valueObject(session, ['userId', 'csrfHash', 'expiresAt']) ||
      typeof session.userId !== 'string' ||
      typeof session.csrfHash !== 'string' || !/^[a-f0-9]{64}$/u.test(session.csrfHash) ||
      !Number.isSafeInteger(session.expiresAt)) {
    fail('UNAVAILABLE');
  }
  return session.expiresAt > now ? session : null;
}

function toPublicUser(user) {
  return Object.freeze({ id: user.id });
}

function unavailable(error) {
  if (error instanceof AuthModuleError) throw error;
  fail('UNAVAILABLE');
}

export function createAuthService(options) {
  exactInput(options, ['store', 'origin', 'localResetChannel', 'clock']);
  const store = options.store;
  if (!store || STORE_METHODS.some(method => typeof store[method] !== 'function')) {
    fail('INVALID_STORE');
  }
  const { origin, secure } = canonicalOrigin(options.origin);
  const channel = options.localResetChannel;
  if (!valueObject(channel, ['kind', 'deliver']) || channel.kind !== 'local' ||
      typeof channel.deliver !== 'function') {
    fail('INVALID_RESET_CHANNEL');
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  let activeHashOperations = 0;

  async function hashPassword(password) {
    if (activeHashOperations >= 4) fail('RATE_LIMITED');
    activeHashOperations += 1;
    try {
      const salt = randomBytes(SALT_LENGTH);
      const key = await derivePassword(password, salt);
      return `scrypt$${PASSWORD_HASH.N}$${PASSWORD_HASH.r}$${PASSWORD_HASH.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
    } finally {
      activeHashOperations -= 1;
    }
  }

  async function verifyPassword(password, encoded) {
    const parsed = parsePasswordHash(encoded);
    const hash = parsed ?? {
      salt: Buffer.alloc(SALT_LENGTH),
      key: Buffer.alloc(PASSWORD_HASH.keyLength),
    };
    if (activeHashOperations >= 4) fail('RATE_LIMITED');
    activeHashOperations += 1;
    try {
      const candidate = await derivePassword(password, hash.salt);
      const matches = timingSafeEqual(candidate, hash.key);
      return parsed !== null && matches;
    } finally {
      activeHashOperations -= 1;
    }
  }

  async function applyRateLimit(operation, email, actor) {
    const limits = RATE_LIMITS[operation];
    const now = validateNow(clock);
    const entries = [
      [digest(`identity:${operation}:${email}`), limits.identity],
      [digest(`actor:${operation}:${actor}`), limits.actor],
    ];
    let allowed = true;
    for (const [key, limit] of entries) {
      const result = await store.consumeRateLimit(key, limit, RATE_WINDOW_MS, now);
      if (typeof result !== 'boolean') fail('UNAVAILABLE');
      allowed = result && allowed;
    }
    return allowed;
  }

  async function lookupSession(cookieHeader) {
    const sessionToken = readCookie(cookieHeader, secure);
    if (!sessionToken) return null;
    const tokenHash = digest(sessionToken);
    const now = validateNow(clock);
    const stored = await store.findSessionByTokenHash(tokenHash);
    if (stored === null) return null;
    const session = validateSessionRecord(stored, now);
    if (!session) {
      await store.deleteSessionByTokenHash(tokenHash);
      return null;
    }
    const user = await store.findUserById(session.userId);
    if (user === null) return null;
    return { tokenHash, session, user: validateUser(user) };
  }

  function checkCsrf(session, csrfToken) {
    return validToken(csrfToken) && sameDigest(csrfToken, session.csrfHash);
  }

  async function createSession(userId) {
    const sessionToken = token();
    const csrfToken = token();
    const now = validateNow(clock);
    const session = {
      userId,
      csrfHash: digest(csrfToken),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    await store.createSession({ tokenHash: digest(sessionToken), ...session });
    return {
      csrfToken,
      setCookie: sessionCookie(sessionToken, secure, SESSION_TTL_MS / 1000),
    };
  }

  async function getCurrentSession(cookieHeader, csrfToken, requireCsrf) {
    const found = await lookupSession(cookieHeader);
    if (!found || (requireCsrf && !checkCsrf(found.session, csrfToken))) fail('INVALID_SESSION');
    return found;
  }

  return Object.freeze({
    async register(input) {
      exactInput(input, ['email', 'password', 'origin', 'rateLimitActor']);
      validateOrigin(input.origin, origin);
      const email = normalizeEmail(input.email);
      const password = validatePassword(input.password);
      const actor = validateActor(input.rateLimitActor);
      try {
        if (!await applyRateLimit('register', email, actor)) fail('RATE_LIMITED');
        const passwordHash = await hashPassword(password);
        const user = { id: randomUUID(), email, passwordHash, createdAt: validateNow(clock) };
        const created = await store.createUser(user);
        if (typeof created !== 'boolean') fail('UNAVAILABLE');
        return Object.freeze({ accepted: true });
      } catch (error) {
        unavailable(error);
      }
    },

    async login(input) {
      exactInput(input, ['email', 'password', 'origin', 'rateLimitActor']);
      validateOrigin(input.origin, origin);
      const email = normalizeEmail(input.email);
      const password = validatePassword(input.password);
      const actor = validateActor(input.rateLimitActor);
      try {
        if (!await applyRateLimit('login', email, actor)) fail('RATE_LIMITED');
        const user = await store.findUserByEmail(email);
        if (user !== null) validateUser(user);
        const valid = await verifyPassword(password, user?.passwordHash);
        if (!user || !valid) fail('AUTHENTICATION_FAILED');
        const session = await createSession(user.id);
        return Object.freeze({
          user: toPublicUser(user),
          csrfToken: session.csrfToken,
          setCookie: session.setCookie,
        });
      } catch (error) {
        unavailable(error);
      }
    },

    async currentUser(input) {
      exactInput(input, ['cookieHeader']);
      try {
        const found = await lookupSession(input.cookieHeader);
        return found ? toPublicUser(found.user) : null;
      } catch (error) {
        unavailable(error);
      }
    },

    async logout(input) {
      exactInput(input, ['cookieHeader', 'csrfToken', 'origin']);
      validateOrigin(input.origin, origin);
      try {
        const found = await getCurrentSession(input.cookieHeader, input.csrfToken, true);
        await store.deleteSessionByTokenHash(found.tokenHash);
        return Object.freeze({ setCookie: sessionCookie('', secure, 0) });
      } catch (error) {
        unavailable(error);
      }
    },

    async rotateSession(input) {
      exactInput(input, ['cookieHeader', 'csrfToken', 'origin']);
      validateOrigin(input.origin, origin);
      try {
        const found = await getCurrentSession(input.cookieHeader, input.csrfToken, true);
        const sessionToken = token();
        const csrfToken = token();
        const now = validateNow(clock);
        const newSession = {
          tokenHash: digest(sessionToken),
          userId: found.user.id,
          csrfHash: digest(csrfToken),
          createdAt: now,
          expiresAt: now + SESSION_TTL_MS,
        };
        const rotated = await store.rotateSession(found.tokenHash, newSession);
        if (typeof rotated !== 'boolean' || !rotated) fail('INVALID_SESSION');
        return Object.freeze({
          user: toPublicUser(found.user),
          csrfToken,
          setCookie: sessionCookie(sessionToken, secure, SESSION_TTL_MS / 1000),
        });
      } catch (error) {
        unavailable(error);
      }
    },

    async requestPasswordReset(input) {
      exactInput(input, ['email', 'origin', 'rateLimitActor']);
      validateOrigin(input.origin, origin);
      const email = normalizeEmail(input.email);
      const actor = validateActor(input.rateLimitActor);
      try {
        if (!await applyRateLimit('reset', email, actor)) {
          return Object.freeze({ accepted: true });
        }
        const user = await store.findUserByEmail(email);
        if (user === null) return Object.freeze({ accepted: true });
        validateUser(user);
        const resetToken = token();
        const expiresAt = validateNow(clock) + RESET_TTL_MS;
        const tokenHash = digest(resetToken);
        await store.createResetToken({
          tokenHash,
          userId: user.id,
          createdAt: expiresAt - RESET_TTL_MS,
          expiresAt,
        });
        try {
          await channel.deliver(Object.freeze({ email, token: resetToken, expiresAt }));
        } catch {
          await store.revokeResetToken(tokenHash);
        }
        return Object.freeze({ accepted: true });
      } catch (error) {
        unavailable(error);
      }
    },

    async completePasswordReset(input) {
      exactInput(input, ['token', 'newPassword', 'origin', 'rateLimitActor']);
      validateOrigin(input.origin, origin);
      const actor = validateActor(input.rateLimitActor);
      const password = validatePassword(input.newPassword);
      if (!validToken(input.token)) fail('RESET_INVALID');
      try {
        if (!await applyRateLimit('reset-complete', digest(input.token), actor)) {
          fail('RATE_LIMITED');
        }
        const passwordHash = await hashPassword(password);
        const completed = await store.completePasswordReset({
          tokenHash: digest(input.token),
          passwordHash,
          now: validateNow(clock),
        });
        if (typeof completed !== 'boolean') fail('UNAVAILABLE');
        if (!completed) fail('RESET_INVALID');
        return Object.freeze({ accepted: true });
      } catch (error) {
        unavailable(error);
      }
    },
  });
}

export const authContract = Object.freeze({
  version: 1,
  passwordHash: Object.freeze({ algorithm: 'scrypt', ...PASSWORD_HASH, saltBytes: SALT_LENGTH }),
  sessionTtlMs: SESSION_TTL_MS,
  resetTtlMs: RESET_TTL_MS,
  rateWindowMs: RATE_WINDOW_MS,
});

export { createPostgresAuthStore, runAuthMigrations } from './postgres-store.mjs';
