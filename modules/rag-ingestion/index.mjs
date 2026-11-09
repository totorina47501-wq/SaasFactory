import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';

const CONTRACT_VERSION = 1;
const INDEX_KEY = 'rag-ingestion-v1/index';
const DEFAULTS = Object.freeze({
  maxInputBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxPages: 100,
  maxZipEntries: 128,
  maxTextCodeUnits: 2 * 1024 * 1024,
  chunkSize: 1000,
  chunkOverlap: 150,
  maxChunks: 5000,
  maxDocuments: 1000,
  maxStoredBytes: 32 * 1024 * 1024,
  maxWriteRetries: 3,
});
const FORMATS = Object.freeze(['txt', 'markdown', 'html', 'pdf', 'docx']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export class RagIngestionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RagIngestionError';
    this.code = code;
  }
}

function fail(code) {
  throw new RagIngestionError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
    result[key] = descriptor.value;
  }
  return result;
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateLimits(value = {}) {
  const limitsInput = exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...limitsInput };
  const bounds = {
    maxInputBytes: 100 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxExpansionRatio: 1000,
    maxPages: 1000,
    maxZipEntries: 2048,
    maxTextCodeUnits: 16 * 1024 * 1024,
    chunkSize: 10000,
    chunkOverlap: 9999,
    maxChunks: 100000,
    maxDocuments: 100000,
    maxStoredBytes: 512 * 1024 * 1024,
    maxWriteRetries: 10,
  };
  for (const [key, maximum] of Object.entries(bounds)) {
    if (!safeInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  if (limits.maxExpandedBytes < limits.maxInputBytes ||
      limits.maxExpansionRatio < 1 ||
      limits.chunkOverlap >= limits.chunkSize ||
      limits.maxTextCodeUnits > limits.maxExpandedBytes) fail('INVALID_CONFIGURATION');
  return Object.freeze(limits);
}

function validateTenantContext(context) {
  let value;
  try {
    value = exactObject(context, ['contractVersion', 'tenantId', 'requestId']);
  } catch {
    fail('INVALID_TENANT_CONTEXT');
  }
  if (value.contractVersion !== 1 || typeof value.tenantId !== 'string' ||
      !UUID.test(value.tenantId) || typeof value.requestId !== 'string' ||
      !REQUEST_ID.test(value.requestId)) fail('INVALID_TENANT_CONTEXT');
  return Object.freeze({
    contractVersion: 1,
    tenantId: value.tenantId.toLowerCase(),
    requestId: value.requestId,
  });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_ENCODING');
  }
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|amp|lt|gt|quot|apos|nbsp);/giu, (match, entity) => {
    const name = entity.toLowerCase();
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name === 'nbsp') return '\u00a0';
    const codePoint = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) :
      Number.parseInt(name.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(codePoint);
  });
}

function normalizeText(value, limits, allowEmpty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) fail('INVALID_DOCUMENT');
  const text = value.normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .split('\n').map(line => line.replace(/[ \t]+$/gu, '')).join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!text && !allowEmpty) fail('EMPTY_DOCUMENT');
  if (text.length > limits.maxTextCodeUnits) fail('TEXT_TOO_LARGE');
  return text;
}

function extractHtml(bytes, limits) {
  let html = decodeUtf8(bytes);
  html = html.replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|iframe|object|embed|template|svg|math|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:script|style|iframe|object|embed|template|svg|math|noscript)\b[^>]*\/?>/giu, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ');
  return normalizeText(decodeEntities(html), limits);
}

function readPdfString(token) {
  if (token.startsWith('(')) {
    const source = token.slice(1, -1);
    const bytes = [];
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code !== 0x5c) {
        bytes.push(code & 0xff);
        continue;
      }
      index += 1;
      if (index >= source.length) fail('INVALID_DOCUMENT');
      const escaped = source[index];
      const special = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (Object.hasOwn(special, escaped)) {
        bytes.push(special[escaped]);
      } else if (/[0-7]/u.test(escaped)) {
        const octal = source.slice(index, index + 3).match(/^[0-7]{1,3}/u)?.[0];
        if (!octal) fail('INVALID_DOCUMENT');
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        index += octal.length - 1;
      } else if (escaped === '\n') {
        continue;
      } else if (escaped === '\r') {
        if (source[index + 1] === '\n') index += 1;
      } else {
        bytes.push(escaped.charCodeAt(0) & 0xff);
      }
    }
    return decodePdfBytes(Buffer.from(bytes));
  }
  const hex = token.slice(1, -1).replace(/\s/gu, '');
  if (hex.length % 2 !== 0 || !/^[a-f0-9]*$/iu.test(hex)) fail('INVALID_DOCUMENT');
  return decodePdfBytes(Buffer.from(hex, 'hex'));
}

