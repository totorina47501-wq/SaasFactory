import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createModuleRegistry,
  ModuleRegistryError,
  moduleRegistry,
} from '../factory/module-registry.mjs';

const catalogPath = fileURLToPath(new URL('../docs/catalog/saas-capabilities-v1.json', import.meta.url));
const catalog = () => JSON.parse(readFileSync(catalogPath, 'utf8'));

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof ModuleRegistryError && error.code === code);
}

test('exposes only the separate operational allowlist and keeps capability references historical', () => {
  const source = catalog();
  const registry = createModuleRegistry(source);
  const entries = registry.listModules();
  const ids = entries.map(entry => entry.descriptor.id);
  assert.deepEqual(ids, ['ai-disabled', 'api', 'auth', 'billing-test', 'media']);
  assert.ok(entries.every(entry => entry.descriptor.maturity === 'scaffold'));
  assert.ok(source.capabilities.some(capability => capability.id === 'auth-rbac'));
  assert.ok(!ids.includes('auth-rbac'));
  assert.equal(registry.moduleRegistryVersion, 1);
  assert.ok(Object.isFrozen(entries));
  assert.ok(Object.isFrozen(entries[0].descriptor));
  assert.ok(Object.isFrozen(moduleRegistry.listModules()));
});

test('validates closed catalogs and descriptor maturity without promoting modules', () => {
  const unknownCatalogField = catalog();
  unknownCatalogField.unexpected = true;
  expectCode(() => createModuleRegistry(unknownCatalogField), 'INVALID_CATALOG');

  const unknownDescriptorField = catalog();
  unknownDescriptorField.modules[0].descriptor.install = 'not executable';
  expectCode(() => createModuleRegistry(unknownDescriptorField), 'INVALID_MODULE_DESCRIPTOR');

  const duplicate = catalog();
  duplicate.modules.push(structuredClone(duplicate.modules[0]));
  expectCode(() => createModuleRegistry(duplicate), 'DUPLICATE_MODULE');

  const reference = catalog();
  reference.modules[0].descriptor.maturity = 'reference';
  expectCode(() => createModuleRegistry(reference), 'INVALID_MODULE_DESCRIPTOR');

  const noLimitation = catalog();
  noLimitation.modules[0].limitations = [];
  expectCode(() => createModuleRegistry(noLimitation), 'INVALID_CATALOG');
});

test('rejects malicious data graphs and accessors without evaluating them', () => {
  const cyclic = catalog();
  cyclic.modules[0].descriptor.cycle = cyclic;
  expectCode(() => createModuleRegistry(cyclic), 'INVALID_INPUT');

  let getterCalled = false;
  const accessor = catalog();
  Object.defineProperty(accessor.modules[0].descriptor, 'description', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('getter must not execute');
    },
  });
  expectCode(() => createModuleRegistry(accessor), 'INVALID_INPUT');
  assert.equal(getterCalled, false);
});

test('returns an immutable snapshot and does not echo credential-like descriptor text', () => {
  const source = catalog();
  const registry = createModuleRegistry(source);
  source.modules[0].descriptor.description = 'changed after validation';
  assert.notEqual(registry.listModules()[0].descriptor.description, 'changed after validation');

  const token = `ghp_${'a'.repeat(24)}`;
  const secretCatalog = catalog();
  secretCatalog.modules[0].descriptor.description = token;
  assert.throws(() => createModuleRegistry(secretCatalog), error =>
    error instanceof ModuleRegistryError &&
    error.code === 'INVALID_MODULE_DESCRIPTOR' &&
    !error.message.includes(token));
});
