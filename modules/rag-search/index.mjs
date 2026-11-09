import { createHash } from 'node:crypto';

const CONTRACT_VERSION = 1;
const INDEX_KEY = 'rag-search-v1/index';
const DEFAULTS = Object.freeze({
  batchSize: 32,
  cacheEntries: 2048,
  maxChunksPerDocument: 5000,
  maxDocuments: 1000,
  maxMetadataEntries: 32,
  maxQueryCodeUnits: 4000,
  maxStoredBytes: 32 * 1024 * 1024,
  maxWriteRetries: 3,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const METADATA_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const ROLES = /^[a-z][a-z0-9-]{0,31}$/u;

export class RagSearchError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RagSearchError';
    this.code = code;
  }
}

function fail(code) {
  throw new RagSearchError(code);
}

function exactObject(value, allowed, required = allowed, errorCode = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail(errorCode);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
    result[key] = descriptor.value;
  }
  return result;
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateLimits(value = {}) {
  const input = exactObject(value, Object.keys(DEFAULTS), [], 'INVALID_CONFIGURATION');
  const limits = { ...DEFAULTS, ...input };
  const maximums = {
    batchSize: 256,
    cacheEntries: 100_000,
    maxChunksPerDocument: 100_000,
    maxDocuments: 100_000,
    maxMetadataEntries: 256,
    maxQueryCodeUnits: 32_000,
    maxStoredBytes: 512 * 1024 * 1024,
    maxWriteRetries: 10,
  };
  for (const [key, maximum] of Object.entries(maximums)) {
    if (!safeInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

function validateContext(value) {
  const context = exactObject(value, ['contractVersion', 'tenantId', 'requestId'], undefined,
    'INVALID_TENANT_CONTEXT');
  if (context.contractVersion !== 1 || typeof context.tenantId !== 'string' ||
      !UUID.test(context.tenantId) || typeof context.requestId !== 'string' ||
      !SAFE_ID.test(context.requestId)) fail('INVALID_TENANT_CONTEXT');
  return Object.freeze({
    contractVersion: 1,
    tenantId: context.tenantId.toLowerCase(),
    requestId: context.requestId,
  });
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateEmbedder(value) {
  const embedder = exactObject(value,
    ['contractVersion', 'modelId', 'modelVersion', 'dimensions', 'fingerprint', 'license', 'runtime', 'embedBatch']);
  if (embedder.contractVersion !== CONTRACT_VERSION ||
      typeof embedder.modelId !== 'string' || !MODEL_ID.test(embedder.modelId) ||
      typeof embedder.modelVersion !== 'string' || embedder.modelVersion.length < 1 ||
      embedder.modelVersion.length > 64 || !embedder.modelVersion.isWellFormed() ||
      !safeInteger(embedder.dimensions, 1, 8192) ||
      typeof embedder.fingerprint !== 'string' || !HASH.test(embedder.fingerprint) ||
      typeof embedder.license !== 'string' || embedder.license.length < 1 ||
      embedder.license.length > 120 || !embedder.license.isWellFormed() ||
      !['local', 'test'].includes(embedder.runtime) ||
      typeof embedder.embedBatch !== 'function') fail('INVALID_CONFIGURATION');
  if (embedder.runtime === 'test' && !embedder.modelId.startsWith('test/')) {
    fail('INVALID_CONFIGURATION');
  }
  if (embedder.runtime === 'local' && embedder.modelId.startsWith('test/')) {
    fail('INVALID_CONFIGURATION');
  }
  return embedder;
}

function normalizeText(value, maximum, errorCode = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) fail(errorCode);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum) fail(errorCode);
  return normalized;
}

function validateMetadata(value, maxEntries, errorCode = 'INVALID_INPUT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const keys = Reflect.ownKeys(value);
  const entries = exactObject(value, keys.filter(key => typeof key === 'string'), undefined, errorCode);
  if (Object.keys(entries).length > maxEntries) fail(errorCode);
  const result = Object.create(null);
  for (const [key, item] of Object.entries(entries)) {
    if (!METADATA_KEY.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !(typeof item === 'string' && item.isWellFormed() && item.length <= 500 ||
          typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item))) fail(errorCode);
    result[key] = item;
  }
  return result;
}

function validateAcl(value, errorCode = 'INVALID_INPUT') {
  const acl = exactObject(value, ['readerIds', 'roles'], undefined, errorCode);
  if (!Array.isArray(acl.readerIds) || !Array.isArray(acl.roles) ||
      acl.readerIds.length + acl.roles.length < 1 ||
      acl.readerIds.length > 100 || acl.roles.length > 32) fail(errorCode);
  const readerIds = acl.readerIds.map(id => {
    if (typeof id !== 'string' || !UUID.test(id)) fail(errorCode);
    return id.toLowerCase();
  });
  const roles = acl.roles.map(role => {
    if (typeof role !== 'string' || !ROLES.test(role)) fail(errorCode);
    return role;
  });
  if (new Set(readerIds).size !== readerIds.length || new Set(roles).size !== roles.length) fail(errorCode);
  return { readerIds, roles };
}

function validateDocument(value, limits) {
  const document = exactObject(value,
    ['id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'chunks',
      'text', 'pageCount', 'createdAt', 'deduplicated'],
    ['id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'chunks']);
  if (typeof document.id !== 'string' || !UUID.test(document.id) ||
      typeof document.sourceId !== 'string' || !SAFE_ID.test(document.sourceId) ||
      typeof document.fileName !== 'string' || document.fileName.length < 1 ||
      document.fileName.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(document.fileName) ||
      !['txt', 'markdown', 'html', 'pdf', 'docx'].includes(document.format) ||
      !safeInteger(document.version, 1, 1_000_000) ||
      typeof document.sha256 !== 'string' || !HASH.test(document.sha256) ||
      !Array.isArray(document.chunks) || document.chunks.length < 1 ||
      document.chunks.length > limits.maxChunksPerDocument) fail('INVALID_DOCUMENT');
  if (Object.hasOwn(document, 'text') &&
      (typeof document.text !== 'string' || !document.text.isWellFormed() || document.text.length > 2 * 1024 * 1024) ||
      Object.hasOwn(document, 'pageCount') && !safeInteger(document.pageCount, 1, 1000) ||
      Object.hasOwn(document, 'createdAt') && !safeInteger(document.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
      Object.hasOwn(document, 'deduplicated') && typeof document.deduplicated !== 'boolean') {
    fail('INVALID_DOCUMENT');
  }
  const seen = new Set();
  const chunks = document.chunks.map(rawChunk => {
    const chunk = exactObject(rawChunk,
      ['index', 'sourceId', 'fileName', 'page', 'startOffset', 'endOffset', 'sha256', 'text'],
      ['index', 'sourceId', 'fileName', 'page', 'startOffset', 'endOffset', 'sha256', 'text'],
      'INVALID_DOCUMENT');
    if (!safeInteger(chunk.index, 0, limits.maxChunksPerDocument - 1) ||
        chunk.sourceId !== document.sourceId || chunk.fileName !== document.fileName ||
        !(chunk.page === null || safeInteger(chunk.page, 1, 1_000_000)) ||
        !safeInteger(chunk.startOffset, 0, Number.MAX_SAFE_INTEGER) ||
        !safeInteger(chunk.endOffset, chunk.startOffset + 1, Number.MAX_SAFE_INTEGER) ||
        typeof chunk.sha256 !== 'string' || chunk.sha256 !== document.sha256 ||
        typeof chunk.text !== 'string' || !chunk.text.isWellFormed() ||
        chunk.text.length < 1 || chunk.text.length > 100_000 || seen.has(chunk.index)) {
      fail('INVALID_DOCUMENT');
    }
    seen.add(chunk.index);
    return {
      index: chunk.index,
      page: chunk.page,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      sha256: chunk.sha256,
      text: normalizeText(chunk.text, 100_000, 'INVALID_DOCUMENT'),
    };
  }).sort((left, right) => left.index - right.index);
  return {
    id: document.id.toLowerCase(),
    sourceId: document.sourceId,
    fileName: document.fileName,
    format: document.format,
    version: document.version,
    sha256: document.sha256,
    chunks,
  };
}

function vectorArray(value, dimensions, errorCode = 'CORRUPT_INDEX') {
  if (!Array.isArray(value) || value.length !== dimensions ||
      value.some(item => typeof item !== 'number' || !Number.isFinite(item))) fail(errorCode);
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 0) fail(errorCode);
  return value.map(item => item / norm);
}

function validateIndex(value, embedder, limits) {
  const index = exactObject(value,
    ['contractVersion', 'embedding', 'documents'], undefined, 'CORRUPT_INDEX');
  const embedding = exactObject(index.embedding,
    ['modelId', 'modelVersion', 'fingerprint', 'dimensions'], undefined, 'CORRUPT_INDEX');
  if (index.contractVersion !== CONTRACT_VERSION || !Array.isArray(index.documents) ||
      !safeInteger(embedding.dimensions, 1, 8192) || typeof embedding.modelId !== 'string' ||
      !MODEL_ID.test(embedding.modelId) || typeof embedding.modelVersion !== 'string' ||
      embedding.modelVersion.length < 1 || embedding.modelVersion.length > 64 ||
      typeof embedding.fingerprint !== 'string' || !HASH.test(embedding.fingerprint)) {
    fail('CORRUPT_INDEX');
  }
  if (
      embedding.modelId !== embedder.modelId || embedding.modelVersion !== embedder.modelVersion ||
      embedding.fingerprint !== embedder.fingerprint || embedding.dimensions !== embedder.dimensions) {
    fail('EMBEDDING_MODEL_MISMATCH');
  }
  if (index.documents.length > limits.maxDocuments) fail('CORRUPT_INDEX');
  const ids = new Set();
  const documents = index.documents.map(rawDocument => {
    const document = exactObject(rawDocument,
      ['id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'metadata', 'acl', 'chunks'],
      undefined, 'CORRUPT_INDEX');
    if (typeof document.id !== 'string' || !UUID.test(document.id) ||
        typeof document.sourceId !== 'string' || !SAFE_ID.test(document.sourceId) ||
        typeof document.fileName !== 'string' || document.fileName.length < 1 ||
        document.fileName.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(document.fileName) ||
        !['txt', 'markdown', 'html', 'pdf', 'docx'].includes(document.format) ||
        !safeInteger(document.version, 1, 1_000_000) ||
        typeof document.sha256 !== 'string' || !HASH.test(document.sha256) ||
        !Array.isArray(document.chunks) || document.chunks.length < 1 ||
        document.chunks.length > limits.maxChunksPerDocument || ids.has(document.id)) fail('CORRUPT_INDEX');
    ids.add(document.id);
    const metadata = validateMetadata(document.metadata, 256, 'CORRUPT_INDEX');
    const acl = validateAcl(document.acl, 'CORRUPT_INDEX');
    const chunks = document.chunks.map(rawChunk => {
      const chunk = exactObject(rawChunk,
        ['index', 'page', 'startOffset', 'endOffset', 'sha256', 'text', 'vector'],
        undefined, 'CORRUPT_INDEX');
      if (!safeInteger(chunk.index, 0, 100_000) ||
          !(chunk.page === null || safeInteger(chunk.page, 1, 1_000_000)) ||
          !safeInteger(chunk.startOffset, 0, Number.MAX_SAFE_INTEGER) ||
          !safeInteger(chunk.endOffset, chunk.startOffset + 1, Number.MAX_SAFE_INTEGER) ||
          chunk.sha256 !== document.sha256 || typeof chunk.text !== 'string' ||
          !chunk.text.isWellFormed() || chunk.text.length < 1 || chunk.text.length > 100_000) {
        fail('CORRUPT_INDEX');
      }
      return {
        index: chunk.index,
        page: chunk.page,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        sha256: chunk.sha256,
        text: chunk.text,
        vector: vectorArray(chunk.vector, embedding.dimensions),
      };
    });
    return {
      id: document.id.toLowerCase(),
      sourceId: document.sourceId,
      fileName: document.fileName,
      format: document.format,
      version: document.version,
      sha256: document.sha256,
      metadata,
      acl,
      chunks,
    };
  });
  return {
    contractVersion: CONTRACT_VERSION,
    embedding: { ...embedding },
    documents,
  };
}

function tokenList(text) {
  return text.toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function cosine(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function metadataMatches(metadata, filters) {
  return Object.entries(filters).every(([key, value]) => Object.hasOwn(metadata, key) &&
    metadata[key] === value);
}

function sameEmbedding(left, right) {
  return left.modelId === right.modelId && left.modelVersion === right.modelVersion &&
    left.fingerprint === right.fingerprint && left.dimensions === right.dimensions;
}

export function createRagSearchService(options) {
  const configuration = exactObject(options,
    ['tenancy', 'store', 'embedder', 'authorizeDocument', 'limits'],
    ['tenancy', 'store', 'embedder', 'authorizeDocument']);
  const { tenancy, store, authorizeDocument } = configuration;
  const embedder = validateEmbedder(configuration.embedder);
  const limits = validateLimits(configuration.limits);
  if (!tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      !store || typeof store.get !== 'function' || typeof store.put !== 'function' ||
      typeof authorizeDocument !== 'function') fail('INVALID_CONFIGURATION');

  const cache = new Map();
  const embeddingInfo = Object.freeze({
    modelId: embedder.modelId,
    modelVersion: embedder.modelVersion,
    fingerprint: embedder.fingerprint,
    dimensions: embedder.dimensions,
  });

  async function resolveContext(input) {
    let rawContext;
    try {
      rawContext = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    const context = validateContext(rawContext);
    if (context.tenantId !== input.tenantId.toLowerCase()) fail('TENANT_ACCESS_DENIED');
    return context;
  }

  async function authorize(context, cookieHeader, document, operation) {
    try {
      return await authorizeDocument({
        tenantContext: context,
        cookieHeader,
        document: {
          id: document.id,
          sourceId: document.sourceId,
          version: document.version,
          metadata: document.metadata,
          acl: document.acl,
        },
        operation,
      }) === true;
    } catch {
      return false;
    }
  }

  async function getIndex(context) {
    let stored;
    try {
      stored = await store.get(context, INDEX_KEY);
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (stored === undefined || stored === null) return { index: null, version: undefined };
    try {
      const record = exactObject(stored, ['value', 'version'], undefined, 'CORRUPT_INDEX');
      if (!safeInteger(record.version, 1, Number.MAX_SAFE_INTEGER)) fail('CORRUPT_INDEX');
      return { index: validateIndex(record.value, embedder, limits), version: record.version };
    } catch (error) {
      if (error instanceof RagSearchError) throw error;
      fail('CORRUPT_INDEX');
    }
  }

  function cacheKey(tenantId, text) {
    return `${tenantId}:${digest(`${embedder.fingerprint}\0${text}`)}`;
  }

  function remember(key, vector) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, vector);
    while (cache.size > limits.cacheEntries) cache.delete(cache.keys().next().value);
  }

  async function embedTexts(tenantId, texts) {
    const vectors = new Array(texts.length);
    const missingTexts = [];
    const missingPositions = [];
    const missingKeys = [];
    texts.forEach((text, index) => {
      const key = cacheKey(tenantId, text);
      if (cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        vectors[index] = cached;
      } else {
        missingTexts.push(text);
        missingPositions.push(index);
        missingKeys.push(key);
      }
    });
    for (let offset = 0; offset < missingTexts.length; offset += limits.batchSize) {
      const batch = missingTexts.slice(offset, offset + limits.batchSize);
      let rawVectors;
      try {
        rawVectors = await embedder.embedBatch(batch);
      } catch {
        fail('EMBEDDING_UNAVAILABLE');
      }
      if (!Array.isArray(rawVectors) || rawVectors.length !== batch.length) fail('INVALID_EMBEDDING');
      rawVectors.forEach((rawVector, localIndex) => {
        const vector = vectorArray(rawVector, embedder.dimensions, 'INVALID_EMBEDDING');
        const position = missingPositions[offset + localIndex];
        const key = missingKeys[offset + localIndex];
        vectors[position] = vector;
        remember(key, vector);
      });
    }
    return vectors;
  }

  async function writeIndex(context, index, expectedVersion) {
    const serialized = JSON.stringify(index);
    if (Buffer.byteLength(serialized, 'utf8') > limits.maxStoredBytes) fail('STORAGE_LIMIT');
    try {
      return await store.put(context, INDEX_KEY, index, expectedVersion);
    } catch (error) {
      if (error?.code === 'CONFLICT') return null;
      fail('STORAGE_UNAVAILABLE');
    }
  }

  return Object.freeze({
    async indexDocument(rawInput) {
      const input = exactObject(rawInput,
        ['cookieHeader', 'tenantId', 'requestId', 'document', 'metadata', 'acl'],
        ['cookieHeader', 'tenantId', 'requestId', 'document', 'metadata', 'acl']);
      if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
          typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
          typeof input.requestId !== 'string' || !SAFE_ID.test(input.requestId)) fail('INVALID_INPUT');
      const context = await resolveContext(input);
      const document = validateDocument(input.document, limits);
      const metadata = validateMetadata(input.metadata, limits.maxMetadataEntries);
      const acl = validateAcl(input.acl);
      const candidate = { ...document, metadata, acl };
      if (!(await authorize(context, input.cookieHeader, candidate, 'index'))) fail('DOCUMENT_ACCESS_DENIED');

      let indexedChunks;
      for (let attempt = 0; attempt < limits.maxWriteRetries; attempt += 1) {
        const current = await getIndex(context);
        if (current.index && !sameEmbedding(current.index.embedding, embeddingInfo)) {
          fail('EMBEDDING_MODEL_MISMATCH');
        }
        const existing = current.index?.documents.find(entry => entry.id === document.id);
        if (existing && existing.version > document.version) fail('STALE_DOCUMENT_VERSION');
        if (existing && existing.version === document.version) {
          if (existing.sha256 !== document.sha256) fail('DOCUMENT_VERSION_CONFLICT');
          return Object.freeze({
            id: document.id,
            version: document.version,
            chunkCount: existing.chunks.length,
            indexed: false,
          });
        }
        if (!indexedChunks) {
          const vectors = await embedTexts(context.tenantId, document.chunks.map(chunk => chunk.text));
          indexedChunks = document.chunks.map((chunk, index) => ({
            index: chunk.index,
            page: chunk.page,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            sha256: chunk.sha256,
            text: chunk.text,
            vector: vectors[index],
          }));
        }
        const documents = current.index?.documents.filter(entry => entry.id !== document.id) ?? [];
        if (documents.length >= limits.maxDocuments) fail('DOCUMENT_LIMIT_EXCEEDED');
        documents.push({ ...candidate, chunks: indexedChunks });
        const nextIndex = {
          contractVersion: CONTRACT_VERSION,
          embedding: embeddingInfo,
          documents,
        };
        const version = await writeIndex(context, nextIndex, current.version);
        if (version !== null) {
          return Object.freeze({
            id: document.id,
            version: document.version,
            chunkCount: indexedChunks.length,
            indexed: true,
          });
        }
      }
      fail('STORAGE_BUSY');
    },

    async search(rawInput) {
      const input = exactObject(rawInput,
        ['cookieHeader', 'tenantId', 'requestId', 'query', 'filters', 'topK', 'mode', 'minScore'],
        ['cookieHeader', 'tenantId', 'requestId', 'query']);
      if (typeof input.cookieHeader !== 'string' || input.cookieHeader.length > 8192 ||
          typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
          typeof input.requestId !== 'string' || !SAFE_ID.test(input.requestId)) fail('INVALID_INPUT');
      const query = normalizeText(input.query, limits.maxQueryCodeUnits);
      const filters = validateMetadata(input.filters ?? {}, limits.maxMetadataEntries);
      const topK = input.topK ?? 5;
      const mode = input.mode ?? 'hybrid';
      const minScore = input.minScore ?? 0.12;
      if (!safeInteger(topK, 1, 100) || !['hybrid', 'lexical', 'vector'].includes(mode) ||
          typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
        fail('INVALID_INPUT');
      }
      const context = await resolveContext(input);
      const current = await getIndex(context);
      if (!current.index || current.index.documents.length === 0) {
        return Object.freeze({ contractVersion: CONTRACT_VERSION, results: [] });
      }

      const allowedDocuments = [];
      for (const document of current.index.documents) {
        if (await authorize(context, input.cookieHeader, document, 'search')) {
          allowedDocuments.push(document);
        }
      }
      const filteredDocuments = allowedDocuments.filter(document =>
        metadataMatches(document.metadata, filters));
      const candidates = filteredDocuments.flatMap(document =>
        document.chunks.map(chunk => ({ document, chunk, tokens: tokenList(chunk.text) })));
      if (candidates.length === 0) {
        return Object.freeze({ contractVersion: CONTRACT_VERSION, results: [] });
      }

      const queryTokens = tokenList(query);
      const documentFrequency = new Map();
      for (const candidate of candidates) {
        for (const token of new Set(candidate.tokens)) {
          documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
      }
      const lexicalScores = candidates.map(candidate => {
        let score = 0;
        for (const token of queryTokens) {
          const frequency = candidate.tokens.filter(item => item === token).length;
          if (!frequency) continue;
          const df = documentFrequency.get(token) ?? 0;
          const inverseFrequency = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
          score += inverseFrequency * frequency * 2.2 / (frequency + 1.2);
        }
        return score;
      });
      const maxLexicalScore = lexicalScores.reduce((maximum, score) => Math.max(maximum, score), 0);
      const queryVector = mode === 'lexical' ? null :
        (await embedTexts(context.tenantId, [query]))[0];
      const results = candidates.map((candidate, index) => {
        const lexical = maxLexicalScore ? lexicalScores[index] / maxLexicalScore : 0;
        const semantic = queryVector ? Math.max(0, cosine(queryVector, candidate.chunk.vector)) : 0;
        const score = mode === 'lexical' ? lexical :
          mode === 'vector' ? semantic : lexical * 0.5 + semantic * 0.5;
        return { ...candidate, score };
      }).filter(result => result.score >= minScore)
        .sort((left, right) => right.score - left.score ||
          (left.document.id < right.document.id ? -1 : left.document.id > right.document.id ? 1 : 0) ||
          left.chunk.index - right.chunk.index)
        .slice(0, topK)
        .map(({ document, chunk, score }) => Object.freeze({
          text: chunk.text,
          score,
          citation: Object.freeze({
            documentId: document.id,
            sourceId: document.sourceId,
            version: document.version,
            fileName: document.fileName,
            format: document.format,
            sha256: document.sha256,
            chunkIndex: chunk.index,
            page: chunk.page,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            metadata: Object.freeze({ ...document.metadata }),
          }),
        }));
      return Object.freeze({ contractVersion: CONTRACT_VERSION, results: Object.freeze(results) });
    },
  });
}

export function createDeterministicTestEmbedder({ dimensions = 128 } = {}) {
  if (!safeInteger(dimensions, 8, 8192)) fail('INVALID_CONFIGURATION');
  const modelId = 'test/hash-bag';
  const modelVersion = '1.0.0';
  const fingerprint = digest(`${modelId}:${modelVersion}:${dimensions}`);
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    modelId,
    modelVersion,
    dimensions,
    fingerprint,
    license: 'MIT (test implementation)',
    runtime: 'test',
    async embedBatch(texts) {
      if (!Array.isArray(texts) || texts.some(text =>
        typeof text !== 'string' || !text.isWellFormed())) fail('INVALID_INPUT');
      return texts.map(text => {
        const vector = Array(dimensions).fill(0);
        for (const token of tokenList(text)) {
          const hash = createHash('sha256').update(token, 'utf8').digest();
          const index = hash.readUInt32BE(0) % dimensions;
          vector[index] += (hash[4] & 1) ? 1 : -1;
        }
        if (vector.every(value => value === 0)) vector[0] = 1;
        return vector;
      });
    },
  });
}

export const ragSearchContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: '1.0.0',
  storageKey: INDEX_KEY,
  modes: Object.freeze(['hybrid', 'lexical', 'vector']),
  defaultHybridWeights: Object.freeze({ lexical: 0.5, vector: 0.5 }),
  errors: Object.freeze([
    'INVALID_INPUT', 'INVALID_CONFIGURATION', 'INVALID_TENANT_CONTEXT', 'TENANT_ACCESS_DENIED',
    'DOCUMENT_ACCESS_DENIED', 'INVALID_DOCUMENT', 'EMBEDDING_UNAVAILABLE', 'INVALID_EMBEDDING',
    'EMBEDDING_MODEL_MISMATCH', 'DOCUMENT_VERSION_CONFLICT', 'STALE_DOCUMENT_VERSION',
    'DOCUMENT_LIMIT_EXCEEDED', 'STORAGE_LIMIT', 'CORRUPT_INDEX', 'STORAGE_UNAVAILABLE',
    'STORAGE_BUSY',
  ]),
});
