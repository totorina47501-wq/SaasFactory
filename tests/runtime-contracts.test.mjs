import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTenantContext,
  CONTRACT_VERSION,
  ContractError,
  validateModuleDescriptor,
} from '../factory/contracts/index.mjs';

const descriptor = () => ({
  contractVersion: 1,
  id: 'local-search',
  version: '1.0.0',
  description: 'Recherche locale de référence',
  category: 'other',
  maturity: 'reference',
  prerequisites: [],
  dependencies: [],
  incompatibilities: [],
  configuration: {
    schemaVersion: 1,
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {},
  },
  permissions: [],
  generatedFiles: [],
  tests: [],
  hardware: {},
  security: {
    dataClassification: 'public',
    handlesSecrets: false,
    permissionsReviewed: true,
  },
  offline: { supported: true, networkRequired: false },
  update: 'Revoir le contrat avant toute mise à jour.',
  rollback: 'Retirer la sélection avant génération.',
});

const expectCode = (callback, code) => {
  assert.throws(callback, error => error instanceof ContractError && error.code === code);
};

test('validates and freezes a defensive descriptor copy', () => {
  const input = descriptor();
  const result = validateModuleDescriptor(input);
  assert.equal(CONTRACT_VERSION, 1);
  assert.notEqual(result, input);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.configuration));
  assert.equal(result.id, 'local-search');
  input.description = 'changed';
  assert.equal(result.description, 'Recherche locale de référence');
});

test('rejects unknown fields, including configuration extensions and executable values', () => {
  expectCode(() => validateModuleDescriptor({ ...descriptor(), install: 'echo unsafe' }), 'UNKNOWN_FIELD');
  const withUnknownConfiguration = descriptor();
  withUnknownConfiguration.configuration.hook = 'not allowed';
  expectCode(() => validateModuleDescriptor(withUnknownConfiguration), 'UNKNOWN_FIELD');
  const withExecutableValue = descriptor();
  withExecutableValue.description = () => 'untrusted';
  expectCode(() => validateModuleDescriptor(withExecutableValue), 'INVALID_INPUT');
  const suspectedSecret = descriptor();
  const token = 'ghp_' + 'a'.repeat(24);
  suspectedSecret.description = token;
  assert.throws(() => validateModuleDescriptor(suspectedSecret), error =>
    error instanceof ContractError && error.code === 'INVALID_INPUT' && !error.message.includes(token));
  const withAccessor = descriptor();
  Object.defineProperty(withAccessor, 'description', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  expectCode(() => validateModuleDescriptor(withAccessor), 'INVALID_INPUT');
  const withArrayAccessor = descriptor();
  withArrayAccessor.permissions.length = 1;
  Object.defineProperty(withArrayAccessor.permissions, '0', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  expectCode(() => validateModuleDescriptor(withArrayAccessor), 'INVALID_INPUT');
});

test('rejects accessors in nested data before executing any getter', () => {
  const nested = descriptor();
  Object.defineProperty(nested.configuration.properties, 'unsafe', {
    enumerable: true,
    get() { throw Error('getter must never run'); },
  });
  expectCode(() => validateModuleDescriptor(nested), 'INVALID_INPUT');
  const context = { contractVersion: 1, tenantId: 'tenant-1', requestId: 'req-1' };
  Object.defineProperty(context, 'tenantId', {
    enumerable: true,
    get() { throw Error('getter must never run'); },
  });
  expectCode(() => assertTenantContext(context), 'INVALID_INPUT');
});

test('rejects sparse descriptor evidence and generated paths', () => {
  for (const field of ['permissions', 'generatedFiles', 'tests', 'dependencies']) {
    const invalid = descriptor();
    invalid[field] = Array(1);
    expectCode(() => validateModuleDescriptor(invalid), 'INVALID_INPUT');
  }
  const invalid = descriptor();
  invalid.maturity = 'verified';
  invalid.verification = Array(1);
  expectCode(() => validateModuleDescriptor(invalid), 'INVALID_INPUT');
});

test('rejects unsupported contract and configuration versions', () => {
  expectCode(() => validateModuleDescriptor({ ...descriptor(), contractVersion: 2 }), 'INVALID_VERSION');
  const wrongConfigVersion = descriptor();
  wrongConfigVersion.configuration.schemaVersion = 2;
  expectCode(() => validateModuleDescriptor(wrongConfigVersion), 'INVALID_VERSION');
  const invalidSemver = descriptor();
  invalidSemver.version = '1.0.0-';
  expectCode(() => validateModuleDescriptor(invalidSemver), 'INVALID_INPUT');
  const withBuildMetadata = descriptor();
  withBuildMetadata.version = '1.0.0+build.7';
  assert.equal(validateModuleDescriptor(withBuildMetadata).version, '1.0.0+build.7');
});

test('bounds descriptor fields and rejects unsafe generated paths', () => {
  for (const generatedPath of ['/absolute/file.ts', '../escape.ts', 'module/../escape.ts', 'module\\escape.ts', '.env']) {
    const invalid = descriptor();
    invalid.generatedFiles = [generatedPath];
    expectCode(() => validateModuleDescriptor(invalid), 'INVALID_INPUT');
  }
  const oversized = descriptor();
  oversized.description = 'x'.repeat(241);
  expectCode(() => validateModuleDescriptor(oversized), 'INVALID_INPUT');
  const unsupportedCategory = descriptor();
  unsupportedCategory.category = 'custom';
  expectCode(() => validateModuleDescriptor(unsupportedCategory), 'INVALID_INPUT');
  const inconsistentOffline = descriptor();
  inconsistentOffline.offline.networkRequired = true;
  expectCode(() => validateModuleDescriptor(inconsistentOffline), 'INVALID_INPUT');
  const oversizedConfiguration = descriptor();
  oversizedConfiguration.configuration.properties = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`field${index}`, { type: 'string' }]),
  );
  expectCode(() => validateModuleDescriptor(oversizedConfiguration), 'INVALID_INPUT');
  const incompatibleLimits = descriptor();
  incompatibleLimits.configuration.properties = { count: { type: 'integer', minimum: 1.5 } };
  expectCode(() => validateModuleDescriptor(incompatibleLimits), 'INVALID_INPUT');
  const emptyEnum = descriptor();
  emptyEnum.configuration.properties = { mode: { type: 'enum', enum: [] } };
  expectCode(() => validateModuleDescriptor(emptyEnum), 'INVALID_INPUT');
});

