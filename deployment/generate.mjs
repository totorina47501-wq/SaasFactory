#!/usr/bin/env node
// Safe packaging wrapper around SaaSFactory's vetted generator, with no remote side effects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateProject } from '../generate.mjs';

export const DEPLOYMENT_PROFILES = Object.freeze(['docker', 'docker-compose', 'static-export', 'cloudflare-opennext']);
const profiles = new Set(DEPLOYMENT_PROFILES);
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../modules/local-runtime');
const baseNextConfig = "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n";
const exportNextConfig = "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = { output: 'export' };\n\nexport default nextConfig;\n";

function safeSource(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Unsafe deployment source.');
  return fs.readFileSync(file, 'utf8');
}
function safeGeneratedFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe generated file.');
  return fs.readFileSync(file, 'utf8');
}
function writeNew(dir, name, content) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !/^[a-zA-Z.]+$/.test(name)) {
    throw new Error('Unsafe deployment destination.');
  }
  fs.writeFileSync(path.join(dir, name), content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}
function instructions(profile) {
  const lines = [
    '# Deployment profile: ' + profile, '',
    'Vetted SaaSFactory application packaging. This file is not a release approval.',
    'No account, registry, payment, DNS, remote provider or deployment is configured.', '',
  ];
  if (profile === 'static-export') {
    lines.push(
      'Static-only Next.js project: no backend API, authentication, billing or worker.',
      'Inside this generated independent project:',
      '1. npm install --ignore-scripts --no-audit --no-fund',
      '2. npm test && npm run typecheck && npm run build',
      '3. Review and publish the generated out/ directory only to an authorized static host.',
      'Check paths, accessibility, privacy, headers and update/sunset policy before release.');
  } else if (profile === 'cloudflare-opennext') {
    lines.push(
      'Existing Cloudflare OpenNext build scaffold is reused, not a static export.',
      'Install dependencies, run test/typecheck/build and validate provider compatibility separately.',
      'No Cloudflare credentials, DNS, Wrangler command or deployment is triggered.');
  } else {
    lines.push(
      'Dockerfile and .dockerignore are reused UNCHANGED from modules/local-runtime.',
      profile === 'docker-compose'
        ? 'The unchanged local Compose additionally includes PostgreSQL and optional local services.'
        : 'Docker profile runs a Node.js app only. No database or worker is enabled.',
      'The existing Dockerfile REQUIRES package-lock.json; the base generator emits no lockfile.',
      'In this independent generated application, BEFORE building:',
      '1. npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
      '2. Review and commit the resulting package-lock.json.',
      '3. npm install --ignore-scripts --no-audit --no-fund',
      '4. npm test && npm run typecheck && npm run build',
      '5. docker build -t local/example-saas:reviewed .',
      profile === 'docker-compose'
        ? '6. Supply local-only APP_SLUG, DATABASE_URL pointing at postgres, POSTGRES_PASSWORD, then explicitly docker compose up --build.'
        : '6. Run the container manually with localhost-only port binding and reviewed runtime settings.',
      'Never commit .env or a secret. Runtime values must be supplied out of band.',
      'Production still requires immutable base image digests, SBOM, CVE scan, signature, health checks and proven rollback.',
      'The Factory CI tests packaging offline: it does NOT build OCI images or publish them.');
  }
  return lines.join('\n') + '\n';
}
function validateOptions({ configText, outputRoot, profile, write }) {
  if (!profiles.has(profile)) throw new Error('Unknown deployment profile.');
  if (typeof configText !== 'string' || Buffer.byteLength(configText, 'utf8') > 65536) throw new Error('Invalid config text.');
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new Error('An explicit outputRoot is required.');
  if (typeof write !== 'boolean') throw new Error('write must be boolean.');
  let config;
  try { config = JSON.parse(configText); } catch { throw new Error('Invalid config JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config object.');
  if (profile === 'static-export') {
    if (config.schemaVersion !== 1 || !Array.isArray(config.modules) ||
        config.modules.length !== 1 || config.modules[0] !== 'ai-disabled' ||
        config.deploymentTarget !== 'none') {
      throw new Error('static-export requires v1, only ai-disabled, and deploymentTarget none.');
    }
  } else if (profile === 'cloudflare-opennext') {
    if (config.deploymentTarget !== 'cloudflare-opennext') {
      throw new Error('Cloudflare profile requires matching generator deploymentTarget.');
    }
  } else if (config.deploymentTarget !== 'none') {
    throw new Error('Docker profile requires deploymentTarget none.');
  }
}
export function generateDeployment({ configText, outputRoot, profile = 'docker', write = false }) {
  validateOptions({ configText, outputRoot, profile, write });
  // The base generator validates duplicate keys, exact schema and safe paths.
  const preview = generateProject({ configText, outputRoot, write: false });
  if (!preview.files.includes('next.config.ts') || !preview.files.includes('package.json')) {
    throw new Error('Unknown generated template.');
  }
  const overlays = profile === 'docker' ? ['Dockerfile', '.dockerignore', 'DEPLOYMENT.md']
    : profile === 'docker-compose' ? ['Dockerfile', '.dockerignore', 'compose.yaml', 'DEPLOYMENT.md']
    : profile === 'static-export' ? ['next.config.ts', 'DEPLOYMENT.md']
    : ['DEPLOYMENT.md'];
  const contents = new Map([['DEPLOYMENT.md', instructions(profile)]]);
  if (profile.startsWith('docker')) {
    for (const name of overlays) {
      if (name === 'DEPLOYMENT.md') continue;
      if (preview.files.includes(name)) throw new Error('Deployment file already exists.');
      contents.set(name, safeSource(path.join(runtime, name)));
    }
    const dockerfile = contents.get('Dockerfile');
    if (!dockerfile.includes('USER node') || !dockerfile.includes('package-lock.json')) {
      throw new Error('Unknown Dockerfile contract.');
    }
  }
  const report = {
    profile, mode: write ? 'write' : 'dry-run', destination: preview.destination,
    generatedBy: 'SaaSFactory generate.mjs', overlays,
    publishEnabled: false, paymentEnabled: false, providerEnabled: false,
    dockerBuildVerified: false, requiresReleaseApproval: true,
    files: [...new Set([...preview.files, ...overlays])].sort(),
  };
  if (!write) return report;
  const generated = generateProject({ configText, outputRoot, write: true });
  if (generated.destination !== preview.destination) throw new Error('Destination changed after preview.');
  if (profile === 'static-export') {
    const file = path.join(preview.destination, 'next.config.ts');
    if (safeGeneratedFile(file) !== baseNextConfig) throw new Error('Next.js baseline changed; refuse overlay.');
    fs.writeFileSync(file, exportNextConfig, { encoding: 'utf8', flag: 'w', mode: 0o644 });
  }
  for (const [name, content] of contents) writeNew(preview.destination, name, content);
  return report;
}
function parseArguments(argv) {
  const options = { config: undefined, outputRoot: undefined, profile: 'docker', write: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') {
      if (seen.has(arg)) throw new Error('Duplicate --write.');
      seen.add(arg);
      options.write = true;
    } else if (['--config', '--output-root', '--profile'].includes(arg)) {
      if (seen.has(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing or duplicate ' + arg);
      seen.add(arg);
      options[arg === '--config' ? 'config' : arg === '--output-root' ? 'outputRoot' : 'profile'] = argv[++i];
    } else throw new Error('Unknown deployment argument: ' + arg);
  }
  if (!options.config || !options.outputRoot) throw new Error('--config and --output-root required.');
  return options;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const stat = fs.lstatSync(args.config);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Unsafe configuration source.');
    const report = generateDeployment({
      configText: fs.readFileSync(args.config, 'utf8'),
      outputRoot: args.outputRoot, profile: args.profile, write: args.write,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    process.stderr.write('deployment: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
