import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDocumentsService,
  createLocalOcrEngine,
  DocumentsError,
  documentsContract,
} from '../modules/documents/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const IMAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHA256 = 'a'.repeat(64);
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'documents-test',
  imageId: IMAGE_ID,
});

function imageServices({ tenantId = TENANT_A, fail = false } = {}) {
  const received = [];
  return {
    received,
    images: {
      contractVersion: 1,
      async get(input) {
        received.push(input);
        if (fail || input.tenantId !== tenantId) throw new Error('not found');
        return {
          id: IMAGE_ID,
          sha256: SHA256,
          contentType: 'image/png',
          width: 2,
          height: 1,
          stream: (async function* stream() { yield Buffer.from('synthetic-png'); })(),
        };
      },
    },
  };
}

function stubOcr(text = 'Texte OCR synthétique') {
  const received = [];
  return {
    received,
    engine: {
      contractVersion: 1,
      model: { engine: 'test-stub', languages: ['fra'] },
      async recognize(input) {
        received.push(input);
        return text;
      },
    },
  };
}

function service({ images, ragIngestion = { ingest: async value => value }, ocrEngine, limits } = {}) {
  return createDocumentsService({
    images: images ?? imageServices().images,
    ragIngestion,
    ...(ocrEngine ? { ocrEngine } : {}),
    ...(limits ? { limits } : {}),
  });
}

function errorCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof DocumentsError && error.code === code);
}

