import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createApiService,
  createMemoryApiStore,
} from '../../modules/api/index.mjs';
import {
  createLlamaCppAdapter,
} from '../../modules/llm-local/index.mjs';
import {
  createRagIngestionService,
  RagIngestionError,
} from '../../modules/rag-ingestion/index.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'local-only-test-secret-with-at-least-32-bytes';

test('fuzzes malformed DOCX archives deterministically without persisting partial documents', async () => {
  const values = new Map();
  const service = createRagIngestionService({
    tenancy: {
      async resolveTenantContext(input) {
        assert.equal(input.tenantId, TENANT_ID);
        return { contractVersion: 1, tenantId: TENANT_ID, requestId: input.requestId };
      },
    },
    store: {
      async get(context, key) {
        return values.get(`${context.tenantId}:${key}`);
      },
      async put(context, key, value) {
        values.set(`${context.tenantId}:${key}`, { value, version: 1 });
        return 1;
      },
    },
  });
  let state = 0x5eed1234;
  for (let index = 0; index < 32; index += 1) {
    const bytes = Buffer.alloc(48);
    bytes.set([0x50, 0x4b, 0x03, 0x04]);
    for (let offset = 4; offset < bytes.length; offset += 1) {
      state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) | 0;
      bytes[offset] = state >>> 24;
    }
    await assert.rejects(service.ingest({
      cookieHeader: 'tenant-a',
      tenantId: TENANT_ID,
      requestId: `fuzz-${index}`,
      sourceId: `fuzz-${index}`,
      fileName: 'fuzz.docx',
      format: 'docx',
      data: bytes,
    }), error => error instanceof RagIngestionError &&
      ['INVALID_DOCUMENT', 'EXPANSION_LIMIT_EXCEEDED'].includes(error.code));
  }
  assert.equal(values.size, 0);
});

test('webhook simulation treats a loopback URL as payload data and makes no network request', async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end('unexpected request');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const store = createMemoryApiStore();
  const service = createApiService({
    store,
    auth: {
      async currentUser({ cookieHeader }) {
        return cookieHeader === 'session=valid' ? { id: ACTOR_ID } : null;
      },
    },
    entitlements: {
      async check() { return { allowed: true }; },
      async reserve() { return { id: 'reservation' }; },
      async consume() {},
      async refund() {},
    },
    authorize: async () => true,
    async listMembers() { return { items: [], nextCursor: null }; },
    webhookSecret: SECRET,
    origin: 'http://localhost:3000',
    clock: () => 1_800_000_000_000,
  });
  const key = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT_ID}/api-keys`,
    headers: { cookie: 'session=valid', origin: 'http://localhost:3000' },
    body: { name: 'local test', scopes: ['webhooks:simulate'], expiresAt: null },
  });
  assert.equal(key.status, 201);
  const url = `http://127.0.0.1:${port}/private`;
  const bearerToken = ['Bearer', key.body.token].join(' ');
  const simulated = await service.dispatch({
    method: 'POST',
    path: `/v1/tenants/${TENANT_ID}/webhooks/simulate`,
    headers: { authorization: bearerToken },
    body: { event: 'test.request', payload: { url } },
  });
  assert.equal(simulated.status, 200);
  assert.equal(simulated.body.payload.url, url);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 0);
});

test('passes shell metacharacters to the local model executable as data, not commands', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-security-argv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'model.gguf');
  const executable = path.join(directory, 'llama-cli');
  const marker = path.join(directory, 'shell-executed');
  const model = Buffer.from('synthetic model fixture');
  const systemPrompt = `$(touch ${marker}) ; harmless`;
  await writeFile(modelPath, model, { mode: 0o600 });
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--system-prompt') + 1];
process.stdout.write(JSON.stringify(prompt));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const adapter = createLlamaCppAdapter({
    contractVersion: 1,
    executable,
    runtimeVersion: 'test-1',
    model: {
      path: modelPath,
      version: 'test-1',
      license: 'MIT',
      sizeBytes: model.length,
      sha256: createHash('sha256').update(model).digest('hex'),
      minimumMemoryBytes: 1024 * 1024,
    },
  });
  const output = [];
  for await (const chunk of adapter.stream({ systemPrompt, prompt: 'fixture' })) {
    output.push(chunk);
  }
  assert.equal(output.join(''), JSON.stringify(systemPrompt));
  await assert.rejects(
    import('node:fs/promises').then(({ lstat }) => lstat(marker)),
    { code: 'ENOENT' },
  );
});
