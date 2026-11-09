import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_PROFILES, generateDeployment } from '../deployment/generate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRuntime = path.join(root, 'modules/local-runtime');
const config = (slug, overrides = {}) => JSON.stringify({
  schemaVersion: 1,
  productName: 'Produit ' + slug,
  projectSlug: slug,
  domain: slug + '.example',
  modules: ['ai-disabled'],
  languages: ['fr-FR'],
  defaultLanguage: 'fr-FR',
  deploymentTarget: 'none',
  ...overrides,
});
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saas-deployment-'));

test('four clear deployment profiles with no implicit publication', () => {
  assert.deepEqual(DEPLOYMENT_PROFILES, ['docker','docker-compose','static-export','cloudflare-opennext']);
  const dir = scratch();
  try {
    for (const profile of DEPLOYMENT_PROFILES) {
      const configText = config('sample-project', profile === 'cloudflare-opennext' ? { deploymentTarget: 'cloudflare-opennext' } : {});
      const r = generateDeployment({ configText, outputRoot: dir, profile });
      assert.equal(r.mode, 'dry-run');
      assert.equal(r.profile, profile);
      assert.equal(r.destination, path.join(dir, 'sample-project'));
      assert.equal(r.publishEnabled, false);
      assert.equal(r.paymentEnabled, false);
      assert.equal(r.providerEnabled, false);
      assert.equal(r.dockerBuildVerified, false);
      assert.equal(r.requiresReleaseApproval, true);
      assert.ok(r.files.includes('DEPLOYMENT.md'));
      assert.equal(r.files.length, new Set(r.files).size);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const profile of DEPLOYMENT_PROFILES) {
  test(profile + ' creates an independent app with the requested reviewed deployment artifacts', () => {
    const dir = scratch();
    const slug = 'product-' + profile;
    const configText = config(slug, profile === 'cloudflare-opennext' ? { deploymentTarget: 'cloudflare-opennext' } : {});
    try {
      const result = generateDeployment({ configText, outputRoot: dir, profile, write: true });
      const app = result.destination;
      assert.equal(result.mode, 'write');
      assert.equal(fs.statSync(app).isDirectory(), true);
      assert.ok(fs.existsSync(path.join(app, 'app/page.tsx')));
      assert.ok(fs.existsSync(path.join(app, 'lib/ai-disabled.mjs')));
      assert.ok(fs.readFileSync(path.join(app, 'DEPLOYMENT.md'), 'utf8').includes('No account, registry, payment'));
      const next = fs.readFileSync(path.join(app, 'next.config.ts'), 'utf8');
      if (profile === 'static-export') assert.match(next, /output: 'export'/);
      else assert.doesNotMatch(next, /output: 'export'/);
      if (profile.startsWith('docker')) {
        for (const asset of ['Dockerfile', '.dockerignore', ...(profile === 'docker-compose' ? ['compose.yaml'] : [])]) {
          assert.equal(fs.readFileSync(path.join(app, asset), 'utf8'), fs.readFileSync(path.join(localRuntime, asset), 'utf8'));
        }
        assert.match(fs.readFileSync(path.join(app, 'DEPLOYMENT.md'), 'utf8'), /package-lock.json/);
        assert.match(fs.readFileSync(path.join(app, 'Dockerfile'), 'utf8'), /USER node/);
        assert.match(fs.readFileSync(path.join(app, '.dockerignore'), 'utf8'), /\.env/);
        assert.equal(fs.existsSync(path.join(app, 'package-lock.json')), false);
        assert.equal(fs.existsSync(path.join(app, 'compose.yaml')), profile === 'docker-compose');
      } else {
        assert.equal(fs.existsSync(path.join(app, 'Dockerfile')), false);
        assert.equal(fs.existsSync(path.join(app, 'compose.yaml')), false);
      }
      assert.equal(fs.existsSync(path.join(app, '.env')), false);
      execFileSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd: app, stdio: 'pipe', timeout: 30_000 });
      assert.throws(() => generateDeployment({ configText, outputRoot: dir, profile, write: true }), /exist|collision|overwrite/i);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('static export refuses backend, auth, commerce or external deployment targets', () => {
  const dir = scratch();
  try {
    for (const overrides of [
      { modules: ['ai-disabled', 'api'] },
      { modules: ['ai-disabled', 'auth'] },
      { modules: ['ai-disabled', 'billing-test'] },
      { modules: ['ai-disabled', 'media'] },
      { deploymentTarget: 'cloudflare-opennext' },
      { schemaVersion: 2 },
    ]) {
      assert.throws(() => generateDeployment({
        configText: config('static-test', overrides), outputRoot: dir, profile: 'static-export', write: true,
      }), /static-export/);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid profiles and conflicting deployment targets are rejected before writes', () => {
  const dir = scratch();
  try {
    assert.throws(() => generateDeployment({ configText: config('oops'), outputRoot: dir, profile: 'production', write: true }), /Unknown deployment profile/);
    assert.throws(() => generateDeployment({ configText: config('oops'), outputRoot: dir, profile: 'cloudflare-opennext', write: true }), /matching generator deploymentTarget/);
    assert.throws(() => generateDeployment({ configText: config('oops', { deploymentTarget:'cloudflare-opennext' }), outputRoot: dir, profile:'docker', write:true }), /Docker profile requires/);
    assert.throws(() => generateDeployment({ configText: config('oops'), outputRoot: dir, profile:'docker', write:'true' }), /write must be boolean/);
    assert.throws(() => generateDeployment({ configText: config('oops', { unknown:'unexpected' }), outputRoot: dir, profile:'docker', write:true }), /Unknown configuration field/);
    assert.throws(() => generateDeployment({ configText: config('oops').replace('"projectSlug":"oops"', '"projectSlug":"oops","projectSlug":"other"'), outputRoot: dir, profile:'docker', write:true }), /Duplicate JSON key/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('symlink destination is rejected and never followed', () => {
  const dir = scratch();
  const link = path.join(os.tmpdir(), 'saas-deployment-link-' + path.basename(dir));
  try {
    fs.symlinkSync(dir, link, 'dir');
    assert.throws(() => generateDeployment({ configText: config('link-product'), outputRoot: link, profile:'docker', write:true }), /symbolic|canonical/i);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(link, { force:true });
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('CLI defaults to dry-run, fails on duplicate options, and lists no secrets', () => {
  const dir = scratch();
  const cfg = path.join(dir, 'demo.json');
  fs.writeFileSync(cfg, config('sample-cli'));
  const command = path.join(root, 'deployment/generate.mjs');
  try {
    const out = execFileSync(process.execPath, [command, '--config',cfg,'--output-root',dir,'--profile','docker'], { encoding:'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(fs.readdirSync(dir), ['demo.json']);
    assert.throws(() => execFileSync(process.execPath,[command,'--config',cfg,'--config',cfg,'--output-root',dir], { stdio:'pipe' }), /Missing or duplicate/);
    assert.throws(() => execFileSync(process.execPath,[command,'--config',cfg,'--output-root',dir,'--profile','unknown','--write'], { stdio:'pipe' }), /Unknown deployment profile/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
