import { readFileSync } from 'node:fs';
import { runMigrations } from '../database/index.mjs';
import { EntitlementsModuleError, fail } from './errors.mjs';

const migration = Object.freeze({
  moduleId: 'entitlements',
  version: 1,
  id: '0001_tenant_entitlements',
  sql: readFileSync(new URL('./migrations/0001_tenant_entitlements.sql', import.meta.url), 'utf8'),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const QUOTA_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function validateTenantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateSchema(value) {
  if (typeof value !== 'string' || !SCHEMA_PATTERN.test(value) ||
      value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) {
    fail('INVALID_CONFIGURATION');
  }
  return `"${value}"`;
}

function validateStoreKey(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_INPUT');
  return value;
}

function validateConfiguration(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CONFIGURATION');
  }
  const keys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null ||
      keys.length !== 2 || keys.some(key => !['pool', 'schemaName'].includes(key)) ||
      keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) fail('INVALID_CONFIGURATION');
  return {
    pool: Object.getOwnPropertyDescriptor(value, 'pool')?.value,
    schema: validateSchema(Object.getOwnPropertyDescriptor(value, 'schemaName')?.value),
  };
}

function databaseNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail('UNAVAILABLE');
  return number;
}

function reservationFromRow(row) {
  return Object.freeze({
    id: row.reservation_id,
    quotaId: row.quota_id,
    periodStartAt: databaseNumber(row.period_start_at),
    periodEndAt: databaseNumber(row.period_end_at),
    amount: databaseNumber(row.amount),
    status: row.status,
  });
}

async function transaction(pool, schema, tenantId, operation) {
  let client;
  let started = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    started = true;
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
    if (error instanceof EntitlementsModuleError) throw error;
    fail('UNAVAILABLE');
  } finally {
    client?.release();
  }
}

async function lockQuota(client, tenantId, quotaId, periodStartAt) {
  const key = `${tenantId}:entitlements:${quotaId}:${periodStartAt}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, key]);
}

async function readReservation(client, tenantId, reservationId, lock = false) {
  const result = await client.query(
    `SELECT reservation_id, quota_id, period_start_at, period_end_at, amount, status
     FROM entitlements_reservations
     WHERE tenant_id = $1 AND reservation_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, reservationId],
  );
  return result.rows?.[0] ?? null;
}

async function reservationResult(client, tenantId, quotaId, periodStartAt, idempotencyKey) {
  const result = await client.query(
    `SELECT reservation_id, quota_id, period_start_at, period_end_at, amount, status, fingerprint
     FROM entitlements_reservations
     WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3 AND idempotency_key = $4`,
    [tenantId, quotaId, periodStartAt, idempotencyKey],
  );
  return result.rows?.[0] ?? null;
}

export async function runEntitlementsMigrations(pool, schemaName) {
  try {
    return await runMigrations(pool, schemaName, { extensionMigrations: [migration] });
  } catch {
    fail('UNAVAILABLE');
  }
}

