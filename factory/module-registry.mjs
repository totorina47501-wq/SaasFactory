import capabilityCatalog from '../docs/catalog/saas-capabilities-v1.json' with { type: 'json' };
import { validateModuleDescriptor } from './contracts/index.mjs';

const registryFields = [
  'catalogVersion',
  'moduleRegistryVersion',
  'scope',
  'source',
  'capabilities',
  'modules',
];
const capabilityFields = ['id', 'title', 'category', 'status', 'scaffold', 'owner', 'reference'];
const moduleFields = ['descriptor', 'limitations'];
const limitationFields = ['id', 'description'];
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const credentialMarkers = [
  /gh[pousr]_[A-Za-z0-9_]{16,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?<![A-Za-z0-9_])sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{16,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{20,}/iu,
  /(?:password|api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*['"]?[A-Za-z0-9_+/=-]{16,}/iu,
];
const registryData = new WeakMap();
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export class ModuleRegistryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ModuleRegistryError';
    this.code = code;
  }
}

function fail(code) {
  throw new ModuleRegistryError(code);
}

function copyJson(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > 20_000 || depth > 64) fail('INVALID_INPUT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail('INVALID_INPUT');
  if (state.seen.has(value)) fail('INVALID_INPUT');
  state.seen.add(value);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    fail('INVALID_INPUT');
  }
  const keys = Reflect.ownKeys(value);
  if (isArray && keys.length !== value.length + 1) fail('INVALID_INPUT');
  const result = isArray ? [] : Object.create(null);
  for (const key of keys) {
    if (isArray && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
        (isArray && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))) {
      fail('INVALID_INPUT');
    }
    Object.defineProperty(result, key, {
      value: copyJson(property.value, state, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (isArray && Array.from({ length: value.length }, (_, index) => Object.hasOwn(result, index)).some(present => !present)) {
    fail('INVALID_INPUT');
  }
  state.seen.delete(value);
  return result;
}

export function snapshotJson(value) {
  return copyJson(value, { seen: new WeakSet(), nodes: 0 }, 0);
}

function exactKeys(value, expected, code = 'INVALID_CATALOG') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) fail(code);
}

function safeText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) &&
    !credentialMarkers.some(marker => marker.test(value));
}

function validateCatalog(catalog) {
  exactKeys(catalog, registryFields);
  if (catalog.catalogVersion !== 1 || catalog.moduleRegistryVersion !== 1 ||
      catalog.scope !== 'design-references-and-reviewed-scaffolds' ||
      !safeText(catalog.source, 300) || !Array.isArray(catalog.capabilities) ||
      catalog.capabilities.length > 256 || !Array.isArray(catalog.modules) ||
      catalog.modules.length > 128) {
    fail('INVALID_CATALOG');
  }

  const capabilityIds = new Set();
  for (const capability of catalog.capabilities) {
    exactKeys(capability, capabilityFields);
    if (typeof capability.id !== 'string' || !idPattern.test(capability.id) ||
        !safeText(capability.title, 160) ||
        typeof capability.category !== 'string' || !idPattern.test(capability.category) ||
        !['scaffold', 'missing', 'proposed'].includes(capability.status) ||
        (capability.scaffold !== null && (typeof capability.scaffold !== 'string' || !idPattern.test(capability.scaffold))) ||
        typeof capability.owner !== 'string' || !idPattern.test(capability.owner) ||
        (capability.reference !== null && !safeText(capability.reference, 300)) ||
        capabilityIds.has(capability.id)) {
      fail('INVALID_CATALOG');
    }
    capabilityIds.add(capability.id);
  }

  const entries = [];
  const seen = new Set();
  for (const module of catalog.modules) {
    exactKeys(module, moduleFields);
    let descriptor;
    try {
      descriptor = validateModuleDescriptor(module.descriptor);
    } catch {
      fail('INVALID_MODULE_DESCRIPTOR');
    }
    if (descriptor.maturity === 'reference') fail('INVALID_MODULE_DESCRIPTOR');
    if (!Array.isArray(module.limitations) || module.limitations.length > 32 ||
        (descriptor.maturity !== 'verified' && module.limitations.length === 0)) {
      fail('INVALID_CATALOG');
    }
    const limitations = module.limitations.map(limitation => {
      exactKeys(limitation, limitationFields);
      if (typeof limitation.id !== 'string' || !idPattern.test(limitation.id) ||
          !safeText(limitation.description, 500)) {
        fail('INVALID_CATALOG');
      }
      return Object.freeze({ id: limitation.id, description: limitation.description });
    });
    if (new Set(limitations.map(limitation => limitation.id)).size !== limitations.length) {
      fail('INVALID_CATALOG');
    }
    const key = `${descriptor.id}@${descriptor.version}`;
    if (seen.has(key)) fail('DUPLICATE_MODULE');
    seen.add(key);
    entries.push(Object.freeze({ descriptor, limitations: Object.freeze(limitations) }));
  }
  if (new Set(entries.map(entry => entry.descriptor.id)).size !== entries.length) {
    fail('DUPLICATE_MODULE');
  }
  entries.sort((left, right) => compareText(left.descriptor.id, right.descriptor.id));
  return entries;
}

export function createModuleRegistry(input) {
  const catalog = snapshotJson(input);
  const entries = validateCatalog(catalog);
  const byId = new Map(entries.map(entry => [entry.descriptor.id, entry]));
  const registry = Object.freeze({
    catalogVersion: catalog.catalogVersion,
    moduleRegistryVersion: catalog.moduleRegistryVersion,
    listModules: () => Object.freeze(entries),
  });
  registryData.set(registry, { entries, byId });
  return registry;
}

export function getModuleEntries(registry) {
  const state = registryData.get(registry);
  if (!state) fail('INVALID_REGISTRY');
  return state.entries;
}

export function getModuleEntry(registry, id, version) {
  const state = registryData.get(registry);
  if (!state) fail('INVALID_REGISTRY');
  const entry = state.byId.get(id);
  if (!entry) fail('MODULE_NOT_FOUND');
  if (entry.descriptor.version !== version) fail('UNSUPPORTED_VERSION');
  return entry;
}

export const moduleRegistry = createModuleRegistry(capabilityCatalog);
