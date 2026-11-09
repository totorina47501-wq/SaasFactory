import { readFileSync } from 'node:fs';
import { runMigrations } from '../database/index.mjs';

const migration = Object.freeze({
  moduleId: 'tenancy',
  version: 1,
  id: '0001_local_tenancy',
  sql: readFileSync(new URL('./migrations/0001_local_tenancy.sql', import.meta.url), 'utf8'),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TenancyStoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new StoreError(code);
}

function validatePool(pool) {
  if (!pool || typeof pool.connect !== 'function') fail('INVALID_CONFIGURATION');
}

function validateSchema(schemaName) {
  if (typeof schemaName !== 'string' || !SCHEMA_PATTERN.test(schemaName) ||
      schemaName.startsWith('pg_') || ['public', 'information_schema'].includes(schemaName)) {
    fail('INVALID_CONFIGURATION');
  }
  return `"${schemaName}"`;
}

function validateTenantContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) fail('INVALID_CONTEXT');
  const keys = Reflect.ownKeys(context);
  if (keys.length !== 3 || keys.some(key => !['contractVersion', 'tenantId', 'requestId'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(context, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail('INVALID_CONTEXT');
  const { contractVersion, tenantId, requestId } = Object.fromEntries(keys.map(key =>
    [key, Object.getOwnPropertyDescriptor(context, key).value]));
  if (contractVersion !== 1 || typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId) ||
      typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(requestId)) {
    fail('INVALID_CONTEXT');
  }
  return Object.freeze({ contractVersion, tenantId, requestId });
}

function validateUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateTenantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_CONTEXT');
  return value.toLowerCase();
}

function validateRole(role, allowed = ['owner', 'admin', 'member']) {
  if (!allowed.includes(role)) fail('INVALID_INPUT');
  return role;
}

function validateEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      email.length > 254) fail('INVALID_INPUT');
  return email.toLowerCase();
}

async function transaction(pool, schema, { tenantId, userId } = {}, operation) {
  let client;
  let started = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    started = true;
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch {
        fail('UNAVAILABLE');
      }
    }
    if (error instanceof StoreError) throw error;
    fail('UNAVAILABLE');
  } finally {
    client?.release();
  }
}

function audit(client, { tenantId, requestId, actorId, action, resourceType, resourceId }) {
  return client.query(
    `INSERT INTO audit_events
      (tenant_id, request_id, action, resource_type, resource_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, 'success', $6::jsonb)`,
    [tenantId, requestId, action, resourceType, resourceId, JSON.stringify({ actorId })],
  );
}

async function requireActor(client, tenantId, actorId, allowedRoles) {
  const result = await client.query(
    'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
    [tenantId, actorId],
  );
  const role = result.rows?.[0]?.role;
  if (!role) fail('NOT_FOUND');
  if (!allowedRoles.includes(role)) fail('FORBIDDEN');
  return role;
}