function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const even = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2));
    return new TextDecoder('utf-16be', { fatal: false }).decode(even);
  }
  return bytes.toString('latin1');
}

function pdfTextOperators(value) {
  const chunks = [];
  const blocks = value.match(/BT\b[\s\S]*?\bET\b/gu) ?? [];
  for (const block of blocks) {
    const operators = /(\((?:\\[\s\S]|[^\\)])*\)|<[\da-f\s]*>|\[(?:[\s\S]*?)\])\s*T[Jj]/giu;
    for (const match of block.matchAll(operators)) {
      const operand = match[1];
      if (operand.startsWith('[')) {
        const strings = operand.matchAll(/\((?:\\[\s\S]|[^\\)])*\)|<[\da-f\s]*>/giu);
        for (const item of strings) chunks.push(readPdfString(item[0]));
      } else {
        chunks.push(readPdfString(operand));
      }
      chunks.push(' ');
    }
  }
  return chunks.join('');
}

function extractPdf(bytes, limits) {
  const source = bytes.toString('latin1');
  if (!source.startsWith('%PDF-')) fail('INVALID_DOCUMENT');
  const objects = new Map();
  let totalExpandedBytes = 0;
  const objectStart = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/gu;
  let cursor = 0;
  while (cursor < source.length) {
    objectStart.lastIndex = cursor;
    const match = objectStart.exec(source);
    if (!match) break;
    const bodyStart = objectStart.lastIndex;
    const endObject = source.indexOf('endobj', bodyStart);
    if (endObject < 0) fail('INVALID_DOCUMENT');
    const objectBody = source.slice(bodyStart, endObject);
    const stream = /\bstream(?:\r\n|\n|\r)/u.exec(objectBody);
    let body;
    let streamBytes;
    if (stream) {
      const dictionary = objectBody.slice(0, stream.index);
      const length = /\/Length\s+(\d+)\b/u.exec(dictionary);
      if (!length) fail('INVALID_DOCUMENT');
      const streamStart = bodyStart + stream.index + stream[0].length;
      const streamLength = Number(length[1]);
      const streamEnd = streamStart + streamLength;
      if (!safeInteger(streamLength, 0, limits.maxExpandedBytes) ||
          streamEnd > source.length ||
          !/^\s*endstream\b/u.test(source.slice(streamEnd, streamEnd + 32))) {
        fail('INVALID_DOCUMENT');
      }
      let payload = bytes.subarray(streamStart, streamEnd);
      if (/\/Filter\s*\/(?:FlateDecode|Fl)\b/u.test(dictionary)) {
        const remaining = limits.maxExpandedBytes - totalExpandedBytes;
        if (remaining < 1) fail('EXPANSION_LIMIT_EXCEEDED');
        try {
          payload = inflateSync(payload, { maxOutputLength: remaining });
        } catch (error) {
          if (error?.code === 'ERR_BUFFER_TOO_LARGE') fail('EXPANSION_LIMIT_EXCEEDED');
          fail('INVALID_DOCUMENT');
        }
      } else if (/\/Filter\b/u.test(dictionary)) {
        fail('UNSUPPORTED_DOCUMENT_FEATURE');
      }
      totalExpandedBytes += payload.length;
      if (totalExpandedBytes > limits.maxExpandedBytes ||
          totalExpandedBytes > bytes.length * limits.maxExpansionRatio) {
        fail('EXPANSION_LIMIT_EXCEEDED');
      }
      body = dictionary;
      streamBytes = payload;
      const actualEnd = source.indexOf('endobj', streamEnd);
      if (actualEnd < 0) fail('INVALID_DOCUMENT');
      cursor = actualEnd + 6;
    } else {
      body = source.slice(bodyStart, endObject);
      cursor = endObject + 6;
    }
    const objectId = Number(match[1]);
    if (!safeInteger(objectId, 1, Number.MAX_SAFE_INTEGER) || objects.has(objectId)) fail('INVALID_DOCUMENT');
    objects.set(objectId, { body, streamBytes });
  }

  const pages = [];
  for (const [id, object] of objects) {
    if (/\/Type\s*\/Page\b/u.test(object.body)) pages.push({ id, body: object.body });
  }
  if (pages.length === 0) fail('INVALID_DOCUMENT');
  if (pages.length > limits.maxPages) fail('PAGE_LIMIT_EXCEEDED');
  const pageTexts = pages.map((page, index) => {
    const contents = /\/Contents\s*(?:\[\s*([\s\S]*?)\]|(\d+\s+\d+\s+R))/u.exec(page.body);
    if (!contents) return { page: index + 1, text: '' };
    const references = (contents[1] ?? contents[2]).matchAll(/(\d+)\s+\d+\s+R/gu);
    const streams = [];
    for (const reference of references) {
      const content = objects.get(Number(reference[1]));
      if (!content?.streamBytes) fail('INVALID_DOCUMENT');
      streams.push(pdfTextOperators(content.streamBytes.toString('latin1')));
    }
    return { page: index + 1, text: streams.join('\n') };
  });
  return pageTexts;
}

