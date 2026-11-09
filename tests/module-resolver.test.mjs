import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModuleRegistry,
  ModuleRegistryError,
  moduleRegistry,
} from '../factory/module-registry.mjs';
import { resolveModules } from '../factory/module-resolver.mjs';

const catalog = () => ({
  catalogVersion: 1,
  moduleRegistryVersion: 1,
  scope: 'design-references-and-reviewed-scaffolds',
  source: 'Test-only module catalog.',
  capabilities: [],
  modules: moduleRegistry.listModules().map(entry => ({
    descriptor: structuredClone(entry.descriptor),
    limitations: structuredClone(entry.limitations),
  })),
});

function entry(registry, id) {
  const found = registry.listModules().find(item => item.descriptor.id === id);
  assert.ok(found, `expected test module ${id}`);
  return found;
}

function selection(registry, requestedIds, acceptedIds = requestedIds) {
  return {
    modules: requestedIds.map(id => ({
      id,
      version: entry(registry, id).descriptor.version,
    })),
    acceptedLimitations: acceptedIds.map(id => {
      const selected = entry(registry, id);
      return {
        id,
        version: selected.descriptor.version,
        limitations: selected.limitations.map(limitation => limitation.id),
      };
    }),
    prerequisites: [],
    permissions: [],
    offline: true,
  };
}

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof ModuleRegistryError && error.code === code);
}

