import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MODULE_VERSION = '1.0.0';
const CONTRACT_VERSION = 1;
const ARCHIVE_NAME = 'backup.pgdump';
const MANIFEST_NAME = 'manifest.json';
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const VERSIONED_ID = /^\d{4}_[a-z0-9_]{1,56}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export class DatabaseOperationsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DatabaseOperationsError';
    this.code = code;
  }
}

function fail(code) {
  throw new DatabaseOperationsError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_INPUT');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) ||
      ['information_schema', 'pg_catalog', 'public'].includes(value) || value.startsWith('pg_')) {
    fail('INVALID_INPUT');
  }
  return value;
}

function databaseName(value) {
  return identifier(value);
}

function validateConnection(value) {
  exactObject(value, ['host', 'port', 'user', 'password', 'database']);
  if (typeof value.host !== 'string' || !LOCAL_HOSTS.has(value.host) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.user !== 'string' || value.user.length < 1 || value.user.length > 63 ||
      !/^[A-Za-z0-9_.-]+$/u.test(value.user) ||
      typeof value.password !== 'string' || value.password.length > 1024 ||
      /[\0\r\n]/u.test(value.password)) {
    fail('INVALID_CONNECTION');
  }
  databaseName(value.database);
  return value;
}

function escapePassfile(value) {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

function connectionEnvironment(connection, passfile) {
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    PGPASSFILE: passfile,
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.user,
    PGCONNECT_TIMEOUT: '5',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function runProcess(command, args, { env, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        signal,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      reject(new DatabaseOperationsError('TOOL_FAILED'));
      return;
    }

    const stdout = [];
    let outputSize = 0;
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > 1024 * 1024) {
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.once('error', () => reject(new DatabaseOperationsError(
      signal?.aborted ? 'INTERRUPTED' : 'TOOL_FAILED',
    )));
    child.once('close', code => {
      if (signal?.aborted) {
        reject(new DatabaseOperationsError('INTERRUPTED'));
      } else if (outputSize > 1024 * 1024 || code !== 0) {
        reject(new DatabaseOperationsError('TOOL_FAILED'));
      } else {
        resolve(Buffer.concat(stdout).toString('utf8'));
      }
    });
  });
}

function runnerFor(runner) {
  if (runner === undefined) return runProcess;
  if (typeof runner !== 'function') fail('INVALID_INPUT');
  return runner;
}

function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
  return signal;
}

async function invoke(runner, command, args, options, interruptedCode = 'TOOL_FAILED') {
  try {
    return await runner(command, args, options);
  } catch {
    fail(options.signal?.aborted ? 'INTERRUPTED' : interruptedCode);
  }
}

async function validateAbsolutePath(target, { directory, requirePrivate = false } = {}) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096 ||
      !path.isAbsolute(target) || path.resolve(target) !== target ||
      /[\0-\x1f\x7f]/u.test(target) ||
      target.split(path.sep).some(part => part === '.' || part === '..')) {
    fail('INVALID_PATH');
  }

  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (directory === 'existing') fail('INVALID_PATH');
        continue;
      }
      fail('INVALID_PATH');
    }
    if (info.isSymbolicLink()) fail('INVALID_PATH');
  }

  let info;
  try {
    info = await lstat(target);
  } catch {
    if (directory === 'new') {
      const parent = path.dirname(target);
      try {
        const parentInfo = await lstat(parent);
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('INVALID_PATH');
      } catch {
        fail('INVALID_PATH');
      }
      return;
    }
    fail('INVALID_PATH');
  }
  if (directory === 'new') fail('DESTINATION_EXISTS');
  if (!info.isDirectory() || info.isSymbolicLink()) fail('INVALID_PATH');
  if (requirePrivate && (info.mode & 0o077) !== 0) fail('INVALID_PATH');
  const resolved = await realpath(target);
  if (resolved !== target) fail('INVALID_PATH');
}

function validateMigrations(migrations) {
  exactObject(migrations, ['core', 'modules']);
  if (!Array.isArray(migrations.core) || !Array.isArray(migrations.modules) ||
      migrations.core.length > 10000 || migrations.modules.length > 10000) {
    fail('INVALID_METADATA');
  }
  let previousVersion = 0;
  for (const row of migrations.core) {
    exactObject(row, ['version', 'id', 'checksum']);
    if (!Number.isSafeInteger(row.version) || row.version <= previousVersion ||
        typeof row.id !== 'string' || !VERSIONED_ID.test(row.id) ||
        !HASH.test(row.checksum)) {
      fail('INVALID_METADATA');
    }
    previousVersion = row.version;
  }
  let previousKey = '';
  for (const row of migrations.modules) {
    exactObject(row, ['moduleId', 'version', 'id', 'checksum']);
    if (typeof row.moduleId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(row.moduleId) ||
        !Number.isSafeInteger(row.version) || row.version < 1 ||
        typeof row.id !== 'string' || !VERSIONED_ID.test(row.id) ||
        !HASH.test(row.checksum)) {
      fail('INVALID_METADATA');
    }
    const key = `${row.moduleId}:${String(row.version).padStart(16, '0')}`;
    if (key <= previousKey) fail('INVALID_METADATA');
    previousKey = key;
  }
  return migrations;
}

