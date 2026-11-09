import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const INDEX_NAME = 'metadata-v1.json';
const INDEX_FIELDS = ['contractVersion', 'items'];
const ITEM_FIELDS = ['id', 'tenantId', 'sha256', 'size', 'contentType', 'createdAt', 'expiresAt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxUploadBytes: 10 * 1024 * 1024,
  maxTenantBytes: 100 * 1024 * 1024,
  maxTenantFiles: 1000,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxStorageFiles: 10000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  temporaryTtlMs: 60 * 60 * 1000,
  quarantineTtlMs: 24 * 60 * 60 * 1000,
  maxQuarantineBytes: 64 * 1024 * 1024,
  maxQuarantineFiles: 100,
  uploadTimeoutMs: 5 * 60 * 1000,
  lockWaitMs: 5000,
  maxMetadataBytes: 16 * 1024 * 1024,
});
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export class PrivateStorageError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrivateStorageError';
    this.code = code;
  }
}

function fail(code) {
  throw new PrivateStorageError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
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

function uuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
}

function validSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
  return signal;
}

function clockValue(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('UNAVAILABLE');
  return value;
}

function validateLimits(value = {}) {
  exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...value };
  for (const [key, number] of Object.entries(limits)) {
    if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_CONFIGURATION');
    const maximum = key === 'maxUploadBytes' ? 20 * 1024 * 1024 :
      key === 'maxTenantBytes' ? 10 * 1024 * 1024 * 1024 :
        key === 'maxStorageBytes' || key === 'maxQuarantineBytes' ? 100 * 1024 * 1024 * 1024 :
          key === 'maxTenantFiles' || key === 'maxStorageFiles' || key === 'maxQuarantineFiles' ? 100000 :
            key === 'retentionMs' || key === 'temporaryTtlMs' || key === 'quarantineTtlMs' ? 365 * 24 * 60 * 60 * 1000 :
              key === 'uploadTimeoutMs' || key === 'lockWaitMs' ? 60 * 60 * 1000 :
                64 * 1024 * 1024;
    if (number > maximum) fail('INVALID_CONFIGURATION');
  }
  if (limits.maxTenantBytes > limits.maxStorageBytes ||
      limits.maxTenantFiles > limits.maxStorageFiles ||
      limits.maxUploadBytes > limits.maxTenantBytes ||
      limits.temporaryTtlMs <= limits.uploadTimeoutMs + 1000) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

async function assertNoSymlinkPath(target, { allowMissingFinal = false } = {}) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096 ||
      !path.isAbsolute(target) || path.resolve(target) !== target ||
      /[\0-\x1f\x7f]/u.test(target) ||
      target.split(path.sep).some(part => part === '.' || part === '..')) {
    fail('INVALID_PATH');
  }
  const parsed = path.parse(target);
  let current = parsed.root;
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissingFinal && index === parts.length - 1) return;
      fail('INVALID_PATH');
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      fail('INVALID_PATH');
    }
  }
}

async function privateDirectory(directory, { create = false } = {}) {
  await assertNoSymlinkPath(directory, { allowMissingFinal: create });
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) fail('UNSAFE_STORAGE');
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch {
      fail('UNSAFE_STORAGE');
    }
    info = await lstat(directory);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE');
  }
}

async function ensureChildDirectory(parent, name) {
  const target = path.join(parent, name);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail('UNSAFE_STORAGE');
  }
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail('UNSAFE_STORAGE');
  }
  return target;
}

