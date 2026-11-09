import { FEATURES } from '../entitlements/contract.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ROLES = Object.freeze(['owner', 'admin', 'member']);
const ADMIN_ROLES = Object.freeze(['owner', 'admin']);
const JOB_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const PUBLIC_ERRORS = new Set([
  'ALREADY_MEMBER', 'FORBIDDEN', 'INVALID_INPUT', 'INVALID_SESSION', 'INVALID_TENANT',
  'INVITATION_INVALID', 'INVITATION_PENDING', 'LAST_ADMIN', 'NOT_FOUND',
  'TENANT_ACCESS_DENIED', 'UNAVAILABLE',
]);

export class AdminModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AdminModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new AdminModuleError(code);
}

function exactObject(value, expected, required = expected) {
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

function validateTenantInput(input) {
  if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
      typeof input.tenantId !== 'string' || !UUID_PATTERN.test(input.tenantId) ||
      typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
    fail('INVALID_INPUT');
  }
  return Object.freeze({
    cookieHeader: input.cookieHeader,
    tenantId: input.tenantId.toLowerCase(),
    requestId: input.requestId,
  });
}

function normalizeError(error) {
  if (error instanceof AdminModuleError) throw error;
  if (PUBLIC_ERRORS.has(error?.code)) fail(error.code);
  fail('UNAVAILABLE');
}

function freezeCounts(jobs) {
  const counts = Object.fromEntries(JOB_STATES.map(status => [status, 0]));
  for (const job of jobs) {
    if (!job || !JOB_STATES.includes(job.status)) fail('UNAVAILABLE');
    counts[job.status] += 1;
  }
  return Object.freeze(counts);
}

function delegatedTenantInput(request) {
  return {
    cookieHeader: request.cookieHeader,
    tenantId: request.tenantId,
    requestId: request.requestId,
  };
}

