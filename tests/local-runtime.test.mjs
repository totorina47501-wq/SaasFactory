import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  diagnoseLocalRuntime,
  LOCAL_RUNTIME_CONTRACT_VERSION,
  LocalRuntimeError,
  validateLocalRuntimeConfig,
} from '../modules/local-runtime/runtime.mjs';

const config = () => ({
  contractVersion: 1,
  appSlug: 'atelier-demo',
  appPort: 3000,
  postgres: { hostPort: 55432 },
  optional: { media: false, localModel: false, cache: false },
});

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof LocalRuntimeError && error.code === code);
}

test('validates a versioned per-app runtime config and rejects unknown or unsafe values', () => {
  const result = validateLocalRuntimeConfig(config());
  assert.equal(LOCAL_RUNTIME_CONTRACT_VERSION, 1);
  assert.equal(result.appSlug, 'atelier-demo');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.optional));
  for (const invalid of [
    { ...config(), unknown: true },
    { ...config(), contractVersion: 2 },
    { ...config(), appSlug: '../escape' },
    { ...config(), appPort: 80 },
    { ...config(), postgres: { ...config().postgres, host: 'remote.example' } },
    { ...config(), optional: { ...config().optional, localModel: 'true' } },
  ]) {
    expectCode(() => validateLocalRuntimeConfig(invalid), 'INVALID_CONFIGURATION');
  }
  let getterCalled = false;
  const withGetter = config();
  Object.defineProperty(withGetter, 'appSlug', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'atelier-demo';
    },
  });
  expectCode(() => validateLocalRuntimeConfig(withGetter), 'INVALID_CONFIGURATION');
  assert.equal(getterCalled, false);
});

test('diagnoses local tools without network access and leaves optional engines disabled', () => {
  const calls = [];
  const result = diagnoseLocalRuntime(config(), {
    nodeVersion: 'v22.12.0',
    probe: (command, args) => {
      calls.push({ command, args });
      return 'available';
    },
  });
  assert.deepEqual(result.checks, {
    node: { status: 'available', version: 'v22.12.0' },
    ffmpeg: 'disabled',
    ffprobe: 'disabled',
    database: 'available',
    model: 'disabled',
    cache: 'disabled',
  });
  assert.deepEqual(calls, [{
    command: 'pg_isready',
    args: ['-h', '127.0.0.1', '-p', '55432', '-t', '2'],
  }]);

  const enabled = config();
  enabled.optional.media = true;
  enabled.optional.localModel = true;
  const failed = diagnoseLocalRuntime(enabled, {
    nodeVersion: 'v20.0.0',
    probe: () => 'unavailable',
    modelProbe: () => 'available',
  });
  assert.equal(failed.checks.node.status, 'unsupported');
  assert.equal(failed.checks.ffmpeg, 'unavailable');
  assert.equal(failed.checks.ffprobe, 'unavailable');
  assert.equal(failed.checks.model, 'available');
  enabled.optional.cache = true;
  assert.equal(diagnoseLocalRuntime(enabled, { probe: () => 'available' }).checks.cache, 'not-checked');
});

test('diagnostic probe failures are reported without exposing error details', () => {
  const result = diagnoseLocalRuntime(config(), {
    probe() {
      throw new Error('must-not-appear');
    },
  });
  assert.equal(result.checks.database, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/u);
  expectCode(() => diagnoseLocalRuntime(config(), { probe: true }), 'INVALID_DIAGNOSTIC_OPTIONS');
  expectCode(() => diagnoseLocalRuntime(config(), { unknown: true }), 'INVALID_DIAGNOSTIC_OPTIONS');
  let getterCalled = false;
  const options = Object.defineProperty({}, 'probe', {
    enumerable: true,
    get() {
      getterCalled = true;
      return () => 'available';
    },
  });
  expectCode(() => diagnoseLocalRuntime(config(), options), 'INVALID_DIAGNOSTIC_OPTIONS');
  assert.equal(getterCalled, false);
});

test('Compose and container artifacts pin images, isolate local ports, bound services, and keep secrets out of the image', async () => {
  const compose = await readFile(new URL('../modules/local-runtime/compose.yaml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../modules/local-runtime/Dockerfile', import.meta.url), 'utf8');
  const dockerignore = await readFile(new URL('../modules/local-runtime/.dockerignore', import.meta.url), 'utf8');

  assert.match(compose, /image: postgres:16\.15-alpine/u);
  assert.match(compose, /image: redis:7\.4\.2-alpine/u);
  assert.match(compose, /image: ollama\/ollama:0\.12\.6/u);
  assert.match(compose, /profiles: \["local-model"\]/u);
  assert.match(compose, /profiles: \["cache"\]/u);
  assert.match(compose, /127\.0\.0\.1:/u);
  assert.match(compose, /internal: true/u);
  assert.match(compose, /mem_limit:/u);
  assert.match(compose, /healthcheck:/u);
  assert.match(compose, /postgres_data:/u);
  assert.match(compose, /DATABASE_URL: \$\{DATABASE_URL:\?/u);
  assert.match(compose, /CACHE_ENABLED: \$\{CACHE_ENABLED:-false\}/u);
  assert.match(compose, /LOCAL_MODEL_ENABLED: \$\{LOCAL_MODEL_ENABLED:-false\}/u);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/'\)/u);
  assert.match(dockerfile, /^FROM node:22\.12\.0-bookworm-slim AS build$/mu);
  assert.match(dockerfile, /^USER node$/mu);
  assert.doesNotMatch(dockerfile, /\b(?:ARG|ENV)\s+\w*(?:SECRET|TOKEN|PASSWORD|KEY)\w*/iu);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^secrets\/$/mu);
});
