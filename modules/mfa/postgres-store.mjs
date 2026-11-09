import { readFileSync } from 'node:fs';
import { runAuthMigrations } from '../auth/postgres-store.mjs';
import { runMigrations } from '../database/index.mjs';

const migration = Object.freeze({
  moduleId: 'mfa',
  version: 1,
  id: '0001_local_mfa',
  sql: readFileSync(new URL('./migrations/0001_local_mfa.sql', import.meta.url), 'utf8'),
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

function validRecoveryCodeHashes(hashes) {
  return Array.isArray(hashes) && hashes.length === 10 &&
    hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash)) &&
    new Set(hashes).size === hashes.length;
}

export async function runMfaMigrations(pool, schemaName) {
  await runAuthMigrations(pool, schemaName);
  return runMigrations(pool, schemaName, { extensionMigrations: [migration] });
}

export function createPostgresMfaStore(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => !['pool', 'schemaName'].includes(key)) ||
      !Object.hasOwn(options, 'pool') || !Object.hasOwn(options, 'schemaName') ||
      Reflect.ownKeys(options).some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
      })) {
    throw new TypeError('Invalid PostgreSQL MFA store options.');
  }
  validatePool(options.pool);
  const pool = options.pool;
  const schema = quoteSchema(options.schemaName);

  return Object.freeze({
    async beginEnrollment(userId, encryptedSecret) {
      const result = await withClient(pool, client => client.query(
        `INSERT INTO ${schema}.mfa_authenticators (user_id, pending_secret)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET pending_secret = EXCLUDED.pending_secret
         WHERE ${schema}.mfa_authenticators.enabled_at IS NULL
           AND ${schema}.mfa_authenticators.secret IS NULL
         RETURNING user_id`,
        [userId, encryptedSecret],
      ));
      return result.rows.length === 1;
    },

    async getAuthenticator(userId) {
      return withClient(pool, async client => {
        const result = await client.query(
          `SELECT pending_secret AS "pendingSecret", secret,
                  last_accepted_step::double precision AS "lastAcceptedStep",
                  enabled_at IS NOT NULL AS enabled
           FROM ${schema}.mfa_authenticators WHERE user_id = $1`,
          [userId],
        );
        const row = result.rows[0];
        return row ? {
          pendingSecret: row.pendingSecret,
          secret: row.secret,
          lastAcceptedStep: row.lastAcceptedStep === null ? null : Number(row.lastAcceptedStep),
          enabled: row.enabled,
        } : null;
      });
    },

    async activateEnrollment({ userId, lastAcceptedStep, recoveryCodeHashes, now }) {
      if (!Number.isSafeInteger(lastAcceptedStep) || lastAcceptedStep < 0 ||
          !Number.isSafeInteger(now) || now < 0 || !validRecoveryCodeHashes(recoveryCodeHashes)) {
        throw new TypeError('Invalid MFA enrollment.');
      }
      return withClient(pool, async client => {
        await client.query('BEGIN');
        try {
          const activated = await client.query(
            `UPDATE ${schema}.mfa_authenticators
             SET secret = pending_secret, pending_secret = NULL,
                 last_accepted_step = $2,
                 enabled_at = to_timestamp($3::double precision / 1000)
             WHERE user_id = $1 AND pending_secret IS NOT NULL
               AND secret IS NULL AND enabled_at IS NULL
             RETURNING user_id`,
            [userId, lastAcceptedStep, now],
          );
          if (activated.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          await client.query(
            `DELETE FROM ${schema}.mfa_recovery_codes WHERE user_id = $1`,
            [userId],
          );
          for (const hash of recoveryCodeHashes) {
            await client.query(
              `INSERT INTO ${schema}.mfa_recovery_codes (user_id, code_hash, created_at)
               VALUES ($1, $2, to_timestamp($3::double precision / 1000))`,
              [userId, hash, now],
            );
          }
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },

    async consumeTotpStep(userId, step) {
      if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('Invalid TOTP step.');
      const result = await withClient(pool, client => client.query(
        `UPDATE ${schema}.mfa_authenticators SET last_accepted_step = $2
         WHERE user_id = $1 AND secret IS NOT NULL AND enabled_at IS NOT NULL
           AND last_accepted_step < $2
         RETURNING user_id`,
        [userId, step],
      ));
      return result.rows.length === 1;
    },

    async consumeRecoveryCode(userId, codeHash) {
      if (typeof codeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(codeHash)) {
        throw new TypeError('Invalid recovery code hash.');
      }
      const result = await withClient(pool, client => client.query(
        `DELETE FROM ${schema}.mfa_recovery_codes AS codes
         USING ${schema}.mfa_authenticators AS authenticators
         WHERE codes.user_id = $1 AND codes.code_hash = $2
           AND authenticators.user_id = codes.user_id
           AND authenticators.secret IS NOT NULL AND authenticators.enabled_at IS NOT NULL
         RETURNING codes.user_id`,
        [userId, codeHash],
      ));
      return result.rows.length === 1;
    },

    async disableMfa({ userId, step, recoveryCodeHash }) {
      if ((step === null) === (recoveryCodeHash === null) ||
          (step !== null && (!Number.isSafeInteger(step) || step < 0)) ||
          (recoveryCodeHash !== null &&
            (typeof recoveryCodeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(recoveryCodeHash)))) {
        throw new TypeError('Invalid MFA disable proof.');
      }
      return withClient(pool, async client => {
        await client.query('BEGIN');
        try {
          const current = await client.query(
            `SELECT last_accepted_step::double precision AS last_accepted_step
             FROM ${schema}.mfa_authenticators
             WHERE user_id = $1 AND secret IS NOT NULL AND enabled_at IS NOT NULL
             FOR UPDATE`,
            [userId],
          );
          if (current.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          if (step !== null) {
            if (step <= Number(current.rows[0].last_accepted_step)) {
              await client.query('ROLLBACK');
              return false;
            }
          } else {
            const consumed = await client.query(
              `DELETE FROM ${schema}.mfa_recovery_codes
               WHERE user_id = $1 AND code_hash = $2 RETURNING user_id`,
              [userId, recoveryCodeHash],
            );
            if (consumed.rows.length !== 1) {
              await client.query('ROLLBACK');
              return false;
            }
          }
          const disabled = await client.query(
            `UPDATE ${schema}.mfa_authenticators
             SET pending_secret = NULL, secret = NULL,
                 last_accepted_step = NULL, enabled_at = NULL
             WHERE user_id = $1 AND enabled_at IS NOT NULL
             RETURNING user_id`,
            [userId],
          );
          if (disabled.rows.length !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
          await client.query(
            `DELETE FROM ${schema}.mfa_recovery_codes WHERE user_id = $1`,
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
        await client.query(
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
