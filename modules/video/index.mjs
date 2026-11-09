import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULTS = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxDurationSeconds: 600,
  maxWidth: 3840,
  maxHeight: 2160,
  maxConcurrentJobs: 2,
  maxTenantFiles: 100,
  maxTenantBytes: 512 * 1024 * 1024,
  maxStorageFiles: 1000,
  maxStorageBytes: 5 * 1024 * 1024 * 1024,
  maxOutputBytes: 24 * 1024 * 1024,
  jobTimeoutMs: 120_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  temporaryTtlMs: 60 * 60 * 1000,
});
const MIME_TYPES = Object.freeze({
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  matroska: 'video/x-matroska',
  webm: 'video/webm',
});

export class VideoModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VideoModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new VideoModuleError(code);
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

function validateLimits(value = {}) {
  exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...value };
  for (const [key, number] of Object.entries(limits)) {
    if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_CONFIGURATION');
    const maximum = key === 'maxInputBytes' ? 100 * 1024 * 1024 :
      key === 'maxDurationSeconds' ? 3600 :
        key === 'maxWidth' || key === 'maxHeight' ? 8192 :
          key === 'maxConcurrentJobs' ? 8 :
            key === 'maxTenantFiles' || key === 'maxStorageFiles' ? 100_000 :
              key === 'maxTenantBytes' || key === 'maxStorageBytes'
                ? 10 * 1024 * 1024 * 1024 :
                  key === 'maxOutputBytes' ? 64 * 1024 * 1024 :
                  key === 'jobTimeoutMs' ? 30 * 60 * 1000 : 365 * 24 * 60 * 60 * 1000;
    if (number > maximum) fail('INVALID_CONFIGURATION');
  }
  if (limits.maxTenantBytes > limits.maxStorageBytes ||
      limits.maxTenantFiles > limits.maxStorageFiles ||
      limits.maxInputBytes > limits.maxTenantBytes ||
      limits.maxOutputBytes > limits.maxTenantBytes ||
      limits.temporaryTtlMs <= limits.jobTimeoutMs) fail('INVALID_CONFIGURATION');
  return Object.freeze(limits);
}

function uuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
}

function positiveNumber(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(code);
  return value;
}

function validSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
  return signal;
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
  try {
    await assertNoSymlinkPath(directory, create);
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
    if (error instanceof VideoModuleError) throw error;
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

function mimeFor(formatName) {
  const formats = new Set(formatName.split(','));
  const isoBmff = new Set(['mp4', 'm4v', 'm4a', '3gp', '3g2', 'mj2', 'mov']);
  const matroska = new Set(['matroska', 'webm']);
  if ([...formats].every(format => isoBmff.has(format)) && formats.size > 0) {
    return [...formats].some(format => format !== 'mov') ? MIME_TYPES.mp4 : MIME_TYPES.mov;
  }
  if ([...formats].every(format => matroska.has(format)) && formats.size > 0) {
    return formats.has('webm') ? MIME_TYPES.webm : MIME_TYPES.matroska;
  }
  fail('UNSUPPORTED_CONTAINER');
}

async function fileHash(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function parseProbe(raw, limits) {
  let probe;
  try {
    probe = JSON.parse(raw);
  } catch {
    fail('INVALID_MEDIA');
  }
  if (!probe || typeof probe !== 'object' || Array.isArray(probe) ||
      !probe.format || typeof probe.format !== 'object' || Array.isArray(probe.format) ||
      !Array.isArray(probe.streams) || probe.streams.length > 32) fail('INVALID_MEDIA');
  const formatName = probe.format.format_name;
  if (typeof formatName !== 'string' || formatName.length > 128 || !/^[a-z0-9,]+$/u.test(formatName)) {
    fail('INVALID_MEDIA');
  }
  const mimeType = mimeFor(formatName);
  const durationSeconds = Number(probe.format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) fail('INVALID_MEDIA');
  if (durationSeconds > limits.maxDurationSeconds) fail('DURATION_LIMIT');
  const videoStreams = probe.streams.filter(stream => stream?.codec_type === 'video');
  const audioStreams = probe.streams.filter(stream => stream?.codec_type === 'audio');
  if (videoStreams.length !== 1) fail('INVALID_MEDIA');
  const video = videoStreams[0];
  if (!['h264', 'hevc', 'vp9', 'av1', 'mpeg4'].includes(video.codec_name)) fail('UNSUPPORTED_CODEC');
  if (!Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
      video.width < 1 || video.height < 1) fail('INVALID_MEDIA');
  if (video.width > limits.maxWidth || video.height > limits.maxHeight) fail('RESOLUTION_LIMIT');
  if (audioStreams.length > 1) fail('INVALID_MEDIA');
  const audioCodec = audioStreams[0]?.codec_name;
  if (audioCodec !== undefined && !['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'flac', 'pcm_s16le'].includes(audioCodec)) {
    fail('UNSUPPORTED_CODEC');
  }
  return Object.freeze({
    mimeType,
    durationSeconds,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioAvailable: audioStreams.length === 1,
  });
}

function validateStoredProbe(probe, limits) {
  safeMetadata(probe, ['mimeType', 'durationSeconds', 'width', 'height', 'videoCodec', 'audioAvailable']);
  if (!['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm'].includes(probe.mimeType) ||
      typeof probe.durationSeconds !== 'number' || !Number.isFinite(probe.durationSeconds) ||
      probe.durationSeconds <= 0 || probe.durationSeconds > limits.maxDurationSeconds ||
      !Number.isSafeInteger(probe.width) || probe.width < 1 || probe.width > limits.maxWidth ||
      !Number.isSafeInteger(probe.height) || probe.height < 1 || probe.height > limits.maxHeight ||
      !['h264', 'hevc', 'vp9', 'av1', 'mpeg4'].includes(probe.videoCodec) ||
      typeof probe.audioAvailable !== 'boolean') fail('CORRUPT_STORAGE');
}

function runEngine(executable, args, { timeoutMs, maxBytes, signal, outputTooLargeCode }) {
  if (signal?.aborted) return Promise.reject(new VideoModuleError('INTERRUPTED'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      reject(new VideoModuleError('ENGINE_UNAVAILABLE'));
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
      failure = new VideoModuleError(code);
      child.kill('SIGKILL');
    };
    const onAbort = () => stop('INTERRUPTED');
    const timer = setTimeout(() => stop('ENGINE_TIMEOUT'), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => finish(new VideoModuleError('ENGINE_UNAVAILABLE')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        stop(outputTooLargeCode);
        return;
      }
      chunks.push(chunk);
    });
    child.once('close', code => {
      if (failure) {
        finish(failure);
      } else if (code !== 0) {
        finish(new VideoModuleError('ENGINE_FAILED'));
      } else {
        finish(null, Buffer.concat(chunks, size));
      }
    });
    if (signal?.aborted) onAbort();
  });
}

function safeMetadata(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(value, key))) fail('CORRUPT_STORAGE');
  return value;
}

export const videoContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  processing: 'explicit-opt-in-only',
  storage: 'local-private-tenant-isolated',
  engines: Object.freeze({ probe: 'ffprobe', media: 'ffmpeg', shell: false }),
  supportedContainers: Object.freeze(['mp4', 'mov', 'matroska', 'webm']),
  supportedVideoCodecs: Object.freeze(['h264', 'hevc', 'vp9', 'av1', 'mpeg4']),
});

