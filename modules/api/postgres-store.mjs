import { readFileSync } from 'node:fs';
import { runMigrations } from '../database/index.mjs';

const migration = Object.freeze({
  moduleId: 'api',
  version: 1,
  id: '0001_local_api',
  sql: readFileSync(new URL('./migrations/0001_local_api.sql', import.meta.url), 'utf8'),
});
const SCHEMA_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const CLEANUP_BATCH_SIZE = 500;

function quoteSchema(name) {
  if (typeof name !== 'string' || !SCHEMA_PATTERN.test(name) || name.startsWith('pg_') ||
      ['public', 'information_schema'].includes(name)) throw new TypeError('Invalid PostgreSQL schema name.');
  return `"${name}"`;
}

function validPool(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
}

async function withClient(pool, operation) {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

function rowDate(value) {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid database timestamp.');
  return result;
}

function keyFromRow(row) {
  return {
    id: row.key_id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    name: row.name,
    scopes: row.scopes,
    tokenHash: row.token_hash,
    createdAt: rowDate(row.created_at),
    expiresAt: row.expires_at === null ? null : rowDate(row.expires_at),
    revokedAt: row.revoked_at === null ? null : rowDate(row.revoked_at),
  };
}

export async function runApiMigrations(pool, schemaName) {
  return runMigrations(pool, schemaName, { extensionMigrations: [migration] });
}

export function createPostgresApiStore(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
      Reflect.ownKeys(configuration).some(key => !['pool', 'schemaName'].includes(key)) ||
      !Object.hasOwn(configuration, 'pool') || !Object.hasOwn(configuration, 'schemaName') ||
      Reflect.ownKeys(configuration).some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) throw new TypeError('Invalid PostgreSQL API store options.');
  validPool(configuration.pool);
  const pool = configuration.pool;
  const schema = quoteSchema(configuration.schemaName);

  return Object.freeze({
    async createApiKey(key) {
      return withClient(pool, async client => {
        await client.query(
          `INSERT INTO ${schema}.api_keys
            (key_id, tenant_id, actor_id, name, scopes, token_hash, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000),
             CASE WHEN $8::bigint IS NULL THEN NULL
               ELSE to_timestamp($8::double precision / 1000) END)`,
          [key.id, key.tenantId, key.actorId, key.name, key.scopes, key.tokenHash,
            key.createdAt, key.expiresAt],
        );
      });
    },

    async findApiKeyById(id) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT key_id, tenant_id, actor_id, name, scopes, token_hash,
              created_at, expires_at, revoked_at
           FROM ${schema}.api_keys WHERE key_id = $1`,
          [id],
        );
        return result.rows[0] ? keyFromRow(result.rows[0]) : null;
      });
    },

    async listApiKeys(tenantId, actorId) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT key_id AS id, name, scopes,
              (extract(epoch FROM created_at) * 1000)::bigint AS "createdAt",
              CASE WHEN expires_at IS NULL THEN NULL
                ELSE (extract(epoch FROM expires_at) * 1000)::bigint END AS "expiresAt",
              CASE WHEN revoked_at IS NULL THEN NULL
                ELSE (extract(epoch FROM revoked_at) * 1000)::bigint END AS "revokedAt"
           FROM ${schema}.api_keys
           WHERE tenant_id = $1 AND actor_id = $2
           ORDER BY created_at DESC, key_id`,
          [tenantId, actorId],
        );
        return result.rows.map(row => ({
          id: row.id,
          name: row.name,
          scopes: row.scopes,
          createdAt: Number(row.createdAt),
          expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
          revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
        }));
      });
    },

    async revokeApiKey(tenantId, actorId, id, now) {
      return withClient(pool, async client => {
        const result = await client.query(
          `UPDATE ${schema}.api_keys
           SET revoked_at = COALESCE(revoked_at, to_timestamp($4::double precision / 1000))
           WHERE tenant_id = $1 AND actor_id = $2 AND key_id = $3`,
          [tenantId, actorId, id, now],
        );
        return result.rowCount === 1;
      });
    },

    async consumeRateLimit(bucket, limit, windowMs, now) {
      return withClient(pool, async client => {
        await client.query(
          `WITH expired AS (
             SELECT bucket_hash FROM ${schema}.api_rate_limits
             WHERE window_start < to_timestamp($1::double precision / 1000) - INTERVAL '1 day'
             ORDER BY window_start, bucket_hash
             LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
           )
           DELETE FROM ${schema}.api_rate_limits AS limits
           USING expired WHERE limits.bucket_hash = expired.bucket_hash`,
          [now],
        );
        const result = await client.query(
          `INSERT INTO ${schema}.api_rate_limits AS current
            (bucket_hash, window_start, attempts)
           VALUES ($1, to_timestamp($4::double precision / 1000), 1)
           ON CONFLICT (bucket_hash) DO UPDATE SET
             window_start = CASE
               WHEN current.window_start <=
                 to_timestamp($4::double precision / 1000) - ($3::double precision * INTERVAL '1 millisecond')
               THEN EXCLUDED.window_start ELSE current.window_start END,
             attempts = CASE
               WHEN current.window_start <=
                 to_timestamp($4::double precision / 1000) - ($3::double precision * INTERVAL '1 millisecond')
               THEN 1 ELSE current.attempts + 1 END
           RETURNING attempts <= $2 AS allowed`,
          [bucket, limit, windowMs, now],
        );
        return result.rows[0]?.allowed === true;
      });
    },

    async consumeWebhookReplay(tenantId, nonce, expiresAt, now) {
      return withClient(pool, async client => {
        await client.query(
          `WITH expired AS (
             SELECT tenant_id, nonce FROM ${schema}.api_webhook_replays
             WHERE expires_at <= to_timestamp($1::double precision / 1000)
             ORDER BY expires_at, tenant_id, nonce
             LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
           )
           DELETE FROM ${schema}.api_webhook_replays AS replays
           USING expired
           WHERE replays.tenant_id = expired.tenant_id AND replays.nonce = expired.nonce`,
          [now],
        );
        const result = await client.query(
          `INSERT INTO ${schema}.api_webhook_replays (tenant_id, nonce, expires_at)
           VALUES ($1, $2, to_timestamp($3::double precision / 1000))
           ON CONFLICT (tenant_id, nonce) DO NOTHING`,
          [tenantId, nonce, expiresAt],
        );
        return result.rowCount === 1;
      });
    },
  });
}
