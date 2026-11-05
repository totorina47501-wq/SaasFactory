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

export function parseConfigText(text: string): unknown;
export function validateConfig(value: unknown): FactoryConfig;
export function generateProject(options: {
  configText: string;
  outputRoot: string;
  write?: boolean;
}): GenerationManifest;
