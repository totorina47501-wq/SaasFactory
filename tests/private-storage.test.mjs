import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPrivateStorageService,
  createStorageRetentionHandler,
  PrivateStorageError,
  privateStorageContract,
} from '../modules/private-storage/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'request-1',
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
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32([name, data]), 8 + data.length);
  return chunk;
}

function png({ red = 12, extra = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...extra.map(([type, data]) => pngChunk(type, data)),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, 20, 30, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function tenancy() {
  return {
    async resolveTenantContext(input) {
      const tenantId = input.cookieHeader === 'tenant-a' ? TENANT_A :
        input.cookieHeader === 'tenant-b' ? TENANT_B : null;
      if (!tenantId || input.tenantId !== tenantId) throw new Error('denied');
      return { contractVersion: 1, tenantId, requestId: input.requestId };
    },
  };
}

async function setup({ limits = {}, clock = () => Date.now() } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'sf-private-storage-'));
  await chmod(parent, 0o700);
  const directory = path.join(parent, 'storage');
  const events = [];
  const service = await createPrivateStorageService({
    directory,
    tenancy: tenancy(),
    audit: {
      async append(context, event) {
        events.push({ context, event });
      },
    },
    limits,
    clock,
  });
  return {
    parent,
    directory,
    service,
    events,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function uploadInput(overrides = {}) {
  return {
    ...auth(),
    fileName: 'profile.png',
    contentType: 'image/png',
    stream: Readable.from([png()]),
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof PrivateStorageError && error.code === code);
}

test('streams validated PNGs into private tenant-isolated storage with tenant-only deduplication', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);

  const first = await fixture.service.upload(uploadInput());
  const duplicate = await fixture.service.upload(uploadInput());
  const otherTenant = await fixture.service.upload(uploadInput({
    ...auth(TENANT_B),
    fileName: 'different-name.png',
  }));
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.id, first.id);
  assert.equal(otherTenant.deduplicated, false);
  assert.notEqual(otherTenant.id, first.id);
  assert.equal(Object.hasOwn(first, 'sha256'), false);
  assert.equal(privateStorageContract.deduplicationScope, 'tenant-only');
  assert.equal((await lstat(fixture.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(fixture.directory, 'objects', TENANT_A))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(fixture.directory, 'objects', TENANT_A, `${first.id}.png`))).mode & 0o777, 0o600);
  assert.deepEqual((await fixture.service.list(auth())).map(item => item.id), [first.id]);
  assert.deepEqual((await fixture.service.list(auth(TENANT_B))).map(item => item.id), [otherTenant.id]);

  const exported = await fixture.service.export({ ...auth(), objectId: first.id });
  const chunks = [];
  for await (const chunk of exported.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), png());
  assert.equal(exported.headers['Content-Type'], 'image/png');
  assert.equal(exported.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(exported.headers['Content-Disposition'], new RegExp(first.id, 'u'));
  await expectCode(fixture.service.export({ ...auth(TENANT_B), objectId: first.id }), 'NOT_FOUND');
  assert.ok(fixture.events.every(({ event }) =>
    !Object.hasOwn(event, 'sha256') && !Object.hasOwn(event, 'fileName')));
});

test('rejects invalid tenant access, unsafe names, symlinked storage, and unknown inputs', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);

  await expectCode(fixture.service.upload(uploadInput({
    ...auth(TENANT_B),
    cookieHeader: 'tenant-a',
  })), 'TENANT_ACCESS_DENIED');
  await expectCode(fixture.service.upload(uploadInput({ fileName: '../escape.png' })), 'INVALID_FILENAME');
  await expectCode(fixture.service.upload(uploadInput({ fileName: 'safe／escape.png' })), 'INVALID_FILENAME');
  await expectCode(fixture.service.upload(uploadInput({ unexpected: true })), 'INVALID_INPUT');
  assert.deepEqual(await fixture.service.list(auth()), []);

  const accessorInput = uploadInput();
  let accessed = false;
  Object.defineProperty(accessorInput, 'fileName', {
    enumerable: true,
    get() {
      accessed = true;
      return 'profile.png';
    },
  });
  await expectCode(fixture.service.upload(accessorInput), 'INVALID_INPUT');
  assert.equal(accessed, false);

  const root = path.join(fixture.parent, 'linked-storage');
  await symlink(fixture.directory, root);
  await assert.rejects(createPrivateStorageService({
    directory: root,
    tenancy: tenancy(),
    audit: { append: async () => {} },
  }), error => error instanceof PrivateStorageError && error.code === 'INVALID_PATH');
});