function readMigrationQuery(schemaName) {
  return [
    'SELECT json_build_object(',
    "  'serverVersion', current_setting('server_version'),",
    "  'core', COALESCE((SELECT json_agg(json_build_object('version', version, 'id', id, 'checksum', checksum) ORDER BY version)",
    `    FROM "${schemaName}".schema_migrations), '[]'::json),`,
    "  'modules', COALESCE((SELECT json_agg(json_build_object('moduleId', module_id, 'version', version, 'id', id, 'checksum', checksum) ORDER BY module_id, version)",
    `    FROM "${schemaName}".module_migrations), '[]'::json)`,
    ')::text;',
  ].join('\n');
}

function validateMigrationSnapshot(value) {
  exactObject(value, ['serverVersion', 'core', 'modules']);
  if (typeof value.serverVersion !== 'string' || value.serverVersion.length > 64) {
    fail('INVALID_METADATA');
  }
  const migrations = validateMigrations({ core: value.core, modules: value.modules });
  return { serverVersion: value.serverVersion, ...migrations };
}

async function withPassfile(connection, callback) {
  let directory;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'sf-dbops-'));
    await chmod(directory, 0o700);
    const passfile = path.join(directory, 'pgpass');
    const file = await open(passfile, 'wx', 0o600);
    try {
      const line = [
        escapePassfile(connection.host),
        String(connection.port),
        '*',
        escapePassfile(connection.user),
        escapePassfile(connection.password),
      ].join(':') + '\n';
      await file.writeFile(line, { encoding: 'utf8' });
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(passfile, 0o600);
    return await callback(connectionEnvironment(connection, passfile));
  } catch (error) {
    if (error instanceof DatabaseOperationsError) throw error;
    fail('TOOL_FAILED');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function validateClock(clock) {
  if (clock === undefined) return new Date();
  if (typeof clock !== 'function') fail('INVALID_INPUT');
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_INPUT');
  return value;
}

async function writePrivateFile(filePath, contents) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function getArchiveInfo(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    fail('INVALID_BACKUP');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 ||
      (info.mode & 0o077) !== 0) {
    fail('INVALID_BACKUP');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return {
    file: ARCHIVE_NAME,
    sha256: hash.digest('hex'),
    size: info.size,
  };
}

function validateManifest(value) {
  exactObject(value, [
    'contractVersion',
    'moduleVersion',
    'createdAt',
    'format',
    'schemaName',
    'postgresVersion',
    'migrations',
    'archive',
  ]);
  if (value.contractVersion !== CONTRACT_VERSION || value.moduleVersion !== MODULE_VERSION ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      value.format !== 'postgres-custom' ||
      typeof value.schemaName !== 'string' || identifier(value.schemaName) !== value.schemaName ||
      typeof value.postgresVersion !== 'string' || value.postgresVersion.length > 64) {
    fail('INCOMPATIBLE_BACKUP');
  }
  validateMigrations(value.migrations);
  exactObject(value.archive, ['file', 'sha256', 'size']);
  if (value.archive.file !== ARCHIVE_NAME || !HASH.test(value.archive.sha256) ||
      !Number.isSafeInteger(value.archive.size) || value.archive.size < 1) {
    fail('INVALID_METADATA');
  }
  return value;
}

async function loadBackup(backupDirectory) {
  await validateAbsolutePath(backupDirectory, { directory: 'existing', requirePrivate: true });
  const manifestPath = path.join(backupDirectory, MANIFEST_NAME);
  const archivePath = path.join(backupDirectory, ARCHIVE_NAME);
  for (const filePath of [manifestPath, archivePath]) {
    const info = await lstat(filePath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      fail('INVALID_BACKUP');
    }
  }
  const manifestInfo = await stat(manifestPath);
  if (manifestInfo.size > 1024 * 1024) fail('INVALID_BACKUP');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch (error) {
    if (error instanceof DatabaseOperationsError) throw error;
    fail('INVALID_BACKUP');
  }
  const archive = await getArchiveInfo(archivePath);
  if (archive.size !== manifest.archive.size || archive.sha256 !== manifest.archive.sha256) {
    fail('BACKUP_INTEGRITY_FAILED');
  }
  return { manifest, archivePath };
}

async function runTool(runner, command, args, options, failureCode = 'TOOL_FAILED') {
  return invoke(runner, command, args, options, failureCode);
}

export async function createBackup(input) {
  exactObject(input, ['connection', 'schemaName', 'destination', 'signal', 'runner', 'clock'],
    ['connection', 'schemaName', 'destination']);
  const connection = validateConnection(input.connection);
  const schemaName = identifier(input.schemaName);
  const runner = runnerFor(input.runner);
  const signal = validateSignal(input.signal);
  const destination = input.destination;
  await validateAbsolutePath(destination, { directory: 'new' });

  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    fail(error.code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'BACKUP_FAILED');
  }
  const archivePath = path.join(destination, ARCHIVE_NAME);
  try {
    await chmod(destination, 0o700);
    await withPassfile(connection, async env => {
      const query = readMigrationQuery(schemaName);
      const readSnapshot = async () => {
        const result = await runTool(runner, 'psql', [
          '-X', '-A', '-t', '--set=ON_ERROR_STOP=1',
          '--host', connection.host,
          '--port', String(connection.port),
          '--username', connection.user,
          '--dbname', connection.database,
          '--command', query,
        ], { env, signal });
        try {
          return validateMigrationSnapshot(JSON.parse(result.trim()));
        } catch (error) {
          if (error instanceof DatabaseOperationsError) throw error;
          fail('INVALID_METADATA');
        }
      };
      const snapshot = await readSnapshot();

      await writePrivateFile(archivePath, '');
      await runTool(runner, 'pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        `--schema=${schemaName}`,
        `--file=${archivePath}`,
        '--host', connection.host,
        '--port', String(connection.port),
        '--username', connection.user,
        '--dbname', connection.database,
      ], { env, signal }, 'BACKUP_FAILED');
      const afterDump = await readSnapshot();
      if (JSON.stringify(snapshot) !== JSON.stringify(afterDump)) fail('MIGRATIONS_CHANGED');
      const archive = await getArchiveInfo(archivePath);
      const manifest = {
        contractVersion: CONTRACT_VERSION,
        moduleVersion: MODULE_VERSION,
        createdAt: validateClock(input.clock).toISOString(),
        format: 'postgres-custom',
        schemaName,
        postgresVersion: snapshot.serverVersion,
        migrations: { core: snapshot.core, modules: snapshot.modules },
        archive,
      };
      validateManifest(manifest);
      await writePrivateFile(path.join(destination, MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`);
    });
    return {
      destination,
      schemaName,
      contractVersion: CONTRACT_VERSION,
      moduleVersion: MODULE_VERSION,
      sha256: (await loadBackup(destination)).manifest.archive.sha256,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    if (error instanceof DatabaseOperationsError) throw error;
    fail(signal?.aborted ? 'INTERRUPTED' : 'BACKUP_FAILED');
  }
}

export async function restoreBackup(input) {
  exactObject(input, ['connection', 'backupDirectory', 'targetDatabase', 'signal', 'runner'],
    ['connection', 'backupDirectory', 'targetDatabase']);
  const connection = validateConnection(input.connection);
  const targetDatabase = databaseName(input.targetDatabase);
  if (targetDatabase === connection.database) fail('INVALID_INPUT');
  const runner = runnerFor(input.runner);
  const signal = validateSignal(input.signal);
  const { manifest, archivePath } = await loadBackup(input.backupDirectory);

  return withPassfile(connection, async env => {
    await runTool(runner, 'pg_restore', ['--list', archivePath], { env, signal }, 'INVALID_BACKUP');
    await runTool(runner, 'createdb', [
      '--host', connection.host,
      '--port', String(connection.port),
      '--username', connection.user,
      '--maintenance-db', connection.database,
      targetDatabase,
    ], { env, signal }, 'RESTORE_FAILED');
    await runTool(runner, 'pg_restore', [
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--single-transaction',
      '--host', connection.host,
      '--port', String(connection.port),
      '--username', connection.user,
      '--dbname', targetDatabase,
      archivePath,
    ], { env, signal }, 'RESTORE_FAILED');
    return {
      targetDatabase,
      schemaName: manifest.schemaName,
      contractVersion: manifest.contractVersion,
      moduleVersion: manifest.moduleVersion,
      migrations: manifest.migrations,
      sha256: manifest.archive.sha256,
    };
  });
}

export const DATABASE_OPERATIONS_CONTRACT_VERSION = CONTRACT_VERSION;
export const DATABASE_OPERATIONS_MODULE_VERSION = MODULE_VERSION;
