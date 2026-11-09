import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const CONTRACT_VERSION = 1;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW_STEPS = 1;
const RECOVERY_CODE_COUNT = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = Object.freeze({
  enroll: 5,
  confirm: 8,
  verify: 8,
  disable: 8,
});
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const STORE_METHODS = [
  'beginEnrollment',
  'getAuthenticator',
  'activateEnrollment',
  'consumeTotpStep',
  'consumeRecoveryCode',
  'disableMfa',
  'consumeRateLimit',
];

export class MfaModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MfaModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new MfaModuleError(code);
}

function exactInput(value, expected, required = expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_INPUT');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function validateUserId(userId) {
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) fail('INVALID_INPUT');
  return userId;
}

function validateActor(actor) {
  if (typeof actor !== 'string' || actor.length < 1 || actor.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/u.test(actor)) {
    fail('INVALID_INPUT');
  }
  return actor;
}

function validatePassword(password) {
  if (typeof password !== 'string' || !password.isWellFormed()) fail('INVALID_INPUT');
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 12 || bytes > 1024) fail('INVALID_INPUT');
  return password;
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]+$/u.test(value)) fail('INVALID_INPUT');
  let bits = 0;
  let accumulator = 0;
  const result = [];
  for (const character of value) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      result.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) fail('INVALID_INPUT');
  const decoded = Buffer.from(result);
  if (encodeBase32(decoded) !== value) fail('INVALID_INPUT');
  return decoded;
}

export function createTotpCode(secret, timestampMs) {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) fail('INVALID_INPUT');
  const key = decodeBase32(secret);
  const counter = Math.floor(timestampMs / (TOTP_PERIOD_SECONDS * 1000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) |
    ((hmac[offset + 1] & 255) << 16) |
    ((hmac[offset + 2] & 255) << 8) |
    (hmac[offset + 3] & 255);
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function matchTotpStep(secret, code, now) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null;
  const currentStep = Math.floor(now / (TOTP_PERIOD_SECONDS * 1000));
  let match = null;
  for (let step = Math.max(0, currentStep - TOTP_WINDOW_STEPS);
    step <= currentStep + TOTP_WINDOW_STEPS; step += 1) {
    const candidate = Buffer.from(createTotpCode(secret, step * TOTP_PERIOD_SECONDS * 1000), 'ascii');
    const supplied = Buffer.from(code, 'ascii');
    if (timingSafeEqual(candidate, supplied)) match = step;
  }
  return match;
}

