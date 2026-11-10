import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateStarterProfile } from '../../factory/starter-profile.mjs';

test('generated starter profile runs its offline smoke suite with only declared local capabilities', t => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'saas-factory-generated-app-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));

  const result = generateStarterProfile({
    configText: readFileSync(new URL('../../examples/saas-starter-v2.json', import.meta.url), 'utf8'),
    outputRoot,
    write: true,
  });
  const app = result.destination;
  const manifest = JSON.parse(readFileSync(path.join(app, 'factory-manifest.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));

  assert.equal(result.mode, 'write');
  assert.equal(result.providerEnabled, false);
  assert.equal(result.paymentEnabled, false);
  assert.equal(result.publishEnabled, false);
  assert.deepEqual(manifest.modules.map(({ id }) => id), [
    'ai-disabled',
    'api',
    'auth',
    'billing-test',
    'media',
  ]);
  assert.ok(manifest.modules.every(({ maturity }) => maturity === 'scaffold'));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['next', 'react', 'react-dom']);
  assert.equal(existsSync(path.join(app, '.env')), false);
  assert.equal(existsSync(path.join(app, 'public/media-fixture.svg')), true);
  execFileSync(process.execPath, ['--test'], {
    cwd: app,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
});
