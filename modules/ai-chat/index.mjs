import { randomUUID } from 'node:crypto';

const CONTRACT_VERSION = 1;
const STORAGE_KEY = 'ai-chat-v1/sessions';
const MAX_STORAGE_BYTES = 60 * 1024;
const REDACTED_ANSWER = 'Cette réponse n’est plus disponible, car une source ou un droit d’accès a changé.';
const DEFAULTS = Object.freeze({
  maxSessions: 10,
  maxTurnsPerSession: 20,
  maxQuestionCodeUnits: 4000,
  maxAnswerCodeUnits: 10_000,
  maxSources: 8,
  maxWriteRetries: 3,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROMPT_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const CITATION_FIELDS = [
  'documentId', 'sourceId', 'version', 'fileName', 'format', 'sha256',
  'chunkIndex', 'page', 'startOffset', 'endOffset',
];

export class AiChatError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AiChatError';
    this.code = code;
  }
}

function fail(code) {
  throw new AiChatError(code);
}

function exactObject(value, fields, required = fields, errorCode = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !fields.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail(errorCode);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
    result[key] = descriptor.value;
  }
  return result;
}

function boundedInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function text(value, maximum, { trim = false, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > maximum ||
      !allowEmpty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('INVALID_INPUT');
  }
  return trim ? value.trim() : value;
}

function validateLimits(raw = {}) {
  const input = exactObject(raw, Object.keys(DEFAULTS), [], 'INVALID_CONFIGURATION');
  const limits = { ...DEFAULTS, ...input };
  const maximums = {
    maxSessions: 100,
    maxTurnsPerSession: 100,
    maxQuestionCodeUnits: 4000,
    maxAnswerCodeUnits: 10_000,
    maxSources: 20,
    maxWriteRetries: 10,
  };
  for (const [key, maximum] of Object.entries(maximums)) {
    if (!boundedInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

function validateRequest(raw, additionalFields = []) {
  const input = exactObject(raw, ['cookieHeader', 'tenantId', 'requestId', ...additionalFields],
    ['cookieHeader', 'tenantId', 'requestId']);
  if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
      typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
      typeof input.requestId !== 'string' || !SAFE_ID.test(input.requestId)) fail('INVALID_INPUT');
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !UUID.test(input.sessionId))) {
    fail('INVALID_INPUT');
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('INVALID_INPUT');
  return input;
}

function validateCitation(raw) {
  const citation = exactObject(raw, [...CITATION_FIELDS, 'metadata'], CITATION_FIELDS);
  if (typeof citation.documentId !== 'string' || !UUID.test(citation.documentId) ||
      typeof citation.sourceId !== 'string' || !citation.sourceId.isWellFormed() ||
      citation.sourceId.length < 1 || citation.sourceId.length > 200 ||
      typeof citation.fileName !== 'string' || !citation.fileName.isWellFormed() ||
      citation.fileName.length < 1 || citation.fileName.length > 255 ||
      typeof citation.format !== 'string' || !/^[a-z0-9][a-z0-9.+-]{0,31}$/iu.test(citation.format) ||
      !boundedInteger(citation.version, 1) ||
      typeof citation.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(citation.sha256) ||
      !boundedInteger(citation.chunkIndex, 0) ||
      citation.page !== null && !boundedInteger(citation.page, 1) ||
      !boundedInteger(citation.startOffset, 0) ||
      !boundedInteger(citation.endOffset, citation.startOffset)) fail('INVALID_RESPONSE');
  return Object.freeze(Object.fromEntries(CITATION_FIELDS.map(key => [key, citation[key]])));
}

function validateMessage(raw, limits) {
  const message = exactObject(raw, [
    'id', 'requestId', 'role', 'content', 'createdAt', 'promptVersion', 'citations', 'abstain',
  ]);
  if (typeof message.id !== 'string' || !UUID.test(message.id) ||
      typeof message.requestId !== 'string' || !SAFE_ID.test(message.requestId) ||
      !['user', 'assistant'].includes(message.role) ||
      !boundedInteger(message.createdAt, 0) ||
      typeof message.content !== 'string' || !message.content.isWellFormed() ||
      message.content.length > (message.role === 'user' ? limits.maxQuestionCodeUnits : limits.maxAnswerCodeUnits) ||
      !Array.isArray(message.citations) || message.citations.length > limits.maxSources) {
    fail('CORRUPT_SESSION');
  }
  const citations = message.citations.map(validateCitation);
  if (message.role === 'user') {
    if (message.promptVersion !== null || citations.length || message.abstain !== false) fail('CORRUPT_SESSION');
  } else if (typeof message.promptVersion !== 'string' || !PROMPT_VERSION.test(message.promptVersion) ||
      typeof message.abstain !== 'boolean' || message.abstain && citations.length ||
      !message.abstain && (!message.content.trim() || !citations.length)) {
    fail('CORRUPT_SESSION');
  }
  return Object.freeze({
    id: message.id,
    requestId: message.requestId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    promptVersion: message.promptVersion,
    citations: Object.freeze(citations),
    abstain: message.abstain,
  });
}

function validateState(raw, limits) {
  const state = exactObject(raw, ['contractVersion', 'sessions'], undefined, 'CORRUPT_SESSION');
  if (state.contractVersion !== CONTRACT_VERSION || !Array.isArray(state.sessions) ||
      state.sessions.length > limits.maxSessions) fail('CORRUPT_SESSION');
  const sessionIds = new Set();
  const sessions = state.sessions.map(rawSession => {
    const session = exactObject(rawSession,
      ['id', 'title', 'createdAt', 'updatedAt', 'messages'], undefined, 'CORRUPT_SESSION');
    if (typeof session.id !== 'string' || !UUID.test(session.id) ||
        typeof session.title !== 'string' || !session.title.isWellFormed() ||
        session.title.length < 1 || session.title.length > 120 ||
        !boundedInteger(session.createdAt, 0) ||
        !boundedInteger(session.updatedAt, session.createdAt) ||
        !Array.isArray(session.messages) || session.messages.length > limits.maxTurnsPerSession * 2) {
      fail('CORRUPT_SESSION');
    }
    if (sessionIds.has(session.id)) fail('CORRUPT_SESSION');
    sessionIds.add(session.id);
    const messages = session.messages.map(message => validateMessage(message, limits));
    if (messages.length % 2 !== 0 ||
        messages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user') ||
          index > 0 && message.requestId !== messages[index - (index % 2 ? 1 : 0)]?.requestId)) {
      fail('CORRUPT_SESSION');
    }
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages,
    };
  });
  return { contractVersion: CONTRACT_VERSION, sessions };
}

