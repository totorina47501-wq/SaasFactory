import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateSync, inflateSync } from 'node:zlib';

const CONTRACT_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULTS = Object.freeze({
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxPixels: 8 * 1024 * 1024,
  maxDimension: 4096,
  maxWorkingBytes: 288 * 1024 * 1024,
  maxInFlightBytes: 16 * 1024 * 1024,
  maxConcurrentUploads: 2,
  maxCarouselItems: 20,
  uploadTimeoutMs: 60 * 1000,
});
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

export class ImagesError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImagesError';
    this.code = code;
  }
}

function fail(code) {
  throw new ImagesError(code);
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

function validateResize(value, limits) {
  if (value === undefined) return;
  const options = exactObject(value, ['width', 'height']);
  if (!safeInteger(options.width, 1, limits.maxDimension) ||
      !safeInteger(options.height, 1, limits.maxDimension)) fail('INVALID_INPUT');
}

function validateCompressionLevel(value) {
  if (value !== undefined && !safeInteger(value, 0, 9)) fail('INVALID_INPUT');
}

function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
  if (signal?.aborted) fail('INTERRUPTED');
}

function exactArray(value, maximumLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > maximumLength) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) fail('INVALID_INPUT');
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
    result.push(descriptor.value);
  }
  return result;
}

function validateLimits(value = {}) {
  const input = exactObject(value, Object.keys(DEFAULTS), []);
  const limits = { ...DEFAULTS, ...input };
  const bounds = {
    maxInputBytes: 20 * 1024 * 1024,
    maxOutputBytes: 20 * 1024 * 1024,
    maxPixels: 16 * 1024 * 1024,
    maxDimension: 4096,
    maxWorkingBytes: 1024 * 1024 * 1024,
    maxInFlightBytes: 128 * 1024 * 1024,
    maxConcurrentUploads: 8,
    maxCarouselItems: 50,
    uploadTimeoutMs: 5 * 60 * 1000,
  };
  for (const [key, maximum] of Object.entries(bounds)) {
    if (!safeInteger(limits[key], 1, maximum)) fail('INVALID_CONFIGURATION');
  }
  if (limits.maxInputBytes > limits.maxInFlightBytes ||
      limits.maxInFlightBytes < limits.maxInputBytes * limits.maxConcurrentUploads ||
      limits.maxWorkingBytes < limits.maxPixels * 32 +
        2 * limits.maxInputBytes + 2 * limits.maxOutputBytes) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze(limits);
}