export async function createVideoService({
  directory,
  tenancy,
  audit,
  ffprobePath = 'ffprobe',
  ffmpegPath = 'ffmpeg',
  limits: configuredLimits,
  clock = () => Date.now(),
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      !tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      !audit || typeof audit.append !== 'function' ||
      typeof ffprobePath !== 'string' || ffprobePath.length < 1 || ffprobePath.length > 4096 ||
      typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.length > 4096 ||
      typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  const limits = validateLimits(configuredLimits);
  await ensurePrivateDirectory(directory, true);
  const sourcesRoot = await ensureChild(directory, 'sources');
  const artifactsRoot = await ensureChild(directory, 'artifacts');
  const temporaryRoot = await ensureChild(directory, 'temporary');
  let activeJobs = 0;
  const activeByTenant = new Map();
  const reservedTenantBytes = new Map();
  const reservedTenantFiles = new Map();
  let reservedStorageBytes = 0;
  let reservedStorageFiles = 0;

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
        cookieHeader: input.cookieHeader,
        tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    if (!context || context.contractVersion !== 1 || context.tenantId !== tenantId ||
        context.requestId !== input.requestId) fail('INVALID_TENANT_CONTEXT');
    try {
      await audit.append(context, { action, module: 'video' });
    } catch {
      fail('AUDIT_UNAVAILABLE');
    }
    return context;
  }

  async function tenantDirectories(tenantId) {
    return {
      sources: await ensureChild(sourcesRoot, tenantId),
      artifacts: await ensureChild(artifactsRoot, tenantId),
    };
  }

  async function usage() {
    let files = 0;
    let bytes = 0;
    for (const root of [sourcesRoot, artifactsRoot]) {
      for (const tenant of await readdir(root)) {
        const tenantPath = path.join(root, tenant);
        const tenantInfo = await lstat(tenantPath);
        if (!tenantInfo.isDirectory() || tenantInfo.isSymbolicLink() || (tenantInfo.mode & 0o077) !== 0) {
          fail('UNSAFE_STORAGE');
        }
        for (const name of await readdir(tenantPath)) {
          if (name.endsWith('.json')) continue;
          const itemPath = path.join(tenantPath, name);
          const info = await lstat(itemPath);
          if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
          files += 1;
          bytes += info.size;
        }
      }
    }
    return { files, bytes };
  }

  async function reserveQuota(tenantId, addedBytes, addedFiles = 1) {
    const totals = await usage();
    const dirs = await tenantDirectories(tenantId);
    let tenantFiles = 0;
    let tenantBytes = 0;
    for (const dir of Object.values(dirs)) {
      for (const name of await readdir(dir)) {
        if (name.endsWith('.json')) continue;
        const info = await lstat(path.join(dir, name));
        if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
        tenantFiles += 1;
        tenantBytes += info.size;
      }
    }
    const tenantReservedBytes = reservedTenantBytes.get(tenantId) ?? 0;
    const tenantReservedFiles = reservedTenantFiles.get(tenantId) ?? 0;
    if (tenantFiles + tenantReservedFiles + addedFiles > limits.maxTenantFiles ||
        tenantBytes + tenantReservedBytes + addedBytes > limits.maxTenantBytes) fail('QUOTA_EXCEEDED');
    if (totals.files + reservedStorageFiles + addedFiles > limits.maxStorageFiles ||
        totals.bytes + reservedStorageBytes + addedBytes > limits.maxStorageBytes) fail('STORAGE_LIMIT');
    reservedTenantBytes.set(tenantId, tenantReservedBytes + addedBytes);
    reservedTenantFiles.set(tenantId, tenantReservedFiles + addedFiles);
    reservedStorageBytes += addedBytes;
    reservedStorageFiles += addedFiles;
    return () => {
      const currentBytes = reservedTenantBytes.get(tenantId) - addedBytes;
      const currentFiles = reservedTenantFiles.get(tenantId) - addedFiles;
      if (currentBytes === 0) reservedTenantBytes.delete(tenantId);
      else reservedTenantBytes.set(tenantId, currentBytes);
      if (currentFiles === 0) reservedTenantFiles.delete(tenantId);
      else reservedTenantFiles.set(tenantId, currentFiles);
      reservedStorageBytes -= addedBytes;
      reservedStorageFiles -= addedFiles;
    };
  }

  async function withJob(tenantId, signal, work) {
    if (signal?.aborted) fail('INTERRUPTED');
    const currentTenant = activeByTenant.get(tenantId) ?? 0;
    if (activeJobs >= limits.maxConcurrentJobs || currentTenant >= limits.maxConcurrentJobs) fail('JOB_LIMIT');
    activeJobs += 1;
    activeByTenant.set(tenantId, currentTenant + 1);
    try {
      return await work();
    } finally {
      activeJobs -= 1;
      const count = activeByTenant.get(tenantId) - 1;
      if (count === 0) activeByTenant.delete(tenantId);
      else activeByTenant.set(tenantId, count);
    }
  }

  async function getVideo(tenantId, videoId) {
    const dirs = await tenantDirectories(tenantId);
    const metaPath = path.join(dirs.sources, `${videoId}.json`);
    const sourcePath = path.join(dirs.sources, `${videoId}.source`);
    let metadata;
    try {
      const metadataInfo = await lstat(metaPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) fail('UNSAFE_STORAGE');
      metadata = safeMetadata(JSON.parse(await readFile(metaPath, 'utf8')),
        ['contractVersion', 'id', 'tenantId', 'probe', 'sourceHash', 'sourceBytes', 'createdAt', 'expiresAt']);
    } catch (error) {
      if (error instanceof VideoModuleError) throw error;
      if (error.code === 'ENOENT') fail('NOT_FOUND');
      fail('CORRUPT_STORAGE');
    }
    if (metadata.contractVersion !== CONTRACT_VERSION || metadata.id !== videoId ||
        metadata.tenantId !== tenantId || !HASH.test(metadata.sourceHash) ||
        !Number.isSafeInteger(metadata.sourceBytes) || metadata.sourceBytes < 16 ||
        metadata.sourceBytes > limits.maxInputBytes ||
        !Number.isSafeInteger(metadata.expiresAt)) fail('CORRUPT_STORAGE');
    validateStoredProbe(metadata.probe, limits);
    if (metadata.expiresAt <= now()) fail('NOT_FOUND');
    const sourceInfo = await lstat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== metadata.sourceBytes) {
      fail('CORRUPT_STORAGE');
    }
    if (await fileHash(sourcePath) !== metadata.sourceHash) fail('CORRUPT_STORAGE');
    return { metadata, sourcePath, dirs };
  }

  async function storeArtifact(tenantId, videoId, kind, mimeType, extension, data, signal) {
    if (signal?.aborted) fail('INTERRUPTED');
    const artifactId = randomUUID();
    const dirs = await tenantDirectories(tenantId);
    const artifactPath = path.join(dirs.artifacts, `${artifactId}.${extension}`);
    const temporaryPath = path.join(temporaryRoot, `${randomUUID()}.output`);
    const createdAt = now();
    const expiresAt = createdAt + limits.retentionMs;
    if (!Number.isSafeInteger(expiresAt)) fail('TIME_RANGE');
    const releaseQuota = await reserveQuota(tenantId, data.length);
    try {
      if (signal?.aborted) fail('INTERRUPTED');
      await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o600 });
      if (signal?.aborted) fail('INTERRUPTED');
      await rename(temporaryPath, artifactPath);
      if (signal?.aborted) fail('INTERRUPTED');
      const metadata = {
        contractVersion: CONTRACT_VERSION, id: artifactId, tenantId, videoId, kind, mimeType,
        sha256: sha256(data), size: data.length, createdAt, expiresAt,
      };
      await writeFile(path.join(dirs.artifacts, `${artifactId}.json`), JSON.stringify(metadata), {
        flag: 'wx', mode: 0o600,
      });
      if (signal?.aborted) fail('INTERRUPTED');
      return Object.freeze({
        id: artifactId, videoId, kind, contentType: mimeType, size: data.length,
        sha256: metadata.sha256, expiresAt,
      });
    } catch (error) {
      await unlink(artifactPath).catch(() => {});
      await unlink(path.join(dirs.artifacts, `${artifactId}.json`)).catch(() => {});
      if (error instanceof VideoModuleError) throw error;
      fail('STORAGE_UNAVAILABLE');
    } finally {
      releaseQuota();
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async function runVideoOperation(input, kind) {
    const allowed = kind === 'frame' || kind === 'thumbnail'
      ? ['cookieHeader', 'tenantId', 'requestId', 'videoId', 'atSeconds', ...(kind === 'thumbnail' ? ['width'] : []), 'signal']
      : ['cookieHeader', 'tenantId', 'requestId', 'videoId', 'signal'];
    const required = kind === 'frame' || kind === 'thumbnail'
      ? ['cookieHeader', 'tenantId', 'requestId', 'videoId', 'atSeconds']
      : ['cookieHeader', 'tenantId', 'requestId', 'videoId'];
    exactObject(input, allowed, required);
    validSignal(input.signal);
    const context = await authorize(input, `video.${kind}`);
    const videoId = uuid(input.videoId);
    return withJob(context.tenantId, input.signal, async () => {
      const { metadata, sourcePath } = await getVideo(context.tenantId, videoId);
      let args;
      let mimeType;
      let extension;
      if (kind === 'audio') {
        if (!metadata.probe.audioAvailable) fail('AUDIO_UNAVAILABLE');
        args = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-threads', '1', '-i', sourcePath, '-threads', '1', '-map', '0:a:0', '-vn',
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'];
        mimeType = 'audio/wav';
        extension = 'wav';
      } else {
        const atSeconds = positiveNumber(input.atSeconds);
        if (atSeconds >= metadata.probe.durationSeconds) fail('TIME_RANGE');
        let filters = 'format=rgb24';
        if (kind === 'thumbnail') {
          const width = input.width ?? 320;
          if (!Number.isSafeInteger(width) || width < 16 || width > 1024) fail('INVALID_INPUT');
          filters = `scale='min(${width},iw)':-2,format=rgb24`;
        }
        args = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-threads', '1', '-filter_threads', '1', '-i', sourcePath, '-threads', '1',
          '-ss', atSeconds.toFixed(3),
          '-frames:v', '1', '-vf', filters, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
        mimeType = 'image/png';
        extension = 'png';
      }
      const data = await runEngine(ffmpegPath, args, {
        timeoutMs: limits.jobTimeoutMs,
        maxBytes: limits.maxOutputBytes,
        signal: input.signal,
        outputTooLargeCode: 'OUTPUT_TOO_LARGE',
      });
      if (input.signal?.aborted) fail('INTERRUPTED');
      if (kind === 'audio') {
        if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' ||
            data.toString('ascii', 8, 12) !== 'WAVE') fail('INVALID_ENGINE_OUTPUT');
      } else if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fail('INVALID_ENGINE_OUTPUT');
      }
      return storeArtifact(context.tenantId, videoId, kind, mimeType, extension, data, input.signal);
    });
  }

  return Object.freeze({
    async ingest(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'consent', 'video', 'signal'],
        ['cookieHeader', 'tenantId', 'requestId', 'consent', 'video']);
      validSignal(input.signal);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      if (!Buffer.isBuffer(input.video) &&
          (!(input.video instanceof Uint8Array) || Object.getPrototypeOf(input.video) !== Uint8Array.prototype)) {
        fail('INVALID_INPUT');
      }
      if (input.video.byteLength < 16) fail('INVALID_MEDIA');
      if (input.video.byteLength > limits.maxInputBytes) fail('FILE_TOO_LARGE');
      const video = Buffer.from(input.video);
      const context = await authorize(input, 'video.ingest');
      return withJob(context.tenantId, input.signal, async () => {
        const id = randomUUID();
        const dirs = await tenantDirectories(context.tenantId);
        const temporaryPath = path.join(temporaryRoot, `${randomUUID()}.input`);
        const sourcePath = path.join(dirs.sources, `${id}.source`);
        const createdAt = now();
        const expiresAt = createdAt + limits.retentionMs;
        if (!Number.isSafeInteger(expiresAt)) fail('TIME_RANGE');
        const releaseQuota = await reserveQuota(context.tenantId, video.length);
        try {
          await writeFile(temporaryPath, video, { flag: 'wx', mode: 0o600 });
          const raw = await runEngine(ffprobePath, [
            '-v', 'error', '-show_entries',
            'format=format_name,duration:stream=codec_type,codec_name,width,height',
            '-of', 'json', '-protocol_whitelist', 'file,pipe', temporaryPath,
          ], {
            timeoutMs: limits.jobTimeoutMs,
            maxBytes: 16 * 1024,
            signal: input.signal,
            outputTooLargeCode: 'INVALID_MEDIA',
          });
          const probe = parseProbe(raw.toString('utf8'), limits);
          if (input.signal?.aborted) fail('INTERRUPTED');
          await rename(temporaryPath, sourcePath);
          const metadata = {
            contractVersion: CONTRACT_VERSION, id, tenantId: context.tenantId, probe,
            sourceHash: sha256(video), sourceBytes: video.length, createdAt, expiresAt,
          };
          await writeFile(path.join(dirs.sources, `${id}.json`), JSON.stringify(metadata), {
            flag: 'wx', mode: 0o600,
          });
          return Object.freeze({
            id, ...probe, sourceBytes: video.length, expiresAt,
          });
        } catch (error) {
          await unlink(temporaryPath).catch(() => {});
          await unlink(sourcePath).catch(() => {});
          await unlink(path.join(dirs.sources, `${id}.json`)).catch(() => {});
          if (error instanceof VideoModuleError) throw error;
          fail('STORAGE_UNAVAILABLE');
        } finally {
          releaseQuota();
          await unlink(temporaryPath).catch(() => {});
        }
      });
    },
    frame(input) {
      return runVideoOperation(input, 'frame');
    },
    thumbnail(input) {
      return runVideoOperation(input, 'thumbnail');
    },
    extractAudio(input) {
      return runVideoOperation(input, 'audio');
    },
    async readArtifact(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'artifactId']);
      const context = await authorize(input, 'video.artifact.read');
      const artifactId = uuid(input.artifactId);
      const dirs = await tenantDirectories(context.tenantId);
      const metaPath = path.join(dirs.artifacts, `${artifactId}.json`);
      let metadata;
      try {
        const metadataInfo = await lstat(metaPath);
        if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) fail('UNSAFE_STORAGE');
        metadata = safeMetadata(JSON.parse(await readFile(metaPath, 'utf8')),
          ['contractVersion', 'id', 'tenantId', 'videoId', 'kind', 'mimeType', 'sha256', 'size', 'createdAt', 'expiresAt']);
      } catch (error) {
        if (error instanceof VideoModuleError) throw error;
        if (error.code === 'ENOENT') fail('NOT_FOUND');
        fail('CORRUPT_STORAGE');
      }
      if (metadata.contractVersion !== CONTRACT_VERSION || metadata.id !== artifactId ||
          metadata.tenantId !== context.tenantId || !HASH.test(metadata.sha256) ||
          !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
          metadata.size > limits.maxOutputBytes ||
          !UUID.test(metadata.videoId) || !Number.isSafeInteger(metadata.createdAt) ||
          !Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= metadata.createdAt ||
          !['frame', 'thumbnail', 'audio'].includes(metadata.kind) ||
          metadata.mimeType !== (metadata.kind === 'audio' ? 'audio/wav' : 'image/png')) {
        fail('CORRUPT_STORAGE');
      }
      if (metadata.expiresAt <= now()) fail('NOT_FOUND');
      const extension = metadata.kind === 'audio' ? 'wav' : 'png';
      const filePath = path.join(dirs.artifacts, `${artifactId}.${extension}`);
      let data;
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== metadata.size) fail('CORRUPT_STORAGE');
        data = await readFile(filePath);
      } catch (error) {
        if (error instanceof VideoModuleError) throw error;
        if (error.code === 'ENOENT') fail('NOT_FOUND');
        fail('STORAGE_UNAVAILABLE');
      }
      if (sha256(data) !== metadata.sha256) fail('CORRUPT_STORAGE');
      return Object.freeze({ contentType: metadata.mimeType, data });
    },
    async purgeExpired(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId']);
      const context = await authorize(input, 'video.retention');
      const currentTime = now();
      const dirs = await tenantDirectories(context.tenantId);
      let deletedVideos = 0;
      let deletedArtifacts = 0;
      for (const [dir, type] of [[dirs.sources, 'source'], [dirs.artifacts, 'artifact']]) {
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.json')) continue;
          const id = name.slice(0, -5);
          if (!UUID.test(id)) fail('UNSAFE_STORAGE');
          const metadataPath = path.join(dir, name);
          const metadataInfo = await lstat(metadataPath);
          if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) fail('UNSAFE_STORAGE');
          let metadata;
          try {
            metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
          } catch {
            fail('CORRUPT_STORAGE');
          }
          const fields = type === 'source'
            ? ['contractVersion', 'id', 'tenantId', 'probe', 'sourceHash', 'sourceBytes', 'createdAt', 'expiresAt']
            : ['contractVersion', 'id', 'tenantId', 'videoId', 'kind', 'mimeType', 'sha256', 'size', 'createdAt', 'expiresAt'];
          safeMetadata(metadata, fields);
          if (metadata.contractVersion !== CONTRACT_VERSION || metadata.id !== id ||
              metadata.tenantId !== context.tenantId || !Number.isSafeInteger(metadata.createdAt) ||
              !Number.isSafeInteger(metadata.expiresAt) || metadata.expiresAt <= metadata.createdAt) {
            fail('CORRUPT_STORAGE');
          }
          if (type === 'source' && (!HASH.test(metadata.sourceHash) ||
              !Number.isSafeInteger(metadata.sourceBytes) || metadata.sourceBytes < 16 ||
              metadata.sourceBytes > limits.maxInputBytes)) {
            fail('CORRUPT_STORAGE');
          }
          if (type === 'source') validateStoredProbe(metadata.probe, limits);
          if (type === 'artifact' && (!UUID.test(metadata.videoId) || !HASH.test(metadata.sha256) ||
              !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
              metadata.size > limits.maxOutputBytes ||
              !['frame', 'thumbnail', 'audio'].includes(metadata.kind) ||
              metadata.mimeType !== (metadata.kind === 'audio' ? 'audio/wav' : 'image/png'))) {
            fail('CORRUPT_STORAGE');
          }
          if (metadata.expiresAt > currentTime) continue;
          const extension = type === 'source' ? 'source' : metadata.kind === 'audio' ? 'wav' : 'png';
          await unlink(path.join(dir, `${id}.${extension}`)).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
          await unlink(metadataPath);
          if (type === 'source') deletedVideos += 1;
          else deletedArtifacts += 1;
        }
      }
      let cleanedTemporaryFiles = 0;
      for (const name of await readdir(temporaryRoot)) {
        if (!/^[0-9a-f-]{36}\.(?:input|output)$/u.test(name)) fail('UNSAFE_STORAGE');
        const itemPath = path.join(temporaryRoot, name);
        const info = await lstat(itemPath);
        if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_STORAGE');
        if (info.mtimeMs + limits.temporaryTtlMs <= currentTime) {
          await unlink(itemPath);
          cleanedTemporaryFiles += 1;
        }
      }
      return Object.freeze({ deletedVideos, deletedArtifacts, cleanedTemporaryFiles });
    },
  });
}
