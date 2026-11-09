import { readFileSync } from 'node:fs';
import { runMigrations } from '../database/index.mjs';

const migration = Object.freeze({
  moduleId: 'auth',
  version: 1,
  id: '0001_local_authentication',
  sql: readFileSync(new URL('./migrations/0001_local_authentication.sql', import.meta.url), 'utf8'),
});
const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const CLEANUP_BATCH_SIZE = 100;

function validatePool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }
}

function quoteSchema(schemaName) {
  if (typeof schemaName !== 'string' || !schemaPattern.test(schemaName) ||
      schemaName.startsWith('pg_') || ['public', 'information_schema'].includes(schemaName)) {
    throw new TypeError('Invalid PostgreSQL schema name.');
  }
  return `"${schemaName}"`;
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

function deleteExpiredSessions(client, schema, now) {
  return client.query(
    `WITH expired AS (
       SELECT token_hash FROM ${schema}.auth_sessions
       WHERE expires_at <= to_timestamp($1::double precision / 1000)
       ORDER BY expires_at, token_hash
       LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${schema}.auth_sessions AS sessions
     USING expired WHERE sessions.token_hash = expired.token_hash`,
    [now],
  );
}

function deleteExpiredResets(client, schema, now) {
  return client.query(
    `WITH expired AS (
       SELECT token_hash FROM ${schema}.auth_password_resets
       WHERE expires_at <= to_timestamp($1::double precision / 1000)
       ORDER BY expires_at, token_hash
       LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${schema}.auth_password_resets AS resets
     USING expired WHERE resets.token_hash = expired.token_hash`,
    [now],
  );
}

function deleteExpiredRateLimits(client, schema, now) {
  return client.query(
    `WITH expired AS (
       SELECT bucket_hash FROM ${schema}.auth_rate_limits
       WHERE window_start < to_timestamp($1::double precision / 1000) - INTERVAL '1 day'
       ORDER BY window_start, bucket_hash
       LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${schema}.auth_rate_limits AS limits
     USING expired WHERE limits.bucket_hash = expired.bucket_hash`,
    [now],
  );
}

export async function runAuthMigrations(pool, schemaName) {
  return runMigrations(pool, schemaName, { extensionMigrations: [migration] });
}

export function createPostgresAuthStore(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !['pool', 'schemaName'].includes(key)) ||
      !Object.hasOwn(options, 'pool') || !Object.hasOwn(options, 'schemaName') ||
      Reflect.ownKeys(options).some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    throw new TypeError('Invalid PostgreSQL auth store options.');
  }
  validatePool(options.pool);
  const pool = options.pool;
  const schema = quoteSchema(options.schemaName);

  async function purgeExpiredAuthData(now) {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid cleanup time.');
    return withClient(pool, async client => {
      const sessions = await deleteExpiredSessions(client, schema, now);
      const resets = await deleteExpiredResets(client, schema, now);
      const limits = await deleteExpiredRateLimits(client, schema, now);
      return (sessions.rowCount ?? 0) + (resets.rowCount ?? 0) + (limits.rowCount ?? 0);
    });
  }

  return Object.freeze({
    async findUserByEmail(email) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT id, email, password_hash AS "passwordHash" FROM ${schema}.auth_users WHERE lower(email) = $1`,
          [email],
        );
        const row = result.rows[0];
        return row ? { id: row.id, email: row.email, passwordHash: row.passwordHash } : null;
      });
    },

    async findUserById(userId) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT id, email, password_hash AS "passwordHash" FROM ${schema}.auth_users WHERE id = $1`,
          [userId],
        );
        const row = result.rows[0];
        return row ? { id: row.id, email: row.email, passwordHash: row.passwordHash } : null;
      });
    },

    async createUser(user) {
      return withClient(pool, async client => {
        const result = await client.query(
          `INSERT INTO ${schema}.auth_users (id, email, password_hash, created_at)
           VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000))
           ON CONFLICT DO NOTHING RETURNING id`,
          [user.id, user.email, user.passwordHash, user.createdAt],
        );
        return result.rows.length === 1;
      });
    },

    async createSessionIfPasswordHashMatches(session, expectedPasswordHash) {
      await purgeExpiredAuthData(session.createdAt);
      return withClient(pool, async client => {
        await client.query('BEGIN');
        try {
          const current = await client.query(
            `SELECT password_hash FROM ${schema}.auth_users WHERE id = $1 FOR UPDATE`,
            [session.userId],
          );
          if (current.rows[0]?.password_hash !== expectedPasswordHash) {
            await client.query('ROLLBACK');
            return false;
          }
          await client.query(
            `INSERT INTO ${schema}.auth_sessions (token_hash, user_id, csrf_hash, created_at, expires_at)
             VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000))`,
            [session.tokenHash, session.userId, session.csrfHash, session.createdAt, session.expiresAt],
          );
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },

    async findSessionByTokenHash(tokenHash) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT user_id AS "userId", csrf_hash AS "csrfHash", expires_at AS "expiresAt"
           FROM ${schema}.auth_sessions WHERE token_hash = $1`,
          [tokenHash],
        );
        const row = result.rows[0];
        return row ? {
          userId: row.userId,
          csrfHash: row.csrfHash,
          expiresAt: rowDate(row.expiresAt),
        } : null;
      });
    },

    async deleteSessionByTokenHash(tokenHash) {
      return withClient(pool, client => client.query(
        `DELETE FROM ${schema}.auth_sessions WHERE token_hash = $1`,
        [tokenHash],
      ));
    },

    async rotateSession(oldTokenHash, session) {
      return withClient(pool, async client => {
        await client.query('BEGIN');
        try {
          const user = await client.query(
            `SELECT id FROM ${schema}.auth_users WHERE id = $1 FOR UPDATE`,
            [session.userId],
          );
          if (user.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          const removed = await client.query(
            `DELETE FROM ${schema}.auth_sessions WHERE token_hash = $1 AND user_id = $2 RETURNING user_id`,
            [oldTokenHash, session.userId],
          );
          if (removed.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          await client.query(
            `INSERT INTO ${schema}.auth_sessions (token_hash, user_id, csrf_hash, created_at, expires_at)
             VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000))`,
            [session.tokenHash, session.userId, session.csrfHash, session.createdAt, session.expiresAt],
          );
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },

    async deleteSessionsByUserId(userId) {
      return withClient(pool, client => client.query(
        `DELETE FROM ${schema}.auth_sessions WHERE user_id = $1`,
        [userId],
      ));
    },

    async purgeExpiredAuthData(now) {
      return purgeExpiredAuthData(now);
    },

    async createResetToken(reset) {
      return withClient(pool, async client => {
        await deleteExpiredResets(client, schema, reset.createdAt);
        return client.query(
          `INSERT INTO ${schema}.auth_password_resets (token_hash, user_id, created_at, expires_at)
           VALUES ($1, $2, to_timestamp($3::double precision / 1000), to_timestamp($4::double precision / 1000))`,
          [reset.tokenHash, reset.userId, reset.createdAt, reset.expiresAt],
        );
      });
    },

    async revokeResetToken(tokenHash) {
      return withClient(pool, client => client.query(
        `DELETE FROM ${schema}.auth_password_resets WHERE token_hash = $1`,
        [tokenHash],
      ));
    },

    async completePasswordReset({ tokenHash, passwordHash, now }) {
      return withClient(pool, async client => {
        await client.query('BEGIN');
        try {
          const candidate = await client.query(
            `SELECT user_id FROM ${schema}.auth_password_resets
             WHERE token_hash = $1 AND expires_at > GREATEST(
               to_timestamp($2::double precision / 1000), clock_timestamp()
             )`,
            [tokenHash, now],
          );
          const userId = candidate.rows[0]?.user_id;
          if (!userId) {
            await client.query('ROLLBACK');
            return false;
          }
          const user = await client.query(
            `SELECT id FROM ${schema}.auth_users WHERE id = $1 FOR UPDATE`,
            [userId],
          );
          if (user.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          const consumed = await client.query(
            `DELETE FROM ${schema}.auth_password_resets
             WHERE token_hash = $1 AND user_id = $2 AND expires_at > GREATEST(
               to_timestamp($3::double precision / 1000), clock_timestamp()
             )
             RETURNING user_id`,
            [tokenHash, userId, now],
          );
          if (consumed.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          const updated = await client.query(
            `UPDATE ${schema}.auth_users SET password_hash = $2 WHERE id = $1 RETURNING id`,
            [userId, passwordHash],
          );
          if (updated.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          await client.query(
            `DELETE FROM ${schema}.auth_password_resets WHERE user_id = $1`,
            [userId],
          );
          await client.query(
            `DELETE FROM ${schema}.auth_sessions WHERE user_id = $1`,
            [userId],
          );
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },

    async consumeRateLimit(key, limit, windowMs, now) {
      return withClient(pool, async client => {
        await deleteExpiredRateLimits(client, schema, now);
        const result = await client.query(
          `INSERT INTO ${schema}.auth_rate_limits AS current (bucket_hash, window_start, attempts)
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
          [key, limit, windowMs, now],
        );
        return result.rows[0]?.allowed === true;
      });
    },
  });
}
