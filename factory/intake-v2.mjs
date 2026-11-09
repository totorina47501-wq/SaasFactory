import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import capabilityCatalog from '../docs/catalog/saas-capabilities-v1.json' with { type: 'json' };
import { generateProjectV2, validateConfig } from '../generate.mjs';
import { moduleRegistry } from './module-registry.mjs';
import { resolveModules } from './module-resolver.mjs';

const topFields = [
  'intakeVersion', 'product', 'market', 'mvp', 'scaffold', 'capabilities', 'assumptions',
];
const productFields = ['name', 'slug', 'domain', 'summary'];
const marketFields = ['audience', 'problem', 'monetization'];
const featureFields = [
  'id', 'title', 'description', 'priority', 'owner', 'dependsOn',
  'moduleIds', 'capabilityIds', 'acceptanceCriteria',
];
const scaffoldFields = [
  'modules', 'acceptedLimitations', 'prerequisites', 'permissions', 'offline',
  'languages', 'defaultLanguage', 'deploymentTarget',
];
const moduleFields = ['id', 'version'];
const limitationFields = ['id', 'version', 'limitations'];
const specialists = new Set([
  'product-architect', 'generator-engineer', 'qa-engineer', 'security-engineer',
  'platform-engineer', 'ux-accessibility', 'documentation-release',
]);
const priorities = new Set(['p0', 'p1', 'p2']);
const priorityRank = new Map([['p0', 0], ['p1', 1], ['p2', 2]]);
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const credentialMarkers = [
  /gh[pousr]_[A-Za-z0-9_]{16,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?<![A-Za-z0-9_])sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{16,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{20,}/iu,
  /(?:password|api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*['"]?[A-Za-z0-9_+/=-]{16,}/iu,
];
const capabilities = new Map(capabilityCatalog.capabilities.map(item => [item.id, item]));
const modules = new Map(moduleRegistry.listModules().map(item => [
  item.descriptor.id,
  { descriptor: item.descriptor, limitations: item.limitations },
]));

function fail(message) {
  throw new Error(`Intake v2: ${message}`);
}

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(`${name} must be an object`);
  }
}

function exactKeys(value, expected, name) {
  record(value, name);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key)) ||
      expected.some(key => !Object.hasOwn(value, key))) {
    fail(`${name} has missing or unsupported fields`);
  }
  if (keys.some(key => credentialMarkers.some(marker => marker.test(key)))) {
    fail('credential-like content rejected');
  }
}

