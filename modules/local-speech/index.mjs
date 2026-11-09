import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const DEFAULTS = Object.freeze({
  maxInputBytes: 24 * 1024 * 1024,
  maxOutputBytes: 24 * 1024 * 1024,
  maxTextCodeUnits: 20_000,
  maxDurationSeconds: 600,
  timeoutMs: 120_000,
});
const HASH = /^[a-f0-9]{64}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u;

export class LocalSpeechError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalSpeechError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalSpeechError(code);
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
  return value;
}

function validateLimits(value = {}) {
  exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...value };
  const maximums = {
    maxInputBytes: 100 * 1024 * 1024,
    maxOutputBytes: 64 * 1024 * 1024,
    maxTextCodeUnits: 100_000,
    maxDurationSeconds: 3600,
    timeoutMs: 30 * 60 * 1000,
  };
  for (const [key, maximum] of Object.entries(maximums)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) {
      fail('INVALID_CONFIGURATION');
    }
  }
  return Object.freeze(limits);
}

function validateArtifact(value) {
  exactObject(value, ['path', 'version', 'license', 'sizeBytes', 'sha256', 'minimumMemoryBytes']);
  if (typeof value.path !== 'string' || !path.isAbsolute(value.path) ||
      path.resolve(value.path) !== value.path || /[\0-\x1f\x7f]/u.test(value.path) ||
      typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/u.test(value.version) ||
      typeof value.license !== 'string' || value.license.length < 1 || value.license.length > 100 ||
      /[\0-\x1f\x7f]/u.test(value.license) ||
      !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 ||
      value.sizeBytes > 10 * 1024 * 1024 * 1024 ||
      typeof value.sha256 !== 'string' || !HASH.test(value.sha256) ||
      !Number.isSafeInteger(value.minimumMemoryBytes) || value.minimumMemoryBytes < value.sizeBytes ||
      value.minimumMemoryBytes > 64 * 1024 * 1024 * 1024) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze({ ...value });
}

function validateModel(value, requireVoiceConfig = false) {
  exactObject(value, ['path', 'version', 'license', 'sizeBytes', 'sha256', 'minimumMemoryBytes', 'voiceConfig'],
    requireVoiceConfig
      ? ['path', 'version', 'license', 'sizeBytes', 'sha256', 'minimumMemoryBytes', 'voiceConfig']
      : ['path', 'version', 'license', 'sizeBytes', 'sha256', 'minimumMemoryBytes']);
  const model = validateArtifact({
    path: value.path,
    version: value.version,
    license: value.license,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    minimumMemoryBytes: value.minimumMemoryBytes,
  });
  if (value.voiceConfig !== undefined) {
    const voiceConfig = validateArtifact(value.voiceConfig);
    if (voiceConfig.path !== `${model.path}.json`) fail('INVALID_CONFIGURATION');
    return Object.freeze({ ...model, voiceConfig });
  }
  return model;
}

function validateExecutable(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
      /[\0-\x1f\x7f]/u.test(value) ||
      (!path.isAbsolute(value) && !/^[A-Za-z0-9._-]+$/u.test(value)) ||
      (path.isAbsolute(value) && path.resolve(value) !== value)) {
    fail('INVALID_CONFIGURATION');
  }
  return value;
}

function validateLanguages(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length === 0 || value.length > 32 ||
      Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_CONFIGURATION');
  const languages = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || !LANGUAGE.test(descriptor.value) ||
        languages.includes(descriptor.value)) fail('INVALID_CONFIGURATION');
    languages.push(descriptor.value);
  }
  return Object.freeze(languages);
}

function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
}

function parseWav(value, maxBytes) {
  if (!Buffer.isBuffer(value) || value.length < 44 || value.length > maxBytes ||
      value.toString('ascii', 0, 4) !== 'RIFF' || value.toString('ascii', 8, 12) !== 'WAVE' ||
      value.readUInt32LE(4) + 8 !== value.length) fail('INVALID_AUDIO');
  let format;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= value.length) {
    const chunkName = value.toString('ascii', offset, offset + 4);
    const chunkSize = value.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkSize;
    if (end > value.length) fail('INVALID_AUDIO');
    if (chunkName === 'fmt ' && chunkSize >= 16 && format === undefined) {
      format = {
        encoding: value.readUInt16LE(start),
        channels: value.readUInt16LE(start + 2),
        sampleRate: value.readUInt32LE(start + 4),
        blockAlign: value.readUInt16LE(start + 12),
        bitsPerSample: value.readUInt16LE(start + 14),
      };
    } else if (chunkName === 'data') {
      dataBytes += chunkSize;
    }
    offset = end + (chunkSize % 2);
  }
  if (offset !== value.length || !format || dataBytes < 1) fail('INVALID_AUDIO');
  return Object.freeze({ ...format, dataBytes });
}

