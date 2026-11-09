import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ROLES = Object.freeze(['owner', 'admin', 'member']);
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze([
    'organization.read', 'organization.update',
    'member.read', 'member.invite', 'member.role.change', 'member.remove',
  ]),
  admin: Object.freeze([
    'organization.read', 'organization.update',
    'member.read', 'member.invite', 'member.remove',
  ]),
  member: Object.freeze(['organization.read', 'member.read']),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INVITATION_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_ERROR_CODES = new Set([
  'ALREADY_MEMBER', 'FORBIDDEN', 'IDENTITY_CONFLICT', 'INVALID_CONTEXT', 'INVALID_INPUT',
  'INVITATION_INVALID', 'INVITATION_PENDING', 'LAST_ADMIN', 'NOT_FOUND', 'UNAVAILABLE',
]);

export class TenancyModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TenancyModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new TenancyModuleError(code);
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

function validateIdentity(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) fail('INVALID_SESSION');
  const prototype = Object.getPrototypeOf(identity);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_SESSION');
  const keys = Reflect.ownKeys(identity);
  if (keys.length !== 1 || keys[0] !== 'id') fail('INVALID_SESSION');
  const descriptor = Object.getOwnPropertyDescriptor(identity, 'id');
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || !UUID_PATTERN.test(descriptor.value)) fail('INVALID_SESSION');
  return descriptor.value;
}

function validateTenantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_TENANT');
  return value.toLowerCase();
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value;
}

function validateName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail('INVALID_INPUT');
  const name = value.trim();
  if (name.length < 1 || name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) fail('INVALID_INPUT');
  return name;
}

function validateEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !value.isWellFormed() ||
      !EMAIL_PATTERN.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateRole(value, allowed = ROLES) {
  if (!allowed.includes(value)) fail('INVALID_ROLE');
  return value;
}

function validateNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function permission(role, name) {
  return ROLE_PERMISSIONS[role]?.includes(name) === true;
}