function text(value, name, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max ||
      !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${name} is invalid`);
  }
  if (credentialMarkers.some(marker => marker.test(value))) fail('credential-like content rejected');
  return value.trim();
}

function id(value, name, max = 64) {
  const result = text(value, name, max);
  if (!identifier.test(result)) fail(`${name} is invalid`);
  return result;
}

function stringList(value, name, max, maxLength = 64) {
  if (!Array.isArray(value) || value.length > max) fail(`${name} is invalid`);
  const result = value.map((item, index) => id(item, `${name}[${index}]`, maxLength));
  if (new Set(result).size !== result.length) fail(`${name} must not contain duplicates`);
  return result.sort();
}

function validateFeature(feature, index, moduleIds, capabilityIds) {
  const name = `mvp[${index}]`;
  exactKeys(feature, featureFields, name);
  const result = {
    id: id(feature.id, `${name}.id`, 48),
    title: text(feature.title, `${name}.title`, 120),
    description: text(feature.description, `${name}.description`, 1500),
    priority: feature.priority,
    owner: feature.owner,
    dependsOn: stringList(feature.dependsOn, `${name}.dependsOn`, 40),
    moduleIds: stringList(feature.moduleIds, `${name}.moduleIds`, 64),
    capabilityIds: stringList(feature.capabilityIds, `${name}.capabilityIds`, 30),
    acceptanceCriteria: feature.acceptanceCriteria,
  };
  if (!priorities.has(result.priority)) fail(`${name}.priority is invalid`);
  if (!specialists.has(result.owner)) fail(`${name}.owner is invalid`);
  if (!Array.isArray(result.acceptanceCriteria) ||
      result.acceptanceCriteria.length < 1 || result.acceptanceCriteria.length > 20) {
    fail(`${name}.acceptanceCriteria must contain 1-20 items`);
  }
  result.acceptanceCriteria = result.acceptanceCriteria.map((item, criterionIndex) =>
    text(item, `${name}.acceptanceCriteria[${criterionIndex}]`, 500));
  if (result.moduleIds.some(moduleId => !moduleIds.has(moduleId)) ||
      result.capabilityIds.some(capabilityId => !capabilityIds.has(capabilityId))) {
    fail(`${name} selects an unrequested module or capability`);
  }
  return result;
}

function validateDependencies(features) {
  const byId = new Map(features.map(feature => [feature.id, feature]));
  if (byId.size !== features.length) fail('MVP feature ids must be unique');
  if (!features.some(feature => feature.priority === 'p0')) fail('MVP requires at least one P0 feature');
  for (const feature of features) {
    if (feature.dependsOn.includes(feature.id)) fail('MVP dependencies cannot be cyclic');
    for (const dependencyId of feature.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency || priorityRank.get(dependency.priority) > priorityRank.get(feature.priority)) {
        fail('MVP dependencies must exist and have equal or higher priority');
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(featureId) {
    if (visiting.has(featureId)) fail('MVP dependencies cannot be cyclic');
    if (visited.has(featureId)) return;
    visiting.add(featureId);
    for (const dependencyId of byId.get(featureId).dependsOn) visit(dependencyId);
    visiting.delete(featureId);
    visited.add(featureId);
  }
  for (const feature of features) visit(feature.id);
  return byId;
}

function validateIntakeV2(raw) {
  exactKeys(raw, topFields, 'intake');
  if (raw.intakeVersion !== 2) fail('intakeVersion must be 2');
  exactKeys(raw.product, productFields, 'product');
  exactKeys(raw.market, marketFields, 'market');
  exactKeys(raw.scaffold, scaffoldFields, 'scaffold');

  const product = {
    name: text(raw.product.name, 'product.name', 80),
    slug: text(raw.product.slug, 'product.slug', 48),
    domain: text(raw.product.domain, 'product.domain', 253),
    summary: text(raw.product.summary, 'product.summary', 2000),
  };
  const market = {
    audience: text(raw.market.audience, 'market.audience', 500),
    problem: text(raw.market.problem, 'market.problem', 500),
    monetization: text(raw.market.monetization, 'market.monetization', 500),
  };

  const scaffold = raw.scaffold;
  if (!Array.isArray(scaffold.modules) || scaffold.modules.length < 1 || scaffold.modules.length > 64) {
    fail('scaffold.modules is invalid');
  }
  const selectedModules = scaffold.modules.map((item, index) => {
    exactKeys(item, moduleFields, `scaffold.modules[${index}]`);
    return {
      id: id(item.id, `scaffold.modules[${index}].id`),
      version: text(item.version, `scaffold.modules[${index}].version`, 64),
    };
  });
  if (new Set(selectedModules.map(item => item.id)).size !== selectedModules.length) {
    fail('scaffold.modules must not contain duplicates');
  }
  const selectedModuleIds = new Set(selectedModules.map(item => item.id));
  const selectedCapabilities = stringList(raw.capabilities, 'capabilities', 30);
  const selectedCapabilityIds = new Set(selectedCapabilities);
  if (selectedCapabilities.some(capabilityId => !capabilities.has(capabilityId))) {
    fail('capabilities contains an unsupported identifier');
  }

  if (!Array.isArray(scaffold.acceptedLimitations) || scaffold.acceptedLimitations.length > 128) {
    fail('scaffold.acceptedLimitations is invalid');
  }
  for (const [index, item] of scaffold.acceptedLimitations.entries()) {
    exactKeys(item, limitationFields, `scaffold.acceptedLimitations[${index}]`);
    if (!Array.isArray(item.limitations)) fail('scaffold.acceptedLimitations is invalid');
  }
  if (typeof scaffold.offline !== 'boolean') fail('scaffold.offline must be a boolean');
  const prerequisites = stringList(scaffold.prerequisites, 'scaffold.prerequisites', 128);
  const permissions = scaffold.permissions;
  if (!Array.isArray(permissions) || permissions.length > 128 ||
      permissions.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(item)) ||
      new Set(permissions).size !== permissions.length) {
    fail('scaffold.permissions is invalid');
  }
  const normalizedPermissions = [...permissions].sort();
  if (!Array.isArray(scaffold.languages) || scaffold.languages.length < 1 || scaffold.languages.length > 32) {
    fail('scaffold.languages is invalid');
  }
  const languages = scaffold.languages.map((item, index) => text(item, `scaffold.languages[${index}]`, 64));
  if (new Set(languages).size !== languages.length) fail('scaffold.languages must not contain duplicates');
  const defaultLanguage = text(scaffold.defaultLanguage, 'scaffold.defaultLanguage', 64);

  const resolved = resolveModules(moduleRegistry, {
    modules: selectedModules,
    acceptedLimitations: scaffold.acceptedLimitations,
    prerequisites,
    permissions: normalizedPermissions,
    offline: scaffold.offline,
  });
  if (!selectedModuleIds.has('ai-disabled')) fail('scaffold.modules must include ai-disabled');

  const normalizedModules = resolved.modules.map(module => ({ id: module.id, version: module.version }));
  const acceptedLimitations = resolved.limitations.map(item => ({
    id: item.moduleId,
    version: item.version,
    limitations: [...item.accepted].sort(),
  }));
  const generatorConfig = {
    schemaVersion: 2,
    productName: product.name,
    projectSlug: product.slug,
    domain: product.domain,
    modules: normalizedModules,
    acceptedLimitations,
    prerequisites,
    permissions: normalizedPermissions,
    offline: scaffold.offline,
    languages,
    defaultLanguage,
    deploymentTarget: text(scaffold.deploymentTarget, 'scaffold.deploymentTarget', 32),
  };
  validateConfig({
    schemaVersion: 1,
    productName: product.name,
    projectSlug: product.slug,
    domain: product.domain,
    modules: resolved.modules.map(module => module.id),
    languages,
    defaultLanguage,
    deploymentTarget: generatorConfig.deploymentTarget,
  });

  if (!Array.isArray(raw.mvp) || raw.mvp.length < 1 || raw.mvp.length > 40) {
    fail('mvp must contain 1-40 features');
  }
  const capabilityIds = new Set(selectedCapabilities);
  const features = raw.mvp.map((feature, index) =>
    validateFeature(feature, index, selectedModuleIds, capabilityIds));
  const featuresById = validateDependencies(features);
  const assumptions = raw.assumptions;
  if (!Array.isArray(assumptions) || assumptions.length > 20) fail('assumptions is invalid');
  const normalizedAssumptions = assumptions.map((item, index) => text(item, `assumptions[${index}]`, 300));
  return {
    product,
    market,
    features,
    featuresById,
    selectedCapabilities,
    generatorConfig,
    assumptions: normalizedAssumptions,
  };
}

function compileIntakeV2(raw) {
  const verified = validateIntakeV2(raw);
  const capabilityRequests = verified.selectedCapabilities.map(capabilityId => {
    const capability = capabilities.get(capabilityId);
    return {
      id: capability.id,
      title: capability.title,
      status: capability.status,
      category: capability.category,
      scaffold: capability.scaffold,
      owner: capability.owner,
      implementation: 'draft-only',
      readyForUse: false,
    };
  });
  const selectedModuleLimitations = verified.generatorConfig.acceptedLimitations.map(item => {
    const entry = modules.get(item.id);
    return {
      id: item.id,
      version: item.version,
      limitations: entry.limitations.map(limitation => ({
        id: limitation.id,
        description: limitation.description,
        accepted: true,
      })),
    };
  });
  const implementationContracts = verified.features.map(feature => {
    const featureCapabilities = capabilityRequests.filter(item => feature.capabilityIds.includes(item.id));
    return {
      contractVersion: 1,
      featureId: feature.id,
      title: feature.title,
      description: feature.description,
      priority: feature.priority,
      specialist: feature.owner,
      dependencies: feature.dependsOn.map(featureId => ({
        featureId,
        priority: verified.featuresById.get(featureId).priority,
        resolved: false,
      })),
      modules: feature.moduleIds,
      missingFeatures: featureCapabilities.filter(item => item.status !== 'scaffold'),
      acceptedLimitations: selectedModuleLimitations.filter(item => feature.moduleIds.includes(item.id)),
      acceptanceCriteria: feature.acceptanceCriteria,
      status: 'draft',
      approved: false,
      files: null,
    };
  });
  const dryRunReport = generateProjectV2({
    config: verified.generatorConfig,
    outputRoot: path.join(os.tmpdir(), `saas-factory-intake-${randomUUID()}`),
    write: false,
  });
  return {
    schemaVersion: 2,
    kind: 'saas-factory-intake-plan',
    intakeVersion: 2,
    projectSlug: verified.generatorConfig.projectSlug,
    generatorConfig: verified.generatorConfig,
    capabilityRequests,
    implementationContracts,
    dryRunReport: {
      ...dryRunReport,
      destination: '<output-root>/<projectSlug>',
      inputMode: 'dry-run',
      filesWritten: false,
      githubIssuesCreated: false,
      requirements: {
        product: verified.product,
        market: verified.market,
        featureCount: verified.features.length,
        priorities: ['p0', 'p1', 'p2'],
        missingFeatures: capabilityRequests.filter(item => item.status !== 'scaffold'),
        acceptedLimitations: selectedModuleLimitations,
      },
      safeguards: {
        networkAccess: false,
        repositoryCreated: false,
        providerActivated: false,
        issuesCreated: false,
        readyForDispatch: false,
      },
    },
    assumptions: verified.assumptions,
  };
}

export { validateIntakeV2, compileIntakeV2 };