function validateAudio(value, durationSeconds, limits) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      durationSeconds > limits.maxDurationSeconds) fail('INVALID_AUDIO');
  const wav = parseWav(value, limits.maxInputBytes);
  const actualDuration = wav.dataBytes / (wav.sampleRate * wav.channels * wav.bitsPerSample / 8);
  if (wav.encoding !== 1 || wav.channels !== 1 || wav.sampleRate !== 16000 ||
      wav.blockAlign !== 2 || wav.bitsPerSample !== 16 ||
      actualDuration <= 0 || actualDuration > limits.maxDurationSeconds ||
      Math.abs(actualDuration - durationSeconds) > Math.max(0.1, durationSeconds * 0.01)) {
    fail('INVALID_AUDIO');
  }
}

async function verifyModel(model) {
  let info;
  try {
    info = await lstat(model.path);
  } catch {
    fail('MODEL_UNAVAILABLE');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== model.sizeBytes) {
    fail('MODEL_INTEGRITY_FAILED');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(model.path)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch {
    fail('MODEL_UNAVAILABLE');
  }
  if (bytes !== model.sizeBytes || hash.digest('hex') !== model.sha256) {
    fail('MODEL_INTEGRITY_FAILED');
  }
}

function runProcess(executable, args, { timeoutMs, signal, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LocalSpeechError('INTERRUPTED'));
      return;
    }
    let child;
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      });
    } catch {
      reject(new LocalSpeechError('ENGINE_UNAVAILABLE'));
      return;
    }
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(new LocalSpeechError('INTERRUPTED'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new LocalSpeechError('ENGINE_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(new LocalSpeechError(
      error.code === 'ENOENT' ? 'ENGINE_UNAVAILABLE' : 'ENGINE_FAILED',
    )));
    child.once('close', code => finish(code === 0 ? undefined : new LocalSpeechError('ENGINE_FAILED')));
    if (signal?.aborted) {
      abort();
      return;
    }
    if (input !== undefined) {
      child.stdin.once('error', () => finish(new LocalSpeechError('ENGINE_FAILED')));
      child.stdin.end(input);
    }
  });
}

async function withTemporaryDirectory(operation) {
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'saasfactory-speech-'));
    return await operation(directory);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function validateSegments(value, durationSeconds, maxTextCodeUnits) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 1000 || Reflect.ownKeys(value).length !== value.length + 1) {
    fail('INVALID_ENGINE_OUTPUT');
  }
  let previousEnd = 0;
  let totalText = 0;
  const segments = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_ENGINE_OUTPUT');
    const segment = exactObject(descriptor.value, ['startSeconds', 'endSeconds', 'text']);
    if (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
        segment.startSeconds < previousEnd || segment.endSeconds <= segment.startSeconds ||
        segment.endSeconds > durationSeconds + 0.05 ||
        typeof segment.text !== 'string' || segment.text.length === 0 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r\n]/u.test(segment.text)) {
      fail('INVALID_ENGINE_OUTPUT');
    }
    const text = segment.text.normalize('NFC').trim();
    totalText += text.length;
    if (!text || totalText > maxTextCodeUnits) fail('INVALID_ENGINE_OUTPUT');
    segments.push(Object.freeze({
      startSeconds: segment.startSeconds,
      endSeconds: Math.min(segment.endSeconds, durationSeconds),
      text,
    }));
    previousEnd = segment.endSeconds;
  }
  return Object.freeze(segments);
}

function parseWhisperJson(data, durationSeconds, maxTextCodeUnits) {
  let result;
  try {
    result = JSON.parse(data.toString('utf8'));
  } catch {
    fail('INVALID_ENGINE_OUTPUT');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !Array.isArray(result.transcription) || result.transcription.length > 1000) {
    fail('INVALID_ENGINE_OUTPUT');
  }
  const segments = result.transcription.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !item.offsets || typeof item.offsets !== 'object' ||
        !Number.isSafeInteger(item.offsets.from) || !Number.isSafeInteger(item.offsets.to) ||
        typeof item.text !== 'string') fail('INVALID_ENGINE_OUTPUT');
    return {
      startSeconds: item.offsets.from / 1000,
      endSeconds: item.offsets.to / 1000,
      text: item.text.trim(),
    };
  });
  return validateSegments(segments, durationSeconds, maxTextCodeUnits);
}

