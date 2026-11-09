import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createPostgresTenancyStore,
  createTenancyService,
  TenancyModuleError,
  tenancyContract,
} from '../modules/tenancy/index.mjs';

const ownerId = '00000000-0000-4000-8000-000000000001';
const adminId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const outsiderId = '00000000-0000-4000-8000-000000000004';
const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';
const identities = new Map([
  ['owner-session', ownerId],
  ['admin-session', adminId],
  ['member-session', memberId],
  ['outsider-session', outsiderId],
]);
const emails = new Map([
  [ownerId, 'owner@example.test'],
  [adminId, 'admin@example.test'],
  [memberId, 'member@example.test'],
  [outsiderId, 'outsider@example.test'],
]);

function fakeStore() {
  const organizations = new Map();
  const memberships = new Map();
  const invitations = new Map();
  const audit = [];
  let now = 1_800_000_000_000;
  const tenantMembers = tenantId => {
    if (!memberships.has(tenantId)) memberships.set(tenantId, new Map());
    return memberships.get(tenantId);
  };
  const store = {
    async createOrganization(input) {
      organizations.set(input.tenantId, { name: input.name });
      tenantMembers(input.tenantId).set(input.ownerId, 'owner');
      audit.push({ action: 'organization.created', actorId: input.ownerId });
      return { tenantId: input.tenantId, name: input.name, role: 'owner' };
    },
    async listMemberships(userId) {
      return [...memberships].flatMap(([tenantId, members]) => members.has(userId)
        ? [{ tenantId, role: members.get(userId) }]
        : []);
    },
    async getOrganization(tenantId, userId) {
      return tenantMembers(tenantId).has(userId) ? organizations.get(tenantId) : null;
    },
    async getMembership(tenantId, userId) {
      const role = tenantMembers(tenantId).get(userId);
      return role ? { role } : null;
    },
    async listMembers(context, userId) {
      if (!tenantMembers(context.tenantId).has(userId)) throw new StoreError('NOT_FOUND');
      return [...tenantMembers(context.tenantId)].map(([id, role]) => ({ id, email: emails.get(id), role }));
    },
    async updateOrganization(input) {
      const members = tenantMembers(input.tenantId);
      if (!['owner', 'admin'].includes(members.get(input.actorId))) throw new StoreError('FORBIDDEN');
      organizations.get(input.tenantId).name = input.name;
      audit.push({ action: 'organization.updated', actorId: input.actorId });
      return { tenantId: input.tenantId, name: input.name };
    },
    async persistInvitation(input) {
      const members = tenantMembers(input.tenantId);
      const actorRole = members.get(input.actorId);
      if (!['owner', 'admin'].includes(actorRole) || (input.role === 'admin' && actorRole !== 'owner')) {
        throw new StoreError('FORBIDDEN');
      }
      if ([...members.keys()].some(id => emails.get(id) === input.email)) throw new StoreError('ALREADY_MEMBER');
      if ([...invitations.values()].some(entry =>
        entry.tenantId === input.tenantId && entry.email === input.email && !entry.accepted)) {
        throw new StoreError('INVITATION_PENDING');
      }
      invitations.set(input.invitationId, { ...input, accepted: false });
      audit.push({ action: 'member.invited', actorId: input.actorId });
    },
    async acceptInvitation(input) {
      const invitation = [...invitations.values()].find(entry =>
        entry.tenantId === input.tenantId && entry.tokenHash === input.tokenHash &&
        !entry.accepted && entry.expiresAt > input.now);
      if (!invitation || emails.get(input.userId) !== invitation.email) {
        throw new StoreError('INVITATION_INVALID');
      }
      const members = tenantMembers(input.tenantId);
      const inviterRole = members.get(invitation.actorId);
      if (!['owner', 'admin'].includes(inviterRole) ||
          (invitation.role === 'admin' && inviterRole !== 'owner')) {
        throw new StoreError('INVITATION_INVALID');
      }
      if (members.has(input.userId)) throw new StoreError('ALREADY_MEMBER');
      invitation.accepted = true;
      members.set(input.userId, invitation.role);
      audit.push({ action: 'member.invitation.accepted', actorId: input.userId });
      return { tenantId: input.tenantId, role: invitation.role };
    },
    async changeMemberRole(input) {
      const members = tenantMembers(input.tenantId);
      if (members.get(input.actorId) !== 'owner') throw new StoreError('FORBIDDEN');
      const previous = members.get(input.memberId);
      if (!previous) throw new StoreError('NOT_FOUND');
      if (previous === 'owner') throw new StoreError('FORBIDDEN');
      if (previous === 'admin' && input.role === 'member' &&
          [...members].filter(([id, role]) => id !== input.memberId && ['owner', 'admin'].includes(role)).length === 0) {
        throw new StoreError('LAST_ADMIN');
      }
      members.set(input.memberId, input.role);
      if (previous === 'admin' && input.role === 'member') {
        for (const [id, invitation] of invitations) {
          if (invitation.tenantId === input.tenantId && invitation.actorId === input.memberId && !invitation.accepted) {
            invitations.delete(id);
          }
        }
      }
      audit.push({ action: 'member.role.changed', actorId: input.actorId });
      return { memberId: input.memberId, role: input.role };
    },
    async removeMember(input) {
      const members = tenantMembers(input.tenantId);
      const actorRole = members.get(input.actorId);
      const targetRole = members.get(input.memberId);
      if (!['owner', 'admin'].includes(actorRole)) throw new StoreError('FORBIDDEN');
      if (!targetRole) throw new StoreError('NOT_FOUND');
      if (targetRole === 'owner' || (targetRole === 'admin' && actorRole !== 'owner')) {
        throw new StoreError('FORBIDDEN');
      }
      if (targetRole === 'admin' &&
          [...members].filter(([id, role]) => id !== input.memberId && ['owner', 'admin'].includes(role)).length === 0) {
        throw new StoreError('LAST_ADMIN');
      }
      members.delete(input.memberId);
      for (const [id, invitation] of invitations) {
        if (invitation.tenantId === input.tenantId && invitation.actorId === input.memberId && !invitation.accepted) {
          invitations.delete(id);
        }
      }
      audit.push({ action: 'member.removed', actorId: input.actorId });
      return { removed: true };
    },
  };
  return {
    store,
    organizations,
    memberships,
    invitations,
    audit,
    setNow(value) { now = value; },
    now: () => now,
  };
}

