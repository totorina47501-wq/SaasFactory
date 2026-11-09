import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const API_VERSION = 1;
const MAX_PAGE_SIZE = 100;
const RATE_WINDOW_MS = 60_000;
const MAX_WEBHOOK_SKEW_MS = 5 * 60_000;
const MAX_WEBHOOK_PAYLOAD_BYTES = 64 * 1024;
const SCOPE_PERMISSIONS = Object.freeze({
  'members:read': 'member.read',
  'webhooks:simulate': 'webhook.simulate',
  'webhooks:verify': 'webhook.verify',
});
const KEY_STORE_METHODS = [
  'createApiKey',
  'findApiKeyById',
  'listApiKeys',
  'revokeApiKey',
  'consumeRateLimit',
  'consumeWebhookReplay',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const KEY_PATTERN = /^sfk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,86}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const ERRORS = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_CONFIGURATION: 500,
  INVALID_SESSION: 401,
  INVALID_API_KEY: 401,
  API_KEY_REVOKED: 401,
  API_KEY_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  FEATURE_DISABLED: 403,
  LIMIT_EXCEEDED: 429,
  INVALID_WEBHOOK: 400,
  WEBHOOK_REPLAYED: 409,
  UNAVAILABLE: 503,
});

export class ApiModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ApiModuleError';
    this.code = code;
  }
}

function fail(code) {
  throw new ApiModuleError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareDigest(candidate, expected) {
  const left = Buffer.from(digest(candidate), 'hex');
  const right = Buffer.from(typeof expected === 'string' && /^[a-f0-9]{64}$/u.test(expected)
    ? expected
    : '0'.repeat(64), 'hex');
  return timingSafeEqual(left, right) &&
    typeof expected === 'string' && /^[a-f0-9]{64}$/u.test(expected);
}

function validateTenant(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_PATTERN.test(value)) fail('INVALID_INPUT');
  return value;
}

function validateNow(clock) {
  let now;
  try {
    now = clock();
  } catch {
    fail('UNAVAILABLE');
  }
  if (!Number.isSafeInteger(now) || now < 0) fail('UNAVAILABLE');
  return now;
}

function validateName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail('INVALID_INPUT');
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) fail('INVALID_INPUT');
  return name;
}

function validateScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 ||
      value.some(scope => typeof scope !== 'string' || !Object.hasOwn(SCOPE_PERMISSIONS, scope)) ||
      new Set(value).size !== value.length) fail('INVALID_INPUT');
  return Object.freeze([...value].sort());
}

function canonicalJson(value, depth = 0) {
  if (depth > 16) fail('INVALID_WEBHOOK');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && !value.isWellFormed()) fail('INVALID_WEBHOOK');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value === null || typeof value !== 'object') fail('INVALID_WEBHOOK');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_WEBHOOK');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) fail('INVALID_WEBHOOK');
  const entries = keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_WEBHOOK');
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
  });
  return `{${entries.join(',')}}`;
}

function eventPayload(value) {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_WEBHOOK_PAYLOAD_BYTES) fail('INVALID_WEBHOOK');
  return encoded;
}

function validStoredKey(record) {
  return record !== null && typeof record === 'object' &&
    typeof record.id === 'string' && UUID_PATTERN.test(record.id) &&
    typeof record.tenantId === 'string' && UUID_PATTERN.test(record.tenantId) &&
    typeof record.actorId === 'string' && UUID_PATTERN.test(record.actorId) &&
    typeof record.name === 'string' && Array.isArray(record.scopes) &&
    typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/u.test(record.tokenHash) &&
    Number.isSafeInteger(record.createdAt) &&
    (record.expiresAt === null || Number.isSafeInteger(record.expiresAt)) &&
    (record.revokedAt === null || Number.isSafeInteger(record.revokedAt));
}

function response(status, body, headers = {}) {
  return Object.freeze({
    status,
    headers: Object.freeze({ 'content-type': 'application/json; charset=utf-8', ...headers }),
    body,
  });
}

