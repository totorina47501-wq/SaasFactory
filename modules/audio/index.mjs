import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULTS = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxDurationSeconds: 600,
  maxOutputBytes: 24 * 1024 * 1024,
  maxTenantFiles: 100,
  maxTenantBytes: 512 * 1024 * 1024,
  maxStorageFiles: 1000,
  maxStorageBytes: 5 * 1024 * 1024 * 1024,
  maxConcurrentJobs: 2,
  jobTimeoutMs: 120_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  temporaryTtlMs: 60 * 60 * 1000,
});
const CONTAINERS = Object.freeze({
  wav: { mimeType: 'audio/wav', formats: ['wav'], codecs: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'] },
  mp3: { mimeType: 'audio/mpeg', formats: ['mp3'], codecs: ['mp3'] },
  flac: { mimeType: 'audio/flac', formats: ['flac'], codecs: ['flac'] },
  ogg: { mimeType: 'audio/ogg', formats: ['ogg'], codecs: ['vorbis', 'opus'] },
  m4a: {
    mimeType: 'audio/mp4',
    formats: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
    codecs: ['aac'],
  },
});
const TRANSCRIPT_STATUSES = ['draft', 'validated'];

export class AudioModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AudioModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new AudioModuleError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function storedObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(value, key))) fail('CORRUPT_STORAGE');
  return value;
}

function validateLimits(value = {}) {
  exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...value };
  for (const [key, number] of Object.entries(limits)) {
    const maximum = key === 'maxInputBytes' ? 100 * 1024 * 1024 :
      key === 'maxDurationSeconds' ? 3600 :
        key === 'maxOutputBytes' ? 64 * 1024 * 1024 :
          key === 'maxConcurrentJobs' ? 8 :
            key === 'jobTimeoutMs' ? 30 * 60 * 1000 :
            key === 'maxTenantFiles' || key === 'maxStorageFiles' ? 100_000 :
              key === 'maxTenantBytes' || key === 'maxStorageBytes' ? 10 * 1024 * 1024 * 1024 :
                365 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail('INVALID_CONFIGURATION');
  }
  if (limits.maxTenantBytes > limits.maxStorageBytes ||
      limits.maxTenantFiles > limits.maxStorageFiles ||
      limits.maxInputBytes > limits.maxTenantBytes ||
      limits.maxOutputBytes > limits.maxTenantBytes ||
      limits.temporaryTtlMs <= limits.jobTimeoutMs) fail('INVALID_CONFIGURATION');
  return Object.freeze(limits);
}

function validSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
  return signal;
}

function uuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function assertNoSymlinkPath(target, allowMissingFinal = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target ||
      /[\0-\x1f\x7f]/u.test(target) || target.split(path.sep).some(part => part === '.' || part === '..')) {
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
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) fail('INVALID_PATH');
  }
}

async function ensurePrivateDirectory(directory, create = false) {
  await assertNoSymlinkPath(directory, create);
  try {
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (!create || error.code !== 'ENOENT') fail('UNSAFE_STORAGE');
      await mkdir(directory, { mode: 0o700 });
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('UNSAFE_STORAGE');
  } catch (error) {
    if (error instanceof AudioModuleError) throw error;
    fail('UNSAFE_STORAGE');
  }
}

async function ensureChild(parent, name) {
  const target = path.join(parent, name);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') fail('UNSAFE_STORAGE');
  }
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('UNSAFE_STORAGE');
  return target;
}

function containerFor(data) {
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WAVE' && data.readUInt32LE(4) + 8 <= data.length) return 'wav';
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3' &&
      data[3] < 0xff && data[4] < 0xff && data[5] < 0xff && data[6] < 0x80 &&
      data[7] < 0x80 && data[8] < 0x80 && data[9] < 0x80) {
    const tagSize = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9];
    if (tagSize + 10 <= data.length) return 'mp3';
  }
  if (data.length >= 4 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0 &&
      (data[1] & 0x06) !== 0 && ((data[2] >> 4) & 0x0f) !== 0x0f) return 'mp3';
  if (data.length >= 4 && data.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' &&
      /^[A-Za-z0-9 ]{4}$/u.test(data.toString('ascii', 8, 12))) return 'm4a';
  fail('INVALID_MEDIA');
}