test('rejects archives, malformed PNGs, active chunks, and client MIME mismatches into quarantine', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from('synthetic archive')]);
  const corrupt = png();
  corrupt[corrupt.length - 5] ^= 0xff;

  await expectCode(fixture.service.upload(uploadInput({
    stream: Readable.from([archive]),
    fileName: 'archive.png',
  })), 'INVALID_FILE');
  await expectCode(fixture.service.upload(uploadInput({
    stream: Readable.from([corrupt]),
  })), 'INVALID_FILE');
  await expectCode(fixture.service.upload(uploadInput({
    stream: Readable.from([png({ extra: [['tEXt', Buffer.from('Comment\\0active')]] })]),
  })), 'INVALID_FILE');
  await expectCode(fixture.service.upload(uploadInput({
    contentType: 'image/jpeg',
  })), 'CONTENT_TYPE_MISMATCH');

  assert.deepEqual(await fixture.service.list(auth()), []);
  const quarantined = await import('node:fs/promises').then(({ readdir }) =>
    readdir(path.join(fixture.directory, 'quarantine')));
  assert.equal(quarantined.length, 4);
  assert.ok(quarantined.every(name => name.endsWith('.quarantine')));
});

test('enforces tenant quotas, preserves integrity checks, and deletes only authorized objects', async t => {
  const fixture = await setup({
    limits: {
      maxUploadBytes: 1024,
      maxTenantBytes: 1024,
      maxTenantFiles: 1,
      maxStorageBytes: 2048,
      maxStorageFiles: 2,
      maxTemporaryBytes: 1024,
    },
  });
  t.after(fixture.dispose);
  const item = await fixture.service.upload(uploadInput());
  await expectCode(fixture.service.upload(uploadInput({
    stream: Readable.from([png({ red: 13 })]),
  })), 'QUOTA_EXCEEDED');
  await expectCode(fixture.service.delete({ ...auth(TENANT_B), objectId: item.id }), 'NOT_FOUND');

  const storedPath = path.join(fixture.directory, 'objects', TENANT_A, `${item.id}.png`);
  const corrupted = await readFile(storedPath);
  corrupted[corrupted.length - 1] ^= 0xff;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(storedPath, corrupted, { mode: 0o600 });
  await expectCode(fixture.service.export({ ...auth(), objectId: item.id }), 'CORRUPT_STORAGE');

  const result = await fixture.service.delete({ ...auth(), objectId: item.id });
  assert.deepEqual(result, { deleted: true });
  assert.deepEqual(await fixture.service.list(auth()), []);
});

test('cleans cancelled uploads and runs tenant-scoped expiry through the jobs adapter', async t => {
  let now = 1000;
  const fixture = await setup({
    clock: () => now,
    limits: {
      retentionMs: 1000,
      temporaryTtlMs: 5000,
      uploadTimeoutMs: 1000,
    },
  });
  t.after(fixture.dispose);

  const source = new PassThrough();
  const controller = new AbortController();
  const interruptedUpload = fixture.service.upload(uploadInput({
    stream: source,
    signal: controller.signal,
  }));
  await new Promise(resolve => setImmediate(resolve));
  source.write(png().subarray(0, 20));
  controller.abort();
  await expectCode(interruptedUpload, 'INTERRUPTED');
  assert.deepEqual(await (await import('node:fs/promises'))
    .readdir(path.join(fixture.directory, 'temporary')), []);

  const item = await fixture.service.upload(uploadInput());
  const otherTenantItem = await fixture.service.upload(uploadInput({
    ...auth(TENANT_B),
    fileName: 'other-tenant.png',
  }));
  now += 1000;
  const runRetention = createStorageRetentionHandler(fixture.service);
  const otherTenantResult = await runRetention({
    tenantContext: { contractVersion: 1, tenantId: TENANT_B, requestId: 'request-1' },
  });
  assert.equal(otherTenantResult.deletedCount, 1);
  assert.deepEqual((await fixture.service.list(auth())).map(entry => entry.id), [item.id]);
  await expectCode(fixture.service.export({ ...auth(TENANT_B), objectId: otherTenantItem.id }), 'NOT_FOUND');
  const result = await runRetention({
    tenantContext: { contractVersion: 1, tenantId: TENANT_A, requestId: 'request-1' },
  });
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(await fixture.service.list(auth()), []);
  await expectCode(fixture.service.export({ ...auth(), objectId: item.id }), 'NOT_FOUND');
});