function normalizeHeaders(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const headers = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || descriptor.value.length > 8192) fail('INVALID_INPUT');
    const normalized = key.toLowerCase();
    if (Object.hasOwn(headers, normalized)) fail('INVALID_INPUT');
    headers[normalized] = descriptor.value;
  }
  return headers;
}

function errorResponse(error) {
  const code = error instanceof ApiModuleError ? error.code : 'UNAVAILABLE';
  return response(ERRORS[code] ?? 500, Object.freeze({ error: Object.freeze({ code }) }));
}

function memberPage(value, limit) {
  exactObject(value, ['items', 'nextCursor']);
  if (!Array.isArray(value.items) || value.items.length > limit ||
      !(value.nextCursor === null || (typeof value.nextCursor === 'string' &&
        CURSOR_PATTERN.test(value.nextCursor)))) fail('UNAVAILABLE');
  const items = value.items.map(member => {
    exactObject(member, ['id', 'email', 'role']);
    if (typeof member.id !== 'string' || !UUID_PATTERN.test(member.id) ||
        typeof member.email !== 'string' || member.email.length > 254 ||
        !['owner', 'admin', 'member'].includes(member.role)) fail('UNAVAILABLE');
    return Object.freeze({ id: member.id.toLowerCase(), email: member.email, role: member.role });
  });
  return Object.freeze({ items: Object.freeze(items), nextCursor: value.nextCursor });
}

function makeRoute(method, path, operationId, summary, parameters = []) {
  return Object.freeze({ method, path, operationId, summary, parameters: Object.freeze(parameters) });
}

const ROUTES = Object.freeze([
  makeRoute('get', '/v1/openapi.json', 'getOpenApi', 'OpenAPI document'),
  makeRoute('get', '/v1/tenants/{tenantId}/members', 'listMembers', 'List tenant members', ['tenantId']),
  makeRoute('get', '/v1/tenants/{tenantId}/api-keys', 'listApiKeys', 'List API keys', ['tenantId']),
  makeRoute('post', '/v1/tenants/{tenantId}/api-keys', 'createApiKey', 'Create an API key', ['tenantId']),
  makeRoute('delete', '/v1/tenants/{tenantId}/api-keys/{keyId}', 'revokeApiKey', 'Revoke an API key', ['tenantId', 'keyId']),
  makeRoute('post', '/v1/tenants/{tenantId}/webhooks/simulate', 'simulateWebhook', 'Simulate a signed local webhook', ['tenantId']),
  makeRoute('post', '/v1/webhooks/verify', 'verifyWebhook', 'Verify a local webhook signature'),
]);