function encryptSecret(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('saasfactory:mfa:v1', 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSecret(encoded, key) {
  if (typeof encoded !== 'string') fail('UNAVAILABLE');
  const match = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/u.exec(encoded);
  if (!match) fail('UNAVAILABLE');
  try {
    const iv = Buffer.from(match[1], 'base64url');
    const tag = Buffer.from(match[2], 'base64url');
    const ciphertext = Buffer.from(match[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== 32 ||
        iv.toString('base64url') !== match[1] || tag.toString('base64url') !== match[2] ||
        ciphertext.toString('base64url') !== match[3]) {
      fail('UNAVAILABLE');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('saasfactory:mfa:v1', 'ascii'));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    decodeBase32(secret);
    return secret;
  } catch {
    fail('UNAVAILABLE');
  }
}

function recoveryCode() {
  return randomBytes(16).toString('base64url');
}

function validRecoveryCode(value) {
  return typeof value === 'string' && RECOVERY_CODE_PATTERN.test(value);
}

function validateRecord(record) {
  if (record === null) return null;
  if (record === null || typeof record !== 'object' || Array.isArray(record) ||
      Reflect.ownKeys(record).some(key => !['pendingSecret', 'secret', 'lastAcceptedStep', 'enabled'].includes(key)) ||
      typeof record.enabled !== 'boolean' ||
      (record.pendingSecret !== null && typeof record.pendingSecret !== 'string') ||
      (record.secret !== null && typeof record.secret !== 'string') ||
      (record.lastAcceptedStep !== null && (!Number.isSafeInteger(record.lastAcceptedStep) || record.lastAcceptedStep < 0))) {
    fail('UNAVAILABLE');
  }
  if (record.enabled !== (record.secret !== null) ||
      (record.enabled && record.lastAcceptedStep === null)) {
    fail('UNAVAILABLE');
  }
  return record;
}

function unavailable(error) {
  if (error instanceof MfaModuleError) throw error;
  fail('UNAVAILABLE');
}

export function createMfaService(options) {
  exactInput(options, ['store', 'encryptionKey', 'reauthenticate', 'clock'], [
    'store',
    'encryptionKey',
    'reauthenticate',
  ]);
  if (!options.store || STORE_METHODS.some(method => typeof options.store[method] !== 'function')) {
    fail('INVALID_STORE');
  }
  if (!Buffer.isBuffer(options.encryptionKey) || options.encryptionKey.length !== 32) {
    fail('INVALID_CONFIGURATION');
  }
  if (typeof options.reauthenticate !== 'function') fail('INVALID_CONFIGURATION');
  const store = options.store;
  const key = Buffer.from(options.encryptionKey);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  async function requireReauthentication(userId, password) {
    try {
      if (await options.reauthenticate(Object.freeze({ userId, password })) !== true) {
        fail('REAUTH_FAILED');
      }
    } catch (error) {
      if (error instanceof MfaModuleError) throw error;
      fail('REAUTH_FAILED');
    }
  }

  async function applyRateLimit(operation, userId, actor, now) {
    const limits = [
      [digest(`identity:${operation}:${userId}`), RATE_LIMITS[operation]],
      [digest(`actor:${operation}:${actor}`), RATE_LIMITS[operation] * 4],
    ];
    let allowed = true;
    for (const [bucket, limit] of limits) {
      const result = await store.consumeRateLimit(bucket, limit, RATE_WINDOW_MS, now);
      if (typeof result !== 'boolean') fail('UNAVAILABLE');
      allowed = result && allowed;
    }
    if (!allowed) fail('RATE_LIMITED');
  }

  async function loadRecord(userId) {
    return validateRecord(await store.getAuthenticator(userId));
  }

  async function resolveFactor(record, code, now) {
    if (!record?.enabled) return null;
    if (validRecoveryCode(code)) {
      return { kind: 'recovery', hash: digest(code) };
    }
    const secret = decryptSecret(record.secret, key);
    const step = matchTotpStep(secret, code, now);
    return step === null ? null : { kind: 'totp', step };
  }

  async function consumeFactor(userId, factor) {
    if (!factor) return false;
    const consumed = factor.kind === 'totp'
      ? await store.consumeTotpStep(userId, factor.step)
      : await store.consumeRecoveryCode(userId, factor.hash);
    if (typeof consumed !== 'boolean') fail('UNAVAILABLE');
    return consumed;
  }

  return Object.freeze({
    async beginEnrollment(input) {
      exactInput(input, ['userId', 'password', 'rateLimitActor']);
      const userId = validateUserId(input.userId);
      const password = validatePassword(input.password);
      const actor = validateActor(input.rateLimitActor);
      const now = validateNow(clock);
      try {
        await applyRateLimit('enroll', userId, actor, now);
        await requireReauthentication(userId, password);
        const record = await loadRecord(userId);
        if (record?.enabled) fail('MFA_ALREADY_ENABLED');
        const secret = encodeBase32(randomBytes(20));
        const saved = await store.beginEnrollment(userId, encryptSecret(secret, key));
        if (typeof saved !== 'boolean') fail('UNAVAILABLE');
        if (!saved) fail('MFA_ALREADY_ENABLED');
        const label = encodeURIComponent(`SaaSFactory:${userId}`);
        const issuer = encodeURIComponent('SaaSFactory');
        return Object.freeze({
          secret,
          otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
        });
      } catch (error) {
        unavailable(error);
      }
    },

    async confirmEnrollment(input) {
      exactInput(input, ['userId', 'password', 'code', 'rateLimitActor']);
      const userId = validateUserId(input.userId);
      const password = validatePassword(input.password);
      const actor = validateActor(input.rateLimitActor);
      if (typeof input.code !== 'string' || input.code.length > 64 || !input.code.isWellFormed()) fail('INVALID_INPUT');
      const now = validateNow(clock);
      try {
        await applyRateLimit('confirm', userId, actor, now);
        await requireReauthentication(userId, password);
        const record = await loadRecord(userId);
        if (!record?.pendingSecret || record.enabled) fail('ENROLLMENT_NOT_FOUND');
        const secret = decryptSecret(record.pendingSecret, key);
        const step = matchTotpStep(secret, input.code, now);
        if (step === null) fail('INVALID_CODE');
        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
        const activated = await store.activateEnrollment({
          userId,
          lastAcceptedStep: step,
          recoveryCodeHashes: codes.map(digest),
          now,
        });
        if (typeof activated !== 'boolean') fail('UNAVAILABLE');
        if (!activated) fail('ENROLLMENT_NOT_FOUND');
        return Object.freeze({ recoveryCodes: Object.freeze(codes) });
      } catch (error) {
        unavailable(error);
      }
    },

    async verify(input) {
      exactInput(input, ['userId', 'code', 'rateLimitActor']);
      const userId = validateUserId(input.userId);
      const actor = validateActor(input.rateLimitActor);
      if (typeof input.code !== 'string' || input.code.length > 64 || !input.code.isWellFormed()) fail('INVALID_INPUT');
      const now = validateNow(clock);
      try {
        await applyRateLimit('verify', userId, actor, now);
        const record = await loadRecord(userId);
        const factor = await resolveFactor(record, input.code, now);
        if (!await consumeFactor(userId, factor)) fail('INVALID_CODE');
        return Object.freeze({ verified: true, factor: factor.kind });
      } catch (error) {
        unavailable(error);
      }
    },

    async disable(input) {
      exactInput(input, ['userId', 'password', 'code', 'rateLimitActor']);
      const userId = validateUserId(input.userId);
      const password = validatePassword(input.password);
      const actor = validateActor(input.rateLimitActor);
      if (typeof input.code !== 'string' || input.code.length > 64 || !input.code.isWellFormed()) fail('INVALID_INPUT');
      const now = validateNow(clock);
      try {
        await applyRateLimit('disable', userId, actor, now);
        await requireReauthentication(userId, password);
        const record = await loadRecord(userId);
        if (!record?.enabled) fail('MFA_NOT_ENABLED');
        const factor = await resolveFactor(record, input.code, now);
        if (!factor) fail('INVALID_CODE');
        const disabled = await store.disableMfa({
          userId,
          step: factor.kind === 'totp' ? factor.step : null,
          recoveryCodeHash: factor.kind === 'recovery' ? factor.hash : null,
        });
        if (typeof disabled !== 'boolean') fail('UNAVAILABLE');
        if (!disabled) fail('INVALID_CODE');
        return Object.freeze({ disabled: true });
      } catch (error) {
        unavailable(error);
      }
    },
  });
}

export const mfaContract = Object.freeze({
  version: CONTRACT_VERSION,
  algorithm: 'TOTP-RFC6238-SHA1',
  digits: TOTP_DIGITS,
  periodSeconds: TOTP_PERIOD_SECONDS,
  allowedDriftSteps: TOTP_WINDOW_STEPS,
  recoveryCodeCount: RECOVERY_CODE_COUNT,
  rateWindowMs: RATE_WINDOW_MS,
  identityAttemptsPerOperation: RATE_LIMITS,
});

export { createPostgresMfaStore, runMfaMigrations } from './postgres-store.mjs';