function safeLocalUrl(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 2048 ||
      !value.startsWith('/') || value.startsWith('//') ||
      /[\\\u0000-\u001f\u007f#]/u.test(value)) fail('INVALID_INPUT');
  let url;
  try {
    url = new URL(value, 'https://ai-chat.invalid');
  } catch {
    fail('INVALID_INPUT');
  }
  if (url.origin !== 'https://ai-chat.invalid' || url.username || url.password || url.hash) fail('INVALID_INPUT');
  return `${url.pathname}${url.search}`;
}

function html(value) {
  return String(value).replace(/[&<>"']/gu, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function matchesCitation(left, right) {
  return left.documentId === right.documentId && left.sourceId === right.sourceId &&
    left.version === right.version && left.sha256 === right.sha256 &&
    left.chunkIndex === right.chunkIndex && left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset;
}

export function createAiChatService(options) {
  const config = exactObject(options, [
    'enabled', 'tenancy', 'store', 'ragSearch', 'assistant', 'appId',
    'promptVersions', 'limits', 'clock',
  ], ['tenancy', 'store', 'ragSearch'], 'INVALID_CONFIGURATION');
  if (!config.tenancy || typeof config.tenancy.resolveTenantContext !== 'function' ||
      !config.store || typeof config.store.get !== 'function' || typeof config.store.put !== 'function' ||
      !config.ragSearch || config.ragSearch.contractVersion !== CONTRACT_VERSION ||
      typeof config.ragSearch.search !== 'function') fail('INVALID_CONFIGURATION');
  const enabled = config.enabled === true;
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail('INVALID_CONFIGURATION');
  const limits = validateLimits(config.limits);
  const clock = config.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');
  let appId;
  let promptVersions = new Set();
  if (enabled) {
    if (!config.assistant || config.assistant.contractVersion !== CONTRACT_VERSION ||
        typeof config.assistant.answer !== 'function' ||
        typeof config.appId !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(config.appId) ||
        !Array.isArray(config.promptVersions) || config.promptVersions.length < 1 ||
        config.promptVersions.length > 32) fail('INVALID_CONFIGURATION');
    appId = config.appId;
    for (const version of config.promptVersions) {
      if (typeof version !== 'string' || !PROMPT_VERSION.test(version) || promptVersions.has(version)) {
        fail('INVALID_CONFIGURATION');
      }
      promptVersions.add(version);
    }
  }

  function now() {
    const value = clock();
    if (!boundedInteger(value, 0)) fail('UNAVAILABLE');
    return value;
  }

  async function resolveContext(input) {
    let context;
    try {
      context = exactObject(await config.tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      }), ['contractVersion', 'tenantId', 'requestId'], undefined, 'TENANT_ACCESS_DENIED');
    } catch (error) {
      if (error instanceof AiChatError) throw error;
      fail('TENANT_ACCESS_DENIED');
    }
    if (context.contractVersion !== CONTRACT_VERSION || context.tenantId !== input.tenantId.toLowerCase() ||
        context.requestId !== input.requestId) fail('TENANT_ACCESS_DENIED');
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      tenantId: context.tenantId,
      requestId: context.requestId,
    });
  }

  async function readState(context) {
    let stored;
    try {
      stored = await config.store.get(context, STORAGE_KEY);
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (stored === undefined) return { state: { contractVersion: CONTRACT_VERSION, sessions: [] }, version: undefined };
    try {
      const record = exactObject(stored, ['value', 'version'], undefined, 'CORRUPT_SESSION');
      if (!boundedInteger(record.version, 1)) fail('CORRUPT_SESSION');
      const state = validateState(record.value, limits);
      if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STORAGE_BYTES) fail('CORRUPT_SESSION');
      return { state, version: record.version };
    } catch (error) {
      if (error instanceof AiChatError) throw error;
      fail('CORRUPT_SESSION');
    }
  }

  async function mutate(context, callback) {
    for (let attempt = 0; attempt < limits.maxWriteRetries; attempt += 1) {
      const current = await readState(context);
      const next = structuredClone(current.state);
      const result = callback(next);
      if (result?.skipWrite) return result.value;
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_STORAGE_BYTES) fail('STORAGE_LIMIT');
      try {
        const version = await config.store.put(context, STORAGE_KEY, next, current.version);
        if (!boundedInteger(version, 1)) fail('STORAGE_UNAVAILABLE');
        return result;
      } catch (error) {
        if (error?.code === 'CONFLICT') continue;
        if (error instanceof AiChatError) throw error;
        fail('STORAGE_UNAVAILABLE');
      }
    }
    fail('STORAGE_BUSY');
  }

  function publicSession(session, { revalidate = false } = {}) {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map(message => ({
        ...message,
        citations: [...message.citations],
        ...(revalidate ? { redacted: false } : {}),
      })),
    };
  }

  async function sessionWithCurrentSources(session, input) {
    const messages = session.messages.map(message => ({ ...message, citations: [...message.citations] }));
    for (let index = 1; index < messages.length; index += 2) {
      const response = messages[index];
      if (!response.citations.length) continue;
      const question = messages[index - 1].content;
      if (!await sourcesRemainAvailable(input, question, response.citations)) {
        response.content = REDACTED_ANSWER;
        response.citations = [];
        response.abstain = true;
        response.redacted = true;
      } else {
        response.redacted = false;
      }
    }
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages,
    };
  }

  async function sourcesRemainAvailable(input, query, citations) {
    let current;
    try {
      current = await config.ragSearch.search({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
        query,
        topK: 100,
      });
    } catch {
      fail('SOURCE_UNAVAILABLE');
    }
    if (!current || current.contractVersion !== CONTRACT_VERSION ||
        !Array.isArray(current.results) || current.results.length > 100) fail('SOURCE_UNAVAILABLE');
    const currentCitations = current.results.map(result => {
      try {
        const entry = exactObject(result, ['text', 'score', 'citation'], undefined, 'SOURCE_UNAVAILABLE');
        if (typeof entry.text !== 'string' || typeof entry.score !== 'number' ||
            !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) {
          fail('SOURCE_UNAVAILABLE');
        }
        return validateCitation(entry.citation);
      } catch {
        fail('SOURCE_UNAVAILABLE');
      }
    });
    return citations.every(citation => currentCitations.some(item => matchesCitation(citation, item)));
  }

  async function retrieve(input, context) {
    const query = text(input.query, limits.maxQuestionCodeUnits, { trim: true });
    const topK = input.topK ?? limits.maxSources;
    if (!boundedInteger(topK, 1, limits.maxSources)) fail('INPUT_LIMIT');
    let result;
    try {
      result = await config.ragSearch.search({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: context.requestId,
        query,
        topK,
      });
    } catch {
      fail('SOURCE_UNAVAILABLE');
    }
    if (!result || result.contractVersion !== CONTRACT_VERSION || !Array.isArray(result.results) ||
        result.results.length > topK) fail('SOURCE_UNAVAILABLE');
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      results: Object.freeze(result.results.map(raw => {
        const entry = exactObject(raw, ['text', 'score', 'citation']);
        if (typeof entry.text !== 'string' || !entry.text.isWellFormed() ||
            entry.text.length > 100_000 || typeof entry.score !== 'number' ||
            !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) {
          fail('SOURCE_UNAVAILABLE');
        }
        return Object.freeze({
          text: entry.text,
          score: entry.score,
          citation: validateCitation(entry.citation),
        });
      })),
    });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    enabled,

    async createSession(rawInput) {
      const input = validateRequest(rawInput, ['title']);
      const context = await resolveContext(input);
      const title = input.title === undefined
        ? 'Nouvelle conversation'
        : text(input.title, 120, { trim: true });
      if (input.title !== undefined && !title) fail('INVALID_INPUT');
      const timestamp = now();
      const session = {
        id: randomUUID(),
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      };
      await mutate(context, state => {
        if (state.sessions.length >= limits.maxSessions) fail('SESSION_LIMIT');
        state.sessions.unshift(session);
        return session;
      });
      return Object.freeze(publicSession(session));
    },

    async listSessions(rawInput) {
      const input = validateRequest(rawInput);
      const context = await resolveContext(input);
      const { state } = await readState(context);
      return Object.freeze(state.sessions.map(session => Object.freeze({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      })));
    },

    async getSession(rawInput) {
      const input = validateRequest(rawInput, ['sessionId']);
      if (!input.sessionId) fail('INVALID_INPUT');
      const context = await resolveContext(input);
      const { state } = await readState(context);
      const session = state.sessions.find(item => item.id === input.sessionId);
      if (!session) fail('SESSION_NOT_FOUND');
      return Object.freeze(await sessionWithCurrentSources(session, input));
    },

    async deleteSession(rawInput) {
      const input = validateRequest(rawInput, ['sessionId']);
      if (!input.sessionId) fail('INVALID_INPUT');
      const context = await resolveContext(input);
      await mutate(context, state => {
        const index = state.sessions.findIndex(item => item.id === input.sessionId);
        if (index < 0) fail('SESSION_NOT_FOUND');
        state.sessions.splice(index, 1);
        return Object.freeze({ deleted: true });
      });
      return Object.freeze({ deleted: true });
    },

    async retrieve(rawInput) {
      const input = validateRequest(rawInput, ['query', 'topK']);
      const context = await resolveContext(input);
      return retrieve(input, context);
    },

    async *streamMessage(rawInput) {
      const input = validateRequest(rawInput, ['sessionId', 'question', 'promptVersion', 'signal']);
      if (!enabled) fail('DISABLED');
      if (!input.sessionId || input.question === undefined || input.promptVersion === undefined) {
        fail('INVALID_INPUT');
      }
      const question = text(input.question, limits.maxQuestionCodeUnits, { trim: true });
      if (typeof input.promptVersion !== 'string' || !promptVersions.has(input.promptVersion)) {
        fail('PROMPT_NOT_FOUND');
      }
      const context = await resolveContext(input);
      if (input.signal?.aborted) fail('INTERRUPTED');
      const initial = await readState(context);
      const session = initial.state.sessions.find(item => item.id === input.sessionId);
      if (!session) fail('SESSION_NOT_FOUND');
      const existing = session.messages.find(message =>
        message.role === 'user' && message.requestId === input.requestId);
      if (existing) {
        const savedSession = await sessionWithCurrentSources(session, input);
        const saved = savedSession.messages.find(message =>
          message.role === 'assistant' && message.requestId === input.requestId);
        if (!saved) fail('CORRUPT_SESSION');
        yield Object.freeze({ contractVersion: CONTRACT_VERSION, type: 'status', status: 'replaying' });
        yield Object.freeze({ contractVersion: CONTRACT_VERSION, type: 'message', message: saved });
        return;
      }
      if (session.messages.length >= limits.maxTurnsPerSession * 2) fail('TURN_LIMIT');
      yield Object.freeze({ contractVersion: CONTRACT_VERSION, type: 'status', status: 'generating' });

      let response;
      try {
        response = await config.assistant.answer({
          cookieHeader: input.cookieHeader,
          tenantId: context.tenantId,
          requestId: input.requestId,
          appId,
          promptVersion: input.promptVersion,
          question,
          signal: input.signal,
        });
      } catch (error) {
        const code = error?.code;
        if (code === 'INTERRUPTED' || code === 'ENGINE_TIMEOUT') fail(code);
        if (code === 'DISABLED') fail('DISABLED');
        if (code === 'PROMPT_NOT_FOUND') fail(code);
        if (code === 'INPUT_LIMIT' || code === 'OUTPUT_LIMIT') fail(code);
        fail(code === 'SOURCE_UNAVAILABLE' ? code : 'GENERATION_FAILED');
      }
      const result = exactObject(response, [
        'contractVersion', 'promptVersion', 'answer', 'citations', 'abstain',
      ], undefined, 'INVALID_RESPONSE');
      if (result.contractVersion !== CONTRACT_VERSION || result.promptVersion !== input.promptVersion ||
          typeof result.answer !== 'string' || !result.answer.isWellFormed() ||
          result.answer.length > limits.maxAnswerCodeUnits || typeof result.abstain !== 'boolean' ||
          !Array.isArray(result.citations) || result.citations.length > limits.maxSources) {
        fail('INVALID_RESPONSE');
      }
      const citations = result.citations.map(validateCitation);
      if (result.abstain ? citations.length !== 0 || result.answer.trim() :
        !citations.length || !result.answer.trim()) fail('INVALID_RESPONSE');
      if (input.signal?.aborted) fail('INTERRUPTED');
      if (citations.length && !await sourcesRemainAvailable(input, question, citations)) {
        fail('SOURCE_UNAVAILABLE');
      }
      const timestamp = now();
      const userMessage = {
        id: randomUUID(),
        requestId: input.requestId,
        role: 'user',
        content: question,
        createdAt: timestamp,
        promptVersion: null,
        citations: [],
        abstain: false,
      };
      const assistantMessage = {
        id: randomUUID(),
        requestId: input.requestId,
        role: 'assistant',
        content: result.answer,
        createdAt: timestamp,
        promptVersion: input.promptVersion,
        citations,
        abstain: result.abstain,
      };
      if (input.signal?.aborted) fail('INTERRUPTED');
      const committed = await mutate(context, state => {
        const current = state.sessions.find(item => item.id === input.sessionId);
        if (!current) fail('SESSION_NOT_FOUND');
        const duplicate = current.messages.find(message =>
          message.role === 'user' && message.requestId === input.requestId);
        if (duplicate) {
          const previous = current.messages.find(message =>
            message.role === 'assistant' && message.requestId === input.requestId);
          if (!previous) fail('CORRUPT_SESSION');
          return { skipWrite: true, value: previous };
        }
        if (current.messages.length >= limits.maxTurnsPerSession * 2) fail('TURN_LIMIT');
        if (current.title === 'Nouvelle conversation') current.title = question.slice(0, 120);
        current.messages.push(userMessage, assistantMessage);
        current.updatedAt = timestamp;
        return assistantMessage;
      });
      yield Object.freeze({
        contractVersion: CONTRACT_VERSION,
        type: 'message',
        message: Object.freeze({ ...committed, citations: Object.freeze([...committed.citations]) }),
      });
    },
  });
}

