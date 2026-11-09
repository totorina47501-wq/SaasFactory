import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const FILE_NAME = 'notifications-v1.json';
const LOCK_NAME = 'notifications-v1.lock';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_LIMITS = Object.freeze({
  maxNotifications: 10000,
  maxEmailInbox: 10000,
  maxStorageBytes: 16 * 1024 * 1024,
  maxBodyChars: 4000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  lockWaitMs: 5000,
});
const JOB_TYPE = 'notifications.email.preview';

export class NotificationsModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NotificationsModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new NotificationsModuleError(code);
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

function validateId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function validateText(value, maxLength) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail('INVALID_INPUT');
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    fail('INVALID_INPUT');
  }
  return text;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function renderEmailTemplate(input) {
  exactInput(input, ['templateVersion', 'subject', 'body']);
  if (input.templateVersion !== 1) fail('INVALID_TEMPLATE');
  const subject = validateText(input.subject, 160);
  if (/[\r\n]/u.test(subject)) fail('INVALID_TEMPLATE');
  const body = validateText(input.body, DEFAULT_LIMITS.maxBodyChars);
  return Object.freeze({
    subject,
    text: body,
    html: `<main><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(body).replace(/\n/gu, '<br>')}</p></main>`,
  });
}

function emptyState() {
  return { version: 1, notifications: [], preferences: [], deliveries: [], emailInbox: [] };
}

function validateState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
      state.version !== 1 ||
      !Array.isArray(state.notifications) || !Array.isArray(state.preferences) ||
      !Array.isArray(state.deliveries) || !Array.isArray(state.emailInbox)) {
    fail('CORRUPT_STORAGE');
  }
  return state;
}

async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
  }
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        await realpath(directory) !== directory || (info.mode & 0o077) !== 0) {
      fail('UNSAFE_STORAGE');
    }
  } catch (error) {
    if (error instanceof NotificationsModuleError) throw error;
    fail('STORAGE_UNAVAILABLE');
  }
}

async function acquireLock(path, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return await open(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
      if (Date.now() >= deadline) fail('STORAGE_BUSY');
      await delay(10);
    }
  }
}

async function readState(path, maxBytes) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || (info.mode & 0o077) !== 0) {
      fail('UNSAFE_STORAGE');
    }
    return validateState(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof NotificationsModuleError) throw error;
    if (error?.code === 'ENOENT') return emptyState();
    fail('CORRUPT_STORAGE');
  }
}

async function writeState(path, state, maxBytes) {
  const contents = JSON.stringify(state);
  if (Buffer.byteLength(contents, 'utf8') > maxBytes) fail('STORAGE_LIMIT');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    fail('STORAGE_UNAVAILABLE');
  }
}