function validateWav(data, maxOutputBytes) {
  let wav;
  try {
    wav = parseWav(data, maxOutputBytes);
  } catch {
    fail('INVALID_ENGINE_OUTPUT');
  }
  if (wav.encoding !== 1 || wav.channels !== 1 || wav.bitsPerSample !== 16 ||
      wav.sampleRate < 8000 || wav.sampleRate > 192000 || wav.blockAlign !== 2) {
    fail('INVALID_ENGINE_OUTPUT');
  }
  return data;
}

function asrEngineMetadata(name, runtimeVersion, model, languages) {
  return Object.freeze({
    engine: name,
    runtimeVersion,
    model: Object.freeze({
      version: model.version,
      license: model.license,
      sizeBytes: model.sizeBytes,
      sha256: model.sha256,
      minimumMemoryBytes: model.minimumMemoryBytes,
    }),
    languages,
    timestamps: true,
    offline: true,
    cpuSupported: true,
  });
}

export function createWhisperCppAsrEngine(options) {
  const config = exactObject(options, [
    'executable', 'runtimeVersion', 'model', 'languages', 'timeoutMs',
    'maxInputBytes', 'maxOutputBytes', 'maxTextCodeUnits',
  ], ['executable', 'runtimeVersion', 'model', 'languages']);
  const executable = validateExecutable(config.executable);
  if (typeof config.runtimeVersion !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/u.test(config.runtimeVersion)) {
    fail('INVALID_CONFIGURATION');
  }
  const model = validateModel(config.model);
  const languages = validateLanguages(config.languages);
  const limits = validateLimits(Object.fromEntries(
    Object.entries(config).filter(([key]) => Object.hasOwn(DEFAULTS, key)),
  ));
  const metadata = asrEngineMetadata('whisper.cpp', config.runtimeVersion, model, languages);
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    kind: 'asr',
    metadata,
    async transcribe(input) {
      exactObject(input, ['consent', 'audio', 'durationSeconds', 'language', 'signal'],
        ['consent', 'audio', 'durationSeconds', 'language']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      validateSignal(input.signal);
      validateAudio(input.audio, input.durationSeconds, limits);
      if (typeof input.language !== 'string' || !languages.includes(input.language)) {
        fail('UNSUPPORTED_LANGUAGE');
      }
      if (input.signal?.aborted) fail('INTERRUPTED');
      await verifyModel(model);
      return withTemporaryDirectory(async directory => {
        const audioPath = path.join(directory, 'audio.wav');
        const outputBase = path.join(directory, 'transcription');
        const outputPath = `${outputBase}.json`;
        await writeFile(audioPath, input.audio, { flag: 'wx', mode: 0o600 });
        await runProcess(executable, [
          '-m', model.path, '-f', audioPath, '-oj', '-of', outputBase, '-l', input.language,
        ], { timeoutMs: limits.timeoutMs, signal: input.signal });
        const info = await lstat(outputPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.size > limits.maxOutputBytes) {
          fail('INVALID_ENGINE_OUTPUT');
        }
        return parseWhisperJson(
          await readFile(outputPath),
          input.durationSeconds,
          limits.maxTextCodeUnits,
        );
      });
    },
  });
}

export function createPiperTtsEngine(options) {
  const config = exactObject(options, [
    'executable', 'runtimeVersion', 'model', 'timeoutMs', 'maxOutputBytes', 'maxTextCodeUnits',
  ], ['executable', 'runtimeVersion', 'model']);
  const executable = validateExecutable(config.executable);
  if (typeof config.runtimeVersion !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/u.test(config.runtimeVersion)) {
    fail('INVALID_CONFIGURATION');
  }
  const model = validateModel(config.model, true);
  const limits = validateLimits(Object.fromEntries(
    Object.entries(config).filter(([key]) => Object.hasOwn(DEFAULTS, key)),
  ));
  const metadata = Object.freeze({
    engine: 'piper',
    runtimeVersion: config.runtimeVersion,
    model: Object.freeze({
      version: model.version,
      license: model.license,
      sizeBytes: model.sizeBytes,
      sha256: model.sha256,
      minimumMemoryBytes: model.minimumMemoryBytes,
      voiceConfig: Object.freeze({
        version: model.voiceConfig.version,
        license: model.voiceConfig.license,
        sizeBytes: model.voiceConfig.sizeBytes,
        sha256: model.voiceConfig.sha256,
        minimumMemoryBytes: model.voiceConfig.minimumMemoryBytes,
      }),
    }),
    timestamps: false,
    offline: true,
    cpuSupported: true,
  });
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    kind: 'tts',
    metadata,
    async synthesize(input) {
      exactObject(input, ['consent', 'text', 'signal'], ['consent', 'text']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      validateSignal(input.signal);
      if (typeof input.text !== 'string' || input.text.trim().length === 0 ||
          input.text.length > limits.maxTextCodeUnits ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)) fail('INVALID_TEXT');
      if (Buffer.byteLength(input.text, 'utf8') > limits.maxInputBytes) fail('INPUT_LIMIT');
      if (input.signal?.aborted) fail('INTERRUPTED');
      await verifyModel(model);
      await verifyModel(model.voiceConfig);
      return withTemporaryDirectory(async directory => {
        const outputPath = path.join(directory, 'speech.wav');
        await runProcess(executable, [
          '--model', model.path, '--output_file', outputPath,
        ], { timeoutMs: limits.timeoutMs, signal: input.signal, input: input.text.trim() });
        const info = await lstat(outputPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.size > limits.maxOutputBytes) {
          fail('INVALID_ENGINE_OUTPUT');
        }
        const data = validateWav(await readFile(outputPath), limits.maxOutputBytes);
        return Object.freeze({ contentType: 'audio/wav', data });
      });
    },
  });
}