test('exports a bounded synthetic PDF using the neutral text-only template', () => {
  const documents = service();
  const exported = documents.exportPdf({
    title: 'Rapport neutre',
    paragraphs: ['Résumé sûr.', '<script>alert(1)</script>', 'https://example.test/'],
  });
  assert.equal(exported.contractVersion, 1);
  assert.equal(exported.contentType, 'application/pdf');
  assert.equal(exported.template, 'neutral-text-v1');
  assert.equal(exported.data.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.match(exported.data.toString('ascii'), /xref\n/u);
  assert.match(exported.data.toString('ascii'), /<3C7363726970743E/u);
  assert.doesNotMatch(exported.data.toString('ascii'), /\/URI\b|\/JavaScript\b|\/OpenAction\b/u);
  assert.equal(documentsContract.pdf.networkRequired, false);
  assert.equal(documentsContract.pdf.htmlEngine, false);
});

test('rejects unknown fields, arbitrary templates and unsupported path or text encodings', async () => {
  const documents = service();
  assert.throws(() => documents.exportPdf({
    title: 'Report',
    paragraphs: [],
    path: '/etc/passwd',
  }), { code: 'INVALID_INPUT' });
  assert.throws(() => documents.exportPdf({
    title: 'Report',
    paragraphs: [],
    template: 'remote-html',
  }), { code: 'UNSUPPORTED_TEMPLATE' });
  assert.throws(() => documents.exportPdf({
    title: 'Report',
    paragraphs: ['\u0000'],
  }), { code: 'PDF_UNSUPPORTED_TEXT' });
  await errorCode(Promise.resolve().then(() => documents.exportPdf({
    title: 'Report',
    paragraphs: [],
    template: 'remote-html',
  })), 'UNSUPPORTED_TEMPLATE');
});

test('enforces PDF page, text and byte budgets', () => {
  const textLimited = service({ limits: {
    maxPdfPages: 1,
    maxPdfBytes: 100,
    maxTextCodeUnits: 16,
    maxOcrInputBytes: 1024,
    maxOcrOutputBytes: 128,
    maxOcrPixels: 100,
    maxOcrWorkingBytes: 3200,
    ocrTimeoutMs: 1000,
  } });
  assert.throws(() => textLimited.exportPdf({
    title: 'A title',
    paragraphs: ['too much content'],
  }), { code: 'PDF_TEXT_LIMIT' });

  const pageLimited = service({ limits: {
    maxPdfPages: 1,
  } });
  assert.throws(() => pageLimited.exportPdf({
    title: 'A title',
    paragraphs: [Array(500).fill('line').join('\n')],
  }), { code: 'PDF_PAGE_LIMIT' });

  const byteLimited = service({ limits: { maxPdfBytes: 100 } });
  assert.throws(() => byteLimited.exportPdf({
    title: 'A title',
    paragraphs: ['short but longer than the PDF budget'],
  }), { code: 'PDF_TOO_LARGE' });
});

test('OCR is disabled unless an explicit engine is configured', async () => {
  const { images, received } = imageServices();
  const documents = service({ images });
  await errorCode(documents.recognizeImage(auth()), 'OCR_UNAVAILABLE');
  assert.equal(received.length, 0);
});

test('uses a distinct OCR stub, validates provenance, and forwards tenant context to RAG', async () => {
  const image = imageServices();
  const ocr = stubOcr();
  let ragInput;
  const documents = service({
    images: image.images,
    ocrEngine: ocr.engine,
    ragIngestion: { async ingest(input) { ragInput = input; return { id: 'rag-1' }; } },
  });
  const result = await documents.ingestImageText(auth());
  assert.equal(result.contractVersion, 1);
  assert.equal(result.document.id, 'rag-1');
  assert.deepEqual(result.provenance, {
    sourceObjectId: IMAGE_ID,
    sourceSha256: SHA256,
    sourceFormat: 'image/png',
    model: { engine: 'test-stub', languages: ['fra'] },
  });
  assert.deepEqual(ragInput, {
    cookieHeader: 'tenant-a',
    tenantId: TENANT_A,
    requestId: 'documents-test',
    sourceId: IMAGE_ID,
    fileName: `${IMAGE_ID}.ocr.txt`,
    format: 'txt',
    data: Buffer.from('Texte OCR synthétique'),
  });
  assert.equal(image.received[0].tenantId, TENANT_A);
  assert.equal(ocr.received.length, 1);
  assert.equal(ocr.received[0].data.toString(), 'synthetic-png');
});

test('fails closed for cross-tenant images, invalid image metadata and hostile OCR output', async () => {
  const denied = imageServices({ tenantId: TENANT_B });
  const ocr = stubOcr();
  const documents = service({ images: denied.images, ocrEngine: ocr.engine });
  await errorCode(documents.recognizeImage(auth(TENANT_A)), 'DOCUMENT_NOT_FOUND');

  const invalidImage = {
    contractVersion: 1,
    async get() {
      return {
        id: IMAGE_ID,
        sha256: 'not-a-hash',
        contentType: 'image/png',
        width: 1,
        height: 1,
        stream: (async function* stream() { yield Buffer.from('x'); })(),
      };
    },
  };
  await errorCode(service({ images: invalidImage, ocrEngine: ocr.engine })
    .recognizeImage(auth()), 'INVALID_IMAGE');

  const hostileOutput = service({
    images: imageServices().images,
    ocrEngine: stubOcr('<script>run()</script>\u0000').engine,
  });
  await errorCode(hostileOutput.recognizeImage(auth()), 'OCR_INVALID_OUTPUT');
});

test('rejects image paths, unknown inputs, missing models, and over-budget image work', async () => {
  const image = imageServices();
  const ocr = stubOcr();
  const documents = service({
    images: image.images,
    ocrEngine: ocr.engine,
    limits: { maxOcrPixels: 1 },
  });
  await errorCode(documents.recognizeImage({ ...auth(), path: '/tmp/image.png' }), 'INVALID_INPUT');
  await errorCode(documents.recognizeImage(auth()), 'OCR_MEMORY_LIMIT');
  assert.throws(() => createLocalOcrEngine({ languages: ['eng;curl'] }), {
    code: 'INVALID_CONFIGURATION',
  });
  assert.throws(() => createLocalOcrEngine({ languages: [] }), {
    code: 'INVALID_CONFIGURATION',
  });
});

test('validates OCR model and output byte limits before ingestion', async () => {
  const tooLarge = service({
    images: imageServices().images,
    ocrEngine: stubOcr('un résultat trop long').engine,
    limits: {
      maxOcrOutputBytes: 3,
      maxTextCodeUnits: 100,
    },
  });
  await errorCode(tooLarge.recognizeImage(auth()), 'OCR_INVALID_OUTPUT');
});

test('local Tesseract engine uses explicit installed models and bounded settings', () => {
  const engine = createLocalOcrEngine({
    languages: ['eng', 'fra'],
    timeoutMs: 1000,
    maxInputBytes: 4096,
    maxOutputBytes: 1024,
  });
  assert.deepEqual(engine.model, { engine: 'tesseract', languages: ['eng', 'fra'] });
  assert.equal(engine.contractVersion, 1);
  assert.throws(() => createLocalOcrEngine({ languages: ['eng', 'eng'] }), {
    code: 'INVALID_CONFIGURATION',
  });
});
