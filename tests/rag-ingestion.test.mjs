import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import {
  createRagIngestionService,
  ragIngestionContract,
  RagIngestionError,
} from '../modules/rag-ingestion/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'request-1',
});

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

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function docx(text, extra = []) {
  return zip([
    ['[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['word/document.xml', `<w:document xmlns:w="urn:word"><w:body>${text}</w:body></w:document>`],
    ...extra,
  ]);
}

function pdf(text, fillerCount = 0) {
  const stream = `BT (${text}) Tj ET`;
  const firstObject = fillerCount + 1;
  const objects = [
    ...Array.from({ length: fillerCount }, (_, index) =>
      `${index + 1} 0 obj\n<< /Info (synthetic ${index}) >>\nendobj\n`),
    `${firstObject} 0 obj\n<< /Type /Catalog /Pages ${firstObject + 1} 0 R >>\nendobj\n`,
    `${firstObject + 1} 0 obj\n<< /Type /Pages /Kids [${firstObject + 2} 0 R] /Count 1 >>\nendobj\n`,
    `${firstObject + 2} 0 obj\n<< /Type /Page /Parent ${firstObject + 1} 0 R /Contents ${firstObject + 3} 0 R >>\nendobj\n`,
    `${firstObject + 3} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Root ${firstObject} 0 R >>\n%%EOF\n`);
}

function createService({ limits, clock = () => 1000 } = {}) {
  const values = new Map();
  const store = {
    async get(context, key) {
      const current = values.get(`${context.tenantId}:${key}`);
      return current ? { value: structuredClone(current.value), version: current.version } : undefined;
    },
    async put(context, key, value, expectedVersion) {
      const storageKey = `${context.tenantId}:${key}`;
      const current = values.get(storageKey);
      if ((current?.version) !== expectedVersion) {
        const error = new Error('conflict');
        error.code = 'CONFLICT';
        throw error;
      }
      const version = (current?.version ?? 0) + 1;
      values.set(storageKey, { value: structuredClone(value), version });
      return version;
    },
  };
  const tenancy = {
    async resolveTenantContext(input) {
      const tenantId = input.cookieHeader === 'tenant-a' ? TENANT_A :
        input.cookieHeader === 'tenant-b' ? TENANT_B : null;
      if (!tenantId || input.tenantId !== tenantId) throw new Error('denied');
      return { contractVersion: 1, tenantId, requestId: input.requestId };
    },
  };
  return {
    service: createRagIngestionService({ tenancy, store, limits, clock }),
    values,
  };
}

function input(data, overrides = {}) {
  return {
    ...auth(),
    sourceId: 'handbook',
    fileName: 'handbook.txt',
    format: 'txt',
    data: Buffer.from(data),
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof RagIngestionError && error.code === code);
}

test('extracts and normalizes TXT and Markdown into deterministic chunks with source offsets and SHA-256', async () => {
  const { service } = createService({ limits: { chunkSize: 8, chunkOverlap: 2 } });
  const source = '  Cafe\u0301 guide 😀\r\n\nNext line  ';
  const first = await service.ingest(input(source));
  const again = await service.ingest(input(source, { format: 'markdown', fileName: 'handbook.md' }));
  assert.equal(first.text, 'Café guide 😀\n\nNext line');
  assert.equal(first.sha256, again.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.deduplicated, false);
  assert.equal(again.deduplicated, true);
  assert.equal(first.version, 1);
  assert.ok(first.chunks.length > 1);
  assert.ok(first.chunks.every(chunk =>
    chunk.sourceId === 'handbook' && chunk.page === null &&
    chunk.sha256 === first.sha256 && chunk.startOffset < chunk.endOffset));
  assert.equal(ragIngestionContract.offsetUnit, 'UTF-16-code-units-in-normalized-document-text');
});

test('removes active HTML and extracts text without interpreting markup', async () => {
  const { service } = createService();
  const document = await service.ingest(input(
    '<html><script>doNotRun()</script><style>.secret{}</style><p onclick="evil()">Hello &amp; world</p></html>',
    { format: 'html', fileName: 'page.html' },
  ));
  assert.equal(document.text, 'Hello & world');
  assert.equal(document.format, 'html');
  assert.equal(document.pageCount, 1);
});

test('extracts bounded DOCX text and page metadata from a synthetic local ZIP', async () => {
  const { service } = createService();
  const document = await service.ingest(input(
    docx('<w:p><w:r><w:t>First page</w:t></w:r></w:p><w:p><w:br w:type="page"/><w:r><w:t>Second page</w:t></w:r></w:p>'),
    { format: 'docx', fileName: 'guide.docx' },
  ));
  assert.equal(document.text, 'First page\nSecond page');
  assert.equal(document.pageCount, 2);
  assert.deepEqual(document.chunks.map(chunk => chunk.page), [1, 2]);
});

test('extracts PDF text with source page metadata and rejects malformed PDFs', async () => {
  const { service } = createService();
  const document = await service.ingest(input(pdf('Local PDF text', 200), {
    format: 'pdf',
    fileName: 'guide.pdf',
  }));
  assert.equal(document.text, 'Local PDF text');
  assert.equal(document.pageCount, 1);
  assert.equal(document.chunks[0].page, 1);
  await expectCode(service.ingest(input('%PDF-1.4\nnot a valid document', {
    format: 'pdf',
    fileName: 'broken.pdf',
    sourceId: 'broken',
  })), 'INVALID_DOCUMENT');
});

test('enforces DOCX expansion, page, and input-size budgets before accepting content', async () => {
  const { service } = createService({ limits: { maxExpansionRatio: 5 } });
  const bomb = docx(`<w:p><w:r><w:t>${'x'.repeat(50000)}</w:t></w:r></w:p>`);
  await expectCode(service.ingest(input(bomb, {
    format: 'docx',
    fileName: 'large.docx',
    sourceId: 'large',
  })), 'EXPANSION_LIMIT_EXCEEDED');
  const inputLimited = createService({ limits: { maxInputBytes: 1024 } }).service;
  await expectCode(inputLimited.ingest(input(Buffer.alloc(1025), {
    sourceId: 'oversized',
  })), 'FILE_TOO_LARGE');

  const limited = createService({ limits: { maxPages: 1 } }).service;
  await expectCode(limited.ingest(input(
    docx('<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:br w:type="page"/><w:r><w:t>two</w:t></w:r></w:p>'),
    { format: 'docx', fileName: 'pages.docx', sourceId: 'pages' },
  )), 'PAGE_LIMIT_EXCEEDED');
});

test('deduplicates within a tenant and source, versions changed documents, and isolates tenants', async () => {
  const { service, values } = createService();
  const original = await service.ingest(input('version one'));
  const duplicate = await service.ingest(input('version one'));
  const updated = await service.ingest(input('version two'));
  const otherTenant = await service.ingest(input('version one', {
    ...auth(TENANT_B),
  }));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.id, original.id);
  assert.equal(updated.version, 2);
  assert.notEqual(updated.id, original.id);
  assert.equal(otherTenant.version, 1);
  assert.notEqual(otherTenant.id, original.id);
  assert.equal(values.size, 2);
});