test('reserves bounded temporary capacity across concurrent uploads and releases it', async t => {
  const limits = {
    maxUploadBytes: 1024,
    maxTenantBytes: 4096,
    maxStorageBytes: 4096,
    maxTemporaryBytes: 1024,
    maxConcurrentUploads: 1,
    temporaryTtlMs: 5000,
    uploadTimeoutMs: 1000,
  };
  const fixture = await setup({
    limits,
  });
  t.after(fixture.dispose);
  const secondService = await createPrivateStorageService({
    directory: fixture.directory,
    tenancy: tenancy(),
    audit: { append: async () => {} },
    limits,
  });
  const source = new PassThrough();
  const firstUpload = fixture.service.upload(uploadInput({ stream: source }));
  const temporaryDirectory = path.join(fixture.directory, 'temporary');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readdir(temporaryDirectory)).some(name => name.endsWith('.permit'))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok((await readdir(temporaryDirectory)).some(name => name.endsWith('.permit')));
  await expectCode(secondService.upload(uploadInput()), 'UPLOAD_BUSY');

  source.end(png());
  const uploaded = await firstUpload;
  assert.equal(uploaded.deduplicated, false);
  assert.deepEqual(await readdir(temporaryDirectory), []);
  await expectCode(secondService.upload(uploadInput({
    stream: Readable.from(['é'.repeat(600)]),
  })), 'INVALID_INPUT');
  assert.deepEqual(await readdir(temporaryDirectory), []);
  await expectCode(secondService.upload(uploadInput({
    stream: Readable.from([Buffer.alloc(1025)]),
  })), 'FILE_TOO_LARGE');
  assert.deepEqual(await readdir(temporaryDirectory), []);
});

test('cleans abandoned private temporary and quarantine files without following symlinks', async t => {
  let now = Date.now();
  const fixture = await setup({
    clock: () => now,
    limits: { temporaryTtlMs: 5000, quarantineTtlMs: 5000, uploadTimeoutMs: 1000 },
  });
  t.after(fixture.dispose);

  const { writeFile } = await import('node:fs/promises');
  const outside = path.join(fixture.parent, 'outside');
  const linkedTemporary = path.join(fixture.directory, 'temporary', `${randomUUID()}.upload`);
  await writeFile(outside, 'outside', { mode: 0o600 });
  await symlink(outside, linkedTemporary);
  await expectCode(fixture.service.purgeExpired(auth()), 'UNSAFE_STORAGE');
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  await rm(linkedTemporary);

  const temporary = path.join(fixture.directory, 'temporary', `${randomUUID()}.upload`);
  const quarantined = path.join(fixture.directory, 'quarantine', `${randomUUID()}.quarantine`);
  await writeFile(temporary, 'partial', { mode: 0o600 });
  await writeFile(quarantined, 'rejected', { mode: 0o600 });
  const old = new Date(now - 6000);
  await utimes(temporary, old, old);
  await utimes(quarantined, old, old);
  now += 1;

  const result = await fixture.service.purgeExpired(auth());
  assert.equal(result.cleanedTemporaryFiles, 2);
  await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  await assert.rejects(lstat(quarantined), { code: 'ENOENT' });
});

test('fails closed on a corrupt metadata index and a missing audit sink', async t => {
  const fixture = await setup();
  t.after(fixture.dispose);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(fixture.directory, 'metadata-v1.json'), '{}');
  await chmod(path.join(fixture.directory, 'metadata-v1.json'), 0o600);
  await expectCode(fixture.service.list(auth()), 'CORRUPT_INDEX');

  await assert.rejects(createPrivateStorageService({
    directory: path.join(fixture.parent, 'no-audit'),
    tenancy: tenancy(),
  }), error => error instanceof PrivateStorageError && error.code === 'INVALID_INPUT');
});
