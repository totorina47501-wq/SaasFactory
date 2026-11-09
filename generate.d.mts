export type DeploymentTarget = 'none' | 'cloudflare-opennext';

export interface FactoryConfig {
  schemaVersion: 1;
  productName: string;
  projectSlug: string;
  domain: string;
  modules: string[];
  languages: string[];
  defaultLanguage: string;
  deploymentTarget: DeploymentTarget;
}

export interface ModuleSelection {
  id: string;
  version: string;
}

export interface AcceptedModuleLimitations extends ModuleSelection {
  limitations: string[];
}

export interface FactoryConfigV2 {
  schemaVersion: 2;
  productName: string;
  projectSlug: string;
  domain: string;
  modules: ModuleSelection[];
  acceptedLimitations: AcceptedModuleLimitations[];
  prerequisites: string[];
  permissions: string[];
  offline: boolean;
  languages: string[];
  defaultLanguage: string;
  deploymentTarget: DeploymentTarget;
}

export interface GenerationManifest {
  mode: 'dry-run' | 'write';
  projectSlug: string;
  destination: string;
  modules: string[];
  languages: string[];
  defaultLanguage: string;
  deploymentTarget: DeploymentTarget;
  files: string[];
  excluded: string[];
  checks: string[];
}

export interface GenerationManifestV2 {
  schemaVersion: 2;
  generatorVersion: 2;
  mode: 'dry-run' | 'write';
  projectSlug: string;
  destination: string;
  deploymentTarget: DeploymentTarget;
  modules: Array<ModuleSelection & {
    maturity: 'reference' | 'scaffold' | 'implemented' | 'verified';
    limitations: string[];
  }>;
  files: string[];
  hashes: Array<{ path: string; sha256: string }>;
  excluded: string[];
  checks: string[];
}

export type GenerationManifestV1 = GenerationManifest;
export interface V1MigrationDecisions {
  acceptedLimitations: AcceptedModuleLimitations[];
  prerequisites: string[];
  permissions: string[];
  offline: boolean;
}

export function parseConfigText(text: string): unknown;
export function validateConfig(value: unknown): FactoryConfig;
export function migrateV1Config(value: unknown, decisions: V1MigrationDecisions): FactoryConfigV2;
export function generateProject(options: {
  configText: string;
  outputRoot: string;
  write?: boolean;
}): GenerationManifest;
export function generateProjectV2(options: {
  config: FactoryConfigV2;
  outputRoot: string;
  write?: boolean;
}): GenerationManifestV2;
