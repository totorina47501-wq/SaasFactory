import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeModuleFiles } from '../factory/composer.mjs';
import { createGenerationReport } from '../factory/generation-report.mjs';
import { generateProject, migrateV1Config } from '../generate.mjs';

const generator = fileURLToPath(new URL('../generate.mjs', import.meta.url));
const selection = [
  { id: 'ai-disabled', version: '1.0.0' },
  { id: 'api', version: '1.0.0' },
  { id: 'auth', version: '1.0.0' },
  { id: 'billing-test', version: '1.0.0' },
  { id: 'media', version: '1.0.0' },
];
const acceptedLimitations = [
  { id: 'ai-disabled', version: '1.0.0', limitations: ['disabled-by-design'] },
  { id: 'api', version: '1.0.0', limitations: ['example-route-only'] },
  { id: 'auth', version: '1.0.0', limitations: ['injected-boundary-only'] },
  { id: 'billing-test', version: '1.0.0', limitations: ['simulation-only'] },
  { id: 'media', version: '1.0.0', limitations: ['synthetic-fixtures-only'] },
];
const config = {
  schemaVersion: 2,
  productName: 'Atelier Exemple',
  projectSlug: 'atelier-exemple',
  domain: 'atelier.example',
  modules: selection,
  acceptedLimitations,
  prerequisites: [],
  permissions: [],
  offline: true,
  languages: ['fr-FR', 'en'],
  defaultLanguage: 'fr-FR',
  deploymentTarget: 'none',
};
let temp;
beforeEach(() => { temp = mkdtempSync(path.join(tmpdir(), 'saas-factory-v2-')); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });
const generate = (changes = {}, write = false, outputRoot = path.join(temp, 'out')) =>
  generateProject({ configText: JSON.stringify({ ...config, ...changes }), outputRoot, write });

