import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPrivateStorageService,
  PrivateStorageError,
} from '../modules/private-storage/index.mjs';
import {
  createImageService,
  ImagesError,
  imagesContract,
} from '../modules/images/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'image-test',
});

function crc32(parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32([name, data]), data.length + 8);
  return result;
}

function png(width, height, { colorType = 6, extra = [], filter = 0 } = {}) {
  const channels = colorType === 6 ? 4 : 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const rows = Buffer.alloc(height * (width * channels + 1));
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * channels + 1);
    rows[rowStart] = filter;
    const current = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * channels;
      current[x * channels] = x * 25;
      current[x * channels + 1] = y * 30;
      current[x * channels + 2] = 80;
      if (channels === 4) current[x * channels + 3] = 255;
    }
    for (let index = 0; index < current.length; index += 1) {
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const predictor = filter === 0 ? 0 :
        filter === 1 ? left :
          filter === 2 ? above :
            filter === 3 ? Math.floor((left + above) / 2) :
              (() => {
                const estimate = left + above - upperLeft;
                const leftDistance = Math.abs(estimate - left);
                const aboveDistance = Math.abs(estimate - above);
                const upperLeftDistance = Math.abs(estimate - upperLeft);
                return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left :
                  aboveDistance <= upperLeftDistance ? above : upperLeft;
              })();
      rows[rowStart + 1 + index] = (current[index] - predictor) & 0xff;
    }
    previous = current;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...extra.map(([type, data]) => pngChunk(type, data)),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngWithDeclaredDimensions(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(1))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function setup({ imageLimits = {}, storageLimits = {} } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'sf-images-'));
  await chmod(parent, 0o700);
  const storage = await createPrivateStorageService({
    directory: path.join(parent, 'storage'),
    tenancy: {
      async resolveTenantContext(input) {
        const tenantId = input.cookieHeader === 'tenant-a' ? TENANT_A :
          input.cookieHeader === 'tenant-b' ? TENANT_B : null;
        if (input.tenantId !== tenantId) throw new Error('denied');
        return { contractVersion: 1, tenantId, requestId: input.requestId };
      },
    },
    audit: { append: async () => {} },
    limits: storageLimits,
  });
  return {
    parent,
    storage,
    images: await createImageService({ storage, limits: imageLimits }),
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function uploadInput(overrides = {}) {
  return {
    ...auth(),
    fileName: 'photo.png',
    contentType: 'image/png',
    stream: Readable.from([png(4, 2)]),
    ...overrides,
  };
}

function expectImageCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof ImagesError && error.code === code);
}

function expectStorageCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof PrivateStorageError && error.code === code);
}

test('validates, decodes, resizes and compresses a local PNG before private tenant storage', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);

  const uploaded = await fixture.images.upload(uploadInput({
    stream: Readable.from([png(4, 2, { colorType: 2, filter: 1 })]),
    resize: { width: 2, height: 2 },
    compressionLevel: 9,
  }));
  assert.equal(uploaded.width, 2);
  assert.equal(uploaded.height, 1);
  assert.equal(uploaded.format, 'image/png');
  assert.equal(uploaded.deduplicated, false);
  assert.equal(imagesContract.storage, 'private-storage-v1');
  assert.equal(imagesContract.exif, 'unsupported-and-rejected');

  const saved = await fixture.images.get({ ...auth(), objectId: uploaded.id });
  assert.equal(saved.width, 2);
  assert.equal(saved.height, 1);
  assert.equal(saved.contentType, 'image/png');
  const duplicate = await fixture.images.upload(uploadInput({
    stream: Readable.from([png(4, 2, { colorType: 2, filter: 1 })]),
    resize: { width: 2, height: 2 },
    compressionLevel: 9,
  }));
  assert.equal(duplicate.id, uploaded.id);
  assert.equal(duplicate.deduplicated, true);
  assert.equal((await fixture.images.list(auth())).length, 1);

  const otherTenant = await fixture.images.upload(uploadInput({
    ...auth(TENANT_B),
    stream: Readable.from([png(4, 2, { colorType: 2, filter: 1 })]),
    resize: { width: 2, height: 2 },
    compressionLevel: 9,
  }));
  assert.notEqual(otherTenant.id, uploaded.id);
  await expectStorageCode(
    fixture.images.get({ ...auth(TENANT_B), objectId: uploaded.id }),
    'NOT_FOUND',
  );
});

