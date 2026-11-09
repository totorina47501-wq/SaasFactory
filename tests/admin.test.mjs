import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AdminModuleError, adminContract, createAdminService } from '../modules/admin/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sessions = {
  owner: { id: OWNER, tenantId: TENANT_A },
  admin: { id: ADMIN, tenantId: TENANT_A },
  member: { id: MEMBER, tenantId: TENANT_A },
  other: { id: OWNER, tenantId: TENANT_B },
};

function fixture() {
  const calls = [];
  const membersByTenant = {
    [TENANT_A]: [
      { id: OWNER, role: 'owner' },
      { id: ADMIN, role: 'admin' },
      { id: MEMBER, role: 'member' },
    ],
    [TENANT_B]: [{ id: MEMBER, role: 'owner' }],
  };
  const auth = {
    async currentUser({ cookieHeader }) {
      return sessions[cookieHeader] ? { id: sessions[cookieHeader].id } : null;
    },
  };
  function sessionFor(input) {
    const session = sessions[input.cookieHeader];
    if (!session || session.tenantId !== input.tenantId) {
      throw Object.assign(new Error('private database detail'), { code: 'NOT_FOUND' });
    }
    return session;
  }
  const tenancy = {
    async createOrganization(input) {
      calls.push(['createOrganization', input]);
      return { tenantId: TENANT_A, name: input.name };
    },
    async listOrganizations(input) {
      calls.push(['listOrganizations', input]);
      return [{ tenantId: TENANT_A, role: 'owner' }];
    },
    async resolveTenantContext(input) {
      sessionFor(input);
      return { contractVersion: 1, tenantId: input.tenantId, requestId: input.requestId };
    },
    async listMembers(input) {
      sessionFor(input);
      return membersByTenant[input.tenantId] ?? [];
    },
    async updateOrganization(input) {
      calls.push(['updateOrganization', input]);
      return { tenantId: input.tenantId, name: input.name };
    },
    async inviteMember(input) {
      calls.push(['inviteMember', input]);
      return { invitationId: 'inv-1', token: 'local-invitation-token' };
    },
    async acceptInvitation(input) {
      calls.push(['acceptInvitation', input]);
      return { tenantId: TENANT_A, role: 'member' };
    },
    async changeMemberRole(input) {
      calls.push(['changeMemberRole', input]);
      if (input.memberId === OWNER) {
        throw Object.assign(new Error('owner membership is protected'), { code: 'FORBIDDEN' });
      }
      return { memberId: input.memberId, role: input.role };
    },
    async removeMember(input) {
      calls.push(['removeMember', input]);
      if (input.memberId === OWNER) {
        throw Object.assign(new Error('owner membership is protected'), { code: 'FORBIDDEN' });
      }
      throw Object.assign(new Error('last administrator'), { code: 'LAST_ADMIN' });
    },
  };
  const billing = {
    listPlans: () => [{ id: 'free', simulated: true }],
    async startSubscription(input) {
      calls.push(['startSubscription', input]);
      return { status: 'active', simulated: true };
    },
    async getSubscription() {
      return { status: 'active', simulated: true };
    },
    async listInvoices() {
      return [];
    },
    async getHistory() {
      return [];
    },
    async cancelSubscription(input) {
      calls.push(['cancelSubscription', input]);
      return { cancelAtPeriodEnd: true, simulated: true };
    },
  };
  const entitlements = {
    async check(context, featureId) {
      return { allowed: true, reason: 'granted', limits: { [`${featureId}.quota`]: 10 } };
    },
  };
  const jobs = {
    async list(input) {
      calls.push(['jobs.list', input]);
      return [
        { id: 'job-1', status: 'queued' },
        { id: 'job-2', status: 'failed' },
      ];
    },
  };
  const notifications = {
    async list(input) {
      calls.push(['notifications.list', input]);
      return [{ id: 'notice-1' }];
    },
    async getPreferences(input) {
      calls.push(['getPreferences', input]);
      return { userId: sessions[input.cookieHeader].id, emailEnabled: false };
    },
    async setPreferences(input) {
      calls.push(['setPreferences', input]);
      return { userId: sessions[input.cookieHeader].id, emailEnabled: input.emailEnabled };
    },
  };
  return {
    service: createAdminService({ auth, tenancy, billing, entitlements, jobs, notifications }),
    calls,
  };
}

function input(cookieHeader = 'owner', tenantId = TENANT_A) {
  return { cookieHeader, tenantId, requestId: 'admin-request-1' };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof AdminModuleError && error.code === code);
}

