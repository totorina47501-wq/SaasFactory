import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateStarterProfile } from '../factory/starter-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = fs.readFileSync(path.join(root, 'examples/saas-starter-v2.json'), 'utf8');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saas-starter-profile-'));
const neutralConfig = () => {
  const config = JSON.parse(example);
  config.modules = [{ id: 'ai-disabled', version: '1.0.0' }];
  config.acceptedLimitations = [{
    id: 'ai-disabled',
    version: '1.0.0',
    limitations: ['disabled-by-design'],
  }];
  return JSON.stringify(config);
};

test('starter profile dry-run is deterministic and reports registry capabilities without writing', () => {
  const outputRoot = scratch();
  try {
    const options = { configText: example, outputRoot };
    const first = generateStarterProfile(options);
    const second = generateStarterProfile(options);
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.mode, 'dry-run');
    assert.equal(first.publishEnabled, false);
    assert.equal(first.paymentEnabled, false);
    assert.equal(first.providerEnabled, false);
    assert.deepEqual(first.capabilities.map(({ id }) => id), [
      'ai-disabled', 'api', 'auth', 'billing-test', 'media',
    ]);
    assert.ok(first.capabilities.every(capability =>
      capability.version === '1.0.0' &&
      Array.isArray(capability.files) &&
      Array.isArray(capability.limitations) &&
      Array.isArray(capability.prerequisites)));
    assert.ok(first.files.includes('factory-manifest.json'));
    assert.ok(first.files.includes('docs/installation-report.md'));
    assert.deepEqual(fs.readdirSync(outputRoot), []);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('starter profile writes through the existing generator and produces a runnable local scaffold', () => {
  const outputRoot = scratch();
  try {
    const report = generateStarterProfile({ configText: example, outputRoot, write: true });
    const app = report.destination;
    assert.equal(report.mode, 'write');
    assert.ok(fs.existsSync(path.join(app, 'app/page.tsx')));
    assert.ok(fs.existsSync(path.join(app, 'lib/auth.mjs')));
    assert.ok(fs.existsSync(path.join(app, 'lib/billing-test.mjs')));
    assert.ok(fs.existsSync(path.join(app, 'lib/media-fixture.mjs')));
    assert.ok(fs.existsSync(path.join(app, 'factory-manifest.json')));
    assert.ok(fs.existsSync(path.join(app, 'docs/installation-report.md')));
    assert.equal(fs.existsSync(path.join(app, '.env')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), /stripe|supabase|openai|anthropic/i);
    execFileSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], {
      cwd: app,
      stdio: 'pipe',
      timeout: 30_000,
    });
    assert.throws(() => generateStarterProfile({ configText: example, outputRoot, write: true }), /exist|collision|overwrite/i);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('i18n SEO is opt-in and limited to the neutral standalone configuration', () => {
  const outputRoot = scratch();
  const origin = 'https://starter.example';
  try {
    const preview = generateStarterProfile({
      configText: neutralConfig(),
      outputRoot,
      integrations: ['i18n-seo'],
      origin,
    });
    assert.equal(preview.mode, 'dry-run');
    assert.equal(preview.integrations[0].id, 'i18n-seo');
    assert.equal(preview.integrations[0].contractVersion, 1);
    assert.equal(preview.integrations[0].files.length, 14);
    assert.ok(preview.files.includes('app/fr-FR/features/page.tsx'));
    assert.ok(preview.files.includes('app/robots.ts'));
    assert.deepEqual(fs.readdirSync(outputRoot), []);

    const written = generateStarterProfile({
      configText: neutralConfig(),
      outputRoot,
      integrations: ['i18n-seo'],
      origin,
      write: true,
    });
    assert.equal(written.mode, 'write');
    assert.equal(written.generator.schemaVersion, undefined);
    assert.equal(written.resolution.schemaVersion, 2);
    assert.equal(fs.existsSync(path.join(written.destination, 'factory-manifest.json')), false);
    assert.ok(fs.existsSync(path.join(written.destination, 'app/fr-FR/features/page.tsx')));
    assert.ok(fs.existsSync(path.join(written.destination, 'app/en/pricing/page.tsx')));
    assert.match(fs.readFileSync(path.join(written.destination, 'app/fr-FR/pricing/page.tsx'), 'utf8'), /"index": false/);
    execFileSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], {
      cwd: written.destination,
      stdio: 'pipe',
      timeout: 30_000,
    });
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('rejects unsupported, unsafe, or incompatible profile selections before writing', () => {
  const outputRoot = scratch();
  try {
    const nonNeutralConfig = JSON.parse(example);
    for (const options of [
      { configText: JSON.stringify({ ...JSON.parse(example), extra: true }), outputRoot },
      { configText: JSON.stringify({ ...JSON.parse(example), modules: [{ id: 'unknown', version: '1.0.0' }] }), outputRoot },
      { configText: JSON.stringify({ ...JSON.parse(example), schemaVersion: 1 }), outputRoot },
      { configText: example, outputRoot, integrations: ['unlisted'] },
      { configText: example, outputRoot, integrations: new Array(1) },
      { configText: example, outputRoot, extra: true },
      { configText: example, outputRoot, integrations: ['i18n-seo'], origin: 'http://starter.example' },
      {
        configText: JSON.stringify(nonNeutralConfig),
        outputRoot,
        integrations: ['i18n-seo'],
        origin: 'https://starter.example',
      },
      { configText: example, outputRoot, write: 'true' },
      { configText: example, outputRoot: '' },
    ]) {
      assert.throws(() => generateStarterProfile(options));
      assert.deepEqual(fs.readdirSync(outputRoot), []);
    }
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