export function createOpenApiDocument() {
  const paths = {};
  const operations = {
    getOpenApi: { response: 'OpenApiDocument' },
    listMembers: {
      security: [{ bearerAuth: [] }],
      query: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 } },
        { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 256 } },
      ],
      response: 'MemberPage',
    },
    listApiKeys: { security: [{ cookieAuth: [] }], response: 'ApiKeyList' },
    createApiKey: {
      security: [{ cookieAuth: [] }],
      request: 'ApiKeyCreateRequest',
      response: 'ApiKeyCreated',
      success: '201',
    },
    revokeApiKey: { security: [{ cookieAuth: [] }], response: 'Revocation' },
    simulateWebhook: {
      security: [{ bearerAuth: [] }],
      request: 'WebhookSimulationRequest',
      response: 'WebhookEnvelope',
    },
    verifyWebhook: {
      security: [{ bearerAuth: [] }],
      request: 'WebhookVerifyRequest',
      response: 'WebhookVerified',
    },
  };
  const schemas = {
    ErrorResponse: {
      type: 'object', additionalProperties: false, required: ['error'],
      properties: { error: { type: 'object', additionalProperties: false, required: ['code'],
        properties: { code: { type: 'string' } } } },
    },
    Member: {
      type: 'object', additionalProperties: false, required: ['id', 'email', 'role'],
      properties: {
        id: { type: 'string', format: 'uuid' }, email: { type: 'string', maxLength: 254 },
        role: { type: 'string', enum: ['owner', 'admin', 'member'] },
      },
    },
    MemberPage: {
      type: 'object', additionalProperties: false, required: ['items', 'nextCursor'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Member' }, maxItems: MAX_PAGE_SIZE },
        nextCursor: { type: ['string', 'null'], maxLength: 256 },
      },
    },
    ApiKeyCreateRequest: {
      type: 'object', additionalProperties: false, required: ['name', 'scopes', 'expiresAt'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        scopes: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
          items: { type: 'string', enum: Object.keys(SCOPE_PERMISSIONS) } },
        expiresAt: { type: ['integer', 'null'], minimum: 0 },
      },
    },
    ApiKeyMetadata: {
      type: 'object', additionalProperties: false,
      required: ['id', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt'],
      properties: {
        id: { type: 'string', format: 'uuid' }, name: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string', enum: Object.keys(SCOPE_PERMISSIONS) } },
        createdAt: { type: 'integer' }, expiresAt: { type: ['integer', 'null'] },
        revokedAt: { type: ['integer', 'null'] },
      },
    },
    ApiKeyCreated: {
      type: 'object', additionalProperties: false,
      required: ['id', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt', 'token'],
      properties: {
        id: { type: 'string', format: 'uuid' }, name: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string', enum: Object.keys(SCOPE_PERMISSIONS) } },
        createdAt: { type: 'integer' }, expiresAt: { type: ['integer', 'null'] },
        revokedAt: { type: ['integer', 'null'] }, token: { type: 'string' },
      },
    },
    ApiKeyList: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', items: { $ref: '#/components/schemas/ApiKeyMetadata' } } },
    },
    Revocation: {
      type: 'object', additionalProperties: false, required: ['revoked'],
      properties: { revoked: { const: true } },
    },
    WebhookSimulationRequest: {
      type: 'object', additionalProperties: false, required: ['event', 'payload'],
      properties: { event: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' },
        payload: { type: 'object' } },
    },
    WebhookVerifyRequest: {
      type: 'object', additionalProperties: false,
      required: ['tenantId', 'timestamp', 'nonce', 'event', 'payload', 'signature'],
      properties: {
        tenantId: { type: 'string', format: 'uuid' }, timestamp: { type: 'integer' },
        nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{22,86}$' },
        event: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9._-]{0,127}$' },
        payload: { type: 'object' },
        signature: { type: 'string', pattern: '^sha256=[a-f0-9]{64}$' },
      },
    },
    WebhookEnvelope: {
      type: 'object', additionalProperties: false,
      required: ['tenantId', 'event', 'timestamp', 'nonce', 'payload', 'signature'],
      properties: {
        tenantId: { type: 'string', format: 'uuid' }, event: { type: 'string' },
        timestamp: { type: 'integer' }, nonce: { type: 'string' }, payload: { type: 'object' },
        signature: { type: 'string' },
      },
    },
    WebhookVerified: {
      type: 'object', additionalProperties: false, required: ['verified', 'event'],
      properties: { verified: { const: true }, event: { type: 'string' } },
    },
    OpenApiDocument: { type: 'object' },
  };
  for (const route of ROUTES) {
    const parameters = route.parameters.map(name => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    const operation = operations[route.operationId];
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      ...((parameters.length || operation.query) ? { parameters: [...parameters, ...(operation.query ?? [])] } : {}),
      ...(operation.security ? { security: operation.security } : {}),
      ...(operation.request ? { requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${operation.request}` } } },
      } } : {}),
      responses: {
        [operation.success ?? '200']: {
          description: 'Successful response',
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${operation.response}` } } },
        },
        '400': { description: 'Invalid request', content: { 'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        } } },
        '401': { description: 'Authentication required or API key invalid' },
        '403': { description: 'Permission or entitlement denied' },
        '404': { description: 'Resource not found' },
        '409': { description: 'Webhook replay rejected' },
        '429': { description: 'Rate or quota limit exceeded' },
        '503': { description: 'Local dependency unavailable' },
      },
    };
  }
  return Object.freeze({
    openapi: '3.1.0',
    info: { title: 'SaaS Factory Local API', version: '1.0.0' },
    paths: Object.freeze(paths),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sf_session' },
      },
      schemas: Object.freeze(schemas),
    },
  });
}