function crc32(parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buffer, maxUploadBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 25 ||
      buffer.length > maxUploadBytes || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('INVALID_FILE');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette;
  let seenIdat = false;
  let endedIdat = false;
  let seenEnd = false;
  const compressed = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('INVALID_FILE');
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) fail('INVALID_FILE');
    const typeBuffer = buffer.subarray(offset + 4, offset + 8);
    const type = typeBuffer.toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkData = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32([typeBuffer, chunkData]) !== expectedCrc) fail('INVALID_FILE');

    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) fail('INVALID_FILE');
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      if (width < 1 || height < 1 || width > 4096 || height > 4096 ||
          chunkData[10] !== 0 || chunkData[11] !== 0 || chunkData[12] !== 0) {
        fail('INVALID_FILE');
      }
      const allowedDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!allowedDepths[colorType]?.includes(bitDepth)) fail('INVALID_FILE');
    } else if (type === 'PLTE') {
      if (seenIdat || palette || length < 3 || length > 768 || length % 3 !== 0 ||
          colorType === 0 || colorType === 4 ||
          (colorType === 3 && length / 3 > 2 ** bitDepth)) {
        fail('INVALID_FILE');
      }
      palette = chunkData;
    } else if (type === 'IDAT') {
      if (endedIdat || (colorType === 3 && !palette)) fail('INVALID_FILE');
      seenIdat = true;
      compressed.push(chunkData);
    } else if (type === 'IEND') {
      if (!seenIdat || length !== 0 || seenEnd) fail('INVALID_FILE');
      seenEnd = true;
      offset = dataEnd + 4;
      if (offset !== buffer.length) fail('INVALID_FILE');
      break;
    } else {
      fail('INVALID_FILE');
    }

    if (seenIdat && type !== 'IDAT') endedIdat = true;
    offset = dataEnd + 4;
  }
  if (!seenEnd || compressed.length === 0 ||
      ([2, 6].includes(colorType) && palette && palette.length > 768)) {
    fail('INVALID_FILE');
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil(width * bitsPerPixel / 8);
  const decodedSize = height * (rowBytes + 1);
  if (!Number.isSafeInteger(decodedSize) || decodedSize > MAX_DECODED_BYTES) fail('INVALID_FILE');
  const filterBytes = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: decodedSize + 1 });
  } catch {
    fail('INVALID_FILE');
  }
  if (decoded.length !== decodedSize) fail('INVALID_FILE');
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[row * (rowBytes + 1)];
    if (filter > 4 || filterBytes < 1) fail('INVALID_FILE');
  }
  return 'image/png';
}

function validateFilename(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 ||
      /[\u0000-\u001f\u007f/\\]/u.test(value) || value === '.' || value === '..' ||
      value.includes('..') || /[\u2044\u2215\u29f8\uff0f\uff3c]/u.test(value)) {
    fail('INVALID_FILENAME');
  }
  return value;
}

function publicMetadata(item) {
  return Object.freeze({
    id: item.id,
    size: item.size,
    contentType: item.contentType,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  });
}

function validateItem(value, id) {
  exactObject(value, ITEM_FIELDS);
  if (value.id !== id || !UUID.test(value.id) || !UUID.test(value.tenantId) ||
      !HASH.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 ||
      value.contentType !== 'image/png' ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.createdAt) {
    fail('CORRUPT_INDEX');
  }
  return value;
}

function validateIndex(value, limits) {
  exactObject(value, INDEX_FIELDS);
  if (value.contractVersion !== CONTRACT_VERSION || value.items === null ||
      typeof value.items !== 'object' || Array.isArray(value.items) ||
      Object.keys(value.items).length > limits.maxStorageFiles) {
    fail('CORRUPT_INDEX');
  }
  const items = new Map();
  let totalBytes = 0;
  for (const [id, item] of Object.entries(value.items)) {
    if (!UUID.test(id)) fail('CORRUPT_INDEX');
    const checked = validateItem(item, id);
    totalBytes += checked.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxStorageBytes) {
      fail('CORRUPT_INDEX');
    }
    items.set(id, checked);
  }
  return items;
}

