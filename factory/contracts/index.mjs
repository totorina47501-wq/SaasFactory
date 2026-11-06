export const CONTRACT_VERSION = 1;

const descriptorFields = [
  'contractVersion', 'id', 'version', 'description', 'category', 'maturity',
  'prerequisites', 'dependencies', 'incompatibilities', 'configuration',
  'permissions', 'generatedFiles', 'tests', 'hardware', 'security', 'offline',
  'update', 'rollback',
];
const descriptorOptionalFields = ['verification'];
const categories = new Set(['identity', 'storage', 'jobs', 'audit', 'entitlements', 'ai', 'media', 'api', 'other']);
const maturities = new Set(['reference', 'scaffold', 'implemented', 'verified']);
const dataClassifications = new Set(['public', 'tenant', 'sensitive']);
const configurationTypes = new Set(['string', 'boolean', 'number', 'integer', 'enum']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('INVALID_INPUT', `${name} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('INVALID_INPUT', `${name} must contain only enumerable data fields`);
    }
  }
}

function exactKeys(value, required, optional = [], name = 'object') {
  record(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key) || !allowed.has(key)) fail('UNKNOWN_FIELD', `${name} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('INVALID_INPUT', `${name}.${key} is required`);
  }
}

function text(value, name, min = 1, max = 256, pattern) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    fail('INVALID_INPUT', `${name} is invalid`);
  }
  return value;
}

function boundedArray(value, name, max = 64, itemValidator) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_INPUT', `${name} must be an array of at most ${max} items`);
  const result = value.map((item, index) => itemValidator(item, `${name}[${index}]`));
  if (new Set(result).size !== result.length) fail('INVALID_INPUT', `${name} must not contain duplicates`);
  return result;
}

function path(value, name) {
  const normalized = text(value, name, 1, 200);
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.includes(':') ||
      normalized.split('/').some(part => !part || part === '.' || part === '..') ||
      normalized.split('/').some(part => part.startsWith('.'))) {
    fail('INVALID_INPUT', `${name} must be a safe relative generated path`);
  }
  return normalized;
}

function validateConfiguration(value) {
  exactKeys(value, ['schemaVersion', 'type', 'additionalProperties', 'required', 'properties'], [], 'configuration');
  if (value.schemaVersion !== 1) fail('INVALID_VERSION', 'configuration.schemaVersion must be 1');
  if (value.type !== 'object' || value.additionalProperties !== false) {
    fail('INVALID_INPUT', 'configuration must be a closed object schema');
  }
  const required = boundedArray(value.required, 'configuration.required', 64, (item, name) =>
    text(item, name, 1, 64, /^[a-z][a-zA-Z0-9]*$/u));
  record(value.properties, 'configuration.properties');
  const propertyNames = Object.keys(value.properties);
  if (propertyNames.length > 64 || propertyNames.some(key => unsafeKeys.has(key) || !/^[a-z][a-zA-Z0-9]*$/u.test(key))) {
    fail('INVALID_INPUT', 'configuration.properties has invalid names or too many fields');
  }
  for (const key of required) {
    if (!Object.hasOwn(value.properties, key)) fail('INVALID_INPUT', `configuration.required references unknown property: ${key}`);
  }
  for (const [key, property] of Object.entries(value.properties)) {
    exactKeys(property, ['type'], ['enum', 'minLength', 'maxLength', 'minimum', 'maximum'], `configuration.properties.${key}`);
    if (!configurationTypes.has(property.type)) fail('INVALID_INPUT', `configuration.properties.${key}.type is unsupported`);
    if (property.type === 'enum') {
      boundedArray(property.enum, `configuration.properties.${key}.enum`, 32, (item, name) => text(item, name, 1, 128));
    } else if (Object.hasOwn(property, 'enum')) {
      fail('INVALID_INPUT', `configuration.properties.${key}.enum is only valid for enum fields`);
    }
    for (const keyName of ['minLength', 'maxLength', 'minimum', 'maximum']) {
      if (Object.hasOwn(property, keyName) &&
          (typeof property[keyName] !== 'number' || !Number.isFinite(property[keyName]) || property[keyName] < 0 || property[keyName] > 1_000_000)) {
        fail('INVALID_INPUT', `configuration.properties.${key}.${keyName} is out of bounds`);
      }
    }
    if (property.minLength !== undefined && property.maxLength !== undefined && property.minLength > property.maxLength) {
      fail('INVALID_INPUT', `configuration.properties.${key} has inverted length limits`);
    }
    if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) {
      fail('INVALID_INPUT', `configuration.properties.${key} has inverted numeric limits`);
    }
  }
}