function crc32(parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32([name, data]), data.length + 8);
  return result;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left :
    aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45 ||
      buffer.length > limits.maxInputBytes || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('INVALID_IMAGE');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let seenIdat = false;
  let endedIdat = false;
  let seenEnd = false;
  const compressedParts = [];
  let compressedBytes = 0;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('INVALID_IMAGE');
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) fail('INVALID_IMAGE');
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32([typeBytes, data]) !== buffer.readUInt32BE(dataEnd)) fail('INVALID_IMAGE');

    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) fail('INVALID_IMAGE');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!safeInteger(width, 1, limits.maxDimension) ||
          !safeInteger(height, 1, limits.maxDimension) ||
          width * height > limits.maxPixels) {
        fail('PIXEL_LIMIT');
      }
      if (data[8] !== 8 || ![2, 6].includes(data[9]) ||
          data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        fail('UNSUPPORTED_FORMAT');
      }
    } else if (type === 'IDAT') {
      if (endedIdat) fail('INVALID_IMAGE');
      seenIdat = true;
      compressedBytes += length;
      if (compressedBytes > limits.maxInputBytes) fail('IMAGE_TOO_LARGE');
      compressedParts.push(data);
    } else if (type === 'IEND') {
      if (!seenIdat || length !== 0) fail('INVALID_IMAGE');
      seenEnd = true;
      offset = dataEnd + 4;
      if (offset !== buffer.length) fail('INVALID_IMAGE');
      break;
    } else {
      fail('UNSUPPORTED_FORMAT');
    }

    if (seenIdat && type !== 'IDAT') endedIdat = true;
    offset = dataEnd + 4;
  }
  if (!seenEnd || compressedParts.length === 0) fail('INVALID_IMAGE');

  const channels = buffer[25] === 6 ? 4 : 3;
  const bytesPerRow = width * channels;
  const expectedSize = height * (bytesPerRow + 1);
  if (!Number.isSafeInteger(expectedSize) || expectedSize > limits.maxPixels * 4 + limits.maxDimension) {
    fail('PIXEL_LIMIT');
  }
  let filtered;
  try {
    filtered = inflateSync(Buffer.concat(compressedParts), { maxOutputLength: expectedSize + 1 });
  } catch {
    fail('INVALID_IMAGE');
  }
  if (filtered.length !== expectedSize) fail('INVALID_IMAGE');

  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(bytesPerRow);
  const current = Buffer.alloc(bytesPerRow);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (bytesPerRow + 1);
    const filter = filtered[rowStart];
    if (filter > 4) fail('INVALID_IMAGE');
    for (let x = 0; x < bytesPerRow; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const above = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0 :
        filter === 1 ? left :
          filter === 2 ? above :
            filter === 3 ? Math.floor((left + above) / 2) :
              paeth(left, above, upperLeft);
      current[x] = (filtered[rowStart + x + 1] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const inputOffset = x * channels;
      const outputOffset = (y * width + x) * 4;
      pixels[outputOffset] = current[inputOffset];
      pixels[outputOffset + 1] = current[inputOffset + 1];
      pixels[outputOffset + 2] = current[inputOffset + 2];
      pixels[outputOffset + 3] = channels === 4 ? current[inputOffset + 3] : 255;
    }
    current.copy(previous);
  }
  return { width, height, pixels };
}

function resizeImage(image, resize, limits) {
  if (resize === undefined) return image;
  const options = exactObject(resize, ['width', 'height']);
  if (!safeInteger(options.width, 1, limits.maxDimension) ||
      !safeInteger(options.height, 1, limits.maxDimension)) fail('INVALID_INPUT');
  const scale = Math.min(1, options.width / image.width, options.height / image.height);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  if (width * height > limits.maxPixels) fail('PIXEL_LIMIT');
  if (width === image.width && height === image.height) return image;

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * image.height / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = Math.max(0, sourceY - y0);
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * image.width / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = Math.max(0, sourceX - x0);
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = image.pixels[(y0 * image.width + x0) * 4 + channel];
        const topRight = image.pixels[(y0 * image.width + x1) * 4 + channel];
        const bottomLeft = image.pixels[(y1 * image.width + x0) * 4 + channel];
        const bottomRight = image.pixels[(y1 * image.width + x1) * 4 + channel];
        const top = topLeft + (topRight - topLeft) * xWeight;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        pixels[target + channel] = Math.round(top + (bottom - top) * yWeight);
      }
    }
  }
  return { width, height, pixels };
}

function encodePng(image, compressionLevel, limits) {
  if (!safeInteger(compressionLevel, 0, 9)) fail('INVALID_INPUT');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;

  const rowLength = image.width * 4;
  const raw = Buffer.alloc(image.height * (rowLength + 1));
  for (let y = 0; y < image.height; y += 1) {
    image.pixels.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
  }
  let compressed;
  try {
    compressed = deflateSync(raw, { level: compressionLevel });
  } catch {
    fail('IMAGE_PROCESSING_FAILED');
  }
  const output = Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  if (output.length > limits.maxOutputBytes) fail('IMAGE_TOO_LARGE');
  return output;
}

function validateFileName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 ||
      /[\u0000-\u001f\u007f/\\]/u.test(value) || value.includes('..') ||
      /[\u2044\u2215\u29f8\uff0f\uff3c]/u.test(value)) fail('INVALID_INPUT');
}

function validateImageId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT');
  return value.toLowerCase();
}

function authFields(input) {
  return {
    cookieHeader: input.cookieHeader,
    tenantId: input.tenantId,
    requestId: input.requestId,
  };
}

