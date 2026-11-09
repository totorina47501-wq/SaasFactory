import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const migrationFiles = [
  { version: 1, id: '0001_identity_audit', url: new URL('./migrations/0001_identity_audit.sql', import.meta.url) },
  { version: 2, id: '0002_tenant_storage', url: new URL('./migrations/0002_tenant_storage.sql', import.meta.url) },
];
const coreMigrations = migrationFiles.map(({ version, id, url }) => Object.freeze({
  version,
  id,
  sql: readFileSync(url, 'utf8'),
}));
const schemaPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const safeTextPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{16,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?<![A-Za-z0-9_])sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{16,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{20,}/iu,
];
const sensitiveFieldPattern = /(?:password|secret|token|credential|cookie|authorization|api.?key)/iu;

export class DatabaseModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DatabaseModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new DatabaseModuleError(code);
}

function exactKeys(value, expected, required = expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !expected.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_INPUT');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function validatePool(pool) {
  if (!pool || typeof pool.connect !== 'function') fail('INVALID_POOL');
}

function validateSchemaName(schemaName) {
  if (typeof schemaName !== 'string' || !schemaPattern.test(schemaName) ||
      schemaName.startsWith('pg_') || ['information_schema', 'public'].includes(schemaName)) {
    fail('INVALID_SCHEMA');
  }
  return `"${schemaName}"`;
}

function validateContext(context) {
  exactKeys(context, ['contractVersion', 'tenantId', 'requestId']);
  if (context.contractVersion !== 1) fail('INVALID_VERSION');
  for (const field of ['tenantId', 'requestId']) {
    if (typeof context[field] !== 'string' || !safeTextPattern.test(context[field])) fail('INVALID_CONTEXT');
  }
  return Object.freeze({
    contractVersion: 1,
    tenantId: context.tenantId,
    requestId: context.requestId,
  });
}

function jsonSnapshot(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 32) fail('INVALID_JSON');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || state.seen.has(value)) fail('INVALID_JSON');
  state.seen.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_JSON');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail('INVALID_JSON');
  const result = array ? [] : Object.create(null);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
        (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) ||
        (!array && ['__proto__', 'prototype', 'constructor'].includes(key))) {
      fail('INVALID_JSON');
    }
    Object.defineProperty(result, key, {
      value: jsonSnapshot(property.value, state, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (array && Array.from({ length: value.length }, (_, index) => Object.hasOwn(result, index)).some(present => !present)) {
    fail('INVALID_JSON');
  }
  state.seen.delete(value);
  return result;
}

function validateJson(value) {
  const copy = jsonSnapshot(value);
  if (Buffer.byteLength(JSON.stringify(copy)) > 65_536) fail('INVALID_JSON');
  return copy;
}

function validateKey(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) fail('INVALID_KEY');
  return key;
}

function validateExpectedVersion(version) {
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) fail('INVALID_VERSION');
  return version ?? null;
}

function normalizeMigrations(extensions = []) {
  if (!Array.isArray(extensions) || extensions.length > 128) fail('INVALID_MIGRATIONS');
  const migrations = [];
  for (const migration of extensions) {
    exactKeys(migration, ['moduleId', 'version', 'id', 'sql'], ['version', 'id', 'sql']);
    const moduleId = migration.moduleId ?? 'legacy-extension';
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 ||
        typeof moduleId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(moduleId) ||
        typeof migration.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(migration.id) ||
        typeof migration.sql !== 'string' || migration.sql.trim().length === 0 ||
        migration.sql.length > 1_000_000 || migration.sql.includes('\0')) {
      fail('INVALID_MIGRATIONS');
    }
    migrations.push({ moduleId, version: migration.version, id: migration.id, sql: migration.sql });
  }
  const modules = new Map();
  for (const migration of migrations) {
    if (!modules.has(migration.moduleId)) modules.set(migration.moduleId, []);
    modules.get(migration.moduleId).push(migration);
  }
  for (const [moduleId, entries] of modules) {
    entries.sort((left, right) => left.version - right.version);
    const firstVersion = moduleId === 'legacy-extension' ? 3 : 1;
    if (entries.some((migration, index) => migration.version !== firstVersion + index) ||
        new Set(entries.map(migration => migration.id)).size !== entries.length) {
      fail('INVALID_MIGRATIONS');
    }
  }
  return migrations.sort((left, right) =>
    left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : left.version - right.version);
}

