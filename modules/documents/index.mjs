import { spawn } from 'node:child_process';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const DEFAULTS = Object.freeze({
  maxPdfBytes: 10 * 1024 * 1024,
  maxPdfPages: 40,
  maxTextCodeUnits: 500_000,
  maxOcrInputBytes: 10 * 1024 * 1024,
  maxOcrOutputBytes: 2 * 1024 * 1024,
  maxOcrPixels: 8 * 1024 * 1024,
  maxOcrWorkingBytes: 256 * 1024 * 1024,
  ocrTimeoutMs: 30_000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OCR_MODELS = new Set(['deu', 'eng', 'fra', 'ita', 'nld', 'por', 'spa']);

export class DocumentsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DocumentsError';
    this.code = code;
  }
}

function fail(code) {
  throw new DocumentsError(code);
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_INPUT');
  }
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
  const input = exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...input };
  const maximums = {
    maxPdfBytes: 50 * 1024 * 1024,
    maxPdfPages: 200,
    maxTextCodeUnits: 2_000_000,
    maxOcrInputBytes: 20 * 1024 * 1024,
    maxOcrOutputBytes: 10 * 1024 * 1024,
    maxOcrPixels: 16 * 1024 * 1024,
    maxOcrWorkingBytes: 1024 * 1024 * 1024,
    ocrTimeoutMs: 5 * 60 * 1000,
  };
  for (const [key, maximum] of Object.entries(maximums)) {
    if (!safeInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

function validateAuth(value) {
  if (typeof value.cookieHeader !== 'string' || value.cookieHeader.length > 8192 ||
      typeof value.tenantId !== 'string' || !UUID.test(value.tenantId) ||
      typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) {
    fail('INVALID_INPUT');
  }
}

function validateModels(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length === 0 || value.length > OCR_MODELS.size) fail('INVALID_CONFIGURATION');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) fail('INVALID_CONFIGURATION');
  const models = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !OCR_MODELS.has(descriptor.value) || models.includes(descriptor.value)) {
      fail('INVALID_CONFIGURATION');
    }
    models.push(descriptor.value);
  }
  return Object.freeze(models);
}

function validateOcrText(value, limits) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > limits.maxTextCodeUnits ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('OCR_INVALID_OUTPUT');
  }
  const text = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > limits.maxOcrOutputBytes) {
    fail('OCR_INVALID_OUTPUT');
  }
  return text;
}

function wrapLine(value, width = 92) {
  const characters = Array.from(value);
  const result = [];
  while (characters.length > width) {
    let breakAt = characters.lastIndexOf(' ', width);
    if (breakAt < 1) breakAt = width;
    result.push(characters.splice(0, breakAt).join('').trimEnd());
    while (characters[0] === ' ') characters.shift();
  }
  result.push(characters.join(''));
  return result;
}

function pdfTextBytes(value) {
  if (!/^[\u0020-\u007e\u00a0-\u00ff]*$/u.test(value)) fail('PDF_UNSUPPORTED_TEXT');
  return Buffer.from(value, 'latin1').toString('hex').toUpperCase();
}

function pdfObject(id, value) {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, 'ascii'),
    Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii'),
    Buffer.from('\nendobj\n', 'ascii'),
  ]);
}