export function createPostgresEntitlementsStore(configuration) {
  const { pool, schema } = validateConfiguration(configuration);
  if (!pool || typeof pool.connect !== 'function') fail('INVALID_CONFIGURATION');

  return Object.freeze({
    async getOverride({ tenantId: value, targetId }) {
      const tenantId = validateTenantId(value);
      validateStoreKey(targetId, ID_PATTERN);
      return transaction(pool, schema, tenantId, async client => {
        const result = await client.query(
          `SELECT kind, override_value FROM entitlements_overrides
           WHERE tenant_id = $1 AND target_id = $2`,
          [tenantId, targetId],
        );
        const row = result.rows?.[0];
        return row ? Object.freeze({ kind: row.kind, value: row.override_value }) : null;
      });
    },

    async setOverride({ tenantId: value, targetId, kind, value: overrideValue }) {
      const tenantId = validateTenantId(value);
      validateStoreKey(targetId, ID_PATTERN);
      if (!['feature', 'quota'].includes(kind) ||
          (kind === 'feature' && typeof overrideValue !== 'boolean') ||
          (kind === 'quota' && (!Number.isSafeInteger(overrideValue) || overrideValue < 0))) {
        fail('INVALID_INPUT');
      }
      return transaction(pool, schema, tenantId, async client => {
        await client.query(
          `INSERT INTO entitlements_overrides (tenant_id, target_id, kind, override_value)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (tenant_id, target_id) DO UPDATE
             SET kind = EXCLUDED.kind, override_value = EXCLUDED.override_value`,
          [tenantId, targetId, kind, JSON.stringify(overrideValue)],
        );
        return Object.freeze({ kind, value: overrideValue });
      });
    },

    async clearOverride({ tenantId: value, targetId }) {
      const tenantId = validateTenantId(value);
      validateStoreKey(targetId, ID_PATTERN);
      return transaction(pool, schema, tenantId, async client => {
        const result = await client.query(
          'DELETE FROM entitlements_overrides WHERE tenant_id = $1 AND target_id = $2',
          [tenantId, targetId],
        );
        return result.rowCount === 1;
      });
    },

    async reserve(input) {
      const tenantId = validateTenantId(input.tenantId);
      const quotaId = validateStoreKey(input.quotaId, QUOTA_PATTERN);
      const idempotencyKey = validateStoreKey(input.idempotencyKey, ID_PATTERN);
      const reservationId = validateTenantId(input.reservationId);
      if (!Number.isSafeInteger(input.periodStartAt) || input.periodStartAt < 0 ||
          !Number.isSafeInteger(input.periodEndAt) || input.periodEndAt <= input.periodStartAt ||
          !Number.isSafeInteger(input.amount) || input.amount < 1 ||
          !Number.isSafeInteger(input.limit) || input.limit < 0 ||
          typeof input.fingerprint !== 'string' || input.fingerprint.length > 512) {
        fail('INVALID_INPUT');
      }
      return transaction(pool, schema, tenantId, async client => {
        await lockQuota(client, tenantId, quotaId, input.periodStartAt);
        const previous = await reservationResult(
          client, tenantId, quotaId, input.periodStartAt, idempotencyKey,
        );
        if (previous) {
          if (previous.fingerprint !== input.fingerprint) fail('IDEMPOTENCY_CONFLICT');
          return reservationFromRow(previous);
        }
        await client.query(
          `INSERT INTO entitlements_usage
             (tenant_id, quota_id, period_start_at, period_end_at, used, reserved)
           VALUES ($1, $2, $3, $4, 0, 0)
           ON CONFLICT (tenant_id, quota_id, period_start_at) DO NOTHING`,
          [tenantId, quotaId, input.periodStartAt, input.periodEndAt],
        );
        const usageResult = await client.query(
          `SELECT period_end_at, used, reserved FROM entitlements_usage
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3 FOR UPDATE`,
          [tenantId, quotaId, input.periodStartAt],
        );
        const usage = usageResult.rows?.[0];
        if (!usage || databaseNumber(usage.period_end_at) !== input.periodEndAt) fail('UNAVAILABLE');
        const used = databaseNumber(usage.used);
        const reserved = databaseNumber(usage.reserved);
        if (used + reserved + input.amount > input.limit) fail('LIMIT_EXCEEDED');
        await client.query(
          `UPDATE entitlements_usage SET reserved = reserved + $4
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3`,
          [tenantId, quotaId, input.periodStartAt, input.amount],
        );
        const result = await client.query(
          `INSERT INTO entitlements_reservations
             (tenant_id, reservation_id, quota_id, period_start_at, period_end_at,
              amount, idempotency_key, fingerprint, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved')
           RETURNING reservation_id, quota_id, period_start_at, period_end_at, amount, status`,
          [tenantId, reservationId, quotaId, input.periodStartAt, input.periodEndAt,
            input.amount, idempotencyKey, input.fingerprint],
        );
        return reservationFromRow(result.rows[0]);
      });
    },

    async consume({ tenantId: value, reservationId: inputReservationId }) {
      const tenantId = validateTenantId(value);
      const reservationId = validateTenantId(inputReservationId);
      return transaction(pool, schema, tenantId, async client => {
        const row = await readReservation(client, tenantId, reservationId, true);
        if (!row) fail('RESERVATION_NOT_FOUND');
        if (row.status === 'consumed') return reservationFromRow(row);
        if (row.status !== 'reserved') fail('RESERVATION_FINALIZED');
        const reservation = reservationFromRow(row);
        await lockQuota(client, tenantId, reservation.quotaId, reservation.periodStartAt);
        const usageResult = await client.query(
          `SELECT reserved FROM entitlements_usage
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3 FOR UPDATE`,
          [tenantId, reservation.quotaId, reservation.periodStartAt],
        );
        const usage = usageResult.rows?.[0];
        if (!usage || databaseNumber(usage.reserved) < reservation.amount) fail('UNAVAILABLE');
        await client.query(
          `UPDATE entitlements_usage SET reserved = reserved - $4, used = used + $4
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3`,
          [tenantId, reservation.quotaId, reservation.periodStartAt, reservation.amount],
        );
        const result = await client.query(
          `UPDATE entitlements_reservations SET status = 'consumed'
           WHERE tenant_id = $1 AND reservation_id = $2
           RETURNING reservation_id, quota_id, period_start_at, period_end_at, amount, status`,
          [tenantId, reservationId],
        );
        return reservationFromRow(result.rows[0]);
      });
    },

    async refund({ tenantId: value, reservationId: inputReservationId }) {
      const tenantId = validateTenantId(value);
      const reservationId = validateTenantId(inputReservationId);
      return transaction(pool, schema, tenantId, async client => {
        const row = await readReservation(client, tenantId, reservationId, true);
        if (!row) fail('RESERVATION_NOT_FOUND');
        if (row.status === 'refunded') return reservationFromRow(row);
        if (!['reserved', 'consumed'].includes(row.status)) fail('UNAVAILABLE');
        const reservation = reservationFromRow(row);
        await lockQuota(client, tenantId, reservation.quotaId, reservation.periodStartAt);
        const column = reservation.status === 'reserved' ? 'reserved' : 'used';
        const usageResult = await client.query(
          `SELECT ${column} AS amount FROM entitlements_usage
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3 FOR UPDATE`,
          [tenantId, reservation.quotaId, reservation.periodStartAt],
        );
        const usage = usageResult.rows?.[0];
        if (!usage || databaseNumber(usage.amount) < reservation.amount) fail('UNAVAILABLE');
        await client.query(
          `UPDATE entitlements_usage SET ${column} = ${column} - $4
           WHERE tenant_id = $1 AND quota_id = $2 AND period_start_at = $3`,
          [tenantId, reservation.quotaId, reservation.periodStartAt, reservation.amount],
        );
        const result = await client.query(
          `UPDATE entitlements_reservations SET status = 'refunded'
           WHERE tenant_id = $1 AND reservation_id = $2
           RETURNING reservation_id, quota_id, period_start_at, period_end_at, amount, status`,
          [tenantId, reservationId],
        );
        return reservationFromRow(result.rows[0]);
      });
    },
  });
}