class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TenancyStoreError';
    this.code = code;
  }
}

function createService(options = {}) {
  const state = options.state ?? fakeStore();
  const service = createTenancyService({
    auth: {
      async currentUser({ cookieHeader }) {
        const id = identities.get(cookieHeader);
        return id ? Object.freeze({ id }) : null;
      },
    },
    store: state.store,
    clock: state.now,
  });
  return { service, ...state };
}

function expectCode(callback, code) {
  return assert.rejects(callback, error =>
    error instanceof TenancyModuleError && error.code === code && error.message === code);
}

async function setupOrganization() {
  const ctx = createService();
  const organization = await ctx.service.createOrganization({
    cookieHeader: 'owner-session',
    name: 'Atelier Exemple',
    requestId: 'request-create',
  });
  ctx.memberships.get(organization.tenantId).set(adminId, 'admin');
  ctx.memberships.get(organization.tenantId).set(memberId, 'member');
  return { ...ctx, tenantId: organization.tenantId };
}

test('publishes the explicit versioned role and permission matrix', () => {
  assert.equal(tenancyContract.version, 1);
  assert.deepEqual(tenancyContract.roles, ['owner', 'admin', 'member']);
  assert.ok(tenancyContract.permissions.owner.includes('member.role.change'));
  assert.ok(!tenancyContract.permissions.admin.includes('member.role.change'));
  assert.ok(!tenancyContract.permissions.member.includes('member.invite'));
  assert.equal(tenancyContract.invitationTtlMs, 7 * 24 * 60 * 60 * 1000);
});