export function createMemoryApiStore() {
  const keys = new Map();
  const limits = new Map();
  const replays = new Map();
  const locks = new Map();

  async function serialize(key, operation) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  return Object.freeze({
    async createApiKey(record) {
      if (keys.has(record.id)) fail('UNAVAILABLE');
      keys.set(record.id, structuredClone(record));
    },
    async findApiKeyById(id) {
      const value = keys.get(id);
      return value ? structuredClone(value) : null;
    },
    async listApiKeys(tenantId, actorId) {
      return [...keys.values()]
        .filter(key => key.tenantId === tenantId && key.actorId === actorId)
        .map(({ id, name, scopes, createdAt, expiresAt, revokedAt }) =>
          ({ id, name, scopes: [...scopes], createdAt, expiresAt, revokedAt }));
    },
    async revokeApiKey(tenantId, actorId, id, now) {
      const key = keys.get(id);
      if (!key || key.tenantId !== tenantId || key.actorId !== actorId) return false;
      if (key.revokedAt === null) keys.set(id, { ...key, revokedAt: now });
      return true;
    },
    async consumeRateLimit(bucket, limit, windowMs, now) {
      return serialize(`limit:${bucket}`, async () => {
        const current = limits.get(bucket);
        const next = !current || current.windowStartedAt + windowMs <= now
          ? { windowStartedAt: now, count: 0 }
          : current;
        if (next.count >= limit) {
          limits.set(bucket, next);
          return false;
        }
        limits.set(bucket, { ...next, count: next.count + 1 });
        return true;
      });
    },
    async consumeWebhookReplay(tenantId, nonce, expiresAt, now) {
      return serialize(`replay:${tenantId}`, async () => {
        for (const [key, expiry] of replays) if (expiry <= now) replays.delete(key);
        const key = `${tenantId}:${nonce}`;
        if (replays.has(key)) return false;
        replays.set(key, expiresAt);
        return true;
      });
    },
  });
}

