import { generateProject } from '../generate.mjs';
import { createSitemap, LOCALES, PUBLIC_ROUTES } from '../modules/i18n-seo/index.mjs';
import { integrateNeutralI18nSeo } from '../modules/i18n-seo/generated-overlay.mjs';
import { moduleRegistry } from './module-registry.mjs';

const profileFields = ['configText', 'outputRoot', 'write', 'integrations', 'origin'];
const integrationIds = new Set(['i18n-seo']);
const registryEntries = new Map(moduleRegistry.listModules().map(entry =>
  [entry.descriptor.id, entry],
));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(message) {
  throw new Error(`Starter profile: ${message}`);
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object.');
  const prototype = Object.getPrototypeOf(options);
  const keys = Reflect.ownKeys(options);
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.some(key => typeof key !== 'string' || !profileFields.includes(key)) ||
      ['configText', 'outputRoot'].some(key => !Object.hasOwn(options, key))) {
    fail('unknown or missing options.');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('options must contain plain data fields.');
  }
  if (typeof options.configText !== 'string' || Buffer.byteLength(options.configText, 'utf8') > 65_536) {
    fail('configText must be a JSON string no larger than 64 KiB.');
  }
  if (typeof options.outputRoot !== 'string' || !options.outputRoot.trim()) {
    fail('an explicit outputRoot is required.');
  }
  if (options.write !== undefined && typeof options.write !== 'boolean') fail('write must be boolean.');
  if (options.integrations !== undefined &&
      (!Array.isArray(options.integrations) || Object.getPrototypeOf(options.integrations) !== Array.prototype)) {
    fail('integrations must be an array.');
  }
  const integrations = options.integrations ?? [];
  if (Reflect.ownKeys(integrations).length !== integrations.length + 1 ||
      Array.from({ length: integrations.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(integrations, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('integrations must be a dense array of plain values.');
        return descriptor.value;
      }).some(id => typeof id !== 'string' || !integrationIds.has(id)) ||
      new Set(integrations).size !== integrations.length) {
    fail('integrations contains an unsupported or duplicate value.');
  }

  let config;
  try {
    config = JSON.parse(options.configText);
  } catch {
    fail('configText must contain valid JSON.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 2) {
    fail('only the strict generator schema v2 is supported.');
  }

  let integration;
  if (integrations.includes('i18n-seo')) {
    if (typeof options.origin !== 'string' ||
        config.deploymentTarget !== 'none' ||
        !Array.isArray(config.modules) ||
        config.modules.length !== 1 ||
        config.modules[0]?.id !== 'ai-disabled' ||
        config.modules[0]?.version !== '1.0.0' ||
        !Array.isArray(config.languages) ||
        [...config.languages].sort(compareText).join('\0') !== [...LOCALES].sort(compareText).join('\0') ||
        config.offline !== true ||
        !Array.isArray(config.prerequisites) || config.prerequisites.length !== 0 ||
        !Array.isArray(config.permissions) || config.permissions.length !== 0) {
      fail('i18n-seo requires only ai-disabled@1.0.0, FR/EN, offline mode, and deploymentTarget none.');
    }
    try {
      createSitemap({ origin: options.origin });
    } catch {
      fail('i18n-seo requires a valid HTTPS public origin.');
    }
    integration = Object.freeze({
      id: 'i18n-seo',
      contractVersion: 1,
      files: Object.freeze([
        'app/(default)/layout.tsx',
        'app/(default)/page.tsx',
        ...LOCALES.flatMap(locale => [
          `app/${locale}/layout.tsx`,
          ...PUBLIC_ROUTES.map(route => `app/${locale}${route === '/' ? '' : route}/page.tsx`),
        ]),
        'app/robots.ts',
        'app/sitemap.ts',
      ].sort(compareText)),
      limitations: Object.freeze([
        'The integration accepts only the neutral ai-disabled starter.',
        'Generated localized pages are draft-only and noindex.',
        'The generated sitemap is intentionally empty.',
      ]),
      prerequisites: Object.freeze(['https-public-origin']),
      permissions: Object.freeze([]),
      offline: true,
      publishEnabled: false,
    });
  } else if (Object.hasOwn(options, 'origin')) {
    fail('origin is only accepted with the i18n-seo integration.');
  }
  return { config, integrations, integration };
}

function capabilityReport(manifest) {
  return manifest.modules.map(module => {
    const entry = registryEntries.get(module.id);
    if (!entry || entry.descriptor.version !== module.version) fail('generator returned an unknown module version.');
    return Object.freeze({
      id: module.id,
      version: module.version,
      maturity: module.maturity,
      included: true,
      files: Object.freeze([...entry.descriptor.generatedFiles].sort(compareText)),
      limitations: Object.freeze(entry.limitations.map(item => Object.freeze({
        id: item.id,
        description: item.description,
      }))),
      prerequisites: Object.freeze([...entry.descriptor.prerequisites].sort(compareText)),
      permissions: Object.freeze([...entry.descriptor.permissions].sort(compareText)),
      offline: Object.freeze({ ...entry.descriptor.offline }),
    });
  }).sort((left, right) => compareText(left.id, right.id));
}

function neutralV1Config(config) {
  return JSON.stringify({
    schemaVersion: 1,
    productName: config.productName,
    projectSlug: config.projectSlug,
    domain: config.domain,
    modules: ['ai-disabled'],
    languages: config.languages,
    defaultLanguage: config.defaultLanguage,
    deploymentTarget: 'none',
  });
}

export function generateStarterProfile(options) {
  const { config, integrations, integration } = validateOptions(options);
  const write = options.write ?? false;
  const resolution = generateProject({
    configText: options.configText,
    outputRoot: options.outputRoot,
    write: false,
  });
  const capabilities = capabilityReport(resolution);
  if (integration && resolution.modules.length !== 1) fail('i18n-seo is incompatible with selected modules.');
  const materializationConfig = integration ? neutralV1Config(config) : options.configText;
  const preview = integration
    ? generateProject({ configText: materializationConfig, outputRoot: options.outputRoot, write: false })
    : resolution;
  let generated = preview;

  if (write) {
    generated = generateProject({
      configText: materializationConfig,
      outputRoot: options.outputRoot,
      write: true,
    });
    if (generated.destination !== preview.destination) fail('destination changed after preview.');
    if (integration) {
      const applied = integrateNeutralI18nSeo({
        projectDir: generated.destination,
        origin: options.origin,
        write: true,
      });
      if (applied.status !== 'written' ||
          applied.files.join('\0') !== integration.files.join('\0')) {
        fail('i18n-seo integration output differed from its validated manifest.');
      }
    }
  }

  const files = [...new Set([
    ...preview.files,
    ...(integration?.files ?? []),
  ])].sort(compareText);
  return Object.freeze({
    schemaVersion: 1,
    profileVersion: 1,
    mode: write ? 'write' : 'dry-run',
    projectSlug: preview.projectSlug,
    destination: preview.destination,
    deploymentTarget: config.deploymentTarget,
    modules: resolution.modules,
    resolution: Object.freeze({
      schemaVersion: resolution.schemaVersion,
      generatorVersion: resolution.generatorVersion,
      modules: resolution.modules,
    }),
    capabilities: Object.freeze(capabilities),
    integrations: Object.freeze(integration ? [integration] : []),
    files: Object.freeze(files),
    generator: generated,
    publishEnabled: false,
    paymentEnabled: false,
    providerEnabled: false,
    requiresReleaseApproval: true,
    checks: Object.freeze([
      'strict generator schema v2 and exact module versions',
      'existing module registry and trusted generator composer',
      'module limitations, prerequisites, permissions, and offline metadata reported',
      'safe destination, generated-file allowlist, and secret checks delegated to generateProject',
      'optional i18n-seo adapter is restricted to the neutral ai-disabled starter',
      'no module hooks, provider calls, payment, or deployment',
    ]),
  });
}
