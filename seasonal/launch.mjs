#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateProject } from '../generate.mjs';
import { themes, stylesheet } from './templates.mjs';

const targets = new Set(['none', 'cloudflare-opennext']);
const smokeNeedle = 'assert.match(page, /Welcome/);';

function safeRead(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe generated file type.');
  return fs.readFileSync(file, 'utf8');
}

function safeReplace(file, oldContent, newContent) {
  if (safeRead(file) !== oldContent) throw new Error('Generated file unexpectedly changed; refusing to replace.');
  fs.writeFileSync(file, newContent, { encoding: 'utf8', flag: 'w', mode: 0o644 });
}

export function launchSeasonal({ preset, outputRoot, write = false, target = 'none' }) {
  if (!Object.hasOwn(themes, preset)) throw new Error('Unknown seasonal preset.');
  if (!targets.has(target)) throw new Error('Unsupported deployment target.');
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new Error('Provide an explicit --output-root.');
  if (typeof write !== 'boolean') throw new Error('write must be boolean.');
  const item = themes[preset];
  const config = {
    schemaVersion: 1,
    productName: item.name,
    projectSlug: preset,
    domain: item.domain,
    modules: ['ai-disabled'],
    languages: ['fr-FR'],
    defaultLanguage: 'fr-FR',
    deploymentTarget: target,
  };
  const configText = JSON.stringify(config);
  // Generator validates path canonicality, symlinks, collisions and module boundaries.
  const preflight = generateProject({ configText, outputRoot, write: false });
  const files = ['app/page.tsx', 'app/globals.css', 'tests/smoke.test.mjs', 'README.md'];
  for (const file of files) {
    if (!preflight.files.includes(file)) throw new Error('Unrecognized generator template contract: ' + file);
  }
  const result = {
    preset, title: item.name, mode: write ? 'write' : 'dry-run',
    deploymentTarget: target, destination: preflight.destination,
    generatedBy: 'SaaSFactory generate.mjs',
    modifications: files,
    publishEnabled: false, networkEnabled: false, paymentEnabled: false,
  };
  if (!write) return result;
  const generated = generateProject({ configText, outputRoot, write: true });
  const dir = generated.destination;
  if (dir !== preflight.destination) throw new Error('Generator destination changed after preflight.');
  const pageFile = path.join(dir, 'app/page.tsx');
  const cssFile = path.join(dir, 'app/globals.css');
  const smokeFile = path.join(dir, 'tests/smoke.test.mjs');
  const readmeFile = path.join(dir, 'README.md');
  const page = safeRead(pageFile), css = safeRead(cssFile), smoke = safeRead(smokeFile), readme = safeRead(readmeFile);
  if (!page.includes('Welcome') || !smoke.includes(smokeNeedle)) {
    throw new Error('Generator baseline changed; seasonal overlays require review.');
  }
  if (!item.page.includes('export default function Home()')) throw new Error('Unknown seasonal page template.');
  const newSmoke = typeof item.smokeTest === 'string'
    ? item.smokeTest.endsWith('\n') ? item.smokeTest : item.smokeTest + '\n'
    : smoke.replace(smokeNeedle, 'assert.match(page, /' + item.name + '/);');
  const notes = `
## Seasonal Fast-Track — ${item.name}

This independent demonstration app is generated from the local SaaSFactory starter. It does not deploy, collect contacts, connect an AI model, process payments or fetch prices. Sample domain: ${item.domain} (not a live website).

To run locally: \`npm install --ignore-scripts\`, \`npm test\`, \`npm run typecheck\`, \`npm run build\`, then \`npm run dev\`. No subscriptions or remote price data are configured.

All displayed calculations rely exclusively on visitor-entered numbers. No promotional price is verified. Before commercial use, validate accessibility, consumer law, privacy, hosting, terms, branding and independent CI in the generated app repository. The optional Cloudflare target is a **build scaffold only**; it does not publish the app.
`;
  // All four targets were just created in a fresh destination by the vetted generator.
  safeReplace(pageFile, page, item.page + '\n');
  safeReplace(cssFile, css, stylesheet + '\n');
  safeReplace(smokeFile, smoke, newSmoke);
  safeReplace(readmeFile, readme, readme + notes);
  return result;
}

function parseCli(argv) {
  const values = { preset: undefined, outputRoot: undefined, write: false, target: 'none' };
  if (argv.length === 1 && argv[0] === '--list') return { list: true };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--write') { if (values.write) throw new Error('Duplicate --write.'); values.write = true; continue; }
    if (['--preset', '--output-root', '--target'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(key + ' requires a value.');
      const field = key === '--preset' ? 'preset' : key === '--target' ? 'target' : 'outputRoot';
      if (field !== 'target' && values[field] !== undefined) throw new Error('Duplicate ' + key);
      values[field] = argv[++i];
      continue;
    }
    throw new Error('Unknown seasonal CLI option: ' + key);
  }
  return values;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseCli(process.argv.slice(2));
    const result = args.list ? { presets: Object.keys(themes) } : launchSeasonal(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write('seasonal: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