export function createApiService(configuration) {
  exactObject(configuration,
    ['store', 'auth', 'entitlements', 'authorize', 'listMembers', 'webhookSecret', 'clock', 'rateLimit'],
    ['store', 'auth', 'entitlements', 'authorize', 'listMembers', 'webhookSecret']);
  const { store, auth, entitlements, authorize, listMembers } = configuration;
  if (!store || KEY_STORE_METHODS.some(method => typeof store[method] !== 'function') ||
      !auth || typeof auth.currentUser !== 'function' ||
      !entitlements || typeof entitlements.check !== 'function' ||
      typeof entitlements.reserve !== 'function' || typeof entitlements.consume !== 'function' ||
      typeof entitlements.refund !== 'function' || typeof authorize !== 'function' ||
      typeof listMembers !== 'function') fail('INVALID_CONFIGURATION');
  const webhookSecret = configuration.webhookSecret;
  if (!(typeof webhookSecret === 'string' || Buffer.isBuffer(webhookSecret)) ||
      Buffer.byteLength(webhookSecret) < 32) fail('INVALID_CONFIGURATION');
  const secret = Buffer.from(webhookSecret);
  const clock = configuration.clock ?? Date.now;
  const rateLimit = configuration.rateLimit ?? 120;
  if (typeof clock !== 'function' || !Number.isSafeInteger(rateLimit) ||
      rateLimit < 1 || rateLimit > 10_000) fail('INVALID_CONFIGURATION');

  async function requirePermission(actorId, tenantId, permission, scopes) {
    let allowed;
    try {
      allowed = await authorize(Object.freeze({ actorId, tenantId, permission, scopes }));
    } catch {
      fail('UNAVAILABLE');
    }
    if (allowed !== true) fail('FORBIDDEN');
  }

  async function sessionActor(headers) {
    const cookieHeader = headers.cookie;
    if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) fail('INVALID_SESSION');
    let user;
    try {
      user = await auth.currentUser({ cookieHeader });
    } catch {
      fail('UNAVAILABLE');
    }
    if (!user || typeof user.id !== 'string' || !UUID_PATTERN.test(user.id)) fail('INVALID_SESSION');
    return user.id.toLowerCase();
  }

  async function createKey(tenantId, actorId, input) {
    exactObject(input, ['name', 'scopes', 'expiresAt']);
    const name = validateName(input.name);
    const scopes = validateScopes(input.scopes);
    const now = validateNow(clock);
    const expiresAt = input.expiresAt;
    if (!(expiresAt === null || (Number.isSafeInteger(expiresAt) &&
        expiresAt > now && expiresAt <= now + 366 * 24 * 60 * 60 * 1000))) fail('INVALID_INPUT');
    for (const scope of scopes) {
      await requirePermission(actorId, tenantId, SCOPE_PERMISSIONS[scope]);
    }
    const id = randomUUID();
    const token = `sfk_${id}.${randomBytes(32).toString('base64url')}`;
    await store.createApiKey({
      id, tenantId, actorId, name, scopes, tokenHash: digest(token),
      createdAt: now, expiresAt, revokedAt: null,
    });
    return Object.freeze({
      id, name, scopes, createdAt: now, expiresAt, revokedAt: null, token,
    });
  }

  async function authenticate(headers, tenantId, scope) {
    const authorization = headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 256 ||
        !authorization.startsWith('Bearer ')) fail('INVALID_API_KEY');
    const match = KEY_PATTERN.exec(authorization.slice(7));
    if (!match) fail('INVALID_API_KEY');
    let stored;
    try {
      stored = await store.findApiKeyById(match[1].toLowerCase());
    } catch {
      fail('UNAVAILABLE');
    }
    if (!validStoredKey(stored) || !compareDigest(authorization.slice(7), stored.tokenHash)) {
      fail('INVALID_API_KEY');
    }
    const now = validateNow(clock);
    if (stored.revokedAt !== null) fail('API_KEY_REVOKED');
    if (stored.expiresAt !== null && stored.expiresAt <= now) fail('API_KEY_EXPIRED');
    if (stored.tenantId.toLowerCase() !== tenantId) fail('NOT_FOUND');
    if (!stored.scopes.includes(scope)) fail('FORBIDDEN');
    await requirePermission(stored.actorId.toLowerCase(), tenantId, SCOPE_PERMISSIONS[scope], stored.scopes);
    await enforceRequestAccess(tenantId, stored.actorId, randomUUID(), `api:${stored.id}`, now);
    return stored;
  }

  async function enforceRequestAccess(tenantId, actorId, requestId, bucket, now = validateNow(clock)) {
    let access;
    try {
      access = await entitlements.check({ contractVersion: 1, tenantId, requestId }, 'api.access');
    } catch {
      fail('UNAVAILABLE');
    }
    if (!access || access.allowed !== true) fail('FEATURE_DISABLED');
    let allowed;
    try {
      allowed = await store.consumeRateLimit(digest(bucket), rateLimit, RATE_WINDOW_MS, now);
    } catch {
      fail('UNAVAILABLE');
    }
    if (allowed !== true) fail('RATE_LIMITED');
  }

  function webhookSignature(tenantId, timestamp, nonce, payload) {
    return createHmac('sha256', secret)
      .update(`${tenantId}.${timestamp}.${nonce}.${payload}`, 'utf8')
      .digest('hex');
  }

  async function chargeRequest(tenantId, requestId, operation) {
    const context = Object.freeze({ contractVersion: 1, tenantId, requestId });
    let reservation;
    try {
      reservation = await entitlements.reserve(context, 'api.requests', 1, requestId);
      const result = await operation();
      await entitlements.consume(context, reservation.id);
      return result;
    } catch (error) {
      if (reservation?.id) {
        try {
          await entitlements.refund(context, reservation.id);
        } catch {
          fail('UNAVAILABLE');
        }
      }
      if (error instanceof ApiModuleError) throw error;
      if (error?.code === 'LIMIT_EXCEEDED' || error?.code === 'FEATURE_DISABLED') {
        fail(error.code);
      }
      fail('UNAVAILABLE');
    }
  }

  async function dispatch(input) {
    try {
      exactObject(input, ['method', 'path', 'headers', 'query', 'body', 'requestId'],
        ['method', 'path', 'headers']);
      if (typeof input.method !== 'string' || typeof input.path !== 'string' ||
          input.path.length > 2048 || input.path.includes('?')) {
        fail('INVALID_INPUT');
      }
      const method = input.method.toUpperCase();
      const headers = normalizeHeaders(input.headers);
      const requestId = input.requestId === undefined ? randomUUID() : validateRequestId(input.requestId);
      if (method === 'GET' && input.path === '/v1/openapi.json') {
        return response(200, createOpenApiDocument());
      }
      const membersPath = /^\/v1\/tenants\/([^/]+)\/members$/u.exec(input.path);
      const keysPath = /^\/v1\/tenants\/([^/]+)\/api-keys$/u.exec(input.path);
      const keyPath = /^\/v1\/tenants\/([^/]+)\/api-keys\/([^/]+)$/u.exec(input.path);
      const simulatePath = /^\/v1\/tenants\/([^/]+)\/webhooks\/simulate$/u.exec(input.path);
      if (method === 'GET' && membersPath) {
        const tenantId = validateTenant(decodeURIComponent(membersPath[1]));
        const key = await authenticate(headers, tenantId, 'members:read');
        const query = input.query ?? {};
        exactObject(query, ['limit', 'cursor'], []);
        const limit = query.limit === undefined ? 50 : query.limit;
        const cursor = query.cursor === undefined ? null : query.cursor;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE ||
            !(cursor === null || (typeof cursor === 'string' && CURSOR_PATTERN.test(cursor)))) {
          fail('INVALID_INPUT');
        }
        const page = await chargeRequest(tenantId, requestId, async () => {
          let result;
          try {
            result = await listMembers(Object.freeze({
              tenantId, actorId: key.actorId, limit, cursor, requestId,
            }));
          } catch {
            fail('UNAVAILABLE');
          }
          return memberPage(result, limit);
        });
        return response(200, page);
      }
      if (keysPath && ['GET', 'POST'].includes(method)) {
        const tenantId = validateTenant(decodeURIComponent(keysPath[1]));
        const actorId = await sessionActor(headers);
        await requirePermission(actorId, tenantId, 'api.keys.manage');
        await enforceRequestAccess(
          tenantId, actorId, requestId, `api-session:${tenantId}:${actorId}`,
        );
        if (method === 'GET') {
          const result = await chargeRequest(tenantId, requestId, async () => {
            let keys;
            try {
              keys = await store.listApiKeys(tenantId, actorId);
            } catch {
              fail('UNAVAILABLE');
            }
            if (!Array.isArray(keys)) fail('UNAVAILABLE');
            return Object.freeze({ items: Object.freeze(keys.map(key => {
              exactObject(key, ['id', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt']);
              if (!UUID_PATTERN.test(key.id) || typeof key.name !== 'string' ||
                  !Array.isArray(key.scopes) || key.scopes.some(scope => !Object.hasOwn(SCOPE_PERMISSIONS, scope)) ||
                  !Number.isSafeInteger(key.createdAt) ||
                  !(key.expiresAt === null || Number.isSafeInteger(key.expiresAt)) ||
                  !(key.revokedAt === null || Number.isSafeInteger(key.revokedAt))) fail('UNAVAILABLE');
              return Object.freeze({ ...key, scopes: Object.freeze([...key.scopes]) });
            })) });
          });
          return response(200, result);
        }
        const created = await chargeRequest(
          tenantId, requestId, () => createKey(tenantId, actorId, input.body),
        );
        return response(201, created);
      }
      if (method === 'DELETE' && keyPath) {
        const tenantId = validateTenant(decodeURIComponent(keyPath[1]));
        const keyId = decodeURIComponent(keyPath[2]);
        if (!UUID_PATTERN.test(keyId)) fail('INVALID_INPUT');
        const actorId = await sessionActor(headers);
        await requirePermission(actorId, tenantId, 'api.keys.manage');
        await enforceRequestAccess(
          tenantId, actorId, requestId, `api-session:${tenantId}:${actorId}`,
        );
        const result = await chargeRequest(tenantId, requestId, async () => {
          let revoked;
          try {
            revoked = await store.revokeApiKey(tenantId, actorId, keyId.toLowerCase(), validateNow(clock));
          } catch {
            fail('UNAVAILABLE');
          }
          if (!revoked) fail('NOT_FOUND');
          return Object.freeze({ revoked: true });
        });
        return response(200, result);
      }
      if (method === 'POST' && simulatePath) {
        const tenantId = validateTenant(decodeURIComponent(simulatePath[1]));
        const key = await authenticate(headers, tenantId, 'webhooks:simulate');
        exactObject(input.body, ['event', 'payload']);
        if (typeof input.body.event !== 'string' || !EVENT_PATTERN.test(input.body.event)) fail('INVALID_INPUT');
        await requirePermission(key.actorId, tenantId, 'webhook.simulate', key.scopes);
        const payload = eventPayload(input.body.payload);
        const timestamp = validateNow(clock);
        const nonce = randomBytes(16).toString('base64url');
        const signature = webhookSignature(tenantId, timestamp, nonce, payload);
        const result = Object.freeze({
          tenantId, event: input.body.event, timestamp, nonce,
          payload: JSON.parse(payload), signature: `sha256=${signature}`,
        });
        return response(200, await chargeRequest(tenantId, requestId, async () => result));
      }
      if (method === 'POST' && input.path === '/v1/webhooks/verify') {
        exactObject(input.body, ['tenantId', 'timestamp', 'nonce', 'event', 'payload', 'signature']);
        const tenantId = validateTenant(input.body.tenantId);
        const key = await authenticate(headers, tenantId, 'webhooks:verify');
        await requirePermission(key.actorId, tenantId, 'webhook.verify', key.scopes);
        const { timestamp, nonce, event, signature } = input.body;
        if (!Number.isSafeInteger(timestamp) || typeof nonce !== 'string' ||
            !NONCE_PATTERN.test(nonce) || typeof event !== 'string' || !EVENT_PATTERN.test(event) ||
            typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/u.test(signature)) {
          fail('INVALID_WEBHOOK');
        }
        const now = validateNow(clock);
        if (Math.abs(now - timestamp) > MAX_WEBHOOK_SKEW_MS) fail('INVALID_WEBHOOK');
        const payload = eventPayload(input.body.payload);
        const expected = webhookSignature(tenantId, timestamp, nonce, payload);
        const supplied = Buffer.from(signature.slice(7), 'hex');
        const actual = Buffer.from(expected, 'hex');
        if (!timingSafeEqual(supplied, actual)) fail('INVALID_WEBHOOK');
        const verified = await chargeRequest(tenantId, requestId, async () => {
          const accepted = await store.consumeWebhookReplay(
            tenantId, nonce, timestamp + MAX_WEBHOOK_SKEW_MS, now,
          );
          if (accepted !== true) fail('WEBHOOK_REPLAYED');
          return Object.freeze({ verified: true, event });
        });
        return response(200, verified);
      }
      return response(404, Object.freeze({ error: Object.freeze({ code: 'NOT_FOUND' }) }));
    } catch (error) {
      return errorResponse(error);
    }
  }

  return Object.freeze({
    dispatch,
  });
}

export const apiContract = Object.freeze({
  version: API_VERSION,
  maxPageSize: MAX_PAGE_SIZE,
  rateWindowMs: RATE_WINDOW_MS,
  maxWebhookSkewMs: MAX_WEBHOOK_SKEW_MS,
  routes: ROUTES,
  scopes: Object.freeze(Object.keys(SCOPE_PERMISSIONS)),
});

export { createPostgresApiStore, runApiMigrations } from './postgres-store.mjs';