function validateTenantContext(value) {
  exactObject(value, ['contractVersion', 'tenantId', 'requestId']);
  if (value.contractVersion !== 1 || !UUID.test(value.tenantId) ||
      typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) {
    fail('INVALID_TENANT_CONTEXT');
  }
  return Object.freeze({
    contractVersion: 1,
    tenantId: value.tenantId.toLowerCase(),
    requestId: value.requestId,
  });
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readPrivateFile(filePath, { maxBytes, minimumBytes = 1 } = {}) {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 ||
        info.size < minimumBytes || info.size > maxBytes) {
      fail('UNSAFE_STORAGE');
    }
    return await file.readFile();
  } catch (error) {
    if (error instanceof PrivateStorageError) throw error;
    fail('UNSAFE_STORAGE');
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function createPrivateStorageService(options) {
  exactObject(options, ['directory', 'tenancy', 'audit', 'limits', 'clock'],
    ['directory', 'tenancy', 'audit']);
  const directory = options.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory) fail('INVALID_PATH');
  if (!options.tenancy || typeof options.tenancy.resolveTenantContext !== 'function' ||
      !options.audit || typeof options.audit.append !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(options.limits);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  await privateDirectory(directory, { create: true });
  const objectsDirectory = await ensureChildDirectory(directory, 'objects');
  const temporaryDirectory = await ensureChildDirectory(directory, 'temporary');
  const quarantineDirectory = await ensureChildDirectory(directory, 'quarantine');
  const indexPath = path.join(directory, INDEX_NAME);
  try {
    const indexHandle = await open(indexPath, 'wx', 0o600);
    try {
      await indexHandle.writeFile(JSON.stringify({ contractVersion: CONTRACT_VERSION, items: {} }));
      await indexHandle.sync();
    } finally {
      await indexHandle.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') fail('UNSAFE_STORAGE');
  }

  const lockPath = path.join(directory, 'metadata-v1.lock');

  async function resolveContext(input) {
    if (!UUID.test(input.tenantId) || typeof input.requestId !== 'string' ||
        !REQUEST_ID.test(input.requestId) || typeof input.cookieHeader !== 'string' ||
        input.cookieHeader.length > 8192) {
      fail('INVALID_INPUT');
    }
    let context;
    try {
      context = await options.tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    const verified = validateTenantContext(context);
    if (verified.tenantId !== input.tenantId.toLowerCase() ||
        verified.requestId !== input.requestId) {
      fail('TENANT_ACCESS_DENIED');
    }
    return verified;
  }

  async function recordAudit(context, type, fields = {}) {
    try {
      await options.audit.append(context, Object.freeze({ type, ...fields }));
    } catch {
      fail('AUDIT_UNAVAILABLE');
    }
  }

  async function readIndex() {
    const serialized = await readPrivateFile(indexPath, {
      maxBytes: limits.maxMetadataBytes,
      minimumBytes: 2,
    });
    let parsed;
    try {
      parsed = JSON.parse(serialized.toString('utf8'));
    } catch {
      fail('CORRUPT_INDEX');
    }
    try {
      return validateIndex(parsed, limits);
    } catch {
      fail('CORRUPT_INDEX');
    }
  }

  async function writeIndex(items) {
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.index`);
    const serialized = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      items: Object.fromEntries(items),
    });
    if (Buffer.byteLength(serialized, 'utf8') > limits.maxMetadataBytes) fail('STORAGE_LIMIT');
    let file;
    try {
      file = await open(temporaryPath, 'wx', 0o600);
      await file.writeFile(serialized);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, indexPath);
      await chmod(indexPath, 0o600);
    } catch {
      await file?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      fail('STORAGE_UNAVAILABLE');
    }
  }

  async function withLock(callback) {
    const started = Date.now();
    let lock;
    while (!lock) {
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
        const info = await lstat(lockPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
          fail('UNSAFE_STORAGE');
        }
        if (Date.now() - started >= limits.lockWaitMs) fail('STORAGE_BUSY');
        await delay(10);
      }
    }
    const identity = await lock.stat();
    try {
      return await callback();
    } finally {
      await lock.close().catch(() => {});
      const current = await lstat(lockPath).catch(() => null);
      if (current && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(lockPath).catch(() => {});
      }
    }
  }

  function objectDirectory(tenantId) {
    return path.join(objectsDirectory, tenantId);
  }

  function objectPath(item) {
    return path.join(objectDirectory(item.tenantId), `${item.id}.png`);
  }

  async function ensureTenantDirectory(tenantId) {
    const target = objectDirectory(tenantId);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') fail('STORAGE_UNAVAILABLE');
    }
    const info = await lstat(target).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      fail('UNSAFE_STORAGE');
    }
    return target;
  }

  async function validateStoredFile(item) {
    const objectsInfo = await lstat(objectsDirectory).catch(() => null);
    const tenantInfo = await lstat(objectDirectory(item.tenantId)).catch(() => null);
    if (!objectsInfo?.isDirectory() || objectsInfo.isSymbolicLink() ||
        (objectsInfo.mode & 0o077) !== 0 ||
        !tenantInfo?.isDirectory() || tenantInfo.isSymbolicLink() ||
        (tenantInfo.mode & 0o077) !== 0) {
      fail('UNSAFE_STORAGE');
    }
    const buffer = await readPrivateFile(objectPath(item), {
      maxBytes: limits.maxUploadBytes,
      minimumBytes: 1,
    });
    if (buffer.length !== item.size || hash(buffer) !== item.sha256 ||
        validatePng(buffer, limits.maxUploadBytes) !== item.contentType) {
      fail('CORRUPT_STORAGE');
    }
    return buffer;
  }

  async function quarantineUpload(temporaryPath) {
    return withLock(async () => {
      const entries = await readdir(quarantineDirectory);
      let totalBytes = 0;
      let totalFiles = 0;
      for (const entry of entries) {
        if (!UUID.test(entry.replace(/\.quarantine$/u, '')) || !entry.endsWith('.quarantine')) {
          fail('UNSAFE_STORAGE');
        }
        const info = await lstat(path.join(quarantineDirectory, entry));
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
          fail('UNSAFE_STORAGE');
        }
        totalBytes += info.size;
        totalFiles += 1;
      }
      const info = await lstat(temporaryPath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) return false;
      if (totalFiles >= limits.maxQuarantineFiles ||
          totalBytes + info.size > limits.maxQuarantineBytes) {
        await unlink(temporaryPath).catch(() => {});
        return false;
      }
      await rename(temporaryPath, path.join(quarantineDirectory, `${randomUUID()}.quarantine`));
      return true;
    });
  }

  async function cleanupDirectory(target, suffixes, cutoff) {
    let deleted = 0;
    for (const entry of await readdir(target)) {
      const match = /^([0-9a-f-]{36})(\.(?:upload|index|deleted|quarantine))$/u.exec(entry);
      if (!match || !UUID.test(match[1]) || !suffixes.includes(match[2])) fail('UNSAFE_STORAGE');
      const entryPath = path.join(target, entry);
      const info = await lstat(entryPath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        fail('UNSAFE_STORAGE');
      }
      if (info.mtimeMs <= cutoff) {
        await unlink(entryPath);
        deleted += 1;
      }
    }
    return deleted;
  }

  async function cleanTemporaryFiles(now) {
    return withLock(async () => {
      const temporary = await cleanupDirectory(temporaryDirectory,
        ['.upload', '.index', '.deleted'], now - limits.temporaryTtlMs);
      const quarantined = await cleanupDirectory(quarantineDirectory,
        ['.quarantine'], now - limits.quarantineTtlMs);
      return temporary + quarantined;
    });
  }

  async function upload(input) {
    exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'fileName', 'contentType', 'stream', 'signal',
    ], ['cookieHeader', 'tenantId', 'requestId', 'fileName', 'contentType', 'stream']);
    const context = await resolveContext(input);
    validateFilename(input.fileName);
    if (typeof input.contentType !== 'string' || input.contentType.length > 128 ||
        !(input.stream instanceof Readable)) {
      fail('INVALID_INPUT');
    }
    const signal = validSignal(input.signal);
    await recordAudit(context, 'storage.upload.requested');
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.upload`);
    const contentHash = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > limits.maxUploadBytes) {
          callback(new PrivateStorageError('FILE_TOO_LARGE'));
          return;
        }
        contentHash.update(chunk);
        callback(null, chunk);
      },
    });
    const timeoutSignal = AbortSignal.timeout(limits.uploadTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      await pipeline(input.stream, counter,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
        { signal: combinedSignal });
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      if (signal?.aborted) fail('INTERRUPTED');
      if (timeoutSignal.aborted) fail('UPLOAD_TIMEOUT');
      if (error instanceof PrivateStorageError) throw error;
      fail('UPLOAD_FAILED');
    }

    let buffer;
    try {
      buffer = await readPrivateFile(temporaryPath, {
        maxBytes: limits.maxUploadBytes,
        minimumBytes: 1,
      });
      if (buffer.length !== size) fail('UPLOAD_FAILED');
      const detectedType = validatePng(buffer, limits.maxUploadBytes);
      if (detectedType !== input.contentType) fail('CONTENT_TYPE_MISMATCH');
    } catch (error) {
      if (error instanceof PrivateStorageError &&
          ['INVALID_FILE', 'CONTENT_TYPE_MISMATCH'].includes(error.code)) {
        await quarantineUpload(temporaryPath).catch(() => unlink(temporaryPath).catch(() => {}));
        throw error;
      }
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }

    const sha256 = contentHash.digest('hex');
    try {
      return await withLock(async () => {
        const items = await readIndex();
        const duplicate = [...items.values()].find(item =>
          item.tenantId === context.tenantId && item.sha256 === sha256);
        if (duplicate) {
          await validateStoredFile(duplicate);
          await unlink(temporaryPath).catch(() => {});
          return Object.freeze({ ...publicMetadata(duplicate), deduplicated: true });
        }
        if (items.size >= limits.maxStorageFiles) fail('STORAGE_LIMIT');
        const tenantItems = [...items.values()].filter(item => item.tenantId === context.tenantId);
        const tenantBytes = tenantItems.reduce((sum, item) => sum + item.size, 0);
        const totalBytes = [...items.values()].reduce((sum, item) => sum + item.size, 0);
        if (tenantItems.length >= limits.maxTenantFiles ||
            tenantBytes + size > limits.maxTenantBytes ||
            totalBytes + size > limits.maxStorageBytes) {
          fail('QUOTA_EXCEEDED');
        }
        const now = clockValue(clock);
        const id = randomUUID();
        const item = {
          id,
          tenantId: context.tenantId,
          sha256,
          size,
          contentType: 'image/png',
          createdAt: now,
          expiresAt: now + limits.retentionMs,
        };
        if (!Number.isSafeInteger(item.expiresAt)) fail('TIME_RANGE');
        const tenantDirectory = await ensureTenantDirectory(context.tenantId);
        const destination = path.join(tenantDirectory, `${id}.png`);
        try {
          await rename(temporaryPath, destination);
          await chmod(destination, 0o600);
          items.set(id, item);
          await writeIndex(items);
        } catch (error) {
          items.delete(id);
          await unlink(destination).catch(() => {});
          await unlink(temporaryPath).catch(() => {});
          if (error instanceof PrivateStorageError) throw error;
          fail('STORAGE_UNAVAILABLE');
        }
        return Object.freeze({ ...publicMetadata(item), deduplicated: false });
      });
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function exportFile(input) {
    exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'objectId']);
    const context = await resolveContext(input);
    const id = uuid(input.objectId);
    await recordAudit(context, 'storage.object.export', { objectId: id });
    const items = await readIndex();
    const item = items.get(id);
    if (!item || item.tenantId !== context.tenantId) fail('NOT_FOUND');
    const buffer = await validateStoredFile(item);
    return Object.freeze({
      stream: Readable.from([buffer]),
      metadata: publicMetadata(item),
      fileName: `${item.id}.png`,
      headers: Object.freeze({
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${item.id}.png"`,
        'X-Content-Type-Options': 'nosniff',
      }),
    });
  }

  async function list(input) {
    exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
    const context = await resolveContext(input);
    await recordAudit(context, 'storage.object.list');
    const items = await readIndex();
    return Object.freeze([...items.values()]
      .filter(item => item.tenantId === context.tenantId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(publicMetadata));
  }

  async function removeItem(items, item) {
    const source = objectPath(item);
    const info = await lstat(source).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      fail('CORRUPT_STORAGE');
    }
    const trash = path.join(temporaryDirectory, `${randomUUID()}.deleted`);
    await rename(source, trash);
    items.delete(item.id);
    try {
      await writeIndex(items);
    } catch (error) {
      items.set(item.id, item);
      await rename(trash, source).catch(() => {});
      throw error;
    }
    await unlink(trash).catch(() => {});
  }

  async function deleteFile(input) {
    exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'objectId']);
    const context = await resolveContext(input);
    const id = uuid(input.objectId);
    await recordAudit(context, 'storage.object.delete', { objectId: id });
    return withLock(async () => {
      const items = await readIndex();
      const item = items.get(id);
      if (!item || item.tenantId !== context.tenantId) fail('NOT_FOUND');
      await removeItem(items, item);
      return Object.freeze({ deleted: true });
    });
  }

  async function purgeExpired(input) {
    exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'tenantContext', 'signal',
    ], []);
    const credentialKeys = ['cookieHeader', 'tenantId', 'requestId'];
    const hasCredentials = credentialKeys.every(key => Object.hasOwn(input, key));
    const hasSomeCredentials = credentialKeys.some(key => Object.hasOwn(input, key));
    if (hasCredentials === Object.hasOwn(input, 'tenantContext') ||
        (!hasCredentials && hasSomeCredentials)) {
      fail('INVALID_INPUT');
    }
    const context = hasCredentials
      ? await resolveContext(input)
      : validateTenantContext(input.tenantContext);
    const signal = validSignal(input.signal);
    if (signal?.aborted) fail('INTERRUPTED');
    await recordAudit(context, 'storage.retention.run');
    const now = clockValue(clock);
    const removed = await withLock(async () => {
      const items = await readIndex();
      const expired = [...items.values()].filter(item =>
        item.tenantId === context.tenantId && item.expiresAt <= now);
      for (const item of expired) {
        if (signal?.aborted) fail('INTERRUPTED');
        await removeItem(items, item);
      }
      return expired.length;
    });
    const cleanedTemporaryFiles = await cleanTemporaryFiles(now);
    return Object.freeze({ deletedCount: removed, cleanedTemporaryFiles });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    moduleVersion: MODULE_VERSION,
    upload,
    export: exportFile,
    list,
    delete: deleteFile,
    purgeExpired,
  });
}

export function createStorageRetentionHandler(storage) {
  if (!storage || typeof storage.purgeExpired !== 'function') fail('INVALID_CONFIGURATION');
  return async job => {
    if (job === null || typeof job !== 'object' || Array.isArray(job)) fail('INVALID_INPUT');
    const prototype = Object.getPrototypeOf(job);
    if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(job, 'tenantContext');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('INVALID_INPUT');
    }
    const signalDescriptor = Object.getOwnPropertyDescriptor(job, 'signal');
    if (signalDescriptor &&
        (!signalDescriptor.enumerable || !Object.hasOwn(signalDescriptor, 'value'))) {
      fail('INVALID_INPUT');
    }
    const signal = signalDescriptor?.value;
    return storage.purgeExpired({ tenantContext: descriptor.value, signal });
  };
}

export const privateStorageContract = Object.freeze({
  version: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  formats: Object.freeze(['image/png']),
  uploadMode: 'bounded-stream',
  deduplicationScope: 'tenant-only',
  erasure: 'filesystem-delete-best-effort',
});