describe('SaaS Factory generator v2', () => {
  it('creates a deterministic dry-run manifest with exact module versions and file hashes', () => {
    const first = generate();
    const second = generate();
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.mode, 'dry-run');
    assert.deepEqual(first, second);
    assert.deepEqual(first.modules.map(({ id, version }) => ({ id, version })), selection);
    assert.ok(first.files.includes('factory-manifest.json'));
    assert.ok(first.files.includes('docs/installation-report.md'));
    assert.ok(first.hashes.some(({ path: file }) => file === 'lib/auth.mjs'));
    assert.equal(new Set(first.hashes.map(({ path: file }) => file.toLowerCase())).size, first.hashes.length);
    assert.deepEqual(readdirSync(temp), []);
  });

  it('writes the composed independent app and refuses a repeated write', () => {
    const result = generate({}, true);
    const manifest = JSON.parse(readFileSync(path.join(result.destination, 'factory-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.modules.map(({ id }) => id), selection.map(({ id }) => id));
    for (const file of result.hashes) {
      const contents = readFileSync(path.join(result.destination, file.path));
      assert.equal(createHash('sha256').update(contents).digest('hex'), file.sha256);
    }
    assert.match(readFileSync(path.join(result.destination, 'docs/installation-report.md'), 'utf8'), /Installation report/);
    assert.match(readFileSync(path.join(result.destination, 'app/api/example/route.js'), 'utf8'), /Example API route/);
    assert.doesNotMatch(readFileSync(path.join(result.destination, 'package.json'), 'utf8'), /preinstall|postinstall/);
    assert.throws(() => generate({}, true), /already exists/);
  });

  it('rejects unknown fields, missing limitation acceptance, untrusted modules, and v1-only schema validation', () => {
    for (const changes of [
      { extra: true },
      { acceptedLimitations: [] },
      { modules: [{ id: '../escape', version: '1.0.0' }] },
      { modules: [{ id: 'ai-disabled', version: '2.0.0' }] },
      { deploymentTarget: 'prod' },
      { productName: 'sk-test-abcdefghijklmnop' },
    ]) {
      assert.throws(() => generate(changes, true));
      assert.deepEqual(readdirSync(temp), []);
    }
    const legacy = {
      schemaVersion: 1,
      productName: config.productName,
      projectSlug: config.projectSlug,
      domain: config.domain,
      modules: ['ai-disabled'],
      languages: ['fr-FR'],
      defaultLanguage: 'fr-FR',
      deploymentTarget: 'none',
    };
    const result = generateProject({
      configText: JSON.stringify(legacy),
      outputRoot: path.join(temp, 'v1'),
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(Object.hasOwn(result, 'generatorVersion'), false);
  });

  it('migrates v1 only with explicit limitation and offline decisions', () => {
    const legacy = {
      schemaVersion: 1,
      productName: config.productName,
      projectSlug: config.projectSlug,
      domain: config.domain,
      modules: ['ai-disabled', 'auth'],
      languages: ['fr-FR'],
      defaultLanguage: 'fr-FR',
      deploymentTarget: 'none',
    };
    const migrated = migrateV1Config(legacy, {
      acceptedLimitations: [
        { id: 'ai-disabled', version: '1.0.0', limitations: ['disabled-by-design'] },
        { id: 'auth', version: '1.0.0', limitations: ['injected-boundary-only'] },
      ],
      prerequisites: [],
      permissions: [],
      offline: true,
    });
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.modules, [
      { id: 'ai-disabled', version: '1.0.0' },
      { id: 'auth', version: '1.0.0' },
    ]);
    assert.throws(() => migrateV1Config(legacy, {}, value => value), /migration options/);
  });

  it('generates and smoke-tests every module and deployment-target combination', () => {
    const optionalModules = ['api', 'auth', 'billing-test', 'media'];
    const smokeTests = [];
    for (let mask = 0; mask < 2 ** optionalModules.length; mask += 1) {
      const ids = ['ai-disabled', ...optionalModules.filter((_, index) => mask & (1 << index))];
      const modules = ids.map(id => ({ id, version: '1.0.0' }));
      const limitations = acceptedLimitations.filter(item => ids.includes(item.id));
      for (const deploymentTarget of ['none', 'cloudflare-opennext']) {
        const outputRoot = path.join(temp, `combo-${mask}-${deploymentTarget}`);
        const result = generateProject({
          configText: JSON.stringify({ ...config, modules, acceptedLimitations: limitations, deploymentTarget }),
          outputRoot,
          write: true,
        });
        assert.deepEqual(result.modules.map(({ id }) => id), ids);
        assert.equal(result.files.includes('open-next.config.ts'), deploymentTarget === 'cloudflare-opennext');
        smokeTests.push(path.join(result.destination, 'tests/smoke.test.mjs'));
      }
    }
    execFileSync(process.execPath, ['--test', ...smokeTests], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  });

  it('rejects case-colliding output paths before writing', () => {
    const files = new Map([
      ['lib/auth.mjs', 'trusted source'],
      ['LIB/AUTH.MJS', 'collision'],
    ]);
    const resolved = {
      modules: [{ id: 'auth', version: '1.0.0', generatedFiles: ['lib/auth.mjs'] }],
      limitations: [],
    };
    assert.throws(() => composeModuleFiles(resolved, files), /collid/i);
    assert.deepEqual(readdirSync(temp), []);
  });

  it('reserves report paths against future module collisions', () => {
    assert.throws(() => createGenerationReport({
      mode: 'dry-run',
      projectSlug: config.projectSlug,
      destination: path.join(temp, 'out', config.projectSlug),
      deploymentTarget: 'none',
      modules: [],
      hashes: [],
      files: new Map([['FACTORY-MANIFEST.JSON', 'collision']]),
    }), /collide/);
  });

  it('rejects traversal paths and symlinked destinations without writing', () => {
    const traversal = {
      modules: [{ id: 'auth', version: '1.0.0', generatedFiles: ['../outside'] }],
      limitations: [],
    };
    assert.throws(() => composeModuleFiles(traversal, new Map([['../outside', 'untrusted']])), /unsafe generated file path/);
    const target = path.join(temp, 'target');
    const link = path.join(temp, 'link');
    mkdirSync(target);
    symlinkSync(target, link);
    assert.throws(() => generate({}, true, link), /symbolic links/);
    assert.deepEqual(readdirSync(target), []);
  });

  it('keeps the CLI dry-run by default and requires explicit write', () => {
    const manifestFile = path.join(temp, 'v2.json');
    const output = path.join(temp, 'out');
    writeFileSync(manifestFile, JSON.stringify(config));
    const dry = spawnSync(process.execPath, [generator, '--config', manifestFile, '--output-root', output], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
    assert.deepEqual(readdirSync(temp), ['v2.json']);
    const write = spawnSync(process.execPath, [generator, '--config', manifestFile, '--output-root', output, '--write'], { encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(JSON.parse(write.stdout).mode, 'write');
  });
});