function normalizeExtensionTargets(targets, extensions) {
  if (targets === undefined) return undefined;
  if (targets === null || typeof targets !== 'object' || Array.isArray(targets) ||
      (Object.getPrototypeOf(targets) !== Object.prototype && Object.getPrototypeOf(targets) !== null)) {
    fail('INVALID_MIGRATIONS');
  }
  const modules = new Map();
  for (const migration of extensions) {
    modules.set(migration.moduleId, Math.max(modules.get(migration.moduleId) ?? 0, migration.version));
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(targets)) {
    const descriptor = Object.getOwnPropertyDescriptor(targets, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !modules.has(key) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 ||
        descriptor.value > modules.get(key)) {
      fail('INVALID_MIGRATIONS');
    }
    result.set(key, descriptor.value);
  }
  return result;
}

async function transaction(pool, schema, context, operation) {
  validatePool(pool);
  const quotedSchema = validateSchemaName(schema);
  const tenant = validateContext(context);
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, pg_catalog`);
    await client.query('SELECT set_config(\'app.tenant_id\', $1, true)', [tenant.tenantId]);
    const result = await operation(client, tenant);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        fail('UNAVAILABLE');
      }
    }
    if (error instanceof DatabaseModuleError) throw error;
    fail('UNAVAILABLE');
  } finally {
    client?.release();
  }
}

export async function runMigrations(pool, schemaName, options = {}) {
  validatePool(pool);
  const quotedSchema = validateSchemaName(schemaName);
  exactKeys(options, ['targetVersion', 'extensionMigrations', 'extensionTargets'], []);
  const extensions = normalizeMigrations(options.extensionMigrations ?? []);
  const targetVersion = options.targetVersion ?? coreMigrations.length;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > coreMigrations.length) {
    fail('INVALID_VERSION');
  }
  const extensionTargets = normalizeExtensionTargets(options.extensionTargets, extensions);
  if ([...(extensionTargets?.values() ?? [])].some(version => version > 0) &&
      targetVersion < coreMigrations.length) fail('INVALID_VERSION');
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, pg_catalog`);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schemaName]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      id text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS module_migrations (
      module_id text NOT NULL,
      version integer NOT NULL,
      id text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module_id, version),
      UNIQUE (module_id, id)
    )`);
    const coreResult = await client.query(
      'SELECT version, id, checksum FROM schema_migrations ORDER BY version',
    );
    const appliedCore = new Map((coreResult.rows ?? []).map(row => [Number(row.version), row]));
    const moduleResult = await client.query(
      'SELECT module_id, version, id, checksum FROM module_migrations ORDER BY module_id, version',
    );
    const appliedModules = new Map((moduleResult.rows ?? []).map(row =>
      [`${row.module_id}:${Number(row.version)}`, row]));
    for (const [version, row] of appliedCore) {
      const coreMigration = coreMigrations[version - 1];
      if (coreMigration?.id === row.id &&
          createHash('sha256').update(coreMigration.sql).digest('hex') === row.checksum) continue;
      const extension = extensions.find(migration => migration.version === version && migration.id === row.id);
      if (!extension || createHash('sha256').update(extension.sql).digest('hex') !== row.checksum) {
        fail('MIGRATION_HISTORY_MISMATCH');
      }
      await client.query(
        'INSERT INTO module_migrations (module_id, version, id, checksum) VALUES ($1, $2, $3, $4)',
        [extension.moduleId, extension.version, extension.id, row.checksum],
      );
      await client.query('DELETE FROM schema_migrations WHERE version = $1 AND id = $2', [version, row.id]);
      appliedModules.set(`${extension.moduleId}:${extension.version}`, {
        ...row,
        module_id: extension.moduleId,
      });
      appliedCore.delete(version);
    }
    for (const [key, row] of appliedModules) {
      const [moduleId, version] = key.split(':');
      const migration = extensions.find(entry => entry.moduleId === moduleId && entry.version === Number(version));
      if (!migration || migration.id !== row.id ||
          createHash('sha256').update(migration.sql).digest('hex') !== row.checksum) {
        fail('MIGRATION_HISTORY_MISMATCH');
      }
    }
    for (const migration of coreMigrations) {
      if (migration.version > targetVersion || appliedCore.has(migration.version)) continue;
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, id, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.id, checksum],
      );
      appliedCore.set(migration.version, {
        version: migration.version,
        id: migration.id,
        checksum,
      });
    }
    for (const migration of extensions) {
      const key = `${migration.moduleId}:${migration.version}`;
      if (appliedModules.has(key)) continue;
      const target = extensionTargets
        ? extensionTargets.get(migration.moduleId) ?? 0
        : targetVersion === coreMigrations.length
          ? Math.max(...extensions
            .filter(entry => entry.moduleId === migration.moduleId)
            .map(entry => entry.version))
          : 0;
      if (migration.version > target) continue;
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO module_migrations (module_id, version, id, checksum) VALUES ($1, $2, $3, $4)',
        [migration.moduleId, migration.version, migration.id, checksum],
      );
      appliedModules.set(key, {
        module_id: migration.moduleId,
        version: migration.version,
        id: migration.id,
        checksum,
      });
    }
    await client.query('COMMIT');
    return Object.freeze([
      ...coreMigrations
        .filter(migration => appliedCore.has(migration.version))
        .map(migration => Object.freeze({ version: migration.version, id: migration.id })),
      ...extensions
        .filter(migration => appliedModules.has(`${migration.moduleId}:${migration.version}`))
        .map(migration => Object.freeze({
          moduleId: migration.moduleId,
          version: migration.version,
          id: migration.id,
        })),
    ]);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        fail('UNAVAILABLE');
      }
    }
    if (error instanceof DatabaseModuleError) throw error;
    fail('MIGRATION_FAILED');
  } finally {
    client?.release();
  }
}

export async function seedSynthetic(pool, schemaName, options = {}) {
  exactKeys(options, ['tenantId'], []);
  const tenantId = options.tenantId ?? 'tenant_demo';
  if (typeof tenantId !== 'string' || !safeTextPattern.test(tenantId)) fail('INVALID_CONTEXT');
  return transaction(pool, schemaName, {
    contractVersion: 1,
    tenantId,
    requestId: 'synthetic-seed',
  }, async client => {
    const queries = [
      ['INSERT INTO organizations (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING',
        [tenantId, 'Synthetic Demo Organization']],
      ['INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        ['00000000-0000-4000-8000-000000000001', 'synthetic-user@example.invalid', 'Synthetic User']],
      ['INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [tenantId, '00000000-0000-4000-8000-000000000001', 'owner']],
    ];
    for (const [sql, parameters] of queries) await client.query(sql, parameters);
    return Object.freeze({ tenantId, synthetic: true });
  });
}

function validateAuditEvent(event) {
  const allowed = ['action', 'resourceType', 'resourceId', 'outcome', 'details'];
  if (event === null || typeof event !== 'object' || Array.isArray(event)) fail('INVALID_EVENT');
  const keys = Reflect.ownKeys(event);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      !Object.hasOwn(event, 'action') || !Object.hasOwn(event, 'resourceType') ||
      !Object.hasOwn(event, 'outcome')) fail('INVALID_EVENT');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(event, key);
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INVALID_EVENT');
  }
  for (const [field, value] of [['action', event.action], ['resourceType', event.resourceType]]) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,95}$/u.test(value)) fail('INVALID_EVENT');
  }
  if (event.resourceId !== undefined &&
      (typeof event.resourceId !== 'string' || !safeTextPattern.test(event.resourceId))) fail('INVALID_EVENT');
  if (!['success', 'denied', 'failure'].includes(event.outcome)) fail('INVALID_EVENT');
  const details = validateJson(event.details ?? {});
  const inspect = value => {
    if (typeof value === 'string' && secretPatterns.some(pattern => pattern.test(value))) fail('SENSITIVE_AUDIT_DATA');
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (sensitiveFieldPattern.test(key)) fail('SENSITIVE_AUDIT_DATA');
        inspect(nested);
      }
    }
  };
  inspect(details);
  return { details, resourceId: event.resourceId ?? null };
}

export function createDatabaseAdapter(configuration) {
  exactKeys(configuration, ['pool', 'schemaName']);
  const { pool, schemaName } = configuration;
  validatePool(pool);
  validateSchemaName(schemaName);
  return Object.freeze({
    async get(context, key) {
      const storageKey = validateKey(key);
      return transaction(pool, schemaName, context, async (client, tenant) => {
        const result = await client.query(
          'SELECT value, version FROM local_storage WHERE tenant_id = $1 AND key = $2',
          [tenant.tenantId, storageKey],
        );
        const row = result.rows?.[0];
        return row ? Object.freeze({ value: validateJson(row.value), version: Number(row.version) }) : undefined;
      });
    },
    async put(context, key, value, expectedVersion) {
      const storageKey = validateKey(key);
      const jsonValue = validateJson(value);
      const expected = validateExpectedVersion(expectedVersion);
      return transaction(pool, schemaName, context, async (client, tenant) => {
        const result = await client.query(
          `INSERT INTO local_storage (tenant_id, key, value, version)
           VALUES ($1, $2, $3::jsonb, 1)
           ON CONFLICT (tenant_id, key) DO UPDATE
           SET value = EXCLUDED.value, version = local_storage.version + 1
           WHERE $4::integer IS NULL OR local_storage.version = $4
           RETURNING version`,
          [tenant.tenantId, storageKey, JSON.stringify(jsonValue), expected],
        );
        if (!result.rows?.length) fail('CONFLICT');
        return Number(result.rows[0].version);
      });
    },
    async delete(context, key, expectedVersion) {
      const storageKey = validateKey(key);
      const expected = validateExpectedVersion(expectedVersion);
      return transaction(pool, schemaName, context, async (client, tenant) => {
        const result = await client.query(
          `DELETE FROM local_storage
           WHERE tenant_id = $1 AND key = $2 AND ($3::integer IS NULL OR version = $3)
           RETURNING key`,
          [tenant.tenantId, storageKey, expected],
        );
        if (result.rows?.length) return true;
        if (expected !== null) {
          const current = await client.query(
            'SELECT 1 FROM local_storage WHERE tenant_id = $1 AND key = $2',
            [tenant.tenantId, storageKey],
          );
          if (current.rows?.length) fail('CONFLICT');
        }
        return false;
      });
    },
    async append(context, event) {
      const audit = validateAuditEvent(event);
      return transaction(pool, schemaName, context, async (client, tenant) => {
        const result = await client.query(
          `INSERT INTO audit_events
            (tenant_id, request_id, action, resource_type, resource_id, outcome, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           RETURNING event_id, recorded_at`,
          [
            tenant.tenantId,
            tenant.requestId,
            event.action,
            event.resourceType,
            audit.resourceId,
            event.outcome,
            JSON.stringify(audit.details),
          ],
        );
        return Object.freeze({
          eventId: result.rows?.[0]?.event_id,
          recordedAt: result.rows?.[0]?.recorded_at,
        });
      });
    },
  });
}
