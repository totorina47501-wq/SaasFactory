import { spawnSync } from 'node:child_process';

export const LOCAL_RUNTIME_CONTRACT_VERSION = 1;

const CONFIG_FIELDS = ['contractVersion', 'appSlug', 'appPort', 'postgres', 'optional'];
const POSTGRES_FIELDS = ['hostPort'];
const OPTIONAL_FIELDS = ['media', 'localModel', 'cache'];
const DIAGNOSTIC_FIELDS = ['nodeVersion', 'probe', 'modelProbe'];
const APP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export class LocalRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimeError';
    this.code = code;
  }
}

function readDataObject(value, fields) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string')) return undefined;
    const result = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function readOptionalDataObject(value, fields) {
  if (value === undefined) return {};
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !fields.includes(key))) return undefined;
    const result = {};
    for (const field of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function validateLocalRuntimeConfig(value) {
  const config = readDataObject(value, CONFIG_FIELDS);
  const postgres = readDataObject(config?.postgres, POSTGRES_FIELDS);
  const optional = readDataObject(config?.optional, OPTIONAL_FIELDS);
  if (!config ||
      config.contractVersion !== LOCAL_RUNTIME_CONTRACT_VERSION ||
      typeof config.appSlug !== 'string' || config.appSlug.length > 48 || !APP_SLUG.test(config.appSlug) ||
      !isPort(config.appPort) ||
      !postgres ||
      !isPort(postgres.hostPort) ||
      !optional ||
      OPTIONAL_FIELDS.some(field => typeof optional[field] !== 'boolean')) {
    throw new LocalRuntimeError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    contractVersion: LOCAL_RUNTIME_CONTRACT_VERSION,
    appSlug: config.appSlug,
    appPort: config.appPort,
    postgres: Object.freeze(postgres),
    optional: Object.freeze(optional),
  });
}

function probeExecutable(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 16384,
      windowsHide: true,
    });
    return result.status === 0 && !result.error ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function supportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 22 && major < 27 && (major > 22 || minor >= 12);
}

export function diagnoseLocalRuntime(value, options) {
  const config = validateLocalRuntimeConfig(value);
  const diagnosticOptions = readOptionalDataObject(options, DIAGNOSTIC_FIELDS);
  const nodeVersion = diagnosticOptions?.nodeVersion ?? process.version;
  const probe = diagnosticOptions?.probe ?? probeExecutable;
  const modelProbe = diagnosticOptions?.modelProbe;
  if (!diagnosticOptions || typeof nodeVersion !== 'string' || typeof probe !== 'function' ||
      (modelProbe !== undefined && typeof modelProbe !== 'function')) {
    throw new LocalRuntimeError('INVALID_DIAGNOSTIC_OPTIONS');
  }
  const check = (enabled, command, args = []) => {
    if (!enabled) return 'disabled';
    try {
      return probe(command, args) === 'available' ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
  let model = 'disabled';
  if (config.optional.localModel) {
    try {
      model = modelProbe?.() === 'available' ? 'available' : 'unavailable';
    } catch {
      model = 'unavailable';
    }
  }
  return Object.freeze({
    contractVersion: LOCAL_RUNTIME_CONTRACT_VERSION,
    checks: Object.freeze({
      node: Object.freeze({
        status: supportedNodeVersion(nodeVersion) ? 'available' : 'unsupported',
        version: nodeVersion,
      }),
      ffmpeg: check(config.optional.media, 'ffmpeg', ['-version']),
      ffprobe: check(config.optional.media, 'ffprobe', ['-version']),
      database: check(
        true,
        'pg_isready',
        ['-h', '127.0.0.1', '-p', String(config.postgres.hostPort), '-t', '2'],
      ),
      model,
      cache: config.optional.cache ? 'configured' : 'disabled',
    }),
  });
}