export function renderChatInterface(rawInput) {
  const input = exactObject(rawInput, ['enabled', 'session', 'actionUrl', 'label', 'status'],
    ['enabled', 'session', 'actionUrl', 'label']);
  if (typeof input.enabled !== 'boolean' || typeof input.label !== 'string' ||
      !input.label.trim() || input.label.length > 200) fail('INVALID_INPUT');
  const actionUrl = safeLocalUrl(input.actionUrl);
  const session = exactObject(input.session, ['id', 'messages']);
  if (typeof session.id !== 'string' || !UUID.test(session.id) ||
      !Array.isArray(session.messages) || session.messages.length > 200) fail('INVALID_INPUT');
  const messages = session.messages.map(raw => {
    const message = exactObject(raw, ['id', 'role', 'content', 'citations', 'redacted'],
      ['id', 'role', 'content', 'citations']);
    if (typeof message.id !== 'string' || message.id.length > 128 ||
        !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' ||
        !message.content.isWellFormed() || message.content.length > 10_000 ||
        !Array.isArray(message.citations) || message.citations.length > 20) fail('INVALID_INPUT');
    const citations = message.citations.map(rawCitation => {
      const citation = exactObject(rawCitation, [...CITATION_FIELDS, 'metadata'], ['sourceId', 'fileName']);
      if (typeof citation.sourceId !== 'string' || typeof citation.fileName !== 'string') {
        fail('INVALID_INPUT');
      }
      return `<li>${html(citation.sourceId)} — ${html(citation.fileName)}</li>`;
    }).join('');
    return `<li class="ai-chat-message ai-chat-message-${message.role}"><h2>${message.role === 'user' ? 'Vous' : 'Assistant'}</h2><p>${html(message.content)}</p>${citations ? `<ul aria-label="Sources citées">${citations}</ul>` : ''}</li>`;
  }).join('');
  const status = input.status === undefined ? '' : `<p role="status" aria-live="polite">${html(text(input.status, 300, { allowEmpty: true }))}</p>`;
  const disabled = input.enabled ? '' : ' disabled';
  return `<section aria-labelledby="ai-chat-title"><h1 id="ai-chat-title">Conversation</h1>${input.enabled ? '' : '<p role="status">La génération locale est désactivée. Vos conversations restent accessibles.</p>'}<ol aria-label="Messages de la conversation" aria-live="polite" aria-relevant="additions text">${messages}</ol>${status}<form action="${html(actionUrl)}" method="post"><input name="sessionId" type="hidden" value="${html(session.id)}"><label for="chat-question">${html(input.label)}</label><textarea id="chat-question" name="question" maxlength="4000" required${disabled}></textarea><button type="submit"${disabled}>Envoyer</button></form></section>`;
}

export const aiChatContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: '1.0.0',
  storageKey: STORAGE_KEY,
  storageSchema: Object.freeze({
    contractVersion: 1,
    sessions: 'tenant-scoped, versioned local storage with optimistic concurrency',
  }),
  limits: DEFAULTS,
  streamEvents: Object.freeze(['status', 'message']),
  errors: Object.freeze([
    'CORRUPT_SESSION', 'DISABLED', 'ENGINE_TIMEOUT', 'GENERATION_FAILED', 'INPUT_LIMIT', 'INVALID_CONFIGURATION',
    'INVALID_INPUT', 'INVALID_RESPONSE', 'PROMPT_NOT_FOUND', 'SESSION_LIMIT', 'SESSION_NOT_FOUND',
    'SOURCE_UNAVAILABLE', 'STORAGE_BUSY', 'STORAGE_LIMIT', 'STORAGE_UNAVAILABLE', 'TENANT_ACCESS_DENIED',
    'TURN_LIMIT', 'UNAVAILABLE',
  ]),
});