function renderPdf(title, paragraphs, limits) {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200 ||
      !Array.isArray(paragraphs) || Object.getPrototypeOf(paragraphs) !== Array.prototype ||
      paragraphs.length > 500) fail('INVALID_INPUT');
  const paragraphKeys = Reflect.ownKeys(paragraphs);
  if (paragraphKeys.length !== paragraphs.length + 1 || !paragraphKeys.includes('length')) {
    fail('INVALID_INPUT');
  }

  let textCodeUnits = title.length;
  const lines = [`${title.trim()}`, ''];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(paragraphs, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string') fail('INVALID_INPUT');
    textCodeUnits += descriptor.value.length;
    if (textCodeUnits > limits.maxTextCodeUnits) fail('PDF_TEXT_LIMIT');
    for (const line of descriptor.value.split(/\r\n?|\n/u)) lines.push(...wrapLine(line));
    lines.push('');
  }
  if (textCodeUnits > limits.maxTextCodeUnits) fail('PDF_TEXT_LIMIT');
  const linesPerPage = 52;
  const pageCount = Math.max(1, Math.ceil(lines.length / linesPerPage));
  if (pageCount > limits.maxPdfPages) fail('PDF_PAGE_LIMIT');

  const pages = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageLines = lines.slice(pageIndex * linesPerPage, (pageIndex + 1) * linesPerPage);
    const commands = [
      'BT',
      '/F1 10 Tf',
      '50 790 Td',
      '14 TL',
      ...pageLines.map((line, index) =>
        `${index === 0 ? '' : 'T*'}<${pdfTextBytes(line)}> Tj`),
      'ET',
    ].join('\n');
    const data = Buffer.from(commands, 'ascii');
    pages.push(data);
  }

  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((content, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    objects.set(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'),
      content,
      Buffer.from('\nendstream', 'ascii'),
    ]));
  });
  const pageReferences = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects.set(2, `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>`);

  const output = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  let offset = output[0].length;
  for (let id = 1; id <= 3 + pageCount * 2; id += 1) {
    const object = pdfObject(id, objects.get(id));
    offsets.push(offset);
    output.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  output.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`, 'ascii'));
  for (const objectOffset of offsets.slice(1)) {
    output.push(Buffer.from(`${String(objectOffset).padStart(10, '0')} 00000 n \n`, 'ascii'));
  }
  output.push(Buffer.from(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'ascii',
  ));
  const result = Buffer.concat(output);
  if (result.length > limits.maxPdfBytes) fail('PDF_TOO_LARGE');
  return Object.freeze({ data: result, pageCount });
}

function runTesseract(data, limits, languages) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('tesseract', [
        'stdin', 'stdout', '-l', languages.join('+'), '--psm', '3',
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      reject(new DocumentsError('OCR_ENGINE_UNAVAILABLE'));
      return;
    }
    const chunks = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DocumentsError('OCR_TIMEOUT'));
    }, limits.ocrTimeoutMs);
    timeout.unref?.();

    function finish(error, output) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    }

    child.on('error', error => {
      finish(new DocumentsError(error.code === 'ENOENT'
        ? 'OCR_ENGINE_UNAVAILABLE' : 'OCR_FAILED'));
    });
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOcrOutputBytes) {
        child.kill('SIGKILL');
        finish(new DocumentsError('OCR_OUTPUT_LIMIT'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0) finish(new DocumentsError('OCR_FAILED'));
      else finish(undefined, Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => finish(new DocumentsError('OCR_FAILED')));
    child.stdin.end(data);
  });
}

export function createLocalOcrEngine(options) {
  const config = exactObject(options, [
    'languages', 'timeoutMs', 'maxInputBytes', 'maxOutputBytes',
  ], ['languages']);
  const languages = validateModels(config.languages);
  const timeoutMs = config.timeoutMs ?? DEFAULTS.ocrTimeoutMs;
  const maxInputBytes = config.maxInputBytes ?? DEFAULTS.maxOcrInputBytes;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULTS.maxOcrOutputBytes;
  if (!safeInteger(timeoutMs, 1, 5 * 60 * 1000) ||
      !safeInteger(maxInputBytes, 1, 20 * 1024 * 1024) ||
      !safeInteger(maxOutputBytes, 1, 10 * 1024 * 1024)) fail('INVALID_CONFIGURATION');
  const limits = Object.freeze({
    ...DEFAULTS,
    ocrTimeoutMs: timeoutMs,
    maxOcrInputBytes: maxInputBytes,
    maxOcrOutputBytes: maxOutputBytes,
  });
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    model: Object.freeze({ engine: 'tesseract', languages }),
    async recognize(input) {
      const value = exactObject(input, ['data']);
      if (!Buffer.isBuffer(value.data) || value.data.length === 0 ||
          value.data.length > limits.maxOcrInputBytes) fail('OCR_INPUT_LIMIT');
      return runTesseract(value.data, limits, languages);
    },
  });
}

export function createDocumentsService(options) {
  const config = exactObject(options, ['images', 'ragIngestion', 'ocrEngine', 'limits'],
    ['images', 'ragIngestion']);
  if (!config.images || config.images.contractVersion !== 1 ||
      typeof config.images.get !== 'function' ||
      !config.ragIngestion || typeof config.ragIngestion.ingest !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(config.limits);
  const ocrEngine = config.ocrEngine;
  if (ocrEngine !== undefined && ocrEngine !== null &&
      (ocrEngine.contractVersion !== CONTRACT_VERSION ||
       !ocrEngine.model || typeof ocrEngine.model.engine !== 'string' ||
       !Array.isArray(ocrEngine.model.languages) ||
       typeof ocrEngine.recognize !== 'function')) {
    fail('INVALID_CONFIGURATION');
  }

  async function recognizeImage(input) {
    const value = exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'imageId',
    ]);
    validateAuth(value);
    if (typeof value.imageId !== 'string' || !UUID.test(value.imageId)) fail('INVALID_INPUT');
    if (!ocrEngine) fail('OCR_UNAVAILABLE');

    let image;
    try {
      image = await config.images.get({
        cookieHeader: value.cookieHeader,
        tenantId: value.tenantId,
        requestId: value.requestId,
        objectId: value.imageId,
      });
    } catch {
      fail('DOCUMENT_NOT_FOUND');
    }
    if (!image || image.id !== value.imageId || image.contentType !== 'image/png' ||
        !/^[a-f0-9]{64}$/u.test(image.sha256) ||
        !safeInteger(image.width, 1, 4096) || !safeInteger(image.height, 1, 4096)) {
      fail('INVALID_IMAGE');
    }
    if (image.width * image.height > limits.maxOcrPixels ||
        image.width * image.height * 32 > limits.maxOcrWorkingBytes) fail('OCR_MEMORY_LIMIT');
    if (!image.stream || typeof image.stream[Symbol.asyncIterator] !== 'function') {
      fail('INVALID_IMAGE');
    }
    const chunks = [];
    let inputBytes = 0;
    for await (const chunk of image.stream) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail('INVALID_IMAGE');
      inputBytes += chunk.byteLength;
      if (inputBytes > limits.maxOcrInputBytes) fail('OCR_INPUT_LIMIT');
      chunks.push(Buffer.from(chunk));
    }
    if (inputBytes === 0) fail('INVALID_IMAGE');

    let text;
    try {
      text = validateOcrText(await ocrEngine.recognize({ data: Buffer.concat(chunks) }), limits);
    } catch (error) {
      if (error instanceof DocumentsError) throw error;
      fail('OCR_FAILED');
    }
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      text,
      provenance: Object.freeze({
        sourceObjectId: image.id,
        sourceSha256: image.sha256,
        sourceFormat: image.contentType,
        model: Object.freeze({
          engine: ocrEngine.model.engine,
          languages: Object.freeze([...ocrEngine.model.languages]),
        }),
      }),
    });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    moduleVersion: MODULE_VERSION,
    exportPdf(input) {
      const value = exactObject(input, ['title', 'paragraphs', 'template'], ['title', 'paragraphs']);
      if (Object.hasOwn(value, 'template') && value.template !== 'neutral-text-v1') {
        fail('UNSUPPORTED_TEMPLATE');
      }
      const rendered = renderPdf(value.title, value.paragraphs, limits);
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        template: 'neutral-text-v1',
        contentType: 'application/pdf',
        fileName: 'document.pdf',
        pageCount: rendered.pageCount,
        data: rendered.data,
      });
    },
    recognizeImage,
    async ingestImageText(input) {
      const value = exactObject(input, [
        'cookieHeader', 'tenantId', 'requestId', 'imageId',
      ]);
      const recognized = await recognizeImage(value);
      const document = await config.ragIngestion.ingest({
        cookieHeader: value.cookieHeader,
        tenantId: value.tenantId,
        requestId: value.requestId,
        sourceId: recognized.provenance.sourceObjectId,
        fileName: `${recognized.provenance.sourceObjectId}.ocr.txt`,
        format: 'txt',
        data: Buffer.from(recognized.text, 'utf8'),
      });
      return Object.freeze({
        contractVersion: CONTRACT_VERSION,
        document,
        provenance: recognized.provenance,
      });
    },
  });
}

export const documentsContract = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  pdf: Object.freeze({
    template: 'neutral-text-v1',
    input: 'plain-text-only',
    externalLinks: false,
    htmlEngine: false,
    networkRequired: false,
  }),
  ocr: Object.freeze({
    optional: true,
    defaultEnabled: false,
    engine: 'tesseract-local',
    models: Object.freeze([...OCR_MODELS]),
    networkRequired: false,
  }),
  storage: 'private-storage-v1-through-images-v1',
  ragIngestion: 'rag-ingestion-v1',
});