test('creates organizations for authenticated identities and lists only verified memberships', async () => {
  const ctx = createService();
  await expectCode(() => ctx.service.createOrganization({
    cookieHeader: 'unverified-session',
    name: 'Private',
    requestId: 'request-create',
  }), 'INVALID_SESSION');

  const created = await ctx.service.createOrganization({
    cookieHeader: 'owner-session',
    name: '  Atelier Exemple  ',
    requestId: 'request-create',
  });
  assert.equal(created.name, 'Atelier Exemple');
  assert.equal(created.role, 'owner');
  assert.match(created.tenantId, /^[0-9a-f-]{36}$/u);
  assert.equal(Object.hasOwn(created, 'ownerId'), false);

  const another = await ctx.service.createOrganization({
    cookieHeader: 'admin-session',
    name: 'Second workspace',
    requestId: 'request-second',
  });
  assert.deepEqual((await ctx.service.listOrganizations({
    cookieHeader: 'owner-session',
    requestId: 'request-list',
  })).map(item => item.tenantId), [created.tenantId]);
  assert.deepEqual((await ctx.service.listOrganizations({
    cookieHeader: 'admin-session',
    requestId: 'request-list',
  })).map(item => item.tenantId), [another.tenantId]);
  assert.deepEqual(ctx.audit.map(event => event.action), ['organization.created', 'organization.created']);
});

test('derives TenantContext only after session and membership verification', async () => {
  const { service, tenantId } = await setupOrganization();
  const context = await service.resolveTenantContext({
    cookieHeader: 'member-session',
    tenantId,
    requestId: 'request-context',
  });
  assert.deepEqual(context, { contractVersion: 1, tenantId, requestId: 'request-context' });
  assert.equal(Object.isFrozen(context), true);

  await expectCode(() => service.resolveTenantContext({
    cookieHeader: 'outsider-session',
    tenantId,
    requestId: 'request-cross',
  }), 'NOT_FOUND');
  await expectCode(() => service.resolveTenantContext({
    cookieHeader: 'member-session',
    tenantId: tenantB,
    requestId: 'request-cross',
  }), 'NOT_FOUND');
  await expectCode(() => service.resolveTenantContext({
    cookieHeader: 'member-session',
    tenantId,
    requestId: 'request-cross',
    userId: ownerId,
  }), 'INVALID_INPUT');
  await expectCode(() => service.resolveTenantContext({
    cookieHeader: 'member-session',
    tenantId,
    requestId: '../other',
  }), 'INVALID_INPUT');
});

test('rechecks membership and enforces horizontal and vertical RBAC boundaries', async () => {
  const { service, tenantId, memberships, audit } = await setupOrganization();
  const before = audit.length;
  await expectCode(() => service.inviteMember({
    cookieHeader: 'member-session',
    tenantId,
    requestId: 'request-invite',
    email: 'new@example.test',
    role: 'member',
  }), 'FORBIDDEN');
  await expectCode(() => service.updateOrganization({
    cookieHeader: 'member-session',
    tenantId,
    requestId: 'request-update',
    name: 'Changed',
  }), 'FORBIDDEN');
  await expectCode(() => service.changeMemberRole({
    cookieHeader: 'admin-session',
    tenantId,
    requestId: 'request-role',
    memberId,
    role: 'admin',
  }), 'FORBIDDEN');
  await expectCode(() => service.removeMember({
    cookieHeader: 'admin-session',
    tenantId,
    requestId: 'request-owner',
    memberId: ownerId,
  }), 'FORBIDDEN');
  assert.equal(memberships.get(tenantId).get(memberId), 'member');
  assert.equal(audit.length, before);

  await service.removeMember({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-remove',
    memberId,
  });
  await expectCode(() => service.listMembers({
    cookieHeader: 'member-session',
    tenantId,
    requestId: 'request-revoked',
  }), 'NOT_FOUND');
});

