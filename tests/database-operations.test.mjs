import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBackup,
  DatabaseOperationsError,
  DATABASE_OPERATIONS_CONTRACT_VERSION,
  DATABASE_OPERATIONS_MODULE_VERSION,
  restoreBackup,
} from '../modules/database-operations/index.mjs';

const connection = {
  host: '127.0.0.1',
  port: 55432,
  user: 'factory_test',
  password: 'synthetic-only-password',
  database: 'factory_test',
};

function localPostgresConnection() {
  if (!process.env.DATABASE_URL) return null;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '::1'].includes(host) ||
        url.pathname.length < 2 || url.search || url.hash) return null;
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(database) ||
        !/^[A-Za-z0-9_.-]{1,63}$/u.test(user)) return null;
    return {
      host,
      port: url.port ? Number(url.port) : 5432,
      user,
      password: decodeURIComponent(url.password) || process.env.PGPASSWORD ||
        process.env.POSTGRES_PASSWORD || '',
      database,
    };
  } catch {
    return null;
  }
}

const localDatabaseConnection = localPostgresConnection();
const postgresToolsAvailable = ['psql', 'pg_dump', 'pg_restore', 'createdb', 'dropdb']
  .every(command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);

const migrations = {
  serverVersion: '16.15',
  core: [
    { version: 1, id: '0001_identity_audit', checksum: 'a'.repeat(64) },
    { version: 2, id: '0002_tenant_storage', checksum: 'b'.repeat(64) },
  ],
  modules: [
    {
      moduleId: 'local-search',
      version: 1,
      id: '0001_search_data',
      checksum: 'c'.repeat(64),
    },
  ],
};

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'database-operations-test-'));
}

function fakeRunner({ onCommand } = {}) {
  const calls = [];
  const createdDatabases = new Set();
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    const passfile = await readFile(options.env.PGPASSFILE, 'utf8');
    assert.match(passfile, /synthetic-only-password/u);
    if (onCommand) {
      const result = await onCommand({ command, args, options, calls, createdDatabases });
      if (result !== undefined) return result;
    }
    if (command === 'psql') return `${JSON.stringify(migrations)}\n`;
    if (command === 'pg_dump') {
      const file = args.find(arg => arg.startsWith('--file=')).slice('--file='.length);
      await writeFile(file, 'synthetic PostgreSQL custom archive');
    }
    if (command === 'createdb') {
      const database = args.at(-1);
      if (createdDatabases.has(database)) throw new Error('database already exists');
      createdDatabases.add(database);
    }
    return '';
  };
  return { runner, calls, createdDatabases };
}

async function backupAt(root, name = 'backup') {
  const destination = path.join(root, name);
  const { runner, calls } = fakeRunner();
  const result = await createBackup({
    connection,
    schemaName: 'atelier_app',
    destination,
    runner,
    clock: () => new Date('2026-11-09T15:00:00.000Z'),
  });
  return { destination, result, calls };
}

function expectCode(callback, code) {
  return assert.rejects(callback, error =>
    error instanceof DatabaseOperationsError && error.code === code);
}

test('creates a private versioned backup with migration and archive integrity metadata', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { destination, result, calls } = await backupAt(root);
  const manifestText = await readFile(path.join(destination, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const directoryInfo = await realpath(destination);
  assert.equal(directoryInfo, destination);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(destination, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(destination, 'backup.pgdump'))).mode & 0o777, 0o600);
  assert.equal(result.contractVersion, DATABASE_OPERATIONS_CONTRACT_VERSION);
  assert.equal(result.moduleVersion, DATABASE_OPERATIONS_MODULE_VERSION);
  assert.deepEqual(manifest.migrations, {
    core: migrations.core,
    modules: migrations.modules,
  });
  assert.equal(manifest.schemaName, 'atelier_app');
  assert.equal(manifest.postgresVersion, '16.15');
  assert.equal(manifest.archive.size, Buffer.byteLength('synthetic PostgreSQL custom archive'));
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(calls.some(call => call.command === 'pg_dump' &&
    call.args.includes('--format=custom') && call.args.includes('--no-owner') &&
    call.args.includes('--no-acl')));
  assert.ok(calls.every(call => !call.args.includes(connection.password)));
  assert.ok(calls.every(call => !Object.values(call.env).includes(connection.password)));
  assert.ok(!manifestText.includes(connection.password));
});

