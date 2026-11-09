import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileIntake} from '../intake.mjs';
import {migrateIntakeV1} from '../factory/intake-migrations.mjs';

const v1File = fileURLToPath(new URL('../examples/intake-sample.json', import.meta.url));
const v2File = fileURLToPath(new URL('../examples/intake-v2.json', import.meta.url));
const cli = fileURLToPath(new URL('../intake.mjs', import.meta.url));
const v1 = JSON.parse(readFileSync(v1File, 'utf8'));
const v2 = JSON.parse(readFileSync(v2File, 'utf8'));
const compile = value => compileIntake(JSON.stringify(value));

function migrationDecisions() {
  return {
    acceptedLimitations: [
      {id: 'ai-disabled', version: '1.0.0', limitations: ['disabled-by-design']},
      {id: 'api', version: '1.0.0', limitations: ['example-route-only']},
      {id: 'auth', version: '1.0.0', limitations: ['injected-boundary-only']},
      {id: 'billing-test', version: '1.0.0', limitations: ['simulation-only']},
    ],
    prerequisites: [],
    permissions: [],
    offline: true,
    features: [
      {
        id: 'schedule',
        dependsOn: [],
        moduleIds: ['api', 'auth'],
        capabilityIds: ['auth-rbac'],
        acceptanceCriteria: ['Synthetic appointment requests can be created.'],
      },
      {
        id: 'accessibility',
        dependsOn: ['schedule'],
        moduleIds: [],
        capabilityIds: ['e2e-playwright'],
        acceptanceCriteria: ['The scheduling flow is keyboard accessible.'],
      },
    ],
  };
}

test('v2 is deterministic and includes generator dry-run and implementation contracts', () => {
  const first = compile(v2);
  const second = compile(v2);
  assert.deepEqual(first, second);
  assert.equal(first.intakeVersion, 2);
  assert.equal(first.generatorConfig.schemaVersion, 2);
  assert.equal(first.implementationContracts.length, v2.mvp.length);
  assert.ok(first.implementationContracts.every(contract =>
    contract.status === 'draft' && contract.approved === false && contract.files === null));
  assert.ok(first.implementationContracts[0].acceptedLimitations.length > 0);
  assert.ok(first.implementationContracts.some(contract => contract.missingFeatures.length > 0));
  assert.equal(first.dryRunReport.mode, 'dry-run');
  assert.equal(first.dryRunReport.filesWritten, false);
  assert.equal(first.dryRunReport.githubIssuesCreated, false);
  assert.ok(first.dryRunReport.files.length > 0);
  assert.ok(first.dryRunReport.hashes.length > 0);
  assert.equal(first.dryRunReport.destination, '<output-root>/<projectSlug>');
});

test('v1 remains supported with its original plan shape', () => {
  const result = compile(v1);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, 'saas-factory-intake-plan');
  assert.equal(result.generatorConfig.schemaVersion, 1);
  assert.equal(result.missionDrafts.length, v1.mvp.length);
  assert.equal(Object.hasOwn(result, 'implementationContracts'), false);
});

test('CLI emits the same v2 plan without writing generated files', () => {
  const output = JSON.parse(execFileSync(process.execPath, [cli, '--input', v2File], {encoding: 'utf8'}));
  assert.deepEqual(output, compile(v2));
});

test('strict validation rejects unsupported versions, fields and generator module versions', () => {
  const unsupported = structuredClone(v2);
  unsupported.intakeVersion = 3;
  assert.throws(() => compile(unsupported));

  const unknown = structuredClone(v2);
  unknown.extra = 'not allowed';
  assert.throws(() => compile(unknown), /missing or unsupported fields/);

  const moduleVersion = structuredClone(v2);
  moduleVersion.scaffold.modules[0].version = '9.0.0';
  moduleVersion.scaffold.acceptedLimitations[0].version = '9.0.0';
  assert.throws(() => compile(moduleVersion), /UNSUPPORTED_VERSION/);
});

test('validates missing, cyclic and priority-inconsistent MVP dependencies', () => {
  const missing = structuredClone(v2);
  missing.mvp[0].dependsOn = ['not-in-the-mvp'];
  assert.throws(() => compile(missing), /dependencies must exist/);

  const cycle = structuredClone(v2);
  cycle.mvp[0].dependsOn = ['accessibility'];
  assert.throws(() => compile(cycle), /equal or higher priority|cyclic/);

  const lowerPriority = structuredClone(v2);
  lowerPriority.mvp[1].priority = 'p0';
  lowerPriority.mvp[0].priority = 'p1';
  assert.throws(() => compile(lowerPriority), /equal or higher priority/);

  const noP0 = structuredClone(v2);
  noP0.mvp.forEach(feature => { feature.priority = 'p1'; });
  assert.throws(() => compile(noP0), /at least one P0/);
});

test('rejects unselected feature modules and capabilities', () => {
  const module = structuredClone(v2);
  module.mvp[0].moduleIds = ['media'];
  assert.throws(() => compile(module), /unrequested module or capability/);

  const capability = structuredClone(v2);
  capability.mvp[0].capabilityIds = ['not-selected'];
  assert.throws(() => compile(capability), /unrequested module or capability/);
});

test('secret detection and duplicate/unknown field diagnostics never echo input', () => {
  const secret = `ghp_${'a'.repeat(36)}`;
  const secretValue = structuredClone(v2);
  secretValue.market.problem = `Issue ${secret}`;
  assert.throws(() => compile(secretValue), error =>
    error.message.includes('credential-like') && !error.message.includes(secret));

  const secretKey = structuredClone(v2);
  secretKey.product[secret] = 'unknown';
  assert.throws(() => compile(secretKey), error =>
    !error.message.includes(secret));

  const duplicateSecretKey = JSON.stringify(v2).replace(
    '"intakeVersion":2,',
    `"intakeVersion":2,"${secret}":"first","${secret}":"second",`,
  );
  assert.throws(() => compileIntake(duplicateSecretKey), error =>
    error.message === 'Duplicate JSON key' && !error.message.includes(secret));

  const invalidLanguageV2 = structuredClone(v2);
  invalidLanguageV2.scaffold.languages = ['PRIVATE_SENTINEL!'];
  assert.throws(() => compile(invalidLanguageV2), error =>
    !error.message.includes('PRIVATE_SENTINEL!'));

  const invalidLanguageV1 = structuredClone(v1);
  invalidLanguageV1.scaffold.languages = ['PRIVATE_SENTINEL!'];
  assert.throws(() => compile(invalidLanguageV1), error =>
    !error.message.includes('PRIVATE_SENTINEL!'));
});

test('credential-prefix prose is accepted when it is not token-shaped', () => {
  const benign = structuredClone(v2);
  benign.product.summary = 'Task management platform for structured work.';
  benign.market.problem = 'Users discuss sk- samples in documentation without real credentials.';
  assert.equal(compile(benign).projectSlug, v2.product.slug);
});

test('v1 migration requires explicit, complete decisions and validates the resulting v2 manifest', () => {
  const migrated = migrateIntakeV1(v1, migrationDecisions());
  assert.equal(migrated.intakeVersion, 2);
  assert.equal(migrated.scaffold.offline, true);
  assert.equal(migrated.mvp.length, v1.mvp.length);
  assert.equal(compileIntake(JSON.stringify(migrated)).generatorConfig.schemaVersion, 2);
  assert.throws(() => migrateIntakeV1(v1, {
    ...migrationDecisions(),
    features: migrationDecisions().features.slice(0, 1),
  }), /decision is required/);
});