test('resolves a stable selection and reports the offline state without promoting maturity', () => {
  const registry = createModuleRegistry(catalog());
  const request = selection(registry, ['media', 'api', 'auth', 'ai-disabled', 'billing-test']);
  const first = resolveModules(registry, request);
  const second = resolveModules(registry, { ...request, modules: [...request.modules].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.modules.map(module => module.id), [
    'ai-disabled', 'api', 'auth', 'billing-test', 'media',
  ]);
  assert.ok(first.modules.every(module => module.maturity === 'scaffold'));
  assert.deepEqual(first.permissions, []);
  assert.deepEqual(first.offline, { requested: true, supported: true, networkRequired: false });
  assert.ok(Object.isFrozen(first.modules));
});

test('resolves transitive dependencies before dependents', () => {
  const input = catalog();
  input.modules.find(item => item.descriptor.id === 'api').descriptor.dependencies = ['auth'];
  const registry = createModuleRegistry(input);
  const result = resolveModules(registry, selection(registry, ['api'], ['api', 'auth']));
  assert.deepEqual(result.modules.map(module => module.id), ['auth', 'api']);
});

test('rejects unknown modules, unsupported versions, missing dependencies and cycles', () => {
  const registry = createModuleRegistry(catalog());
  const historicalReference = selection(registry, ['auth']);
  historicalReference.modules[0].id = 'auth-rbac';
  expectCode(() => resolveModules(registry, historicalReference), 'MODULE_NOT_FOUND');
  const unsupported = selection(registry, ['auth']);
  unsupported.modules[0].version = '2.0.0';
  unsupported.acceptedLimitations[0].version = '2.0.0';
  expectCode(() => resolveModules(registry, unsupported), 'UNSUPPORTED_VERSION');

  const missingDependencyCatalog = catalog();
  missingDependencyCatalog.modules.find(item => item.descriptor.id === 'api').descriptor.dependencies = ['email'];
  const missingDependencyRegistry = createModuleRegistry(missingDependencyCatalog);
  expectCode(() => resolveModules(
    missingDependencyRegistry,
    selection(missingDependencyRegistry, ['api']),
  ), 'MISSING_DEPENDENCY');

  const cyclicCatalog = catalog();
  cyclicCatalog.modules.find(item => item.descriptor.id === 'api').descriptor.dependencies = ['auth'];
  cyclicCatalog.modules.find(item => item.descriptor.id === 'auth').descriptor.dependencies = ['api'];
  const cyclicRegistry = createModuleRegistry(cyclicCatalog);
  expectCode(() => resolveModules(
    cyclicRegistry,
    selection(cyclicRegistry, ['api'], ['api', 'auth']),
  ), 'DEPENDENCY_CYCLE');
});

test('fails closed on incompatibilities, missing prerequisites and ungranted permissions', () => {
  const incompatibleCatalog = catalog();
  incompatibleCatalog.modules.find(item => item.descriptor.id === 'api').descriptor.incompatibilities = ['auth'];
  const incompatibleRegistry = createModuleRegistry(incompatibleCatalog);
  expectCode(() => resolveModules(
    incompatibleRegistry,
    selection(incompatibleRegistry, ['api', 'auth']),
  ), 'INCOMPATIBLE_MODULES');

  const guardedCatalog = catalog();
  const api = guardedCatalog.modules.find(item => item.descriptor.id === 'api').descriptor;
  api.prerequisites = ['local-runtime'];
  api.permissions = ['storage:read'];
  const guardedRegistry = createModuleRegistry(guardedCatalog);
  expectCode(() => resolveModules(
    guardedRegistry,
    selection(guardedRegistry, ['api']),
  ), 'MISSING_PREREQUISITE');

  const permitted = selection(guardedRegistry, ['api']);
  permitted.prerequisites = ['local-runtime'];
  expectCode(() => resolveModules(guardedRegistry, permitted), 'PERMISSION_DENIED');
  permitted.permissions = ['storage:read'];
  assert.deepEqual(
    resolveModules(guardedRegistry, permitted).permissions,
    ['storage:read'],
  );
});

test('requires exact acceptance of limitations, including transitively selected modules', () => {
  const input = catalog();
  input.modules.find(item => item.descriptor.id === 'api').descriptor.dependencies = ['auth'];
  const registry = createModuleRegistry(input);
  const missingDependencyAcceptance = selection(registry, ['api']);
  expectCode(() => resolveModules(registry, missingDependencyAcceptance), 'LIMITATION_NOT_ACCEPTED');

  const wrongAcceptance = selection(registry, ['api'], ['api', 'auth']);
  wrongAcceptance.acceptedLimitations[0].limitations = ['different-limit'];
  expectCode(() => resolveModules(registry, wrongAcceptance), 'LIMITATION_NOT_ACCEPTED');

  const exactAcceptance = selection(registry, ['api'], ['api', 'auth']);
  assert.deepEqual(
    resolveModules(registry, exactAcceptance).limitations.map(item => item.moduleId),
    ['auth', 'api'],
  );
});

test('enforces offline constraints and reports network requirements when online mode is requested', () => {
  const input = catalog();
  const api = input.modules.find(item => item.descriptor.id === 'api').descriptor;
  api.offline = { supported: false, networkRequired: true };
  const registry = createModuleRegistry(input);
  const offline = selection(registry, ['api']);
  expectCode(() => resolveModules(registry, offline), 'OFFLINE_UNSUPPORTED');
  offline.offline = false;
  assert.deepEqual(
    resolveModules(registry, offline).offline,
    { requested: false, supported: false, networkRequired: true },
  );
});

test('rejects unknown selection fields and hostile values without echoing them', () => {
  const registry = createModuleRegistry(catalog());
  const unknown = selection(registry, ['auth']);
  unknown.execute = 'must not be accepted';
  expectCode(() => resolveModules(registry, unknown), 'INVALID_SELECTION');

  const secret = `ghp_${'b'.repeat(24)}`;
  const hostile = selection(registry, ['auth']);
  hostile.modules[0].id = secret;
  assert.throws(() => resolveModules(registry, hostile), error =>
    error instanceof ModuleRegistryError && !error.message.includes(secret));

  let getterCalled = false;
  const accessor = selection(registry, ['auth']);
  Object.defineProperty(accessor.modules[0], 'id', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('getter must not execute');
    },
  });
  expectCode(() => resolveModules(registry, accessor), 'INVALID_SELECTION');
  assert.equal(getterCalled, false);
});