test('rejects unknown input, invalid tenant context, malformed DOCX archives, and corrupt storage', async () => {
  const { service, values } = createService();
  await expectCode(service.ingest(input('hello', { unexpected: true })), 'INVALID_INPUT');
  await expectCode(service.ingest(input('hello', { tenantId: 'not-a-tenant' })), 'INVALID_INPUT');
  await expectCode(service.ingest(input('hello', {
    cookieHeader: 'tenant-a',
    tenantId: TENANT_B,
  })), 'TENANT_ACCESS_DENIED');
  await expectCode(service.ingest(input(Buffer.from('not a zip'), {
    format: 'docx',
    fileName: 'broken.docx',
  })), 'INVALID_DOCUMENT');
  const traversalDocx = zip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<w:document/>'],
    ['../outside.xml', 'not extracted'],
  ]);
  await expectCode(service.ingest(input(traversalDocx, {
    format: 'docx',
    fileName: 'unsafe.docx',
    sourceId: 'unsafe',
  })), 'INVALID_DOCUMENT');
  await expectCode(service.ingest(input('<p>text</p>', {
    format: 'html',
    fileName: '../unsafe.html',
  })), 'INVALID_INPUT');
  values.set(`${TENANT_A}:rag-ingestion-v1/index`, {
    value: { contractVersion: 2, documents: [] },
    version: 1,
  });
  await expectCode(service.ingest(input('storage must fail closed', {
    sourceId: 'corrupt-index',
  })), 'CORRUPT_INDEX');
});