export function createAdminService(configuration) {
  exactObject(configuration,
    ['auth', 'tenancy', 'billing', 'entitlements', 'jobs', 'notifications']);
  const { auth, tenancy, billing, entitlements, jobs, notifications } = configuration;
  if (!auth || typeof auth.currentUser !== 'function' ||
      !tenancy || ['createOrganization', 'listOrganizations', 'resolveTenantContext',
        'listMembers', 'updateOrganization', 'inviteMember', 'acceptInvitation',
        'changeMemberRole', 'removeMember'].some(method => typeof tenancy[method] !== 'function') ||
      !billing || ['listPlans', 'startSubscription', 'getSubscription', 'listInvoices',
        'getHistory', 'cancelSubscription'].some(method => typeof billing[method] !== 'function') ||
      !entitlements || typeof entitlements.check !== 'function' ||
      !jobs || typeof jobs.list !== 'function' ||
      !notifications || ['list', 'getPreferences', 'setPreferences']
        .some(method => typeof notifications[method] !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }

  async function run(operation) {
    try {
      return await operation();
    } catch (error) {
      normalizeError(error);
    }
  }

  async function authenticatedUser(cookieHeader) {
    if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) fail('INVALID_SESSION');
    let user;
    try {
      user = await auth.currentUser({ cookieHeader });
    } catch {
      fail('UNAVAILABLE');
    }
    if (!user || typeof user.id !== 'string' || !UUID_PATTERN.test(user.id)) fail('INVALID_SESSION');
    return user.id.toLowerCase();
  }

  async function authorizeTenant(input, allowedRoles = ROLES) {
    const request = validateTenantInput(input);
    const userId = await authenticatedUser(request.cookieHeader);
    let members;
    try {
      members = await tenancy.listMembers(request);
    } catch (error) {
      normalizeError(error);
    }
    if (!Array.isArray(members)) fail('UNAVAILABLE');
    const member = members.find(entry =>
      typeof entry?.id === 'string' && entry.id.toLowerCase() === userId);
    if (!member || !ROLES.includes(member.role)) fail('NOT_FOUND');
    if (!allowedRoles.includes(member.role)) fail('FORBIDDEN');
    return Object.freeze({ ...request, userId, role: member.role });
  }

  function invoke(operation) {
    return run(operation);
  }

  return Object.freeze({
    async createOrganization(input) {
      exactObject(input, ['cookieHeader', 'requestId', 'name']);
      if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
        fail('INVALID_INPUT');
      }
      await authenticatedUser(input.cookieHeader);
      return invoke(() => tenancy.createOrganization(input));
    },

    async listOrganizations(input) {
      exactObject(input, ['cookieHeader', 'requestId']);
      if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
        fail('INVALID_INPUT');
      }
      await authenticatedUser(input.cookieHeader);
      return invoke(() => tenancy.listOrganizations(input));
    },

    async acceptInvitation(input) {
      exactObject(input, ['cookieHeader', 'requestId', 'token']);
      if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
        fail('INVALID_INPUT');
      }
      await authenticatedUser(input.cookieHeader);
      return invoke(() => tenancy.acceptInvitation(input));
    },

    async listMembers(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const request = await authorizeTenant(input);
      return invoke(() => tenancy.listMembers(delegatedTenantInput(request)));
    },

    async updateOrganization(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'name']);
      const request = await authorizeTenant(input, ADMIN_ROLES);
      return invoke(() => tenancy.updateOrganization({
        ...delegatedTenantInput(request), name: input.name,
      }));
    },

    async inviteMember(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'email', 'role']);
      const request = await authorizeTenant(input, ADMIN_ROLES);
      return invoke(() => tenancy.inviteMember({
        ...delegatedTenantInput(request), email: input.email, role: input.role,
      }));
    },

    async changeMemberRole(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'memberId', 'role']);
      const request = await authorizeTenant(input, ['owner']);
      return invoke(() => tenancy.changeMemberRole({
        ...delegatedTenantInput(request), memberId: input.memberId, role: input.role,
      }));
    },

    async removeMember(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'memberId']);
      const request = await authorizeTenant(input, ADMIN_ROLES);
      return invoke(() => tenancy.removeMember({
        ...delegatedTenantInput(request), memberId: input.memberId,
      }));
    },

    async getPreferences(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const request = await authorizeTenant(input);
      return invoke(() => notifications.getPreferences(delegatedTenantInput(request)));
    },

    async setPreferences(input) {
      exactObject(input,
        ['cookieHeader', 'tenantId', 'requestId', 'inAppEnabled', 'emailEnabled']);
      const request = await authorizeTenant(input);
      return invoke(() => notifications.setPreferences({
        ...delegatedTenantInput(request),
        inAppEnabled: input.inAppEnabled,
        emailEnabled: input.emailEnabled,
      }));
    },

    async getBillingPortal(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const request = await authorizeTenant(input, ADMIN_ROLES);
      const base = {
        cookieHeader: request.cookieHeader,
        tenantId: request.tenantId,
        requestId: request.requestId,
      };
      return invoke(async () => Object.freeze({
        simulated: true,
        plans: billing.listPlans(),
        subscription: await billing.getSubscription(base),
        invoices: await billing.listInvoices(base),
        history: await billing.getHistory(base),
      }));
    },

    async startSubscription(input) {
      exactObject(input, [
        'cookieHeader', 'tenantId', 'requestId', 'planId', 'idempotencyKey', 'trial',
      ], ['cookieHeader', 'tenantId', 'requestId', 'planId', 'idempotencyKey']);
      const request = await authorizeTenant(input, ['owner']);
      const { cookieHeader, tenantId, requestId } = request;
      return invoke(() => billing.startSubscription({
        cookieHeader, tenantId, requestId,
        planId: input.planId,
        idempotencyKey: input.idempotencyKey,
        ...(Object.hasOwn(input, 'trial') ? { trial: input.trial } : {}),
      }));
    },

    async cancelSubscription(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const request = await authorizeTenant(input, ['owner']);
      const { cookieHeader, tenantId, requestId } = request;
      return invoke(() => billing.cancelSubscription({ cookieHeader, tenantId, requestId }));
    },

    async getDashboard(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const request = await authorizeTenant(input, ADMIN_ROLES);
      return invoke(async () => {
        const context = await tenancy.resolveTenantContext(delegatedTenantInput(request));
        const [jobList, memberNotifications, quotaResults] = await Promise.all([
          jobs.list(delegatedTenantInput(request)),
          notifications.list(delegatedTenantInput(request)),
          Promise.all(FEATURES.map(async featureId => ({
            featureId,
            ...await entitlements.check(context, featureId),
          }))),
        ]);
        if (!Array.isArray(jobList) || !Array.isArray(memberNotifications)) fail('UNAVAILABLE');
        const jobsByStatus = freezeCounts(jobList);
        return Object.freeze({
          status: 'ready',
          tenantId: request.tenantId,
          quotas: Object.freeze({
            status: 'ready',
            usageReported: false,
            features: Object.freeze(quotaResults),
          }),
          jobs: Object.freeze({
            status: 'ready',
            total: jobList.length,
            counts: jobsByStatus,
            recent: Object.freeze(jobList.slice(-50)),
          }),
          notifications: Object.freeze({
            status: 'ready',
            scope: 'current-member',
            count: memberNotifications.length,
          }),
        });
      });
    },
  });
}

export const adminContract = Object.freeze({
  version: 1,
  roleSource: 'authenticated-tenant-membership',
  billing: 'simulated-local-only',
  dashboardStates: Object.freeze(['loading', 'ready', 'error']),
  dashboardRecentJobs: 50,
  notificationScope: 'current-member-only',
});
