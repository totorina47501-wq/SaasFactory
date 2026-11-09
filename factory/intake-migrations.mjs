import { migrateV1Config } from '../generate.mjs';
import { verifyIntake } from '../intake.mjs';
import { validateIntakeV2 } from './intake-v2.mjs';

const migrationFields = ['acceptedLimitations', 'prerequisites', 'permissions', 'offline', 'features'];
const featureDecisionFields = [
  'id', 'dependsOn', 'moduleIds', 'capabilityIds', 'acceptanceCriteria',
];

function fail(message) {
  throw new Error(`Intake migration: ${message}`);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('decisions must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key)) ||
      expected.some(key => !Object.hasOwn(value, key))) {
    fail('decisions have missing or unsupported fields');
  }
}

function migrateIntakeV1(input, decisions) {
  const legacy = verifyIntake(input);
  exactKeys(decisions, migrationFields);
  if (!Array.isArray(decisions.features) || decisions.features.length !== legacy.mvp.length) {
    fail('a decision is required for every MVP feature');
  }

  const featureDecisions = new Map();
  for (const decision of decisions.features) {
    exactKeys(decision, featureDecisionFields);
    if (typeof decision.id !== 'string' || featureDecisions.has(decision.id)) {
      fail('feature decisions must use unique existing feature ids');
    }
    featureDecisions.set(decision.id, decision);
  }
  if (legacy.mvp.some(feature => !featureDecisions.has(feature.id))) {
    fail('a decision is required for every MVP feature');
  }

  const generatorConfig = migrateV1Config(legacy.generatorConfig, {
    acceptedLimitations: decisions.acceptedLimitations,
    prerequisites: decisions.prerequisites,
    permissions: decisions.permissions,
    offline: decisions.offline,
  });
  const migrated = {
    intakeVersion: 2,
    product: legacy.product,
    market: legacy.market,
    mvp: legacy.mvp.map(feature => ({
      ...feature,
      ...featureDecisions.get(feature.id),
    })),
    scaffold: {
      modules: generatorConfig.modules,
      acceptedLimitations: generatorConfig.acceptedLimitations,
      prerequisites: generatorConfig.prerequisites,
      permissions: generatorConfig.permissions,
      offline: generatorConfig.offline,
      languages: generatorConfig.languages,
      defaultLanguage: generatorConfig.defaultLanguage,
      deploymentTarget: generatorConfig.deploymentTarget,
    },
    capabilities: legacy.capabilities.map(capability => capability.id),
    assumptions: legacy.assumptions,
  };
  validateIntakeV2(migrated);
  return migrated;
}

export { migrateIntakeV1 };