test('audits administration and role changes while enforcing the last-admin invariant', async () => {
  const { service, tenantId, memberships, audit } = await setupOrganization();
  assert.deepEqual(await service.updateOrganization({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-update',
    name: 'Updated Workspace',
  }), { tenantId, name: 'Updated Workspace' });
  assert.deepEqual(await service.updateOrganization({
    cookieHeader: 'admin-session',
    tenantId,
    requestId: 'request-admin-update',
    name: 'Admin Updated Workspace',
  }), { tenantId, name: 'Admin Updated Workspace' });
  await service.changeMemberRole({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-role',
    memberId: adminId,
    role: 'member',
  });
  assert.equal(memberships.get(tenantId).get(adminId), 'member');
  await expectCode(() => service.changeMemberRole({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-owner-role',
    memberId: ownerId,
    role: 'member',
  }), 'FORBIDDEN');
  await expectCode(() => service.removeMember({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-owner-remove',
    memberId: ownerId,
  }), 'FORBIDDEN');
  assert.deepEqual(audit.map(event => event.action), [
    'organization.created',
    'organization.updated',
    'organization.updated',
    'member.role.changed',
  ]);
});

test('stores one-time hashed invitations, binds acceptance to the authenticated email, and expires tokens', async () => {
  const { service, tenantId, invitations, memberships } = await setupOrganization();
  const sent = await service.inviteMember({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-invite',
    email: 'OUTSIDER@example.test',
    role: 'member',
  });
  const stored = invitations.get(sent.invitationId);
  assert.equal(stored.email, 'outsider@example.test');
  assert.notEqual(stored.tokenHash, sent.token);
  assert.equal(stored.tokenHash, createHash('sha256').update(sent.token.split('.')[1]).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(sent.token), false);
  assert.equal(sent.expiresAt - stored.now, tenancyContract.invitationTtlMs);

  await expectCode(() => service.acceptInvitation({
    cookieHeader: 'member-session',
    requestId: 'request-accept',
    token: sent.token,
  }), 'INVITATION_INVALID');
  assert.equal(stored.accepted, false);
  assert.deepEqual(await service.acceptInvitation({
    cookieHeader: 'outsider-session',
    requestId: 'request-accept',
    token: sent.token,
  }), { tenantId, role: 'member' });
  assert.equal(memberships.get(tenantId).get(outsiderId), 'member');
  await expectCode(() => service.acceptInvitation({
    cookieHeader: 'outsider-session',
    requestId: 'request-replay',
    token: sent.token,
  }), 'INVITATION_INVALID');

  const second = await service.inviteMember({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-expiring-invite',
    email: 'new@example.test',
    role: 'member',
  });
  const expiresAt = invitations.get(second.invitationId).expiresAt;
  const state = createService();
  state.invitations.set(second.invitationId, invitations.get(second.invitationId));
  state.memberships.set(tenantId, memberships.get(tenantId));
  state.organizations.set(tenantId, { name: 'Atelier Exemple' });
  state.setNow(expiresAt);
  await expectCode(() => state.service.acceptInvitation({
    cookieHeader: 'outsider-session',
    requestId: 'request-expired',
    token: second.token,
  }), 'INVITATION_INVALID');
});

test('revoking an inviter also invalidates their outstanding invitations', async () => {
  const { service, tenantId, invitations } = await setupOrganization();
  const sent = await service.inviteMember({
    cookieHeader: 'admin-session',
    tenantId,
    requestId: 'request-admin-invite',
    email: 'outsider@example.test',
    role: 'member',
  });
  assert.equal(invitations.has(sent.invitationId), true);
  await service.removeMember({
    cookieHeader: 'owner-session',
    tenantId,
    requestId: 'request-admin-remove',
    memberId: adminId,
  });
  assert.equal(invitations.has(sent.invitationId), false);
  await expectCode(() => service.acceptInvitation({
    cookieHeader: 'outsider-session',
    requestId: 'request-stale-invite',
    token: sent.token,
  }), 'INVITATION_INVALID');
});