test('restores into a new database without clean, ownership changes, or overwrite behavior', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { destination } = await backupAt(root);
  const { runner, calls, createdDatabases } = fakeRunner();
  const restored = await restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: 'restore_test',
    runner,
  });

  assert.equal(restored.targetDatabase, 'restore_test');
  assert.equal(restored.schemaName, 'atelier_app');
  assert.deepEqual(restored.migrations.core, migrations.core);
  assert.ok(createdDatabases.has('restore_test'));
  const restore = calls.find(call => call.command === 'pg_restore' &&
    call.args.includes('--exit-on-error'));
  assert.ok(restore);
  assert.ok(restore.args.includes('--single-transaction'));
  assert.ok(restore.args.includes('--no-owner'));
  assert.ok(restore.args.includes('--no-acl'));
  assert.ok(!restore.args.includes('--clean'));
  assert.ok(!calls.some(call => /dropdb|DROP DATABASE/iu.test(`${call.command} ${call.args.join(' ')}`)));

  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: 'restore_test',
    runner,
  }), 'RESTORE_FAILED');
});

test('rejects corrupted, incompatible, incomplete, and broadly permissioned backups before restore', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { destination } = await backupAt(root);
  const archive = path.join(destination, 'backup.pgdump');
  await writeFile(archive, 'corrupted archive');
  const attempted = fakeRunner();
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: 'restore_corrupt',
    runner: attempted.runner,
  }), 'BACKUP_INTEGRITY_FAILED');
  assert.equal(attempted.calls.length, 0);

  await writeFile(archive, 'synthetic PostgreSQL custom archive');
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.contractVersion = 2;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await chmod(manifestPath, 0o600);
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: 'restore_incompatible',
    runner: attempted.runner,
  }), 'INCOMPATIBLE_BACKUP');

  manifest.contractVersion = DATABASE_OPERATIONS_CONTRACT_VERSION;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await chmod(manifestPath, 0o644);
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: 'restore_perms',
    runner: attempted.runner,
  }), 'INVALID_BACKUP');
  assert.equal(attempted.calls.length, 0);
});

test('refuses existing destinations, symlinks, remote hosts, unknown input, and same-database restores', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { destination } = await backupAt(root);
  const existing = fakeRunner();
  await expectCode(() => createBackup({
    connection,
    schemaName: 'atelier_app',
    destination,
    runner: existing.runner,
  }), 'DESTINATION_EXISTS');

  const linkedPath = path.join(root, 'linked-backup');
  await symlink(destination, linkedPath);
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: linkedPath,
    targetDatabase: 'restore_link',
    runner: existing.runner,
  }), 'INVALID_PATH');
  await expectCode(() => createBackup({
    connection: { ...connection, host: 'db.example.invalid' },
    schemaName: 'atelier_app',
    destination: path.join(root, 'remote-backup'),
    runner: existing.runner,
  }), 'INVALID_CONNECTION');
  await expectCode(() => createBackup({
    connection,
    schemaName: 'atelier_app',
    destination: path.join(root, 'unknown-field'),
    unexpected: true,
    runner: existing.runner,
  }), 'INVALID_INPUT');
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory: destination,
    targetDatabase: connection.database,
    runner: existing.runner,
  }), 'INVALID_INPUT');
  assert.equal(existing.calls.length, 0);
});

test('removes partial backups on interruption and leaves an interrupted restore database intact', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'interrupted-backup');
  const backupController = new AbortController();
  const { runner: interruptedBackup } = fakeRunner({
    onCommand: async ({ command }) => {
      if (command === 'pg_dump') {
        backupController.abort();
        throw new Error('interrupted');
      }
      return undefined;
    },
  });
  await expectCode(() => createBackup({
    connection,
    schemaName: 'atelier_app',
    destination,
    signal: backupController.signal,
    runner: interruptedBackup,
  }), 'INTERRUPTED');
  await assert.rejects(lstat(destination), { code: 'ENOENT' });

  const { destination: backupDirectory } = await backupAt(root, 'complete-backup');
  const restoreController = new AbortController();
  const interruptedRestore = fakeRunner();
  const runner = async (command, args, options) => {
    if (command === 'pg_restore' && args.includes('--exit-on-error')) {
      restoreController.abort();
      throw new Error('interrupted');
    }
    return interruptedRestore.runner(command, args, options);
  };
  await expectCode(() => restoreBackup({
    connection,
    backupDirectory,
    targetDatabase: 'restore_interrupted',
    signal: restoreController.signal,
    runner,
  }), 'INTERRUPTED');
  assert.ok(interruptedRestore.createdDatabases.has('restore_interrupted'));
  assert.ok(!interruptedRestore.calls.some(call => call.command === 'dropdb'));
});