function readZipEntries(bytes, limits) {
  let eocd = -1;
  const searchStart = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) fail('INVALID_DOCUMENT');
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount ||
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      entryCount > limits.maxZipEntries || eocd + 22 + commentLength !== bytes.length ||
      centralOffset + centralSize > eocd) fail('INVALID_DOCUMENT');

  const entries = [];
  const names = new Set();
  let position = centralOffset;
  let expandedTotal = 0;
  let compressedTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > bytes.length || bytes.readUInt32LE(position) !== 0x02014b50) {
      fail('INVALID_DOCUMENT');
    }
    const creator = bytes.readUInt16LE(position + 4) >>> 8;
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const uncompressedSize = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const entryCommentLength = bytes.readUInt16LE(position + 32);
    const externalAttributes = bytes.readUInt32LE(position + 38);
    const localOffset = bytes.readUInt32LE(position + 42);
    const end = position + 46 + nameLength + extraLength + entryCommentLength;
    if (end > bytes.length || (flags & 1) !== 0 || ![0, 8].includes(method) ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff) fail('INVALID_DOCUMENT');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = decodeUtf8(nameBytes);
    const pathParts = name.split('/');
    const checkedParts = name.endsWith('/') ? pathParts.slice(0, -1) : pathParts;
    if (!name || name.startsWith('/') || name.includes('\\') ||
        /^[a-z]:/iu.test(name) || /%(?:2e|2f|5c)/iu.test(name) ||
        /[\u0000-\u001f\u007f\u2044\u2215\uff0f\uff3c]/u.test(name) ||
        checkedParts.some(part => !part || part === '..' || part === '.') ||
        names.has(name.toLowerCase())) fail('INVALID_DOCUMENT');
    names.add(name.toLowerCase());
    const unixMode = creator === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0xf000) === 0xa000) fail('INVALID_DOCUMENT');
    if (/vbaProject|\.bin$/iu.test(name)) fail('UNSUPPORTED_DOCUMENT_FEATURE');
    expandedTotal += uncompressedSize;
    compressedTotal += compressedSize;
    if (expandedTotal > limits.maxExpandedBytes) fail('EXPANSION_LIMIT_EXCEEDED');
    entries.push({
      name, flags, method, checksum, compressedSize, uncompressedSize, localOffset,
      directory: name.endsWith('/'),
    });
    position = end;
  }
  if (position !== centralOffset + centralSize ||
      expandedTotal > Math.max(1, compressedTotal) * limits.maxExpansionRatio) {
    fail('EXPANSION_LIMIT_EXCEEDED');
  }

  const result = new Map();
  for (const entry of entries) {
    if (entry.directory) continue;
    const offset = entry.localOffset;
    if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) fail('INVALID_DOCUMENT');
    const localFlags = bytes.readUInt16LE(offset + 6);
    const localMethod = bytes.readUInt16LE(offset + 8);
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const localName = decodeUtf8(bytes.subarray(offset + 30, offset + 30 + localNameLength));
    const dataEnd = dataStart + entry.compressedSize;
    if (localName !== entry.name || localMethod !== entry.method ||
        localFlags !== entry.flags || dataEnd > bytes.length) fail('INVALID_DOCUMENT');
    const compressed = bytes.subarray(dataStart, dataEnd);
    let data;
    try {
      data = entry.method === 0 ? Buffer.from(compressed) :
        inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch {
      fail('INVALID_DOCUMENT');
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.checksum) fail('INVALID_DOCUMENT');
    result.set(entry.name, data);
  }
  return result;
}