export function createLocalSpeechService(options) {
  const config = exactObject(options, ['asrEngine', 'ttsEngine', 'limits'], ['asrEngine']);
  const limits = validateLimits(config.limits);
  if (!config.asrEngine || config.asrEngine.contractVersion !== CONTRACT_VERSION ||
      config.asrEngine.kind !== 'asr' || typeof config.asrEngine.transcribe !== 'function' ||
      !config.asrEngine.metadata || config.asrEngine.metadata.offline !== true ||
      config.asrEngine.metadata.timestamps !== true) fail('INVALID_CONFIGURATION');
  if (config.ttsEngine !== undefined &&
      (!config.ttsEngine || config.ttsEngine.contractVersion !== CONTRACT_VERSION ||
       config.ttsEngine.kind !== 'tts' || typeof config.ttsEngine.synthesize !== 'function' ||
       !config.ttsEngine.metadata || config.ttsEngine.metadata.offline !== true)) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    moduleVersion: MODULE_VERSION,
    async transcribe(input) {
      exactObject(input, ['consent', 'audio', 'durationSeconds', 'language', 'signal'],
        ['consent', 'audio', 'durationSeconds', 'language']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      validateSignal(input.signal);
      validateAudio(input.audio, input.durationSeconds, limits);
      if (input.signal?.aborted) fail('INTERRUPTED');
      let segments;
      try {
        segments = await config.asrEngine.transcribe({
          consent: true,
          audio: input.audio,
          durationSeconds: input.durationSeconds,
          language: input.language,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof LocalSpeechError) throw error;
        fail('ENGINE_FAILED');
      }
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        status: 'draft',
        source: 'local-model',
        metadata: config.asrEngine.metadata,
        segments: validateSegments(segments, input.durationSeconds, limits.maxTextCodeUnits),
      });
    },
    async synthesize(input) {
      exactObject(input, ['consent', 'text', 'signal'], ['consent', 'text']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      if (!config.ttsEngine) fail('TTS_UNAVAILABLE');
      validateSignal(input.signal);
      if (typeof input.text !== 'string' || input.text.trim().length === 0 ||
          input.text.length > limits.maxTextCodeUnits ||
          Buffer.byteLength(input.text, 'utf8') > limits.maxInputBytes) fail('INVALID_TEXT');
      if (input.signal?.aborted) fail('INTERRUPTED');
      let result;
      try {
        result = await config.ttsEngine.synthesize({
          consent: true,
          text: input.text,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof LocalSpeechError) throw error;
        fail('ENGINE_FAILED');
      }
      const data = validateWav(result?.data, limits.maxOutputBytes);
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        source: 'local-model',
        metadata: config.ttsEngine.metadata,
        contentType: 'audio/wav',
        data,
      });
    },
  });
}

export function createDeterministicSpeechDemo() {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    kind: 'demo',
    async demonstrate(input) {
      exactObject(input, ['consent']);
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        source: 'demo-only',
        label: 'DEMONSTRATION — NOT A TRANSCRIPTION OR SYNTHESIS',
        text: 'Exemple vocal déterministe (simulation uniquement).',
      });
    },
  });
}

export const localSpeechContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  engines: Object.freeze({
    asr: Object.freeze({ name: 'whisper.cpp', offline: true, cpuSupported: true, timestamps: true }),
    tts: Object.freeze({ name: 'Piper', offline: true, cpuSupported: true, timestamps: false }),
  }),
  requiredModelMetadata: Object.freeze([
    'version', 'license', 'sizeBytes', 'sha256', 'minimumMemoryBytes',
  ]),
  networkRequired: false,
  defaultEnabled: false,
});