function parseProbe(raw, container, limits) {
  let probe;
  try {
    probe = JSON.parse(raw);
  } catch {
    fail('INVALID_MEDIA');
  }
  if (!probe || typeof probe !== 'object' || Array.isArray(probe) ||
      !probe.format || typeof probe.format !== 'object' || Array.isArray(probe.format) ||
      !Array.isArray(probe.streams) || probe.streams.length !== 1) fail('INVALID_MEDIA');
  const formatName = probe.format.format_name;
  const spec = CONTAINERS[container];
  if (typeof formatName !== 'string' || !/^[a-z0-9,]+$/u.test(formatName) || !spec) fail('INVALID_MEDIA');
  const formats = formatName.split(',');
  if (!formats.every(format => spec.formats.includes(format))) fail('UNSUPPORTED_CONTAINER');
  const stream = probe.streams[0];
  if (stream?.codec_type !== 'audio' || !spec.codecs.includes(stream.codec_name)) fail('UNSUPPORTED_CODEC');
  const durationSeconds = Number(probe.format.duration);
  const sampleRate = Number(stream.sample_rate);
  const channels = stream.channels;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isSafeInteger(channels) || channels < 1 || channels > 8) fail('INVALID_MEDIA');
  if (durationSeconds > limits.maxDurationSeconds) fail('DURATION_LIMIT');
  const bitRate = Number(probe.format.bit_rate ?? stream.bit_rate);
  return Object.freeze({
    mimeType: spec.mimeType,
    container,
    durationSeconds,
    codec: stream.codec_name,
    sampleRate,
    channels,
    bitRate: Number.isSafeInteger(bitRate) && bitRate > 0 ? bitRate : null,
  });
}

