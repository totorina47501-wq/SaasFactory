import {
  getModuleEntries,
  getModuleEntry,
  ModuleRegistryError,
  snapshotJson,
} from './module-registry.mjs';

const requestFields = ['modules', 'acceptedLimitations', 'prerequisites', 'permissions', 'offline'];
const moduleFields = ['id', 'version'];
const limitationFields = ['id', 'version', 'limitations'];
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const permissionPattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u;

function fail(code) {
  throw new ModuleRegistryError(code);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SELECTION');
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) fail('INVALID_SELECTION');
}

function id(value) {
  if (typeof value !== 'string' || value.length > 64 || !idPattern.test(value)) fail('INVALID_SELECTION');
  return value;
}

function version(value) {
  if (typeof value !== 'string' || value.length > 64 || !semverPattern.test(value)) fail('INVALID_SELECTION');
  return value;
}

function stringList(value, pattern, maxLength, maxItemLength = 128) {
  if (!Array.isArray(value) || value.length > maxLength) fail('INVALID_SELECTION');
  const values = value.map(item => {
    if (typeof item !== 'string' || item.length > maxItemLength || !pattern.test(item)) fail('INVALID_SELECTION');
    return item;
  });
  if (new Set(values).size !== values.length) fail('INVALID_SELECTION');
  return values;
}

function validateRequest(input) {
  exactKeys(input, requestFields);
  if (!Array.isArray(input.modules) || input.modules.length === 0 || input.modules.length > 64 ||
      typeof input.offline !== 'boolean') {
    fail('INVALID_SELECTION');
  }
  const modules = input.modules.map(module => {
    exactKeys(module, moduleFields);
    return { id: id(module.id), version: version(module.version) };
  });
  if (new Set(modules.map(module => module.id)).size !== modules.length) fail('INVALID_SELECTION');

  if (!Array.isArray(input.acceptedLimitations) || input.acceptedLimitations.length > 128) {
    fail('INVALID_SELECTION');
  }
  const acceptedLimitations = input.acceptedLimitations.map(item => {
    exactKeys(item, limitationFields);
    return {
      id: id(item.id),
      version: version(item.version),
      limitations: stringList(item.limitations, idPattern, 32, 64),
    };
  });
  if (new Set(acceptedLimitations.map(item => `${item.id}@${item.version}`)).size !== acceptedLimitations.length) {
    fail('INVALID_SELECTION');
  }
  return {
    modules,
    acceptedLimitations,
    prerequisites: stringList(input.prerequisites, idPattern, 128),
    permissions: stringList(input.permissions, permissionPattern, 128, 64),
    offline: input.offline,
  };
}

export function resolveModules(registry, selection) {
  let input;
  try {
    input = validateRequest(snapshotJson(selection));
  } catch (error) {
    if (error instanceof ModuleRegistryError && error.code === 'INVALID_INPUT') {
      fail('INVALID_SELECTION');
    }
    if (error instanceof ModuleRegistryError) throw error;
    fail('INVALID_SELECTION');
  }

  const entries = getModuleEntries(registry);
  const entriesById = new Map(entries.map(entry => [entry.descriptor.id, entry]));
  const chosen = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(entry) {
    const key = `${entry.descriptor.id}@${entry.descriptor.version}`;
    if (visiting.has(key)) fail('DEPENDENCY_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependencyId of [...entry.descriptor.dependencies].sort()) {
      const dependency = entriesById.get(dependencyId);
      if (!dependency) fail('MISSING_DEPENDENCY');
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
    chosen.push(entry);
  }

  for (const requested of [...input.modules].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(getModuleEntry(registry, requested.id, requested.version));
  }

  const chosenById = new Map(chosen.map(entry => [entry.descriptor.id, entry]));
  for (const entry of chosen) {
    for (const incompatibleId of entry.descriptor.incompatibilities) {
      if (chosenById.has(incompatibleId)) fail('INCOMPATIBLE_MODULES');
    }
  }

  const availablePrerequisites = new Set(input.prerequisites);
  if (chosen.some(entry => entry.descriptor.prerequisites.some(item => !availablePrerequisites.has(item)))) {
    fail('MISSING_PREREQUISITE');
  }

  const availablePermissions = new Set(input.permissions);
  if (chosen.some(entry => entry.descriptor.permissions.some(permission => !availablePermissions.has(permission)))) {
    fail('PERMISSION_DENIED');
  }

  const acceptedByModule = new Map(input.acceptedLimitations.map(item => [
    `${item.id}@${item.version}`,
    new Set(item.limitations),
  ]));
  const chosenKeys = new Set(chosen.map(entry => `${entry.descriptor.id}@${entry.descriptor.version}`));
  if ([...acceptedByModule.keys()].some(key => !chosenKeys.has(key))) fail('INVALID_SELECTION');
  const limitations = [];
  for (const entry of chosen) {
    const key = `${entry.descriptor.id}@${entry.descriptor.version}`;
    const accepted = acceptedByModule.get(key) ?? new Set();
    const required = new Set(entry.limitations.map(limitation => limitation.id));
    if (required.size > 0 && !acceptedByModule.has(key)) fail('LIMITATION_NOT_ACCEPTED');
    if ([...accepted].some(item => !required.has(item)) ||
        [...required].some(item => !accepted.has(item))) {
      fail('LIMITATION_NOT_ACCEPTED');
    }
    if (entry.limitations.length > 0) {
      limitations.push(Object.freeze({
        moduleId: entry.descriptor.id,
        version: entry.descriptor.version,
        accepted: Object.freeze(entry.limitations.map(limitation => limitation.id)),
      }));
    }
  }

  const offlineSupported = chosen.every(entry => entry.descriptor.offline.supported);
  const networkRequired = chosen.some(entry => entry.descriptor.offline.networkRequired);
  if (input.offline && (!offlineSupported || networkRequired)) fail('OFFLINE_UNSUPPORTED');

  const permissions = [...new Set(chosen.flatMap(entry => entry.descriptor.permissions))].sort();
  return Object.freeze({
    registryVersion: registry.moduleRegistryVersion,
    modules: Object.freeze(chosen.map(entry => entry.descriptor)),
    permissions: Object.freeze(permissions),
    limitations: Object.freeze(limitations),
    offline: Object.freeze({
      requested: input.offline,
      supported: offlineSupported && !networkRequired,
      networkRequired,
    }),
  });
}