test('rejects mismatched MIME, active metadata, corrupt data and pixel bombs', async t => {
  const fixture = await setup({
    imageLimits: { maxPixels: 16, maxInputBytes: 1024, maxInFlightBytes: 2048 },
  });
  t.after(fixture.dispose);

  await expectImageCode(fixture.images.upload(uploadInput({
    contentType: 'image/jpeg',
  })), 'CONTENT_TYPE_MISMATCH');
  await expectImageCode(fixture.images.upload(uploadInput({
    stream: Readable.from([Buffer.from('<svg onload="alert(1)"/>')]),
  })), 'INVALID_IMAGE');
  await expectImageCode(fixture.images.upload(uploadInput({
    stream: Readable.from([png(1, 1, { extra: [['eXIf', Buffer.from('metadata')]] })]),
  })), 'UNSUPPORTED_FORMAT');
  await expectImageCode(fixture.images.upload(uploadInput({
    stream: Readable.from([pngWithDeclaredDimensions(4096, 4096)]),
  })), 'PIXEL_LIMIT');

  const corrupt = png(1, 1);
  corrupt[corrupt.length - 5] ^= 0xff;
  await expectImageCode(fixture.images.upload(uploadInput({
    stream: Readable.from([corrupt]),
  })), 'INVALID_IMAGE');
  assert.deepEqual(await fixture.images.list(auth()), []);
});

test('creates bounded thumbnails and tenant-checked carousel metadata', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);

  const first = await fixture.images.upload(uploadInput({
    stream: Readable.from([png(4, 4)]),
  }));
  const second = await fixture.images.createThumbnail({
    ...auth(),
    objectId: first.id,
    width: 2,
    height: 2,
  });
  assert.equal(second.width, 2);
  assert.equal(second.height, 2);
  assert.equal(second.sourceId, first.id);

  const carousel = await fixture.images.createCarousel({
    ...auth(),
    imageIds: [first.id, second.id],
    activeIndex: 1,
  });
  assert.deepEqual(carousel.items.map(item => [item.width, item.height]), [[4, 4], [2, 2]]);
  assert.equal(carousel.activeIndex, 1);
  assert.equal(carousel.previousIndex, 0);
  assert.equal(carousel.nextIndex, null);
  await expectImageCode(fixture.images.createCarousel({
    ...auth(TENANT_B),
    imageIds: [first.id],
  }), 'IMAGE_NOT_FOUND');
  await expectImageCode(fixture.images.createCarousel({
    ...auth(),
    imageIds: [first.id, first.id],
  }), 'INVALID_INPUT');
  assert.deepEqual(await fixture.images.delete({ ...auth(), objectId: second.id }), { deleted: true });
});

test('enforces input, memory and concurrency budgets and rejects unsafe API inputs', async t => {
  const fixture = await setup({
    imageLimits: {
      maxInputBytes: 64,
      maxOutputBytes: 64,
      maxPixels: 4,
      maxDimension: 4,
      maxInFlightBytes: 128,
      maxConcurrentUploads: 2,
      maxWorkingBytes: 1024,
    },
  });
  t.after(fixture.dispose);

  await expectImageCode(fixture.images.upload(uploadInput({
    stream: Readable.from([Buffer.alloc(65)]),
  })), 'IMAGE_TOO_LARGE');
  await expectImageCode(fixture.images.upload(uploadInput({ unexpected: true })), 'INVALID_INPUT');
  const unsafe = uploadInput();
  Object.defineProperty(unsafe, 'fileName', {
    enumerable: true,
    get() {
      throw new Error('must not evaluate getters');
    },
  });
  await expectImageCode(fixture.images.upload(unsafe), 'INVALID_INPUT');
  await assert.rejects(fixture.images.upload(uploadInput({
    fileName: '../escape.png',
  })), error => error instanceof ImagesError && error.code === 'INVALID_INPUT');
});

test('fails closed on missing private storage capabilities and invalid limits', async () => {
  await assert.rejects(createImageService({ storage: {} }), error =>
    error instanceof ImagesError && error.code === 'INVALID_CONFIGURATION');
  const fixture = await setup();
  await fixture.dispose();
  await assert.rejects(createImageService({
    storage: fixture.storage,
    limits: { maxPixels: 0 },
  }), error => error instanceof ImagesError && error.code === 'INVALID_CONFIGURATION');
});

test('reserves the processing memory budget before consuming concurrent uploads', async t => {
  const fixture = await setup({
    imageLimits: {
      maxInputBytes: 256,
      maxOutputBytes: 256,
      maxPixels: 4,
      maxDimension: 4,
      maxWorkingBytes: 640,
      maxInFlightBytes: 512,
      maxConcurrentUploads: 2,
    },
  });
  t.after(fixture.dispose);
  const pending = new PassThrough();
  const firstUpload = fixture.images.upload(uploadInput({ stream: pending }));
  await new Promise(resolve => setImmediate(resolve));
  await expectImageCode(fixture.images.upload(uploadInput()), 'IMAGE_BUSY');
  pending.end(png(1, 1));
  assert.equal((await firstUpload).width, 1);
});
