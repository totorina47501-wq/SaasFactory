import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createDatabaseAdapter,
  DatabaseModuleError,
  runMigrations,
  seedSynthetic,
} from '../modules/database/index.mjs';

const context = (tenantId = 'tenant-a') => ({
  contractVersion: 1,
  tenantId,
  requestId: 'request-1',
});

function fakePool({ rows = [], failOn, queryRows = {} } = {}) {
  const state = { calls: [], applied: new Map(rows.map(row => [row.version, row])), connects: 0 };
  const pool = {
    async connect() {
      state.connects += 1;
      return {
        async query(sql, parameters = []) {
          state.calls.push({ sql, parameters });
          if (failOn && failOn(sql)) throw new Error('driver detail must not escape');
          if (sql.startsWith('SELECT version, id, checksum FROM schema_migrations')) {
            return { rows: [...state.applied.values()] };
          }
          if (sql.startsWith('INSERT INTO schema_migrations')) {
            state.applied.set(parameters[0], {
              version: parameters[0],
              id: parameters[1],
              checksum: parameters[2],
            });
          }
          if (queryRows[sql]) return { rows: queryRows[sql] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return { pool, state };
}

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof DatabaseModuleError && error.code === code);
}

test('applies versioned migrations atomically and supports additive upgrades', async () => {
  const { pool, state } = fakePool();
  assert.deepEqual(await runMigrations(pool, 'app_test', { targetVersion: 1 }), [
    { version: 1, id: '0001_identity_audit' },
  ]);
  assert.equal(state.applied.size, 1);
  assert.ok(state.calls.some(call => call.sql.includes('CREATE SCHEMA IF NOT EXISTS "app_test"')));
  assert.ok(state.calls.some(call => call.sql.includes('CREATE TABLE organizations')));
  assert.ok(state.calls.some(call => call.sql === 'COMMIT'));

  assert.deepEqual(await runMigrations(pool, 'app_test'), [
    { version: 1, id: '0001_identity_audit' },
    { version: 2, id: '0002_tenant_storage' },
    { version: 3, id: '0003_audit_truncate_guard' },
  ]);
  assert.equal(state.applied.size, 3);
  assert.equal(state.calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.deepEqual(await runMigrations(pool, 'app_test', { targetVersion: 1 }), [
    { version: 1, id: '0001_identity_audit' },
    { version: 2, id: '0002_tenant_storage' },
    { version: 3, id: '0003_audit_truncate_guard' },
  ]);
});

test('fails closed on unsafe schemas, invalid extension migrations, altered history and SQL errors', async () => {
  const { pool, state } = fakePool();
  await assert.rejects(runMigrations(pool, 'app"; DROP SCHEMA public;--'), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_SCHEMA');
  await assert.rejects(runMigrations(pool, 'app_test', { unexpected: true }), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_INPUT');
  await assert.rejects(runMigrations(pool, 'app_test', {
    extensionMigrations: [{ version: 5, id: 'unsafe', sql: 'SELECT 1' }],
  }), error => error instanceof DatabaseModuleError && error.code === 'INVALID_MIGRATIONS');
  assert.equal(state.connects, 0);

  const badHistory = fakePool({
    rows: [{ version: 1, id: '0001_identity_audit', checksum: 'incorrect' }],
  });
  await assert.rejects(runMigrations(badHistory.pool, 'app_test'), error =>
    error instanceof DatabaseModuleError && error.code === 'MIGRATION_HISTORY_MISMATCH');
  assert.ok(badHistory.state.calls.some(call => call.sql === 'ROLLBACK'));

  const failedQuery = fakePool({ failOn: sql => sql.includes('CREATE TABLE organizations') });
  await assert.rejects(runMigrations(failedQuery.pool, 'app_test'), error =>
    error instanceof DatabaseModuleError && error.code === 'MIGRATION_FAILED');
  assert.ok(failedQuery.state.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!failedQuery.state.calls.some(call => call.sql === 'COMMIT'));
});

test('runs approved extension migrations in order and records their checksum', async () => {
  const { pool, state } = fakePool();
  const applied = await runMigrations(pool, 'app_test', {
    extensionMigrations: [{ version: 4, id: '0004_extension_example', sql: 'CREATE TABLE extension_data (id text)' }],
  });
  assert.equal(applied.at(-1).version, 4);
  assert.equal(state.applied.get(4).id, '0004_extension_example');
  assert.ok(state.calls.some(call => call.sql.includes('CREATE TABLE extension_data')));
});

test('implements tenant-scoped local storage and append-only audit through the v1 adapter', async () => {
  const upsertSql = [
    'INSERT INTO local_storage (tenant_id, key, value, version)',
    '           VALUES ($1, $2, $3::jsonb, 1)',
    '           ON CONFLICT (tenant_id, key) DO UPDATE',
    '           SET value = EXCLUDED.value, version = local_storage.version + 1',
    '           WHERE $4::integer IS NULL OR local_storage.version = $4',
    '           RETURNING version',
  ].join('\n');
  const deleteSql = [
    'DELETE FROM local_storage',
    '           WHERE tenant_id = $1 AND key = $2 AND ($3::integer IS NULL OR version = $3)',
    '           RETURNING key',
  ].join('\n');
  const auditSql = [
    'INSERT INTO audit_events',
    '            (tenant_id, request_id, action, resource_type, resource_id, outcome, details)',
    '           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
    '           RETURNING event_id, recorded_at',
  ].join('\n');
  const queryRows = {
    'SELECT value, version FROM local_storage WHERE tenant_id = $1 AND key = $2': [
      { value: { enabled: true }, version: 3 },
    ],
    [upsertSql]: [{ version: 4 }],
    [deleteSql]: [{ key: 'settings' }],
    [auditSql]: [{
        event_id: '00000000-0000-4000-8000-000000000002',
        recorded_at: '2026-01-01T00:00:00.000Z',
      }],
  };
  const { pool, state } = fakePool({ queryRows });
  const adapter = createDatabaseAdapter({ pool, schemaName: 'app_test' });
  const stored = await adapter.get(context(), 'settings');
  assert.equal(stored.value.enabled, true);
  assert.equal(stored.version, 3);
  assert.equal(await adapter.put(context(), 'settings', { enabled: false }, 3), 4);
  assert.equal(await adapter.delete(context(), 'settings', 4), true);
  assert.deepEqual(await adapter.append(context(), {
    action: 'user.updated',
    resourceType: 'user',
    resourceId: 'user-1',
    outcome: 'success',
    details: { source: 'local' },
  }), {
    eventId: '00000000-0000-4000-8000-000000000002',
    recordedAt: '2026-01-01T00:00:00.000Z',
  });
  const scopedQueries = state.calls.filter(call =>
    /(?:FROM|INTO|DELETE FROM) (?:local_storage|audit_events)/u.test(call.sql));
  assert.ok(scopedQueries.every(call => call.parameters[0] === 'tenant-a'));
  assert.ok(state.calls.some(call =>
    call.sql.includes("set_config('app.tenant_id', $1, true)") &&
    call.parameters[0] === 'tenant-a'));
  assert.ok(state.calls.every(call => call.sql !== 'SET search_path TO app_test'));
});

test('validates tenant contexts, JSON, optimistic versions, and non-sensitive audit events before access', async () => {
  const { pool, state } = fakePool();
  const adapter = createDatabaseAdapter({ pool, schemaName: 'app_test' });
  await assert.rejects(adapter.get(undefined, 'settings'), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_INPUT');
  await assert.rejects(adapter.get({ ...context(), role: 'admin' }, 'settings'), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_INPUT');
  await assert.rejects(adapter.get(context(), '../other'), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_KEY');
  await assert.rejects(adapter.put(context(), 'settings', { value: 1 }, -1), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_VERSION');

  let getterCalled = false;
  const value = {};
  Object.defineProperty(value, 'unsafe', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('getter must not execute');
    },
  });
  await assert.rejects(adapter.put(context(), 'settings', value), error =>
    error instanceof DatabaseModuleError && error.code === 'INVALID_JSON');
  await assert.rejects(adapter.append(context(), {
    action: 'user.updated',
    resourceType: 'user',
    outcome: 'success',
    details: { access_token: 'synthetic-sensitive-value' },
  }), error => error instanceof DatabaseModuleError && error.code === 'SENSITIVE_AUDIT_DATA');
  assert.equal(getterCalled, false);
  assert.equal(state.connects, 0);
});

test('rolls back optimistic conflicts and seeds only fixed synthetic identities', async () => {
  const upsertSql = [
    'INSERT INTO local_storage (tenant_id, key, value, version)',
    '           VALUES ($1, $2, $3::jsonb, 1)',
    '           ON CONFLICT (tenant_id, key) DO UPDATE',
    '           SET value = EXCLUDED.value, version = local_storage.version + 1',
    '           WHERE $4::integer IS NULL OR local_storage.version = $4',
    '           RETURNING version',
  ].join('\n');
  const conflict = fakePool({ queryRows: { [upsertSql]: [] } });
  const adapter = createDatabaseAdapter({ pool: conflict.pool, schemaName: 'app_test' });
  await assert.rejects(adapter.put(context(), 'settings', { ok: true }, 99), error =>
    error instanceof DatabaseModuleError && error.code === 'CONFLICT');
  assert.ok(conflict.state.calls.some(call => call.sql === 'ROLLBACK'));

  const seeded = fakePool();
  assert.deepEqual(await seedSynthetic(seeded.pool, 'app_test'), {
    tenantId: 'tenant_demo',
    synthetic: true,
  });
  const seedInserts = seeded.state.calls.filter(call => call.sql.startsWith('INSERT INTO'));
  assert.equal(seedInserts.length, 3);
  assert.ok(seedInserts.every(call => call.sql.includes('ON CONFLICT') && !call.sql.includes('DO UPDATE')));
  assert.ok(seedInserts.some(call => call.parameters.includes('synthetic-user@example.invalid')));
  assert.ok(seedInserts.every(call => call.parameters.every(value =>
    typeof value !== 'string' || !/password|token|secret/iu.test(value))));
});

test('declares tenant foreign keys, uniqueness, append-only audit, RLS and module extension storage', () => {
  const identity = readFileSync(new URL('../modules/database/migrations/0001_identity_audit.sql', import.meta.url), 'utf8');
  const storage = readFileSync(new URL('../modules/database/migrations/0002_tenant_storage.sql', import.meta.url), 'utf8');
  const appendOnly = readFileSync(new URL('../modules/database/migrations/0003_audit_truncate_guard.sql', import.meta.url), 'utf8');
  assert.match(identity, /CREATE TABLE organizations/u);
  assert.match(identity, /CREATE TABLE users/u);
  assert.match(identity, /CREATE TABLE memberships/u);
  assert.match(identity, /PRIMARY KEY \(tenant_id, user_id\)/u);
  assert.match(identity, /REFERENCES organizations \(tenant_id\)/u);
  assert.match(identity, /CREATE UNIQUE INDEX users_email_unique ON users \(lower\(email\)\)/u);
  assert.match(identity, /BEFORE UPDATE OR DELETE ON audit_events/u);
  assert.match(appendOnly, /BEFORE TRUNCATE ON audit_events/u);
  for (const table of ['organizations', 'users', 'memberships', 'audit_events', 'local_storage', 'module_data']) {
    assert.match(storage, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'u'));
  }
  assert.match(storage, /CREATE TABLE module_data/u);
});

const databaseUrl = process.env.DATABASE_URL;
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : undefined;
const localDatabase = parsedDatabaseUrl &&
  ['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) &&
  ['localhost', '127.0.0.1', '::1'].includes(parsedDatabaseUrl.hostname) &&
  parsedDatabaseUrl.pathname.length > 1 &&
  parsedDatabaseUrl.search.length === 0;

test('PostgreSQL blank install, upgrade, constraints, rollback, and tenant RLS', {
  skip: !localDatabase ? 'Set DATABASE_URL to a disposable local PostgreSQL database.' : false,
}, () => {
  const schemaName = `sf_test_${randomUUID().replaceAll('-', '')}`;
  const roleName = `${schemaName}_app`;
  const psql = sql => {
    const result = spawnSync('psql', [
      '-X',
      '-q',
      '--set=ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
    ], {
      env: {
        ...process.env,
        PGHOST: parsedDatabaseUrl.hostname,
        PGPORT: parsedDatabaseUrl.port || '5432',
        PGUSER: decodeURIComponent(parsedDatabaseUrl.username),
        PGDATABASE: decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)),
        PGPASSWORD: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
      },
      input: sql,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
      const diagnostic = (result.stderr ?? '').replaceAll(databaseUrl, '[DATABASE_URL]').trim();
      throw new Error(`Local PostgreSQL integration command failed: ${diagnostic}`);
    }
    return result.stdout.trim();
  };
  const identity = readFileSync(new URL('../modules/database/migrations/0001_identity_audit.sql', import.meta.url), 'utf8');
  const storage = readFileSync(new URL('../modules/database/migrations/0002_tenant_storage.sql', import.meta.url), 'utf8');
  const appendOnly = readFileSync(new URL('../modules/database/migrations/0003_audit_truncate_guard.sql', import.meta.url), 'utf8');
  const qualified = `"${schemaName}"`;
  try {
    psql(`CREATE SCHEMA ${qualified}; CREATE ROLE "${roleName}" NOLOGIN; GRANT "${roleName}" TO CURRENT_USER;`);
    psql(`SET search_path TO ${qualified}, pg_catalog; ${identity}`);
    assert.equal(psql(`SELECT to_regclass('${schemaName}.local_storage') IS NULL;`), 't');
    psql(`SET search_path TO ${qualified}, pg_catalog; ${storage}`);
    assert.equal(psql(`SELECT to_regclass('${schemaName}.local_storage') IS NOT NULL;`), 't');
    psql(`SET search_path TO ${qualified}, pg_catalog; ${appendOnly}`);
    psql(`GRANT USAGE ON SCHEMA ${qualified} TO "${roleName}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${qualified} TO "${roleName}";`);
    psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      INSERT INTO organizations (tenant_id, name) VALUES ('tenant-a', 'Synthetic A');
      INSERT INTO users (id, email, display_name) VALUES
        ('00000000-0000-4000-8000-000000000011', 'a@example.invalid', 'Synthetic A');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES
        ('tenant-a', '00000000-0000-4000-8000-000000000011', 'owner');
      INSERT INTO local_storage (tenant_id, key, value, version)
        VALUES ('tenant-a', 'settings', '{"tenant":"a"}', 1);
      INSERT INTO audit_events (tenant_id, request_id, action, resource_type, outcome)
        VALUES ('tenant-a', 'request-a', 'user.created', 'user', 'success');
      COMMIT;`);
    psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-b', true);
      INSERT INTO organizations (tenant_id, name) VALUES ('tenant-b', 'Synthetic B');
      INSERT INTO users (id, email, display_name) VALUES
        ('00000000-0000-4000-8000-000000000012', 'b@example.invalid', 'Synthetic B');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES
        ('tenant-b', '00000000-0000-4000-8000-000000000012', 'owner');
      INSERT INTO local_storage (tenant_id, key, value, version)
        VALUES ('tenant-b', 'settings', '{"tenant":"b"}', 1);
      COMMIT;`);
    const scopedCounts = psql(`SET ROLE "${roleName}";
      BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      SELECT count(*) FROM local_storage;
      COMMIT;
      BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-b', true);
      SELECT count(*) FROM local_storage;
      COMMIT;
      RESET ROLE;`).split('\n').filter(line => line === '1');
    assert.deepEqual(scopedCounts, ['1', '1']);
    psql(`SET ROLE "${roleName}";
      BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      INSERT INTO local_storage (tenant_id, key, value, version) VALUES ('tenant-a', 'rolled-back', '{}', 1);
      ROLLBACK;
      RESET ROLE;`);
    assert.equal(psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      SELECT count(*) FROM local_storage WHERE key = 'rolled-back';
      ROLLBACK;`).split('\n').at(-1), '0');
    assert.throws(() => psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ('tenant-a', '00000000-0000-4000-8000-000000000099', 'owner');
      ROLLBACK;`));
    assert.throws(() => psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      INSERT INTO users (id, email, display_name) VALUES
      ('00000000-0000-4000-8000-000000000013', 'A@EXAMPLE.INVALID', 'Duplicate');
      ROLLBACK;`));
    assert.throws(() => psql(`BEGIN;
      SET LOCAL search_path TO ${qualified}, pg_catalog;
      SELECT set_config('app.tenant_id', 'tenant-a', true);
      UPDATE audit_events SET action = 'user.changed';
      ROLLBACK;`));
    assert.throws(() => psql(`TRUNCATE ${qualified}.audit_events;`));
  } finally {
    psql(`DROP SCHEMA IF EXISTS ${qualified} CASCADE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          EXECUTE 'REVOKE "${roleName}" FROM CURRENT_USER';
          EXECUTE 'DROP ROLE "${roleName}"';
        END IF;
      END $$;`);
  }
});