test('uses transaction rollback and tenant/session settings in the PostgreSQL store', async () => {
  const calls = [];
  let failAudit = false;
  const pool = {
    async connect() {
      return {
        async query(sql, parameters = []) {
          calls.push({ sql, parameters });
          if (failAudit && sql.includes('INSERT INTO audit_events')) throw new Error('driver detail');
          if (sql.includes('SELECT email FROM auth_users')) return { rows: [{ email: 'owner@example.test' }] };
          if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: ownerId }] };
          if (sql.includes('SELECT tenant_id FROM organizations')) return { rows: [{ tenant_id: tenantA }] };
          if (sql.includes('SELECT role FROM memberships') && sql.includes('FOR UPDATE')) {
            return { rows: [{ role: parameters[1] === adminId ? 'admin' : 'owner' }] };
          }
          if (sql.includes('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2')) {
            return { rows: [{ role: 'owner' }] };
          }
          if (sql.includes('SELECT role FROM memberships') && sql.includes('user_id = $2 FOR UPDATE')) {
            return { rows: [{ role: 'admin' }] };
          }
          if (sql.includes('SELECT count(*)::integer AS count')) return { rows: [{ count: 0 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createPostgresTenancyStore({ pool, schemaName: 'app_test' });
  await store.createOrganization({
    tenantId: tenantA,
    name: 'Atelier Exemple',
    ownerId,
    requestId: 'request-create',
    now: 1_800_000_000_000,
  });
  assert.ok(calls.some(call =>
    call.sql.includes("set_config('app.tenant_id', $1, true)") && call.parameters[0] === tenantA));
  assert.ok(calls.some(call =>
    call.sql.includes("set_config('app.user_id', $1, true)") && call.parameters[0] === ownerId));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));

  failAudit = true;
  const countBefore = calls.length;
  await assert.rejects(store.createOrganization({
    tenantId: tenantB,
    name: 'Rollback',
    ownerId,
    requestId: 'request-fail',
    now: 1_800_000_000_000,
  }), error => error.name === 'TenancyStoreError' && error.code === 'UNAVAILABLE');
  assert.ok(calls.slice(countBefore).some(call => call.sql === 'ROLLBACK'));
  assert.ok(!calls.slice(countBefore).some(call => call.sql === 'COMMIT'));

  failAudit = false;
  await assert.rejects(store.removeMember({
    tenantId: tenantA,
    requestId: 'request-last-admin',
    actorId: ownerId,
    memberId: adminId,
  }), error => error.name === 'TenancyStoreError' && error.code === 'LAST_ADMIN');
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
});

test('declares tenant-scoped invitation storage, self-membership lookup and fail-closed RLS', () => {
  const migration = readFileSync(
    new URL('../modules/tenancy/migrations/0001_local_tenancy.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE organization_invitations/u);
  assert.match(migration, /token_hash text NOT NULL UNIQUE/u);
  assert.match(migration, /role IN \('admin', 'member'\)/u);
  assert.match(migration, /CREATE UNIQUE INDEX organization_invitations_pending_email/u);
  assert.match(migration, /ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /memberships_self_list_policy/u);
  assert.match(migration, /users_self_read_policy/u);
  assert.doesNotMatch(migration, /\bDROP\b/iu);
});

test('rejects unknown configuration and hostile input objects before storage', async () => {
  const ctx = await setupOrganization();
  let getterCalled = false;
  const hostile = { cookieHeader: 'owner-session', tenantId: ctx.tenantId, requestId: 'request-x' };
  Object.defineProperty(hostile, 'role', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('must not run');
    },
  });
  await expectCode(() => ctx.service.resolveTenantContext(hostile), 'INVALID_INPUT');
  assert.equal(getterCalled, false);
  const hostileIdentity = {};
  Object.defineProperty(hostileIdentity, 'id', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('must not run');
    },
  });
  const identityService = createTenancyService({
    auth: { currentUser: async () => hostileIdentity },
    store: ctx.store,
  });
  await expectCode(() => identityService.createOrganization({
    cookieHeader: 'cookie',
    name: 'Hostile',
    requestId: 'request-hostile',
  }), 'INVALID_SESSION');
  assert.equal(getterCalled, false);

  const hostileConfiguration = { schemaName: 'app_test' };
  Object.defineProperty(hostileConfiguration, 'pool', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('must not run');
    },
  });
  assert.throws(() => createPostgresTenancyStore(hostileConfiguration), error =>
    error.name === 'TenancyStoreError' && error.code === 'INVALID_CONFIGURATION');
  assert.equal(getterCalled, false);
  assert.throws(() => createTenancyService({
    auth: { currentUser: async () => null },
    store: ctx.store,
    extra: true,
  }), error => error instanceof TenancyModuleError && error.code === 'INVALID_INPUT');
});
