import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProject, parseConfigText, validateConfig } from '../generate.mjs';

const generator = fileURLToPath(new URL('../generate.mjs', import.meta.url));
const base = {
  schemaVersion: 1,
  productName: 'Atelier Exemple',
  projectSlug: 'atelier-exemple',
  domain: 'atelier.example',
  modules: ['ai-disabled'],
  languages: ['fr-FR'],
  defaultLanguage: 'fr-FR',
  deploymentTarget: 'none',
};
let temp;
beforeEach(() => { temp = mkdtempSync(path.join(tmpdir(), 'saas-factory-')); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });
const configText = (changes = {}) => JSON.stringify({ ...base, ...changes });
const generate = (changes = {}, write = false, outputRoot = path.join(temp, 'out')) =>
  generateProject({ configText: configText(changes), outputRoot, write });

describe('SaaS Factory standalone generator', () => {
  it('strictly validates the versioned manifest and canonicalizes module order', () => {
    const parsed = validateConfig({ ...base, modules: ['media', 'api', 'ai-disabled'] });
    assert.deepEqual(parsed.modules, ['ai-disabled', 'api', 'media']);
    assert.equal(parsed.schemaVersion, 1);
  });

  it('rejects repeated JSON keys, including nested objects', () => {
    assert.throws(() => parseConfigText('{"a":1,"a":2}'), /Duplicate JSON key/);
    assert.throws(() => parseConfigText('{"nested":{"a":1,"a":2}}'), /Duplicate JSON key/);
  });

  const invalidCases = [
    { unexpected: true },
    { schemaVersion: 2 },
    { productName: 42 },
    { projectSlug: '../escape' },
    { projectSlug: '%2e%2e' },
    { projectSlug: 'con' },
    { domain: 'https://bad.example/path' },
    { modules: ['api'] },
    { modules: ['ai-disabled', 'ai-disabled'] },
    { modules: ['ai-disabled', 'payments'] },
    { languages: ['en_US'] },
    { languages: ['en', 'en'], defaultLanguage: 'en' },
    { defaultLanguage: 'en' },
    { deploymentTarget: 'prod' },
  ];
  for (const invalid of invalidCases) {
    it('fails closed on invalid manifest ' + JSON.stringify(invalid), () => {
      assert.throws(() => generate(invalid));
      assert.deepEqual(readdirSync(temp), []);
    });
  }

  it('defaults to deterministic zero-write dry runs', () => {
    const options = { modules: ['ai-disabled', 'api'], languages: ['fr-FR', 'en'] };
    const a = generate(options);
    const b = generate(options);
    assert.equal(a.mode, 'dry-run');
    assert.deepEqual(a.files, b.files);
    assert.ok(a.files.includes('app/api/example/route.js'));
    assert.ok(a.files.includes('i18n/messages/en.json'));
    assert.deepEqual(readdirSync(temp), []);
  });

  it('writes a new project, runs its smoke tests, and refuses overwrite', () => {
    const result = generate({ modules: ['ai-disabled', 'api', 'auth', 'billing-test', 'media'] }, true);
    const dir = result.destination;
    assert.match(readFileSync(path.join(dir, 'app/page.tsx'), 'utf8'), /Welcome/);
    assert.ok(result.files.includes('lib/auth.mjs'));
    assert.ok(result.files.includes('lib/billing-test.mjs'));
    assert.ok(result.files.includes('public/media-fixture.svg'));
    assert.ok(!readdirSync(dir).includes('.git'));
    assert.match(execFileSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } }), /pass/);
    assert.throws(() => generate({}, true), /already exists/);
  });

  it('rejects symlinked output roots and case-colliding slugs', () => {
    const original = path.join(temp, 'actual');
    const symlink = path.join(temp, 'link');
    mkdirSync(original);
    symlinkSync(original, symlink);
    assert.throws(() => generate({}, true, symlink), /symbolic links/);
    const root = path.join(temp, 'output');
    mkdirSync(root);
    mkdirSync(path.join(root, 'ATELIER-EXEMPLE'));
    assert.throws(() => generate({}, true, root), /collides by case/);
  });

  it('does not generate brand-bearing content or live provider configuration', () => {
    assert.throws(() => generate({ productName: 'Mia Demo' }), /exclusion check/);
    const generated = generate({
      modules: ['ai-disabled', 'api', 'auth', 'billing-test', 'media'],
      deploymentTarget: 'cloudflare-opennext',
    }, true);
    const dir = generated.destination;
    const workflow = readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
    assert.doesNotMatch(workflow, /deploy|secrets|token/i);
    assert.ok(generated.files.includes('open-next.config.ts'));
    const config = JSON.parse(readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'));
    assert.ok(!Object.hasOwn(config, 'account_id'));
    assert.ok(!Object.hasOwn(config, 'zone_id'));
  });

  it('CLI previews and writes explicitly with no remote dependencies', () => {
    const manifestFile = path.join(temp, 'manifest.json');
    const output = path.join(temp, 'out');
    writeFileSync(manifestFile, configText());
    const dry = spawnSync(process.execPath, [generator, '--config', manifestFile, '--output-root', output], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
    assert.ok(!readdirSync(temp).includes('out'));
    const write = spawnSync(process.execPath, [generator, '--config', manifestFile, '--output-root', output, '--write'], { encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(JSON.parse(write.stdout).mode, 'write');
    assert.deepEqual(readdirSync(output), ['atelier-exemple']);
  });
});