async function lockOrganization(client, tenantId) {
  const result = await client.query(
    'SELECT tenant_id FROM organizations WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  if (!result.rows?.length) fail('NOT_FOUND');
}

async function assertAdminRemains(client, tenantId, memberId) {
  const count = await client.query(
    `SELECT count(*)::integer AS count FROM memberships
     WHERE tenant_id = $1 AND role IN ('owner', 'admin') AND user_id <> $2`,
    [tenantId, memberId],
  );
  if (Number(count.rows?.[0]?.count ?? 0) < 1) fail('LAST_ADMIN');
}

async function ensureUserProfile(client, userId) {
  const identity = await client.query('SELECT email FROM auth_users WHERE id = $1', [userId]);
  const email = identity.rows?.[0]?.email;
  if (!email || typeof email !== 'string') fail('INVALID_SESSION');
  await client.query(
    `INSERT INTO users (id, email, display_name)
     VALUES ($1, $2, 'Member')
     ON CONFLICT (id) DO NOTHING`,
    [userId, email],
  );
  const profile = await client.query(
    'SELECT id FROM users WHERE id = $1 AND lower(email) = $2',
    [userId, email.toLowerCase()],
  );
  if (!profile.rows?.length) fail('IDENTITY_CONFLICT');
  return email.toLowerCase();
}

export async function runTenancyMigrations(pool, schemaName) {
  try {
    return await runMigrations(pool, schemaName, { extensionMigrations: [migration] });
  } catch {
    fail('UNAVAILABLE');
  }
}

export function createPostgresTenancyStore(configuration) {
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) {
    fail('INVALID_CONFIGURATION');
  }
  const prototype = Object.getPrototypeOf(configuration);
  const keys = Reflect.ownKeys(configuration);
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 2 || keys.some(key => !['pool', 'schemaName'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    fail('INVALID_CONFIGURATION');
  }
  const pool = Object.getOwnPropertyDescriptor(configuration, 'pool')?.value;
  const schemaName = Object.getOwnPropertyDescriptor(configuration, 'schemaName')?.value;
  validatePool(pool);
  const schema = validateSchema(schemaName);

  return Object.freeze({
    async createOrganization(input) {
      const tenantId = validateTenantId(input.tenantId);
      const ownerId = validateUuid(input.ownerId);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 ||
          typeof input.requestId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.requestId) ||
          !Number.isSafeInteger(input.now)) fail('INVALID_INPUT');
      return transaction(pool, schema, { tenantId, userId: ownerId }, async client => {
        await ensureUserProfile(client, ownerId);
        await client.query('INSERT INTO organizations (tenant_id, name) VALUES ($1, $2)', [tenantId, input.name]);
        await client.query(
          'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
          [tenantId, ownerId, 'owner'],
        );
        await audit(client, {
          tenantId, requestId: input.requestId, actorId: ownerId,
          action: 'organization.created', resourceType: 'organization', resourceId: tenantId,
        });
        return Object.freeze({ tenantId, name: input.name, role: 'owner' });
      });
    },

    async listMemberships(userId) {
      const id = validateUuid(userId);
      return transaction(pool, schema, { userId: id }, async client => {
        const result = await client.query(
          'SELECT tenant_id, role FROM memberships WHERE user_id = $1 ORDER BY tenant_id',
          [id],
        );
        return Object.freeze((result.rows ?? []).map(row => Object.freeze({
          tenantId: row.tenant_id,
          role: validateRole(row.role),
        })));
      });
    },

    async getOrganization(tenantId, userId) {
      tenantId = validateTenantId(tenantId);
      const id = validateUuid(userId);
      return transaction(pool, schema, { tenantId, userId: id }, async client => {
        const membership = await client.query(
          'SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2',
          [tenantId, id],
        );
        if (!membership.rows?.length) return null;
        const result = await client.query('SELECT name FROM organizations WHERE tenant_id = $1', [tenantId]);
        return result.rows?.[0] ? Object.freeze({ name: result.rows[0].name }) : null;
      });
    },

    async getMembership(tenantId, userId) {
      tenantId = validateTenantId(tenantId);
      const id = validateUuid(userId);
      return transaction(pool, schema, { tenantId, userId: id }, async client => {
        const result = await client.query(
          'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
          [tenantId, id],
        );
        return result.rows?.[0] ? Object.freeze({ role: validateRole(result.rows[0].role) }) : null;
      });
    },

    async updateOrganization(input) {
      const tenantId = validateTenantId(input.tenantId);
      const actorId = validateUuid(input.actorId);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 ||
          typeof input.requestId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.requestId)) fail('INVALID_INPUT');
      return transaction(pool, schema, { tenantId, userId: actorId }, async client => {
        await lockOrganization(client, tenantId);
        await requireActor(client, tenantId, actorId, ['owner', 'admin']);
        await client.query('UPDATE organizations SET name = $1 WHERE tenant_id = $2', [input.name, tenantId]);
        await audit(client, {
          tenantId, requestId: input.requestId, actorId,
          action: 'organization.updated', resourceType: 'organization', resourceId: tenantId,
        });
        return Object.freeze({ tenantId, name: input.name });
      });
    },

    async listMembers(context, actorId) {
      const tenant = validateTenantContext(context);
      const actor = validateUuid(actorId);
      return transaction(pool, schema, { tenantId: tenant.tenantId, userId: actor }, async client => {
        await requireActor(client, tenant.tenantId, actor, ['owner', 'admin', 'member']);
        const result = await client.query(
          `SELECT u.id, u.email, m.role, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 ORDER BY m.created_at, u.id`,
          [tenant.tenantId],
        );
        return Object.freeze((result.rows ?? []).map(row => Object.freeze({
          id: row.id,
          email: row.email,
          role: validateRole(row.role),
          createdAt: row.created_at,
        })));
      });
    },

    async persistInvitation(input) {
      const tenantId = validateTenantId(input.tenantId);
      const actorId = validateUuid(input.actorId);
      const email = validateEmail(input.email);
      const role = validateRole(input.role, ['admin', 'member']);
      const invitationId = validateUuid(input.invitationId);
      if (typeof input.tokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.tokenHash) ||
          !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.expiresAt) ||
          input.expiresAt <= input.now || typeof input.requestId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.requestId)) fail('INVALID_INPUT');
      return transaction(pool, schema, { tenantId, userId: actorId }, async client => {
        await lockOrganization(client, tenantId);
        const actorRole = await requireActor(client, tenantId, actorId, ['owner', 'admin']);
        if (role === 'admin' && actorRole !== 'owner') fail('FORBIDDEN');
        await ensureUserProfile(client, actorId);
        await client.query(
          'DELETE FROM organization_invitations WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at <= $3',
          [tenantId, email, new Date(input.now)],
        );
        const existingMember = await client.query(
          `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = $1 AND lower(u.email) = $2`,
          [tenantId, email],
        );
        if (existingMember.rows?.length) fail('ALREADY_MEMBER');
        const existingInvitation = await client.query(
          `SELECT 1 FROM organization_invitations
           WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL`,
          [tenantId, email],
        );
        if (existingInvitation.rows?.length) fail('INVITATION_PENDING');
        await client.query(
          `INSERT INTO organization_invitations
            (invitation_id, tenant_id, email, role, token_hash, inviter_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [invitationId, tenantId, email, role, input.tokenHash, actorId,
            new Date(input.now), new Date(input.expiresAt)],
        );
        await audit(client, {
          tenantId, requestId: input.requestId, actorId,
          action: 'member.invited', resourceType: 'invitation', resourceId: invitationId,
        });
        return Object.freeze({ invitationId });
      });
    },

    async acceptInvitation(input) {
      const tenantId = validateTenantId(input.tenantId);
      const userId = validateUuid(input.userId);
      if (typeof input.tokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.tokenHash) ||
          !Number.isSafeInteger(input.now) || typeof input.requestId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.requestId)) fail('INVALID_INPUT');
      return transaction(pool, schema, { tenantId, userId }, async client => {
        await lockOrganization(client, tenantId);
        const invite = await client.query(
          `SELECT invitation_id, email, role, inviter_id FROM organization_invitations
           WHERE tenant_id = $1 AND token_hash = $2 AND accepted_at IS NULL AND expires_at > $3
           FOR UPDATE`,
          [tenantId, input.tokenHash, new Date(input.now)],
        );
        const invitation = invite.rows?.[0];
        if (!invitation) fail('INVITATION_INVALID');
        const inviter = await client.query(
          'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
          [tenantId, invitation.inviter_id],
        );
        if (!['owner', 'admin'].includes(inviter.rows?.[0]?.role) ||
            (invitation.role === 'admin' && inviter.rows[0].role !== 'owner')) {
          fail('INVITATION_INVALID');
        }
        const email = await ensureUserProfile(client, userId);
        if (email !== invitation.email) fail('INVITATION_INVALID');
        await client.query(
          'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
          [tenantId, userId, validateRole(invitation.role)],
        );
        await client.query(
          'UPDATE organization_invitations SET accepted_at = $1 WHERE invitation_id = $2',
          [new Date(input.now), invitation.invitation_id],
        );
        await audit(client, {
          tenantId, requestId: input.requestId, actorId: userId,
          action: 'member.invitation.accepted', resourceType: 'membership', resourceId: userId,
        });
        return Object.freeze({ tenantId, role: invitation.role });
      });
    },

    async changeMemberRole(input) {
      const tenantId = validateTenantId(input.tenantId);
      const actorId = validateUuid(input.actorId);
      const memberId = validateUuid(input.memberId);
      const role = validateRole(input.role, ['admin', 'member']);
      return transaction(pool, schema, { tenantId, userId: actorId }, async client => {
        await lockOrganization(client, tenantId);
        await requireActor(client, tenantId, actorId, ['owner']);
        const target = await client.query(
          'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
          [tenantId, memberId],
        );
        if (!target.rows?.length) fail('NOT_FOUND');
        if (target.rows[0].role === 'owner') fail('FORBIDDEN');
        if (target.rows[0].role === 'admin' && role === 'member') {
          await assertAdminRemains(client, tenantId, memberId);
        }
        await client.query(
          'UPDATE memberships SET role = $1 WHERE tenant_id = $2 AND user_id = $3',
          [role, tenantId, memberId],
        );
        if (target.rows[0].role === 'admin' && role === 'member') {
          await client.query(
            'DELETE FROM organization_invitations WHERE tenant_id = $1 AND inviter_id = $2 AND accepted_at IS NULL',
            [tenantId, memberId],
          );
        }
        await audit(client, {
          tenantId, requestId: input.requestId, actorId,
          action: 'member.role.changed', resourceType: 'membership', resourceId: memberId,
        });
        return Object.freeze({ memberId, role });
      });
    },

    async removeMember(input) {
      const tenantId = validateTenantId(input.tenantId);
      const actorId = validateUuid(input.actorId);
      const memberId = validateUuid(input.memberId);
      return transaction(pool, schema, { tenantId, userId: actorId }, async client => {
        await lockOrganization(client, tenantId);
        const actorRole = await requireActor(client, tenantId, actorId, ['owner', 'admin']);
        const target = await client.query(
          'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
          [tenantId, memberId],
        );
        if (!target.rows?.length) fail('NOT_FOUND');
        if (target.rows[0].role === 'owner' ||
            (target.rows[0].role === 'admin' && actorRole !== 'owner')) fail('FORBIDDEN');
        if (target.rows[0].role === 'admin') await assertAdminRemains(client, tenantId, memberId);
        await client.query(
          'DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2',
          [tenantId, memberId],
        );
        await client.query(
          'DELETE FROM organization_invitations WHERE tenant_id = $1 AND inviter_id = $2 AND accepted_at IS NULL',
          [tenantId, memberId],
        );
        await audit(client, {
          tenantId, requestId: input.requestId, actorId,
          action: 'member.removed', resourceType: 'membership', resourceId: memberId,
        });
        return Object.freeze({ removed: true });
      });
    },
  });
}