async function collectReadable(stream, maxBytes, signal, timeoutMs) {
  if (!(stream instanceof Readable)) fail('INVALID_INPUT');
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const parts = [];
  let size = 0;
  const validateChunks = new Transform({
    decodeStrings: false,
    transform(value, encoding, callback) {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        callback(new ImagesError('INVALID_INPUT'));
        return;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        callback(new ImagesError('IMAGE_TOO_LARGE'));
        return;
      }
      callback(null, value);
    },
  });
  const collect = new Writable({
    write(value, encoding, callback) {
      parts.push(Buffer.from(value));
      callback();
    },
  });
  try {
    await pipeline(stream, validateChunks, collect, { signal: combinedSignal });
  } catch (error) {
    if (signal?.aborted) fail('INTERRUPTED');
    if (timeoutSignal.aborted) fail('IMAGE_TIMEOUT');
    if (error instanceof ImagesError) throw error;
    fail('UPLOAD_FAILED');
  }
  if (signal?.aborted) fail('INTERRUPTED');
  return Buffer.concat(parts, size);
}

export async function createImageService(options) {
  const config = exactObject(options, ['storage', 'limits'], ['storage']);
  const storage = config.storage;
  if (!storage || storage.contractVersion !== 1 ||
      typeof storage.upload !== 'function' || typeof storage.export !== 'function' ||
      typeof storage.list !== 'function' || typeof storage.delete !== 'function' ||
      typeof storage.purgeExpired !== 'function') {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(config.limits);
  let activeUploads = 0;
  let reservedBytes = 0;
  let reservedWorkingBytes = 0;
  const workingReservation = limits.maxPixels * 32 +
    2 * limits.maxInputBytes + 2 * limits.maxOutputBytes;

  function reserveWorkingSet() {
    if (reservedWorkingBytes + workingReservation > limits.maxWorkingBytes) {
      fail('IMAGE_BUSY');
    }
    reservedWorkingBytes += workingReservation;
    return () => {
      reservedWorkingBytes -= workingReservation;
    };
  }

  async function getImage(input, reserved = false, includeStream = true) {
    const value = exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'objectId', 'signal',
    ], ['cookieHeader', 'tenantId', 'requestId', 'objectId']);
    validateSignal(value.signal);
    const releaseWorkingSet = reserved ? () => {} : reserveWorkingSet();
    try {
      const exported = await storage.export({
        ...authFields(value),
        objectId: validateImageId(value.objectId),
      });
      const buffer = await collectReadable(
        exported.stream, limits.maxOutputBytes, value.signal, limits.uploadTimeoutMs,
      );
      const image = decodePng(buffer, { ...limits, maxInputBytes: limits.maxOutputBytes });
      return Object.freeze({
        ...exported.metadata,
        width: image.width,
        height: image.height,
        format: 'image/png',
        ...(includeStream ? { stream: Readable.from([buffer]) } : {}),
      });
    } finally {
      releaseWorkingSet();
    }
  }

  async function upload(input) {
    const value = exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'fileName', 'contentType', 'stream',
      'resize', 'compressionLevel', 'signal',
    ], ['cookieHeader', 'tenantId', 'requestId', 'fileName', 'contentType', 'stream']);
    validateFileName(value.fileName);
    if (value.contentType !== 'image/png') fail('CONTENT_TYPE_MISMATCH');
    validateSignal(value.signal);
    if (!(value.stream instanceof Readable)) fail('INVALID_INPUT');
    validateResize(value.resize, limits);
    validateCompressionLevel(value.compressionLevel);
    if (activeUploads >= limits.maxConcurrentUploads ||
        reservedBytes + limits.maxInputBytes > limits.maxInFlightBytes) fail('IMAGE_BUSY');

    activeUploads += 1;
    reservedBytes += limits.maxInputBytes;
    let releaseWorkingSet;
    try {
      releaseWorkingSet = reserveWorkingSet();
      await storage.list(authFields(value));
      const source = await collectReadable(
        value.stream, limits.maxInputBytes, value.signal, limits.uploadTimeoutMs,
      );
      const decoded = decodePng(source, limits);
      const transformed = resizeImage(decoded, value.resize, limits);
      const compressed = encodePng(transformed, value.compressionLevel ?? 6, limits);
      const stored = await storage.upload({
        ...authFields(value),
        fileName: 'image.png',
        contentType: 'image/png',
        stream: Readable.from([compressed]),
        signal: value.signal,
      });
      return Object.freeze({
        ...stored,
        width: transformed.width,
        height: transformed.height,
        format: 'image/png',
      });
    } finally {
      releaseWorkingSet?.();
      activeUploads -= 1;
      reservedBytes -= limits.maxInputBytes;
    }
  }

  async function createThumbnail(input) {
    const value = exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'objectId', 'width', 'height',
      'compressionLevel', 'signal',
    ], [
      'cookieHeader', 'tenantId', 'requestId', 'objectId', 'width', 'height',
    ]);
    validateSignal(value.signal);
    validateResize({ width: value.width, height: value.height }, limits);
    validateCompressionLevel(value.compressionLevel);
    const sourceId = validateImageId(value.objectId);
    const releaseWorkingSet = reserveWorkingSet();
    try {
      const original = await getImage({
        ...authFields(value),
        objectId: sourceId,
        signal: value.signal,
      }, true);
      const chunks = [];
      for await (const data of original.stream) chunks.push(data);
      const image = resizeImage(
        decodePng(Buffer.concat(chunks), { ...limits, maxInputBytes: limits.maxOutputBytes }),
        { width: value.width, height: value.height },
        limits,
      );
      const compressed = encodePng(image, value.compressionLevel ?? 6, limits);
      const stored = await storage.upload({
        ...authFields(value),
        fileName: `${sourceId}-thumbnail.png`,
        contentType: 'image/png',
        stream: Readable.from([compressed]),
        signal: value.signal,
      });
      return Object.freeze({
        ...stored,
        sourceId,
        width: image.width,
        height: image.height,
        format: 'image/png',
      });
    } finally {
      releaseWorkingSet();
    }
  }

  async function createCarousel(input) {
    const value = exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'imageIds', 'activeIndex', 'signal',
    ], ['cookieHeader', 'tenantId', 'requestId', 'imageIds']);
    validateSignal(value.signal);
    const ids = exactArray(value.imageIds, limits.maxCarouselItems).map(validateImageId);
    if (new Set(ids).size !== ids.length) fail('INVALID_INPUT');
    if (Object.hasOwn(value, 'activeIndex') && value.activeIndex === null) fail('INVALID_INPUT');
    const activeIndex = value.activeIndex ?? 0;
    if (!safeInteger(activeIndex, 0, ids.length - 1)) fail('INVALID_INPUT');
    const available = new Map((await storage.list(authFields(value))).map(item => [item.id, item]));
    const items = [];
    for (const id of ids) {
      const metadata = available.get(id);
      if (!metadata) fail('IMAGE_NOT_FOUND');
      const image = await getImage({
        ...authFields(value),
        objectId: id,
        signal: value.signal,
      }, false, false);
      items.push(Object.freeze({
        ...metadata,
        width: image.width,
        height: image.height,
        format: image.format,
      }));
    }
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      items: Object.freeze(items),
      activeIndex,
      previousIndex: activeIndex === 0 ? null : activeIndex - 1,
      nextIndex: activeIndex === items.length - 1 ? null : activeIndex + 1,
    });
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    moduleVersion: MODULE_VERSION,
    upload,
    get: input => getImage(input),
    list: input => storage.list(exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId',
    ])),
    createThumbnail,
    createCarousel,
    delete: input => storage.delete(exactObject(input, [
      'cookieHeader', 'tenantId', 'requestId', 'objectId',
    ])),
    purgeExpired: input => storage.purgeExpired(input),
  });
}

export const imagesContract = Object.freeze({
  version: CONTRACT_VERSION,
  moduleVersion: MODULE_VERSION,
  formats: Object.freeze(['image/png']),
  inputPixelFormats: Object.freeze(['RGB', 'RGBA']),
  outputFormat: 'image/png',
  uploadMode: 'bounded-memory-transform-storage-stream',
  storage: 'private-storage-v1',
  exif: 'unsupported-and-rejected',
});