function extractXmlText(xml) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail('INVALID_DOCUMENT');
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:\s[^<>]*?)?\/?>|[^<]+|</gu) ?? [];
  if (tokens.join('') !== xml) fail('INVALID_DOCUMENT');
  const stack = [];
  const text = [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (stack.at(-1) === 'w:t') text.push(token.slice(9, -3));
      continue;
    }
    if (token.startsWith('</')) {
      const closeName = /^<\/([A-Za-z_][\w.:-]*)\s*>$/u.exec(token)?.[1];
      if (!closeName || stack.pop() !== closeName) fail('INVALID_DOCUMENT');
    } else if (token.startsWith('<')) {
      const tagName = /^<([A-Za-z_][\w.:-]*)/u.exec(token)?.[1];
      if (!tagName) fail('INVALID_DOCUMENT');
      if (tagName === 'w:tab') text.push('\t');
      if (tagName === 'w:lastRenderedPageBreak' ||
          (tagName === 'w:br' && /\bw:type\s*=\s*["']page["']/u.test(token))) text.push('\f');
      else if (tagName === 'w:br') text.push('\n');
      if (!/\/\s*>$/u.test(token)) stack.push(tagName);
    } else if (stack.at(-1) === 'w:t') {
      text.push(decodeEntities(token));
    }
    if (token === '</w:p>') text.push('\n');
  }
  if (stack.length !== 0) fail('INVALID_DOCUMENT');
  return text.join('').replace(/\n{2,}/gu, '\n').trim();
}

function extractDocx(bytes, limits) {
  const entries = readZipEntries(bytes, limits);
  const types = entries.get('[Content_Types].xml');
  const document = entries.get('word/document.xml');
  if (!types || !document) fail('INVALID_DOCUMENT');
  const contentTypes = decodeUtf8(types);
  if (/macroEnabled|vbaProject/iu.test(contentTypes)) fail('UNSUPPORTED_DOCUMENT_FEATURE');
  const xml = decodeUtf8(document);
  const text = extractXmlText(xml);
  if (!text) fail('EMPTY_DOCUMENT');
  const pageTexts = text.split('\f');
  if (pageTexts.length > limits.maxPages) fail('PAGE_LIMIT_EXCEEDED');
  return pageTexts.map((page, index) => ({ page: index + 1, text: page }));
}

function extractPages(format, bytes, limits) {
  if (format === 'txt' || format === 'markdown') {
    return [{ page: null, text: normalizeText(decodeUtf8(bytes), limits) }];
  }
  if (format === 'html') return [{ page: null, text: extractHtml(bytes, limits) }];
  if (format === 'pdf') return extractPdf(bytes, limits);
  if (format === 'docx') return extractDocx(bytes, limits);
  fail('UNSUPPORTED_FORMAT');
}

function makeChunks(pages, sourceId, fileName, digest, limits) {
  const pageRecords = pages.map(({ page, text }) => ({
    page,
    text: normalizeText(text, limits, true),
  }));
  const fullText = pageRecords.map(item => item.text).join('\n');
  if (!pageRecords.some(item => item.text)) fail('EMPTY_DOCUMENT');
  if (fullText.length > limits.maxTextCodeUnits) fail('TEXT_TOO_LARGE');
  const chunks = [];
  let documentOffset = 0;
  for (const item of pageRecords) {
    const codePoints = [...item.text];
    const offsets = [0];
    for (const point of codePoints) offsets.push(offsets.at(-1) + point.length);
    let start = 0;
    while (start < codePoints.length) {
      if (chunks.length >= limits.maxChunks) fail('CHUNK_LIMIT_EXCEEDED');
      const end = Math.min(start + limits.chunkSize, codePoints.length);
      const startOffset = documentOffset + offsets[start];
      const endOffset = documentOffset + offsets[end];
      chunks.push({
        index: chunks.length,
        sourceId,
        fileName,
        page: item.page,
        startOffset,
        endOffset,
        sha256: digest,
        text: item.text.slice(offsets[start], offsets[end]),
      });
      if (end === codePoints.length) break;
      start = end - limits.chunkOverlap;
    }
    documentOffset += item.text.length + 1;
  }
  return { text: fullText, chunks };
}

function validIndex(value, limits) {
  if (value === undefined) return { contractVersion: CONTRACT_VERSION, documents: [] };
  try {
    const index = exactObject(value, ['contractVersion', 'documents']);
    if (index.contractVersion !== CONTRACT_VERSION || !Array.isArray(index.documents) ||
        index.documents.length > limits.maxDocuments) fail('CORRUPT_INDEX');
    for (const document of index.documents) {
      const item = exactObject(document, [
        'id', 'sourceId', 'fileName', 'format', 'version', 'sha256', 'pageCount',
        'createdAt', 'text', 'chunks',
      ]);
      if (typeof item.id !== 'string' || !UUID.test(item.id) ||
          typeof item.sourceId !== 'string' || !SOURCE_ID.test(item.sourceId) ||
          typeof item.fileName !== 'string' || !FILE_NAME.test(item.fileName) ||
          !FORMATS.includes(item.format) || !safeInteger(item.version, 1, Number.MAX_SAFE_INTEGER) ||
          typeof item.sha256 !== 'string' || !HASH.test(item.sha256) ||
          !safeInteger(item.pageCount, 1, DEFAULTS.maxPages) ||
          !safeInteger(item.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
          typeof item.text !== 'string' || item.text.length > limits.maxTextCodeUnits ||
          !Array.isArray(item.chunks) || item.chunks.length === 0 ||
          item.chunks.length > limits.maxChunks) fail('CORRUPT_INDEX');
      for (let chunkIndex = 0; chunkIndex < item.chunks.length; chunkIndex += 1) {
        const chunk = exactObject(item.chunks[chunkIndex], [
          'index', 'sourceId', 'fileName', 'page', 'startOffset', 'endOffset', 'sha256', 'text',
        ]);
        if (chunk.index !== chunkIndex || chunk.sourceId !== item.sourceId ||
            chunk.fileName !== item.fileName ||
            (chunk.page !== null && !safeInteger(chunk.page, 1, item.pageCount)) ||
            !safeInteger(chunk.startOffset, 0, item.text.length) ||
            !safeInteger(chunk.endOffset, 1, item.text.length) ||
            chunk.startOffset >= chunk.endOffset || chunk.sha256 !== item.sha256 ||
            typeof chunk.text !== 'string' ||
            item.text.slice(chunk.startOffset, chunk.endOffset) !== chunk.text) {
          fail('CORRUPT_INDEX');
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(index), 'utf8') > limits.maxStoredBytes) fail('CORRUPT_INDEX');
    return index;
  } catch (error) {
    if (error instanceof RagIngestionError) throw error;
    fail('CORRUPT_INDEX');
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function createRagIngestionService(options) {
  const config = exactObject(options, ['tenancy', 'store', 'limits', 'clock'], ['tenancy', 'store']);
  const { tenancy, store } = config;
  if (!tenancy || typeof tenancy.resolveTenantContext !== 'function' ||
      !store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(config.limits);
  const clock = config.clock ?? Date.now;
  if (typeof clock !== 'function') fail('INVALID_CONFIGURATION');

  async function resolveContext(input) {
    let context;
    try {
      context = await tenancy.resolveTenantContext({
        cookieHeader: input.cookieHeader,
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
    } catch {
      fail('TENANT_ACCESS_DENIED');
    }
    const validated = validateTenantContext(context);
    if (validated.tenantId !== input.tenantId.toLowerCase() ||
        validated.requestId !== input.requestId) fail('TENANT_ACCESS_DENIED');
    return validated;
  }

  async function readIndex(context) {
    let result;
    try {
      result = await store.get(context, INDEX_KEY);
    } catch {
      fail('STORAGE_UNAVAILABLE');
    }
    if (result === undefined) return { index: validIndex(undefined, limits), version: undefined };
    try {
      const stored = exactObject(result, ['value', 'version']);
      if (!safeInteger(stored.version, 1, Number.MAX_SAFE_INTEGER)) fail('CORRUPT_INDEX');
      return { index: validIndex(stored.value, limits), version: stored.version };
    } catch (error) {
      if (error instanceof RagIngestionError) throw error;
      fail('CORRUPT_INDEX');
    }
  }

  return Object.freeze({
    async ingest(input) {
      const value = exactObject(input, [
        'cookieHeader', 'tenantId', 'requestId', 'sourceId', 'fileName', 'format', 'data',
      ]);
      if (typeof value.cookieHeader !== 'string' || value.cookieHeader.length > 8192 ||
          typeof value.tenantId !== 'string' || !UUID.test(value.tenantId) ||
          typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId) ||
          typeof value.sourceId !== 'string' || !SOURCE_ID.test(value.sourceId) ||
          typeof value.fileName !== 'string' || !FILE_NAME.test(value.fileName) ||
          !FORMATS.includes(value.format) ||
          !(Buffer.isBuffer(value.data) || value.data instanceof Uint8Array)) fail('INVALID_INPUT');
      const data = Buffer.from(value.data);
      if (data.length === 0) fail('INVALID_DOCUMENT');
      if (data.length > limits.maxInputBytes) fail('FILE_TOO_LARGE');
      const context = await resolveContext(value);
      const digest = sha256(data);
      const pages = extractPages(value.format, data, limits);
      if (pages.length > limits.maxPages) fail('PAGE_LIMIT_EXCEEDED');
      const normalized = makeChunks(pages, value.sourceId, value.fileName, digest, limits);
      const now = clock();
      if (!safeInteger(now, 0, Number.MAX_SAFE_INTEGER)) fail('INVALID_CONFIGURATION');

      for (let attempt = 0; attempt < limits.maxWriteRetries; attempt += 1) {
        const { index, version: indexVersion } = await readIndex(context);
        const duplicate = index.documents.find(document =>
          document.sourceId === value.sourceId && document.sha256 === digest);
        if (duplicate) {
          return deepFreeze({ ...JSON.parse(JSON.stringify(duplicate)), deduplicated: true });
        }
        const matchingVersions = index.documents.filter(document => document.sourceId === value.sourceId);
        const version = matchingVersions.reduce((maximum, document) => Math.max(maximum, document.version), 0) + 1;
        if (index.documents.length >= limits.maxDocuments) fail('DOCUMENT_LIMIT_EXCEEDED');
        const document = {
          id: randomUUID(),
          sourceId: value.sourceId,
          fileName: value.fileName,
          format: value.format,
          version,
          sha256: digest,
          pageCount: pages.length,
          createdAt: now,
          text: normalized.text,
          chunks: normalized.chunks,
        };
        const next = { contractVersion: CONTRACT_VERSION, documents: [...index.documents, document] };
        const serialized = JSON.stringify(next);
        if (Buffer.byteLength(serialized, 'utf8') > limits.maxStoredBytes) fail('STORAGE_LIMIT');
        try {
          await store.put(context, INDEX_KEY, next, indexVersion);
          return deepFreeze({ ...JSON.parse(serialized).documents.at(-1), deduplicated: false });
        } catch (error) {
          if (error?.code !== 'CONFLICT') fail('STORAGE_UNAVAILABLE');
        }
      }
      fail('STORAGE_BUSY');
    },
  });
}

export const ragIngestionContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: '1.0.0',
  formats: FORMATS,
  defaults: DEFAULTS,
  deduplicationScope: 'tenant-and-source-id',
  versioning: 'monotonic-per-source-id',
  storageKey: INDEX_KEY,
  offsetUnit: 'UTF-16-code-units-in-normalized-document-text',
  networkRequired: false,
});