test('declares a versioned local admin contract and creates organizations for authenticated users', async () => {
  const { service, calls } = fixture();

  assert.equal(adminContract.version, 1);
  assert.equal(adminContract.billing, 'simulated-local-only');
  assert.deepEqual(await service.createOrganization({
    cookieHeader: 'owner', requestId: 'onboard-1', name: 'Atelier Exemple',
  }), { tenantId: TENANT_A, name: 'Atelier Exemple' });
  assert.equal(calls[0][0], 'createOrganization');
  await expectCode(service.createOrganization({
    cookieHeader: 'invalid', requestId: 'onboard-2', name: 'Atelier Exemple',
  }), 'INVALID_SESSION');
  await expectCode(service.createOrganization({
    cookieHeader: 'owner', requestId: 'onboard-3', name: 'Atelier Exemple', role: 'owner',
  }), 'INVALID_INPUT');
});

test('enforces tenant membership and role restrictions before member administration', async () => {
  const { service, calls } = fixture();

  await expectCode(service.inviteMember({
    ...input('member'), email: 'new@example.test', role: 'member',
  }), 'FORBIDDEN');
  await expectCode(service.changeMemberRole({
    ...input('admin'), memberId: MEMBER, role: 'admin',
  }), 'FORBIDDEN');
  await expectCode(service.listMembers(input('owner', TENANT_B)), 'NOT_FOUND');
  assert.equal(calls.length, 0);

  await service.changeMemberRole({ ...input(), memberId: MEMBER, role: 'admin' });
  assert.equal(calls[0][0], 'changeMemberRole');
  assert.deepEqual(Object.keys(calls[0][1]).sort(),
    ['cookieHeader', 'memberId', 'requestId', 'role', 'tenantId']);
});

test('keeps owner invariants and tenancy errors intact without exposing error details', async () => {
  const { service } = fixture();
  await expectCode(service.changeMemberRole({
    ...input(), memberId: OWNER, role: 'member',
  }), 'FORBIDDEN');
  await expectCode(service.removeMember({ ...input(), memberId: OWNER }), 'FORBIDDEN');
  await assert.rejects(service.removeMember({ ...input(), memberId: ADMIN }), error => {
    assert.equal(error.code, 'LAST_ADMIN');
    assert.equal(error.message, 'LAST_ADMIN');
    assert.doesNotMatch(error.message, /private database detail/u);
    return true;
  });
});

test('keeps notification preferences scoped to the current tenant member', async () => {
  const { service, calls } = fixture();
  const result = await service.setPreferences({
    ...input('member'), inAppEnabled: true, emailEnabled: true,
  });

  assert.equal(result.userId, MEMBER);
  assert.equal(calls[0][1].cookieHeader, 'member');
  assert.equal(calls[0][1].tenantId, TENANT_A);
});

test('returns a tenant-scoped operations dashboard with quota limits and redacted notification counts', async () => {
  const { service, calls } = fixture();
  const dashboard = await service.getDashboard(input('admin'));

  assert.equal(dashboard.status, 'ready');
  assert.equal(dashboard.quotas.usageReported, false);
  assert.equal(dashboard.jobs.counts.queued, 1);
  assert.equal(dashboard.jobs.counts.failed, 1);
  assert.equal(dashboard.jobs.recent.length, 2);
  assert.deepEqual(dashboard.notifications, {
    status: 'ready', scope: 'current-member', count: 1,
  });
  assert.ok(calls.some(([name]) => name === 'jobs.list'));
  assert.ok(calls.some(([name]) => name === 'notifications.list'));
  await expectCode(service.getDashboard(input('member')), 'FORBIDDEN');
});

test('restricts subscription cancellation to the owner and keeps billing simulated', async () => {
  const { service, calls } = fixture();
  await expectCode(service.cancelSubscription(input('admin')), 'FORBIDDEN');

  assert.deepEqual(await service.cancelSubscription(input()), {
    cancelAtPeriodEnd: true, simulated: true,
  });
  const portal = await service.getBillingPortal(input('admin'));
  assert.equal(portal.simulated, true);
  assert.equal(portal.plans[0].simulated, true);
  assert.equal(calls.filter(([name]) => name === 'cancelSubscription').length, 1);
});

test('fails closed on unknown input and missing module dependencies', async () => {
  const { service } = fixture();
  await expectCode(service.getDashboard({ ...input(), unknown: true }), 'INVALID_INPUT');
  assert.throws(() => createAdminService({
    auth: { currentUser: async () => null },
    tenancy: {},
    billing: {},
    entitlements: {},
    jobs: {},
    notifications: {},
  }), error => error instanceof AdminModuleError && error.code === 'INVALID_CONFIGURATION');
});

test('provides accessible dashboard loading, error, and ready views', () => {
  const component = readFileSync(
    new URL('../modules/admin/components/admin-dashboard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(component, /aria-busy=\{state\.status === "loading"\}/u);
  assert.match(component, /aria-live="polite" role="status"/u);
  assert.match(component, /<div role="alert">/u);
  assert.match(component, /onClick=\{\(\) => void refresh\(\)\}/u);
  assert.match(component, /<caption>/u);
  assert.match(component, /<th scope="col">/u);
});