function runEngine(executable, args, { timeoutMs, maxBytes, signal, outputTooLargeCode }) {
  if (signal?.aborted) return Promise.reject(new AudioModuleError('INTERRUPTED'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      reject(new AudioModuleError('ENGINE_UNAVAILABLE'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let failure;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = code => {
      if (failure) return;
      failure = new AudioModuleError(code);
      child.kill('SIGKILL');
    };
    const onAbort = () => stop('INTERRUPTED');
    const timer = setTimeout(() => stop('ENGINE_TIMEOUT'), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => finish(new AudioModuleError('ENGINE_UNAVAILABLE')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        stop(outputTooLargeCode);
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', code => {
      if (failure) finish(failure);
      else if (code !== 0) finish(new AudioModuleError('ENGINE_FAILED'));
      else finish(null, Buffer.concat(chunks, size));
    });
    if (signal?.aborted) onAbort();
  });
}

function validAudioBuffer(value) {
  return Buffer.isBuffer(value) ||
    (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype);
}

function formatTime(seconds, separator) {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((millis % 60_000) / 1000);
  const remainder = millis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(wholeSeconds).padStart(2, '0')}${separator}${String(remainder).padStart(3, '0')}`;
}

function validateSegments(value, durationSeconds, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 1000) {
    fail('INVALID_TRANSCRIPT');
  }
  let previousEnd = 0;
  let totalChars = 0;
  const segments = value.map((segment, index) => {
    exactObject(segment, ['startSeconds', 'endSeconds', 'text']);
    const { startSeconds, endSeconds, text } = segment;
    if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) ||
        typeof endSeconds !== 'number' || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds ||
          Math.round(startSeconds * 1000) >= Math.round(endSeconds * 1000) ||
          (index > 0 && startSeconds < previousEnd) || typeof text !== 'string' ||
          text.trim().length < 1 || text.length > 2000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r\n]/u.test(text)) {
      fail('INVALID_TRANSCRIPT');
    }
    totalChars += text.length;
    if (totalChars > 500_000) fail('INVALID_TRANSCRIPT');
    previousEnd = endSeconds;
    return Object.freeze({ startSeconds, endSeconds, text: text.trim() });
  });
  return Object.freeze(segments);
}

function subtitleText(text) {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

export const audioContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  processing: 'explicit-opt-in-only',
  storage: 'local-private-tenant-isolated',
  engines: Object.freeze({ probe: 'ffprobe', conversion: 'ffmpeg', shell: false }),
  supportedContainers: Object.freeze(Object.keys(CONTAINERS)),
  transcriptSchema: Object.freeze({
    contractVersion: 1,
    segmentFields: Object.freeze(['startSeconds', 'endSeconds', 'text']),
    statuses: Object.freeze(TRANSCRIPT_STATUSES),
  }),
});

export async function createAudioService({
  directory,
  tenancy,
  audit,
  ffprobePath = 'ffprobe',
  ffmpegPath = 'ffmpeg',
  videoService,
  limits: configuredLimits,
  clock = () => Date.now(),
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      !tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      !audit || typeof audit.append !== 'function' ||
      typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.length > 4096 ||
      typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.length > 4096 ||
      (videoService !== undefined && (!videoService || typeof videoService.extractAudio !== 'function' ||
        typeof videoService.readArtifact !== 'function')) || typeof clock !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(configuredLimits);
  await ensurePrivateDirectory(directory, true);
  const sourcesRoot = await ensureChild(directory, 'sources');
  const transcriptsRoot = await ensureChild(directory, 'transcripts');
  const temporaryRoot = await ensureChild(directory, 'temporary');
  let activeJobs = 0;
  const activeByTenant = new Map();
  const locks = new Map();
  let quotaQueue = Promise.resolve();

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('TIME_RANGE');
    return value;
  }

  async function authorize(input, action) {
    if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 4096 ||
        typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) fail('INVALID_INPUT');
    const tenantId = uuid(input.tenantId);
    let context;
    try {
      context = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader, tenantId, requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    if (!context || context.contractVersion !== 1 || context.tenantId !== tenantId ||
        context.requestId !== input.requestId) fail('INVALID_TENANT_CONTEXT');
    try {
      await audit.append(context, { action, module: 'audio' });
    } catch {
      fail('AUDIT_UNAVAILABLE');
    }
    return context;
  }

  async function withJob(tenantId, signal, operation) {
    validSignal(signal);
    if (signal?.aborted) fail('INTERRUPTED');
    const tenantJobs = activeByTenant.get(tenantId) ?? 0;
    if (activeJobs >= limits.maxConcurrentJobs || tenantJobs >= limits.maxConcurrentJobs) fail('JOB_LIMIT');
    activeJobs += 1;
    activeByTenant.set(tenantId, tenantJobs + 1);
    try {
      const previous = locks.get(tenantId) ?? Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      const queued = previous.then(() => current);
      locks.set(tenantId, queued);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(tenantId) === queued) locks.delete(tenantId);
      }
    } finally {
      activeJobs -= 1;
      const remaining = (activeByTenant.get(tenantId) ?? 1) - 1;
      if (remaining === 0) activeByTenant.delete(tenantId);
      else activeByTenant.set(tenantId, remaining);
    }
  }

  async function withQuotaLock(operation) {
    const previous = quotaQueue;
    let release;
    quotaQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function tenantDirectories(tenantId) {
    return {
      sources: await ensureChild(sourcesRoot, tenantId),
      transcripts: await ensureChild(transcriptsRoot, tenantId),
    };
  }

  async function usage() {
    let files = 0;
    let bytes = 0;
    for (const root of [sourcesRoot, transcriptsRoot]) {
      for (const tenant of await readdir(root)) {
        if (!UUID.test(tenant)) fail('UNSAFE_STORAGE');
        const tenantPath = path.join(root, tenant);
        const tenantInfo = await lstat(tenantPath);
        if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink() || (tenantInfo.mode & 0o077) !== 0) {
          fail('UNSAFE_STORAGE');
        }
        for (const name of await readdir(tenantPath)) {
          const itemPath = path.join(tenantPath, name);
          const info = await lstat(itemPath);
          if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
          files += 1;
          bytes += info.size;
          if (files > limits.maxStorageFiles || bytes > limits.maxStorageBytes) fail('STORAGE_LIMIT');
        }
      }
    }
    return { files, bytes };
  }

  async function tenantUsage(tenantId) {
    let files = 0;
    let bytes = 0;
    for (const root of [sourcesRoot, transcriptsRoot]) {
      const dir = path.join(root, tenantId);
      for (const name of await readdir(dir)) {
        const info = await lstat(path.join(dir, name));
        if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
        files += 1;
        bytes += info.size;
      }
    }
    return { files, bytes };
  }

  async function reserve(tenantId, extraFiles, extraBytes) {
    const [all, tenant] = await Promise.all([usage(), tenantUsage(tenantId)]);
    if (all.files + extraFiles > limits.maxStorageFiles ||
        all.bytes + extraBytes > limits.maxStorageBytes ||
        tenant.files + extraFiles > limits.maxTenantFiles ||
        tenant.bytes + extraBytes > limits.maxTenantBytes) fail('QUOTA_EXCEEDED');
  }

  async function writeJson(filePath, value, replace = false) {
    const tempPath = path.join(temporaryRoot, `${randomUUID()}.json`);
    try {
      await writeFile(tempPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      if (replace) {
        const info = await lstat(filePath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
      }
      await rename(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      if (error instanceof AudioModuleError) throw error;
      fail('STORAGE_UNAVAILABLE');
    }
  }

  async function readJson(filePath, maximum = 1024 * 1024) {
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (info.mode & 0o077) !== 0) {
        fail('UNSAFE_STORAGE');
      }
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error instanceof AudioModuleError) throw error;
      fail(error.code === 'ENOENT' ? 'NOT_FOUND' : 'CORRUPT_STORAGE');
    }
  }

  async function getAudio(tenantId, audioId) {
    const dirs = await tenantDirectories(tenantId);
    const metadata = storedObject(await readJson(path.join(dirs.sources, `${audioId}.json`)), [
      'contractVersion', 'id', 'tenantId', 'mimeType', 'container', 'durationSeconds',
      'codec', 'sampleRate', 'channels', 'bitRate', 'sourceHash', 'sourceBytes', 'createdAt',
      'expiresAt',
    ]);
    if (!metadata || metadata.contractVersion !== CONTRACT_VERSION || metadata.id !== audioId ||
        metadata.tenantId !== tenantId || !Object.hasOwn(CONTAINERS, metadata.container) ||
        metadata.mimeType !== CONTAINERS[metadata.container].mimeType ||
        !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 ||
        metadata.durationSeconds > limits.maxDurationSeconds ||
        !Number.isSafeInteger(metadata.sourceBytes) || metadata.sourceBytes < 1 ||
        metadata.sourceBytes > limits.maxInputBytes || !Number.isSafeInteger(metadata.createdAt) ||
        !Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= metadata.createdAt ||
        (metadata.bitRate !== null && (!Number.isSafeInteger(metadata.bitRate) || metadata.bitRate < 1)) ||
        !Number.isSafeInteger(metadata.sampleRate) || metadata.sampleRate < 8000 ||
        metadata.sampleRate > 192000 || !Number.isSafeInteger(metadata.channels) ||
        metadata.channels < 1 || metadata.channels > 8 ||
        !CONTAINERS[metadata.container].codecs.includes(metadata.codec) ||
        typeof metadata.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.sourceHash)) {
      fail('CORRUPT_STORAGE');
    }
    if (metadata.expiresAt <= now()) fail('NOT_FOUND');
    const sourcePath = path.join(dirs.sources, `${audioId}.source`);
    const sourceInfo = await lstat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== metadata.sourceBytes ||
        (sourceInfo.mode & 0o077) !== 0) fail('CORRUPT_STORAGE');
    const source = await readFile(sourcePath);
    if (sha256(source) !== metadata.sourceHash) fail('CORRUPT_STORAGE');
    return { dirs, metadata, sourcePath };
  }

  async function getTranscript(tenantId, transcriptId) {
    const dirs = await tenantDirectories(tenantId);
    const filePath = path.join(dirs.transcripts, `${transcriptId}.json`);
    const metadata = storedObject(await readJson(filePath, 2 * 1024 * 1024), [
      'contractVersion', 'id', 'tenantId', 'audioId', 'version', 'status', 'segments',
      'validatedAt', 'createdAt', 'updatedAt', 'expiresAt',
    ]);
    if (!metadata || metadata.contractVersion !== CONTRACT_VERSION || metadata.id !== transcriptId ||
        metadata.tenantId !== tenantId || !UUID.test(metadata.audioId) ||
        !Number.isSafeInteger(metadata.version) || metadata.version < 1 ||
        !TRANSCRIPT_STATUSES.includes(metadata.status) || !Number.isSafeInteger(metadata.createdAt) ||
        !Number.isSafeInteger(metadata.updatedAt) || !Number.isSafeInteger(metadata.expiresAt) ||
        !Array.isArray(metadata.segments) ||
        (metadata.validatedAt !== null && !Number.isSafeInteger(metadata.validatedAt))) fail('CORRUPT_STORAGE');
    const audio = await getAudio(tenantId, metadata.audioId);
    const segments = validateSegments(metadata.segments, audio.metadata.durationSeconds, {
      allowEmpty: metadata.status === 'draft',
    });
    if (metadata.status === 'validated' && metadata.validatedAt === null ||
        metadata.status === 'draft' && metadata.validatedAt !== null) fail('CORRUPT_STORAGE');
    return { dirs, filePath, metadata: { ...metadata, segments }, audio: audio.metadata };
  }

  async function removeAudioFiles(tenantId, audioId) {
    const dirs = await tenantDirectories(tenantId);
    const transcriptDir = dirs.transcripts;
    let deletedTranscripts = 0;
    for (const name of await readdir(transcriptDir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(transcriptDir, name);
      const item = storedObject(await readJson(filePath, 2 * 1024 * 1024), [
        'contractVersion', 'id', 'tenantId', 'audioId', 'version', 'status', 'segments',
        'validatedAt', 'createdAt', 'updatedAt', 'expiresAt',
      ]);
      if (item.tenantId !== tenantId || !UUID.test(item.id) ||
          name !== `${item.id}.json` || !UUID.test(item.audioId)) fail('CORRUPT_STORAGE');
      if (item.audioId === audioId) {
        await unlink(filePath);
        deletedTranscripts += 1;
      }
    }
    for (const suffix of ['.source', '.normalized.wav', '.normalized.json', '.json']) {
      await unlink(path.join(dirs.sources, `${audioId}${suffix}`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return deletedTranscripts;
  }

  const service = Object.freeze({
    async ingest(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'consent', 'audio', 'signal'],
        ['cookieHeader', 'tenantId', 'requestId', 'consent', 'audio']);
      validSignal(input.signal);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      if (!validAudioBuffer(input.audio)) fail('INVALID_INPUT');
      if (input.audio.byteLength < 12) fail('INVALID_MEDIA');
      if (input.audio.byteLength > limits.maxInputBytes) fail('FILE_TOO_LARGE');
      const audio = Buffer.from(input.audio);
      const container = containerFor(audio);
      const context = await authorize(input, 'audio.ingest');
      return withJob(context.tenantId, input.signal, async () => {
        const dirs = await tenantDirectories(context.tenantId);
        const id = randomUUID();
        const temporaryPath = path.join(temporaryRoot, `${randomUUID()}.input`);
        const sourcePath = path.join(dirs.sources, `${id}.source`);
        const metadataPath = path.join(dirs.sources, `${id}.json`);
        const createdAt = now();
        const expiresAt = createdAt + limits.retentionMs;
        if (!Number.isSafeInteger(expiresAt)) fail('TIME_RANGE');
        try {
          await writeFile(temporaryPath, audio, { flag: 'wx', mode: 0o600 });
          const raw = await runEngine(ffprobePath, [
            '-v', 'error', '-show_entries',
            'format=format_name,duration,bit_rate:stream=codec_type,codec_name,sample_rate,channels,bit_rate',
            '-of', 'json', '-protocol_whitelist', 'file,pipe', temporaryPath,
          ], {
            timeoutMs: limits.jobTimeoutMs, maxBytes: 16 * 1024,
            signal: input.signal, outputTooLargeCode: 'INVALID_MEDIA',
          });
          const probe = parseProbe(raw.toString('utf8'), container, limits);
          if (input.signal?.aborted) fail('INTERRUPTED');
          const metadata = {
            contractVersion: CONTRACT_VERSION, id, tenantId: context.tenantId, ...probe,
            sourceHash: sha256(audio), sourceBytes: audio.length, createdAt, expiresAt,
          };
          await withQuotaLock(async () => {
            await reserve(context.tenantId, 2,
              audio.length + Buffer.byteLength(JSON.stringify(metadata)));
            if (input.signal?.aborted) fail('INTERRUPTED');
            await rename(temporaryPath, sourcePath);
            await writeFile(metadataPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            if (input.signal?.aborted) fail('INTERRUPTED');
          });
          return Object.freeze({
            id, contractVersion: CONTRACT_VERSION, ...probe, sourceBytes: audio.length, expiresAt,
          });
        } catch (error) {
          await Promise.all([unlink(temporaryPath), unlink(sourcePath), unlink(metadataPath)].map(
            operation => operation.catch(() => {})));
          if (error instanceof AudioModuleError) throw error;
          fail('STORAGE_UNAVAILABLE');
        } finally {
          await unlink(temporaryPath).catch(() => {});
        }
      });
    },
    async ingestVideoAudio(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'consent', 'videoId']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      if (!videoService) fail('VIDEO_UNAVAILABLE');
      const context = await authorize(input, 'audio.video-import');
      const auth = {
        cookieHeader: input.cookieHeader, tenantId: context.tenantId, requestId: input.requestId,
      };
      const artifact = await videoService.extractAudio({ ...auth, videoId: uuid(input.videoId) });
      if (!artifact || typeof artifact.id !== 'string' || artifact.contentType !== 'audio/wav') {
        fail('INVALID_VIDEO_ARTIFACT');
      }
      const result = await videoService.readArtifact({ ...auth, artifactId: artifact.id });
      if (!result || result.contentType !== 'audio/wav' || !Buffer.isBuffer(result.data)) {
        fail('INVALID_VIDEO_ARTIFACT');
      }
      return service.ingest({ ...auth, consent: true, audio: result.data });
    },
    async normalize(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId', 'signal'],
        ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      validSignal(input.signal);
      const context = await authorize(input, 'audio.normalize');
      return withJob(context.tenantId, input.signal, async () => {
        const audioId = uuid(input.audioId);
        const { dirs, metadata, sourcePath } = await getAudio(context.tenantId, audioId);
        const normalizedPath = path.join(dirs.sources, `${audioId}.normalized.wav`);
        const normalizedMetadataPath = path.join(dirs.sources, `${audioId}.normalized.json`);
        if (await lstat(normalizedPath).catch(() => null)) fail('ALREADY_NORMALIZED');
        const temp = path.join(temporaryRoot, `${randomUUID()}.normalized`);
        try {
          const normalized = await runEngine(ffmpegPath, [
            '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', sourcePath,
            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
            '-f', 'wav', 'pipe:1',
          ], {
            timeoutMs: limits.jobTimeoutMs, maxBytes: limits.maxOutputBytes,
            signal: input.signal, outputTooLargeCode: 'OUTPUT_TOO_LARGE',
          });
          if (normalized.length < 44 || normalized.toString('ascii', 0, 4) !== 'RIFF' ||
              normalized.toString('ascii', 8, 12) !== 'WAVE' ||
              normalized.readUInt32LE(4) + 8 > normalized.length) fail('INVALID_ENGINE_OUTPUT');
          const normalizedMetadata = {
            contractVersion: CONTRACT_VERSION, audioId, tenantId: context.tenantId,
            size: normalized.length, sha256: sha256(normalized), createdAt: now(),
          };
          await writeFile(temp, normalized, { flag: 'wx', mode: 0o600 });
          if (input.signal?.aborted) fail('INTERRUPTED');
          await withQuotaLock(async () => {
            await reserve(context.tenantId, 2,
              normalized.length + Buffer.byteLength(JSON.stringify(normalizedMetadata)));
            if (input.signal?.aborted) fail('INTERRUPTED');
            await rename(temp, normalizedPath);
            await writeJson(normalizedMetadataPath, normalizedMetadata);
            if (input.signal?.aborted) fail('INTERRUPTED');
          });
          return Object.freeze({
            audioId, contentType: 'audio/wav', sampleRate: 16000, channels: 1,
            size: normalized.length, sha256: normalizedMetadata.sha256, expiresAt: metadata.expiresAt,
          });
        } catch (error) {
          await unlink(temp).catch(() => {});
          await unlink(normalizedPath).catch(() => {});
          await unlink(normalizedMetadataPath).catch(() => {});
          if (error instanceof AudioModuleError) throw error;
          fail('STORAGE_UNAVAILABLE');
        }
      });
    },
    async readAudio(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId', 'normalized'],
        ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      if (input.normalized !== undefined && typeof input.normalized !== 'boolean') fail('INVALID_INPUT');
      const context = await authorize(input, 'audio.read');
      const audioId = uuid(input.audioId);
      const { dirs, metadata, sourcePath } = await getAudio(context.tenantId, audioId);
      const normalizedPath = path.join(dirs.sources, `${audioId}.normalized.wav`);
      const normalizedInfo = await lstat(normalizedPath).catch(() => null);
      if (input.normalized === true && !normalizedInfo) fail('NOT_FOUND');
      const useNormalized = input.normalized === true;
      const target = useNormalized ? normalizedPath : sourcePath;
      const info = await lstat(target).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
          info.size > (useNormalized ? limits.maxOutputBytes : limits.maxInputBytes)) fail('CORRUPT_STORAGE');
      const data = await readFile(target);
      if (useNormalized) {
        const normalizedMetadata = storedObject(await readJson(
          path.join(dirs.sources, `${audioId}.normalized.json`), 4096), [
          'contractVersion', 'audioId', 'tenantId', 'size', 'sha256', 'createdAt',
        ]);
        if (normalizedMetadata.contractVersion !== CONTRACT_VERSION ||
            normalizedMetadata.audioId !== audioId || normalizedMetadata.tenantId !== context.tenantId ||
            normalizedMetadata.size !== data.length || !/^[a-f0-9]{64}$/u.test(normalizedMetadata.sha256) ||
            !Number.isSafeInteger(normalizedMetadata.createdAt) ||
            sha256(data) !== normalizedMetadata.sha256) fail('CORRUPT_STORAGE');
      } else if (sha256(data) !== metadata.sourceHash) {
        fail('CORRUPT_STORAGE');
      }
      return Object.freeze({
        contentType: useNormalized ? 'audio/wav' : metadata.mimeType,
        data,
      });
    },
    async createTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      const context = await authorize(input, 'audio.transcript.create');
      const audioId = uuid(input.audioId);
      const id = randomUUID();
      const createdAt = now();
      return withJob(context.tenantId, undefined, async () => {
        const { metadata: audio } = await getAudio(context.tenantId, audioId);
        const dirs = await tenantDirectories(context.tenantId);
        const transcript = {
          contractVersion: CONTRACT_VERSION, id, tenantId: context.tenantId, audioId,
          version: 1, status: 'draft', segments: Object.freeze([]), validatedAt: null, createdAt,
          updatedAt: createdAt, expiresAt: audio.expiresAt,
        };
        await withQuotaLock(async () => {
          await reserve(context.tenantId, 1, Buffer.byteLength(JSON.stringify(transcript)));
          await writeJson(path.join(dirs.transcripts, `${id}.json`), transcript);
        });
        return Object.freeze({ ...transcript });
      });
    },
    async editTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'expectedVersion', 'segments']);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT');
      const context = await authorize(input, 'audio.transcript.edit');
      const transcriptId = uuid(input.transcriptId);
      return withJob(context.tenantId, undefined, async () => {
        const transcript = await getTranscript(context.tenantId, transcriptId);
        if (transcript.metadata.version !== input.expectedVersion) fail('VERSION_CONFLICT');
        const segments = validateSegments(input.segments, transcript.audio.durationSeconds);
        const updated = {
          ...transcript.metadata, version: transcript.metadata.version + 1,
          status: 'draft', segments, validatedAt: null, updatedAt: now(),
        };
        await withQuotaLock(async () => {
          await reserve(context.tenantId, 0, Buffer.byteLength(JSON.stringify(updated)) -
            Buffer.byteLength(JSON.stringify(transcript.metadata)));
          await writeJson(transcript.filePath, updated, true);
        });
        return Object.freeze({ ...updated });
      });
    },
    async validateTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'expectedVersion']);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT');
      const context = await authorize(input, 'audio.transcript.validate');
      const transcriptId = uuid(input.transcriptId);
      return withJob(context.tenantId, undefined, async () => {
        const transcript = await getTranscript(context.tenantId, transcriptId);
        if (transcript.metadata.version !== input.expectedVersion) fail('VERSION_CONFLICT');
        if (transcript.metadata.segments.length === 0) fail('INVALID_TRANSCRIPT');
        const validatedAt = now();
        const updated = {
          ...transcript.metadata, version: transcript.metadata.version + 1,
          status: 'validated', validatedAt, updatedAt: validatedAt,
        };
        await withQuotaLock(async () => {
          await reserve(context.tenantId, 0, Buffer.byteLength(JSON.stringify(updated)) -
            Buffer.byteLength(JSON.stringify(transcript.metadata)));
          await writeJson(transcript.filePath, updated, true);
        });
        return Object.freeze({ ...updated });
      });
    },
    async exportSubtitles(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'format']);
      if (!['srt', 'vtt'].includes(input.format)) fail('INVALID_INPUT');
      const context = await authorize(input, 'audio.transcript.export');
      const transcript = await getTranscript(context.tenantId, uuid(input.transcriptId));
      if (transcript.metadata.status !== 'validated') fail('TRANSCRIPT_NOT_VALIDATED');
      const separator = input.format === 'srt' ? ',' : '.';
      const cues = transcript.metadata.segments.map((segment, index) =>
        `${input.format === 'srt' ? `${index + 1}\n` : ''}` +
        `${formatTime(segment.startSeconds, separator)} --> ${formatTime(segment.endSeconds, separator)}\n` +
        `${subtitleText(segment.text)}`).join('\n\n');
      const text = input.format === 'vtt' ? `WEBVTT\n\n${cues}\n` : `${cues}\n`;
      return Object.freeze({
        contentType: input.format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
        data: text,
      });
    },
    async getRagDocument(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId']);
      const context = await authorize(input, 'audio.transcript.rag-read');
      const transcript = await getTranscript(context.tenantId, uuid(input.transcriptId));
      if (transcript.metadata.status !== 'validated') fail('TRANSCRIPT_NOT_VALIDATED');
      const text = transcript.metadata.segments.map(segment => segment.text).join('\n');
      return Object.freeze({
        contractVersion: 1,
        id: `audio-transcript:${transcript.metadata.id}`,
        version: transcript.metadata.version,
        text,
        source: Object.freeze({
          kind: 'audio-transcript',
          audioId: transcript.metadata.audioId,
          validated: true,
          validatedAt: transcript.metadata.validatedAt,
        }),
      });
    },
    async deleteTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId']);
      const context = await authorize(input, 'audio.transcript.delete');
      const transcript = await getTranscript(context.tenantId, uuid(input.transcriptId));
      await withJob(context.tenantId, undefined, () => unlink(transcript.filePath));
      return Object.freeze({ deleted: true });
    },
    async deleteAudio(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      const context = await authorize(input, 'audio.delete');
      const audioId = uuid(input.audioId);
      await withJob(context.tenantId, undefined, async () => {
        await getAudio(context.tenantId, audioId);
        await removeAudioFiles(context.tenantId, audioId);
      });
      return Object.freeze({ deleted: true });
    },
    async purgeExpired(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await authorize(input, 'audio.retention');
      return withJob(context.tenantId, undefined, async () => {
        const dirs = await tenantDirectories(context.tenantId);
        let deletedAudio = 0;
        let deletedTranscripts = 0;
        let cleanedTemporaryFiles = 0;
        let cleanedOrphanFiles = 0;
        const audioNames = await readdir(dirs.sources);
        for (const name of audioNames.filter(item => item.endsWith('.json'))) {
          const metadata = storedObject(await readJson(path.join(dirs.sources, name)), [
            'contractVersion', 'id', 'tenantId', 'mimeType', 'container', 'durationSeconds',
            'codec', 'sampleRate', 'channels', 'bitRate', 'sourceHash', 'sourceBytes',
            'createdAt', 'expiresAt',
          ]);
          if (!Number.isSafeInteger(metadata.expiresAt) || !UUID.test(metadata.id) ||
              name !== `${metadata.id}.json` || metadata.tenantId !== context.tenantId ||
              metadata.contractVersion !== CONTRACT_VERSION) {
            fail('CORRUPT_STORAGE');
          }
          if (metadata.expiresAt <= now()) {
            deletedTranscripts += await removeAudioFiles(context.tenantId, metadata.id);
            deletedAudio += 1;
          }
        }
        const sourceNames = await readdir(dirs.sources);
        const sourceSet = new Set(sourceNames);
        const sourceIds = new Set();
        for (const name of sourceNames) {
          const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|source|normalized\.wav|normalized\.json)$/iu.exec(name);
          if (!match) fail('UNSAFE_STORAGE');
          sourceIds.add(match[1]);
        }
        const orphanNames = new Set();
        for (const id of sourceIds) {
          const hasSource = sourceSet.has(`${id}.source`);
          const hasMetadata = sourceSet.has(`${id}.json`);
          const hasNormalized = sourceSet.has(`${id}.normalized.wav`);
          const hasNormalizedMetadata = sourceSet.has(`${id}.normalized.json`);
          if (!hasMetadata) {
            for (const name of [`${id}.source`, `${id}.normalized.wav`, `${id}.normalized.json`]) {
              if (sourceSet.has(name)) orphanNames.add(name);
            }
            continue;
          }
          if (hasMetadata && !hasSource) fail('CORRUPT_STORAGE');
          if (hasNormalized !== hasNormalizedMetadata) {
            if (hasNormalized) orphanNames.add(`${id}.normalized.wav`);
            if (hasNormalizedMetadata) orphanNames.add(`${id}.normalized.json`);
          }
        }
        for (const name of orphanNames) {
          const filePath = path.join(dirs.sources, name);
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('UNSAFE_STORAGE');
          if (info.mtimeMs <= now() - limits.temporaryTtlMs) {
            await unlink(filePath);
            cleanedOrphanFiles += 1;
          }
        }
        for (const name of await readdir(dirs.transcripts)) {
          if (!name.endsWith('.json')) fail('CORRUPT_STORAGE');
          const filePath = path.join(dirs.transcripts, name);
          const metadata = storedObject(await readJson(filePath, 2 * 1024 * 1024), [
            'contractVersion', 'id', 'tenantId', 'audioId', 'version', 'status', 'segments',
            'validatedAt', 'createdAt', 'updatedAt', 'expiresAt',
          ]);
          if (!Number.isSafeInteger(metadata.expiresAt) || !UUID.test(metadata.id) ||
              name !== `${metadata.id}.json` || metadata.tenantId !== context.tenantId) {
            fail('CORRUPT_STORAGE');
          }
          if (metadata.expiresAt <= now()) {
            await unlink(filePath);
            deletedTranscripts += 1;
          }
        }
        for (const name of await readdir(temporaryRoot)) {
          const filePath = path.join(temporaryRoot, name);
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
          if (info.mtimeMs <= now() - limits.temporaryTtlMs) {
            await unlink(filePath);
            cleanedTemporaryFiles += 1;
          }
        }
        return Object.freeze({
          deletedAudio, deletedTranscripts, cleanedTemporaryFiles, cleanedOrphanFiles,
        });
      });
    },
  });
  return service;
}