function validateVerification(value) {
  boundedArray(value, 'verification', 16, (item, name) => {
    exactKeys(item, ['kind', 'reference'], [], name);
    if (!['test', 'review', 'ci', 'measurement'].includes(item.kind)) {
      fail('INVALID_INPUT', `${name}.kind is unsupported`);
    }
    text(item.reference, `${name}.reference`, 1, 256);
    return `${item.kind}:${item.reference}`;
  });
}

function validateDescriptor(value) {
  exactKeys(value, descriptorFields, descriptorOptionalFields, 'ModuleDescriptor');
  if (value.contractVersion !== CONTRACT_VERSION) fail('INVALID_VERSION', 'ModuleDescriptor.contractVersion is unsupported');
  text(value.id, 'ModuleDescriptor.id', 1, 64, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
  text(value.version, 'ModuleDescriptor.version', 5, 32, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u);
  text(value.description, 'ModuleDescriptor.description', 1, 240);
  if (!categories.has(value.category)) fail('INVALID_INPUT', 'ModuleDescriptor.category is unsupported');
  if (!maturities.has(value.maturity)) fail('INVALID_INPUT', 'ModuleDescriptor.maturity is unsupported');
  for (const field of ['prerequisites', 'dependencies', 'incompatibilities']) {
    const items = boundedArray(value[field], `ModuleDescriptor.${field}`, 32, (item, name) =>
      text(item, name, 1, 128, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u));
    if (field !== 'prerequisites' && items.includes(value.id)) fail('INVALID_INPUT', `ModuleDescriptor.${field} must not contain its own id`);
  }
  validateConfiguration(value.configuration);
  boundedArray(value.permissions, 'ModuleDescriptor.permissions', 32, (item, name) =>
    text(item, name, 3, 64, /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u));
  boundedArray(value.generatedFiles, 'ModuleDescriptor.generatedFiles', 128, path);
  boundedArray(value.tests, 'ModuleDescriptor.tests', 64, path);
  exactKeys(value.hardware, [], ['cpuCores', 'memoryMiB', 'diskMiB'], 'ModuleDescriptor.hardware');
  for (const [key, limit] of Object.entries({ cpuCores: 256, memoryMiB: 1_048_576, diskMiB: 1_048_576 })) {
    if (Object.hasOwn(value.hardware, key) &&
        (!Number.isSafeInteger(value.hardware[key]) || value.hardware[key] < 0 || value.hardware[key] > limit)) {
      fail('INVALID_INPUT', `ModuleDescriptor.hardware.${key} is out of bounds`);
    }
  }
  exactKeys(value.security, ['dataClassification', 'handlesSecrets', 'permissionsReviewed'], [], 'ModuleDescriptor.security');
  if (!dataClassifications.has(value.security.dataClassification) ||
      typeof value.security.handlesSecrets !== 'boolean' || typeof value.security.permissionsReviewed !== 'boolean') {
    fail('INVALID_INPUT', 'ModuleDescriptor.security is invalid');
  }
  exactKeys(value.offline, ['supported', 'networkRequired'], [], 'ModuleDescriptor.offline');
  if (typeof value.offline.supported !== 'boolean' || typeof value.offline.networkRequired !== 'boolean' ||
      (value.offline.supported && value.offline.networkRequired)) {
    fail('INVALID_INPUT', 'ModuleDescriptor.offline is inconsistent');
  }
  text(value.update, 'ModuleDescriptor.update', 1, 500);
  text(value.rollback, 'ModuleDescriptor.rollback', 1, 500);
  if (value.maturity === 'verified') {
    if (!Object.hasOwn(value, 'verification')) fail('INVALID_INPUT', 'verified modules require explicit verification evidence');
    validateVerification(value.verification);
    if (value.verification.length === 0) fail('INVALID_INPUT', 'verified modules require non-empty verification evidence');
  } else if (Object.hasOwn(value, 'verification')) {
    validateVerification(value.verification);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function validateModuleDescriptor(value) {
  validateDescriptor(value);
  return deepFreeze(structuredClone(value));
}

export function assertTenantContext(value) {
  exactKeys(value, ['contractVersion', 'tenantId', 'requestId'], [], 'TenantContext');
  if (value.contractVersion !== CONTRACT_VERSION) fail('INVALID_VERSION', 'TenantContext.contractVersion is unsupported');
  text(value.tenantId, 'TenantContext.tenantId', 1, 128, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
  text(value.requestId, 'TenantContext.requestId', 1, 128, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
  return Object.freeze({ contractVersion: CONTRACT_VERSION, tenantId: value.tenantId, requestId: value.requestId });
}
