import capabilityCatalog from '../docs/catalog/saas-capabilities-v1.json' with { type: 'json' };
import { composeModuleFiles } from './composer.mjs';
import { createGenerationReport } from './generation-report.mjs';
import { createModuleRegistry, snapshotJson } from './module-registry.mjs';
import { resolveModules } from './module-resolver.mjs';

const v2Fields = [
  'schemaVersion',
  'productName',
  'projectSlug',
  'domain',
  'modules',
  'acceptedLimitations',
  'prerequisites',
  'permissions',
  'offline',
  'languages',
  'defaultLanguage',
  'deploymentTarget',
];
const migrationFields = ['acceptedLimitations', 'prerequisites', 'permissions', 'offline'];
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{16,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?<![A-Za-z0-9_])sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{16,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{20,}/iu,
  /(?:password|api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*['"]?[A-Za-z0-9_+/=-]{16,}/iu,
];
const registry = createModuleRegistry(capabilityCatalog);
const descriptors = new Map(registry.listModules().map(entry => [entry.descriptor.id, entry.descriptor]));

function fail(message) {
  throw new Error(`Generator v2 configuration: ${message}`);
}

function validateV2Config(input) {
  let value;
  try {
    value = snapshotJson(input);
  } catch {
    fail('input must be a plain JSON value.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('input must be an object.');
  }
  const keys = Object.keys(value);
  if (keys.length !== v2Fields.length || keys.some(key => !v2Fields.includes(key))) {
    fail('unknown or missing configuration fields.');
  }
  if (value.schemaVersion !== 2) fail('schemaVersion must be exactly 2.');

  const selection = resolveModules(registry, {
    modules: value.modules,
    acceptedLimitations: value.acceptedLimitations,
    prerequisites: value.prerequisites,
    permissions: value.permissions,
    offline: value.offline,
  });
  if (!value.modules.some(module => module?.id === 'ai-disabled')) {
    fail('modules must include ai-disabled.');
  }
  return { value, selection };
}

function toV1Config(value, selection, validateV1Config) {
  return validateV1Config({
    schemaVersion: 1,
    productName: value.productName,
    projectSlug: value.projectSlug,
    domain: value.domain,
    modules: selection.modules.map(module => module.id),
    languages: value.languages,
    defaultLanguage: value.defaultLanguage,
    deploymentTarget: value.deploymentTarget,
  });
}

export function migrateV1Config(value, migration, validateV1Config) {
  if (typeof validateV1Config !== 'function') fail('migration requires the v1 validator.');
  let legacyInput;
  try {
    legacyInput = snapshotJson(value);
  } catch {
    fail('v1 input must be a plain JSON value.');
  }
  const legacy = validateV1Config(legacyInput);
  let migrationOptions;
  try {
    migrationOptions = snapshotJson(migration);
  } catch {
    fail('migration options must be plain JSON.');
  }
  if (!migrationOptions || typeof migrationOptions !== 'object' || Array.isArray(migrationOptions) ||
      Object.keys(migrationOptions).length !== migrationFields.length ||
      migrationFields.some(key => !Object.hasOwn(migrationOptions, key))) {
    fail('migration options must explicitly state limitation acceptance and runtime constraints.');
  }
  const migrated = {
    schemaVersion: 2,
    productName: legacy.productName,
    projectSlug: legacy.projectSlug,
    domain: legacy.domain,
    modules: legacy.modules.map(id => {
      const descriptor = descriptors.get(id);
      if (!descriptor) fail('v1 module has no v2 registry entry.');
      return { id, version: descriptor.version };
    }),
    acceptedLimitations: migrationOptions.acceptedLimitations,
    prerequisites: migrationOptions.prerequisites,
    permissions: migrationOptions.permissions,
    offline: migrationOptions.offline,
    languages: legacy.languages,
    defaultLanguage: legacy.defaultLanguage,
    deploymentTarget: legacy.deploymentTarget,
  };
  validateV2Config(migrated);
  return migrated;
}

export function buildProjectV2({
  config,
  outputRoot,
  mode = 'dry-run',
  validateV1Config,
  renderFiles,
  checkDestination,
}) {
  if (typeof outputRoot !== 'string' || outputRoot.trim().length === 0) {
    throw new Error('An explicit --output-root is required.');
  }
  if (!['dry-run', 'write'].includes(mode)) fail('mode must be dry-run or write.');
  if ([validateV1Config, renderFiles, checkDestination].some(value => typeof value !== 'function')) {
    throw new Error('Generator v2 requires the trusted v1 generation and filesystem boundaries.');
  }

  const { value, selection } = validateV2Config(config);
  const legacyConfig = toV1Config(value, selection, validateV1Config);
  const rendered = renderFiles(legacyConfig);
  const composed = composeModuleFiles(selection, rendered);
  for (const [filePath, content] of composed.files) {
    if (secretPatterns.some(pattern => pattern.test(content))) {
      throw new Error(`Generated content failed the secret check: ${filePath}`);
    }
  }
  const destinationInfo = checkDestination(outputRoot, legacyConfig.projectSlug, false);
  const report = createGenerationReport({
    mode,
    projectSlug: legacyConfig.projectSlug,
    destination: destinationInfo.destination,
    deploymentTarget: legacyConfig.deploymentTarget,
    modules: composed.modules,
    hashes: composed.hashes,
    files: composed.files,
  });

  return Object.freeze({
    ...destinationInfo,
    projectSlug: legacyConfig.projectSlug,
    report,
  });
}