test('verified maturity requires explicit non-empty evidence', () => {
  const missingEvidence = descriptor();
  missingEvidence.maturity = 'verified';
  expectCode(() => validateModuleDescriptor(missingEvidence), 'INVALID_INPUT');
  const emptyEvidence = { ...missingEvidence, verification: [] };
  expectCode(() => validateModuleDescriptor(emptyEvidence), 'INVALID_INPUT');
  const evidenced = {
    ...missingEvidence,
    verification: [{
      kind: 'test',
      reference: 'tests/local-search.test.mjs',
      version: '1.0.0',
      scope: 'implementation',
    }],
  };
  assert.equal(validateModuleDescriptor(evidenced).maturity, 'verified');
  const staleEvidence = {
    ...evidenced,
    verification: [{ ...evidenced.verification[0], version: '0.9.0' }],
  };
  expectCode(() => validateModuleDescriptor(staleEvidence), 'INVALID_INPUT');
});

test('tenant context must be present, versioned and exact', () => {
  for (const context of [undefined, null, {}, { contractVersion: 1, requestId: 'req-1' }]) {
    expectCode(() => assertTenantContext(context), 'INVALID_INPUT');
  }
  expectCode(() => assertTenantContext({ contractVersion: 2, tenantId: 'tenant-1', requestId: 'req-1' }), 'INVALID_VERSION');
  expectCode(() => assertTenantContext({ contractVersion: 1, tenantId: '../other', requestId: 'req-1' }), 'INVALID_INPUT');
  expectCode(() => assertTenantContext({ contractVersion: 1, tenantId: 'tenant-1', requestId: 'req-1', role: 'admin' }), 'UNKNOWN_FIELD');
  const context = assertTenantContext({ contractVersion: 1, tenantId: 'tenant-1', requestId: 'req-1' });
  assert.deepEqual(context, { contractVersion: 1, tenantId: 'tenant-1', requestId: 'req-1' });
  assert.ok(Object.isFrozen(context));
});