export async function createNotificationsService(configuration) {
  exactInput(configuration, ['directory', 'auth', 'tenancy', 'jobs', 'limits', 'clock'],
    ['directory', 'auth', 'tenancy', 'jobs']);
  if (typeof configuration.directory !== 'string' || !isAbsolute(configuration.directory) ||
      !configuration.auth || typeof configuration.auth.currentUser !== 'function' ||
      !configuration.tenancy || typeof configuration.tenancy.resolveTenantContext !== 'function' ||
      typeof configuration.tenancy.listMembers !== 'function' ||
      !configuration.jobs || typeof configuration.jobs.enqueue !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const directory = resolve(configuration.directory);
  const limits = { ...DEFAULT_LIMITS };
  if (configuration.limits !== undefined) {
    exactInput(configuration.limits, Object.keys(DEFAULT_LIMITS), []);
    for (const [key, value] of Object.entries(configuration.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_CONFIGURATION');
      limits[key] = value;
    }
  }
  if (limits.maxNotifications > 100000 || limits.maxEmailInbox > 100000 ||
      limits.maxStorageBytes > 1024 * 1024 * 1024 || limits.maxBodyChars > 16000 ||
      limits.retentionMs > 365 * 24 * 60 * 60 * 1000 || limits.lockWaitMs > 60000) {
    fail('INVALID_CONFIGURATION');
  }
  const clock = configuration.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  await ensureDirectory(directory);

  const storagePath = resolve(directory, FILE_NAME);
  const lockPath = resolve(directory, LOCK_NAME);

  async function mutate(callback) {
    await ensureDirectory(directory);
    let lock;
    try {
      lock = await acquireLock(lockPath, limits.lockWaitMs);
      const state = await readState(storagePath, limits.maxStorageBytes);
      const result = await callback(state);
      await writeState(storagePath, state, limits.maxStorageBytes);
      return result;
    } finally {
      if (lock) {
        await lock.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    }
  }

  async function access(input) {
    const user = await configuration.auth.currentUser({ cookieHeader: input.cookieHeader }).catch(() => null);
    if (!user || typeof user.id !== 'string' || !UUID_PATTERN.test(user.id)) fail('INVALID_SESSION');
    const userId = user.id.toLowerCase();
    const tenantId = validateId(input.tenantId);
    if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) fail('INVALID_INPUT');
    let context;
    let members;
    try {
      context = await configuration.tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader, tenantId, requestId: input.requestId,
      });
      members = await configuration.tenancy.listMembers({
        cookieHeader: input.cookieHeader, tenantId, requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    if (!context || context.contractVersion !== 1 || context.tenantId !== tenantId ||
        context.requestId !== input.requestId || !Array.isArray(members)) fail('TENANT_ACCESS_DENIED');
    const member = members.find(entry => entry?.id?.toLowerCase() === userId);
    if (!member) fail('TENANT_ACCESS_DENIED');
    return { tenantId, userId, requestId: input.requestId, member };
  }

  function getPreferences(state, tenantId, userId) {
    return state.preferences.find(entry => entry.tenantId === tenantId && entry.userId === userId) ??
      { tenantId, userId, inAppEnabled: true, emailEnabled: false };
  }

  function purge(state, now) {
    const expiredIds = new Set(state.notifications
      .filter(notification => notification.expiresAt <= now)
      .map(notification => notification.id));
    state.notifications = state.notifications.filter(notification => !expiredIds.has(notification.id));
    state.deliveries = state.deliveries.filter(delivery => !expiredIds.has(delivery.notificationId));
    state.emailInbox = state.emailInbox.filter(message => !expiredIds.has(message.notificationId));
    return expiredIds.size;
  }

  async function deliverPreview(notificationId) {
    const id = validateId(notificationId);
    return mutate(state => {
      const notification = state.notifications.find(entry => entry.id === id);
      if (!notification || notification.deletedAt !== null || notification.expiresAt <= validateNow(clock)) {
        return false;
      }
      const delivery = state.deliveries.find(entry => entry.notificationId === id);
      if (!delivery || delivery.emailStatus !== 'queued') return false;
      const preference = getPreferences(state, notification.tenantId, notification.userId);
      if (!preference.emailEnabled) {
        delivery.emailStatus = 'suppressed';
        return false;
      }
      if (state.emailInbox.some(entry => entry.notificationId === id)) {
        delivery.emailStatus = 'delivered';
        return false;
      }
      if (state.emailInbox.length >= limits.maxEmailInbox) fail('STORAGE_LIMIT');
      const rendered = renderEmailTemplate({
        templateVersion: 1,
        subject: notification.title,
        body: notification.body,
      });
      state.emailInbox.push({
        id: randomUUID(),
        notificationId: id,
        tenantId: notification.tenantId,
        userId: notification.userId,
        to: notification.email,
        ...rendered,
        createdAt: validateNow(clock),
      });
      delivery.emailStatus = 'delivered';
      return true;
    });
  }

  async function ensureEmailJob(accessInfo, notification, idempotencyKey) {
    const deliveryKey = `notification:${digest(`${accessInfo.tenantId}:${accessInfo.userId}:${idempotencyKey}`)}`;
    try {
      await configuration.jobs.enqueue({
        cookieHeader: accessInfo.cookieHeader,
        tenantId: accessInfo.tenantId,
        requestId: accessInfo.requestId,
        type: JOB_TYPE,
        idempotencyKey: deliveryKey,
        payload: { notificationId: notification.id, tenantId: accessInfo.tenantId },
      });
    } catch {
      fail('JOBS_UNAVAILABLE');
    }
  }

  return Object.freeze({
    async send(input) {
      exactInput(input, [
        'cookieHeader', 'tenantId', 'requestId', 'idempotencyKey', 'title', 'body',
      ]);
      const accessInfo = await access(input);
      if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
        fail('INVALID_INPUT');
      }
      const title = validateText(input.title, 160);
      const body = validateText(input.body, limits.maxBodyChars);
      if (typeof accessInfo.member.email !== 'string' || accessInfo.member.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(accessInfo.member.email) ||
          /[\u0000-\u001f\u007f]/u.test(accessInfo.member.email)) {
        fail('UNAVAILABLE');
      }
      const requestHash = digest(JSON.stringify([title, body]));
      const keyHash = digest(`${accessInfo.tenantId}:${accessInfo.userId}:${input.idempotencyKey}`);
      const now = validateNow(clock);
      const notification = await mutate(state => {
        purge(state, now);
        const duplicate = state.deliveries.find(entry =>
          entry.tenantId === accessInfo.tenantId && entry.userId === accessInfo.userId &&
          entry.keyHash === keyHash);
        if (duplicate) {
          if (duplicate.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
          return state.notifications.find(entry => entry.id === duplicate.notificationId) ?? null;
        }
        const preferences = getPreferences(state, accessInfo.tenantId, accessInfo.userId);
        if (!preferences.inAppEnabled && !preferences.emailEnabled) return null;
        if (state.notifications.length >= limits.maxNotifications) fail('STORAGE_LIMIT');
        const expiresAt = now + limits.retentionMs;
        if (!Number.isSafeInteger(expiresAt)) fail('TIME_RANGE');
        const record = {
          id: randomUUID(),
          tenantId: accessInfo.tenantId,
          userId: accessInfo.userId,
          requestId: accessInfo.requestId,
          title,
          body,
          email: accessInfo.member.email,
          createdAt: now,
          expiresAt,
          readAt: null,
          deletedAt: null,
        };
        state.notifications.push(record);
        state.deliveries.push({
          tenantId: accessInfo.tenantId,
          userId: accessInfo.userId,
          keyHash,
          requestHash,
          notificationId: record.id,
          emailStatus: preferences.emailEnabled ? 'queued' : 'disabled',
        });
        return record;
      });
      if (!notification) return Object.freeze({ suppressed: true });
      const delivery = await mutate(state =>
        state.deliveries.find(entry => entry.notificationId === notification.id));
      if (delivery?.emailStatus === 'queued') await ensureEmailJob({ ...accessInfo, cookieHeader: input.cookieHeader },
        notification, input.idempotencyKey);
      const { email: _email, ...result } = notification;
      return Object.freeze(result);
    },

    async list(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const accessInfo = await access(input);
      return mutate(state => {
        purge(state, validateNow(clock));
        if (!getPreferences(state, accessInfo.tenantId, accessInfo.userId).inAppEnabled) return [];
        return state.notifications
          .filter(entry => entry.tenantId === accessInfo.tenantId && entry.userId === accessInfo.userId &&
            entry.deletedAt === null)
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(({ email: _email, ...entry }) => Object.freeze(entry));
      });
    },

    async markRead(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'notificationId']);
      const accessInfo = await access(input);
      const id = validateId(input.notificationId);
      return mutate(state => {
        purge(state, validateNow(clock));
        const notification = state.notifications.find(entry =>
          entry.id === id && entry.tenantId === accessInfo.tenantId &&
          entry.userId === accessInfo.userId && entry.deletedAt === null);
        if (!notification) fail('NOT_FOUND');
        notification.readAt ??= validateNow(clock);
        const { email: _email, ...result } = notification;
        return Object.freeze(result);
      });
    },

    async delete(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'notificationId']);
      const accessInfo = await access(input);
      const id = validateId(input.notificationId);
      return mutate(state => {
        purge(state, validateNow(clock));
        const notification = state.notifications.find(entry =>
          entry.id === id && entry.tenantId === accessInfo.tenantId &&
          entry.userId === accessInfo.userId && entry.deletedAt === null);
        if (!notification) fail('NOT_FOUND');
        notification.deletedAt = validateNow(clock);
        state.emailInbox = state.emailInbox.filter(entry => entry.notificationId !== id);
        return Object.freeze({ deleted: true });
      });
    },

    async getPreferences(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const accessInfo = await access(input);
      return mutate(state => {
        const { tenantId, userId, inAppEnabled, emailEnabled } =
          getPreferences(state, accessInfo.tenantId, accessInfo.userId);
        return Object.freeze({ tenantId, userId, inAppEnabled, emailEnabled });
      });
    },

    async setPreferences(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'inAppEnabled', 'emailEnabled']);
      const accessInfo = await access(input);
      if (typeof input.inAppEnabled !== 'boolean' || typeof input.emailEnabled !== 'boolean') {
        fail('INVALID_INPUT');
      }
      return mutate(state => {
        const preference = getPreferences(state, accessInfo.tenantId, accessInfo.userId);
        preference.inAppEnabled = input.inAppEnabled;
        preference.emailEnabled = input.emailEnabled;
        const existing = state.preferences.find(entry =>
          entry.tenantId === preference.tenantId && entry.userId === preference.userId);
        if (existing) Object.assign(existing, preference);
        else state.preferences.push(preference);
        return Object.freeze({
          tenantId: preference.tenantId,
          userId: preference.userId,
          inAppEnabled: preference.inAppEnabled,
          emailEnabled: preference.emailEnabled,
        });
      });
    },

    async listEmailInbox(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const accessInfo = await access(input);
      return mutate(state => {
        purge(state, validateNow(clock));
        return state.emailInbox
          .filter(entry => entry.tenantId === accessInfo.tenantId && entry.userId === accessInfo.userId)
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(entry => Object.freeze({ ...entry }));
      });
    },

    async purgeExpired() {
      return mutate(state => purge(state, validateNow(clock)));
    },

    jobHandlers() {
      return Object.freeze({
        [JOB_TYPE]: async ({ payload, tenantContext }) => {
          exactInput(payload, ['notificationId', 'tenantId']);
          const tenantId = validateId(payload.tenantId);
          if (!tenantContext || tenantContext.tenantId !== tenantId) fail('TENANT_ACCESS_DENIED');
          await deliverPreview(payload.notificationId);
        },
      });
    },
  });
}

export const notificationsContract = Object.freeze({
  version: 1,
  jobType: JOB_TYPE,
  defaultLimits: DEFAULT_LIMITS,
  emailTransport: 'local-inbox-only',
  retryOwner: 'jobs-module',
  recipientScope: 'authenticated-member-self',
});