test('cleans up a backup when migration-version metadata is invalid', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'invalid-migrations');
  const { runner } = fakeRunner({
    onCommand: async ({ command }) => {
      if (command === 'psql') {
        return JSON.stringify({
          ...migrations,
          core: [{ version: 2, id: '0001_identity_audit', checksum: 'not-a-checksum' }],
        });
      }
      return '';
    },
  });
  await expectCode(() => createBackup({
    connection,
    schemaName: 'atelier_app',
    destination,
    runner,
  }), 'INVALID_METADATA');
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('rejects a migration history change during the dump', async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'changed-migrations');
  let snapshots = 0;
  const { runner } = fakeRunner({
    onCommand: async ({ command }) => {
      if (command === 'psql' && ++snapshots === 2) {
        return JSON.stringify({
          ...migrations,
          core: [...migrations.core, {
            version: 3,
            id: '0003_changed_history',
            checksum: 'd'.repeat(64),
          }],
        });
      }
      return undefined;
    },
  });
  await expectCode(() => createBackup({
    connection,
    schemaName: 'atelier_app',
    destination,
    runner,
  }), 'MIGRATIONS_CHANGED');
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('local PostgreSQL synthetic dump restores data and migration history', {
  skip: !localDatabaseConnection
    ? 'Set DATABASE_URL to a disposable local PostgreSQL database.'
    : !postgresToolsAvailable
      ? 'Install PostgreSQL client tools for the local integration test.'
      : false,
}, async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const suffix = randomUUID().replaceAll('-', '');
  const schemaName = `sf_backup_${suffix}`;
  const targetDatabase = `sf_restore_${suffix}`;
  const env = {
    PATH: process.env.PATH ?? '',
    PGHOST: localDatabaseConnection.host,
    PGPORT: String(localDatabaseConnection.port),
    PGUSER: localDatabaseConnection.user,
    PGPASSWORD: localDatabaseConnection.password,
    PGCONNECT_TIMEOUT: '5',
  };
  const psql = (database, sql) => {
    const result = spawnSync('psql', [
      '-X', '-A', '-t', '--set=ON_ERROR_STOP=1',
      '--host', localDatabaseConnection.host,
      '--port', String(localDatabaseConnection.port),
      '--username', localDatabaseConnection.user,
      '--dbname', database,
      '--command', sql,
    ], { env, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'local PostgreSQL command could not start');
    assert.equal(result.status, 0, 'local PostgreSQL command failed');
    return result.stdout.trim();
  };
  const cleanupDatabase = () => {
    const result = spawnSync('dropdb', [
      '--if-exists',
      '--host', localDatabaseConnection.host,
      '--port', String(localDatabaseConnection.port),
      '--username', localDatabaseConnection.user,
      '--maintenance-db', localDatabaseConnection.database,
      targetDatabase,
    ], { env, stdio: 'ignore' });
    assert.equal(result.status, 0, 'isolated test database cleanup failed');
  };

  try {
    psql(localDatabaseConnection.database, `
      CREATE SCHEMA "${schemaName}";
      CREATE TABLE "${schemaName}".schema_migrations (
        version integer PRIMARY KEY, id text NOT NULL, checksum text NOT NULL
      );
      INSERT INTO "${schemaName}".schema_migrations VALUES
        (1, '0001_identity_audit', '${'a'.repeat(64)}'),
        (2, '0002_tenant_storage', '${'b'.repeat(64)}');
      CREATE TABLE "${schemaName}".module_migrations (
        module_id text NOT NULL, version integer NOT NULL, id text NOT NULL,
        checksum text NOT NULL, PRIMARY KEY (module_id, version)
      );
      INSERT INTO "${schemaName}".module_migrations VALUES
        ('local-search', 1, '0001_search_data', '${'c'.repeat(64)}');
      CREATE TABLE "${schemaName}".synthetic_records (
        id integer PRIMARY KEY, payload text NOT NULL
      );
      INSERT INTO "${schemaName}".synthetic_records VALUES (1, 'synthetic-only');
    `);
    const backupDirectory = path.join(root, 'postgres-backup');
    await createBackup({
      connection: localDatabaseConnection,
      schemaName,
      destination: backupDirectory,
    });
    const restored = await restoreBackup({
      connection: localDatabaseConnection,
      backupDirectory,
      targetDatabase,
    });
    assert.equal(restored.targetDatabase, targetDatabase);
    assert.equal(psql(targetDatabase,
      `SELECT payload || ':' || (SELECT max(version)::text FROM "${schemaName}".schema_migrations)
       FROM "${schemaName}".synthetic_records WHERE id = 1;`), 'synthetic-only:2');
    assert.equal(psql(targetDatabase,
      `SELECT module_id || ':' || version::text FROM "${schemaName}".module_migrations;`),
    'local-search:1');
  } finally {
    cleanupDatabase();
    psql(localDatabaseConnection.database, `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  }
});
