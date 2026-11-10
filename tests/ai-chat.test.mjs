import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiChatError,
  aiChatContract,
  createAiChatService,
  renderChatInterface,
} from '../modules/ai-chat/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CITATION = Object.freeze({
  documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceId: 'guide-a',
  version: 1,
  fileName: 'guide.txt',
  format: 'txt',
  sha256: 'a'.repeat(64),
  chunkIndex: 0,
  page: null,
  startOffset: 0,
  endOffset: 24,
  metadata: Object.freeze({ category: 'guide' }),
});

function harness({ enabled = true, answer, results = [{ text: 'Verified guidance.', score: 0.8, citation: CITATION }] } = {}) {
  const values = new Map();
  const retrieval = { results };
  const calls = { answers: [], searches: [] };
  const tenancy = {
    async resolveTenantContext({ tenantId, requestId }) {
      return { contractVersion: 1, tenantId, requestId };
    },
  };
  const store = {
    async get(context, key) {
      return values.get(`${context.tenantId}:${key}`);
    },
    async put(context, key, value, expectedVersion) {
      const storageKey = `${context.tenantId}:${key}`;
      const current = values.get(storageKey);
      if (current?.version !== expectedVersion) {
        const error = new Error('conflict');
        error.code = 'CONFLICT';
        throw error;
      }
      const version = (current?.version ?? 0) + 1;
      values.set(storageKey, { value: structuredClone(value), version });
      return version;
    },
  };
  const ragSearch = {
    contractVersion: 1,
    async search(input) {
      calls.searches.push(input);
      return { contractVersion: 1, results: retrieval.results };
    },
  };
  const assistant = {
    contractVersion: 1,
    async answer(input) {
      calls.answers.push(input);
      if (answer instanceof Error) throw answer;
      return answer ?? { contractVersion: 1, promptVersion: '1.0.0', answer: 'A supported answer.', citations: [CITATION], abstain: false };
    },
  };
  const service = createAiChatService({
    enabled,
    tenancy,
    store,
    ragSearch,
    assistant,
    appId: 'example-app',
    promptVersions: ['1.0.0'],
    clock: () => 1_700_000_000_000,
  });
  return { service, values, calls, retrieval };
}

function request(overrides = {}) {
  return {
    cookieHeader: 'local-session',
    tenantId: TENANT_A,
    requestId: 'request-1',
    ...overrides,
  };
}

async function createSession(service, overrides = {}) {
  return service.createSession(request(overrides));
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof AiChatError && error.code === code);
}

async function collect(stream) {
  for await (const _event of stream) {}
}

test('publishes the versioned chat contract and keeps generation disabled by default', async () => {
  const { service } = harness({ enabled: false });
  assert.equal(aiChatContract.contractVersion, 1);
  assert.equal(service.enabled, false);
  const session = await createSession(service);
  await expectCode(collect(service.streamMessage(request({ sessionId: session.id, question: 'Question?' }))), 'DISABLED');
});

test('persists sessions per tenant and returns only the current tenant session', async () => {
  const { service, values, calls } = harness();
  const sessionA = await createSession(service);
  const sessionB = await createSession(service, { tenantId: TENANT_B, requestId: 'request-b' });
  const events = [];
  for await (const event of service.streamMessage(request({
    sessionId: sessionA.id,
    question: 'Where is the policy?',
    promptVersion: '1.0.0',
  }))) events.push(event);

  assert.equal(events.at(-1).type, 'message');
  assert.equal(events.at(-1).message.content, 'A supported answer.');
  assert.equal(calls.answers.length, 1);
  assert.equal(calls.answers[0].tenantId, TENANT_A);
  assert.equal(calls.answers[0].promptVersion, '1.0.0');
  assert.equal((await service.getSession(request({ sessionId: sessionA.id }))).messages.length, 2);
  assert.equal((await service.getSession(request({
    tenantId: TENANT_B,
    requestId: 'request-b',
    sessionId: sessionB.id,
  }))).messages.length, 0);
  await expectCode(service.getSession(request({ sessionId: sessionB.id })), 'SESSION_NOT_FOUND');
  assert.equal(values.size, 2);
});

test('retrieves authorized sources without invoking the local assistant', async () => {
  const { service, calls } = harness();
  const result = await service.retrieve(request({ query: 'access policy' }));
  assert.deepEqual(result.results.map(item => item.citation.sourceId), ['guide-a']);
  assert.equal(calls.answers.length, 0);
  assert.equal(calls.searches[0].tenantId, TENANT_A);
});

test('does not persist a partial turn when local generation is interrupted', async () => {
  const { service } = harness({ answer: Object.assign(new Error('interrupted'), { code: 'INTERRUPTED' }) });
  const session = await createSession(service);
  const pending = collect(service.streamMessage(request({
    sessionId: session.id,
    question: 'A question',
    promptVersion: '1.0.0',
  })));
  await expectCode(pending, 'INTERRUPTED');
  assert.equal((await service.getSession(request({ sessionId: session.id }))).messages.length, 0);
});

test('redacts stored answers when their sources are no longer available', async () => {
  const { service, retrieval } = harness();
  const session = await createSession(service);
  for await (const _event of service.streamMessage(request({
    sessionId: session.id,
    question: 'A supported question',
    promptVersion: '1.0.0',
  }))) {}

  retrieval.results = [];
  const sessionAfterRevocation = await service.getSession(request({ sessionId: session.id }));
  assert.equal(sessionAfterRevocation.messages[1].redacted, true);
  assert.equal(sessionAfterRevocation.messages[1].content, 'Cette réponse n’est plus disponible, car une source ou un droit d’accès a changé.');
  assert.deepEqual(sessionAfterRevocation.messages[1].citations, []);
});

test('renders model and document content as escaped text with accessible controls', () => {
  const html = renderChatInterface({
    enabled: true,
    session: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      messages: [
        { id: '1', role: 'assistant', content: '<img src=x onerror=alert(1)> [open](javascript:alert(1))', citations: [{ sourceId: '<script>doc</script>', fileName: 'guide<&>.txt' }] },
      ],
    },
    actionUrl: '/chat/send',
    label: 'Votre message',
  });
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /for="chat-question"/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /&lt;script&gt;doc&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<img|<script>|href="javascript:/iu);
});

test('rejects unknown fields, missing prompt versions, and invalid budgets', async () => {
  const { service } = harness();
  const session = await createSession(service);
  await expectCode(collect(service.streamMessage(request({
    sessionId: session.id,
    question: 'Question',
    promptVersion: 'unknown',
  }))), 'PROMPT_NOT_FOUND');
  await expectCode(service.retrieve(request({ query: 'query', surprise: true })), 'INVALID_INPUT');
  await expectCode(collect(service.streamMessage(request({
    sessionId: session.id,
    question: ' ',
    promptVersion: '1.0.0',
  }))), 'INVALID_INPUT');
});