export function createTenancyService(options) {
  exactInput(options, ['auth', 'store', 'clock'], ['auth', 'store']);
  const { auth, store } = options;
  if (!auth || typeof auth.currentUser !== 'function' || !store ||
      ['createOrganization', 'listMemberships', 'getOrganization', 'getMembership',
        'updateOrganization', 'listMembers', 'persistInvitation', 'acceptInvitation', 'changeMemberRole',
        'removeMember'].some(method => typeof store[method] !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  async function authenticatedUser(cookieHeader) {
    if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) fail('INVALID_SESSION');
    let user;
    try {
      user = await auth.currentUser({ cookieHeader });
    } catch {
      fail('UNAVAILABLE');
    }
    if (user === null) fail('INVALID_SESSION');
    return validateIdentity(user);
  }

  async function tenantAccess(cookieHeader, tenantId, requestId) {
    const userId = await authenticatedUser(cookieHeader);
    const id = validateTenantId(tenantId);
    const request = validateRequestId(requestId);
    let membership;
    try {
      membership = await store.getMembership(id, userId);
    } catch (error) {
      if (error instanceof TenancyModuleError) throw error;
      fail('UNAVAILABLE');
    }
    if (!membership) fail('NOT_FOUND');
    const role = validateRole(membership.role);
    const context = Object.freeze({ contractVersion: 1, tenantId: id, requestId: request });
    return { userId, role, context };
  }

  async function runStore(callback) {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof TenancyModuleError) throw error;
      if (error?.name === 'TenancyStoreError' && STORE_ERROR_CODES.has(error.code)) fail(error.code);
      fail('UNAVAILABLE');
    }
  }

  return Object.freeze({
    async createOrganization(input) {
      exactInput(input, ['cookieHeader', 'name', 'requestId']);
      const ownerId = await authenticatedUser(input.cookieHeader);
      const organization = Object.freeze({
        tenantId: randomUUID(),
        name: validateName(input.name),
        ownerId,
        requestId: validateRequestId(input.requestId),
        now: validateNow(clock),
      });
      return runStore(() => store.createOrganization(organization));
    },

    async listOrganizations(input) {
      exactInput(input, ['cookieHeader', 'requestId']);
      const userId = await authenticatedUser(input.cookieHeader);
      validateRequestId(input.requestId);
      const memberships = await runStore(() => store.listMemberships(userId));
      const organizations = await Promise.all(memberships.map(async entry => {
        const tenantId = validateTenantId(entry.tenantId);
        const organization = await runStore(() => store.getOrganization(tenantId, userId));
        if (!organization) fail('UNAVAILABLE');
        return Object.freeze({
          tenantId,
          name: organization.name,
          role: validateRole(entry.role),
        });
      }));
      return Object.freeze(organizations);
    },

    async resolveTenantContext(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      return access.context;
    },

    async listMembers(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      if (!permission(access.role, 'member.read')) fail('FORBIDDEN');
      return runStore(() => store.listMembers(access.context, access.userId));
    },

    async updateOrganization(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'name']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      if (!permission(access.role, 'organization.update')) fail('FORBIDDEN');
      return runStore(() => store.updateOrganization({
        tenantId: access.context.tenantId,
        requestId: access.context.requestId,
        actorId: access.userId,
        name: validateName(input.name),
      }));
    },

    async inviteMember(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'email', 'role']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      if (!permission(access.role, 'member.invite')) fail('FORBIDDEN');
      const role = validateRole(input.role, ['admin', 'member']);
      const invitation = {
        tenantId: access.context.tenantId,
        requestId: access.context.requestId,
        actorId: access.userId,
        invitationId: randomUUID(),
        email: validateEmail(input.email),
        role,
        now: validateNow(clock),
      };
      return runStore(async () => {
        const token = `${invitation.tenantId}.${randomBytes(32).toString('base64url')}`;
        const expiresAt = invitation.now + INVITATION_TTL_MS;
        await store.persistInvitation({
          ...invitation,
          tokenHash: digest(token.split('.')[1]),
          expiresAt,
        });
        return Object.freeze({ invitationId: invitation.invitationId, token, expiresAt });
      });
    },

    async acceptInvitation(input) {
      exactInput(input, ['cookieHeader', 'requestId', 'token']);
      const userId = await authenticatedUser(input.cookieHeader);
      const requestId = validateRequestId(input.requestId);
      if (typeof input.token !== 'string' || input.token.length > 96) fail('INVITATION_INVALID');
      const match = INVITATION_PATTERN.exec(input.token);
      if (!match) fail('INVITATION_INVALID');
      const tenantId = validateTenantId(match[1]);
      return runStore(() => store.acceptInvitation({
        tenantId,
        userId,
        requestId,
        tokenHash: digest(match[2]),
        now: validateNow(clock),
      }));
    },

    async changeMemberRole(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'memberId', 'role']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      if (!permission(access.role, 'member.role.change')) fail('FORBIDDEN');
      if (typeof input.memberId !== 'string' || !UUID_PATTERN.test(input.memberId)) fail('INVALID_INPUT');
      const role = validateRole(input.role, ['admin', 'member']);
      return runStore(() => store.changeMemberRole({
        tenantId: access.context.tenantId,
        requestId: access.context.requestId,
        actorId: access.userId,
        memberId: input.memberId.toLowerCase(),
        role,
      }));
    },

    async removeMember(input) {
      exactInput(input, ['cookieHeader', 'tenantId', 'requestId', 'memberId']);
      const access = await tenantAccess(input.cookieHeader, input.tenantId, input.requestId);
      if (!permission(access.role, 'member.remove')) fail('FORBIDDEN');
      if (typeof input.memberId !== 'string' || !UUID_PATTERN.test(input.memberId)) fail('INVALID_INPUT');
      return runStore(() => store.removeMember({
        tenantId: access.context.tenantId,
        requestId: access.context.requestId,
        actorId: access.userId,
        memberId: input.memberId.toLowerCase(),
      }));
    },
  });
}

export const tenancyContract = Object.freeze({
  version: 1,
  roles: ROLES,
  permissions: ROLE_PERMISSIONS,
  invitationTtlMs: INVITATION_TTL_MS,
});

export {
  createPostgresTenancyStore,
  runTenancyMigrations,
} from './postgres-store.mjs';
