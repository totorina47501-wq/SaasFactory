import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createVideoService,
  VideoModuleError,
  videoContract,
} from '../modules/video/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const wav = Buffer.concat([Buffer.from('RIFF0000WAVEfmt ', 'ascii'), Buffer.alloc(40)]);
const normalProbe = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'video-request-1',
});

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

function fakeEngine(pathName, {
  output = '',
  audioOutput,
  errorCode = 0,
  delayMs = 0,
  checkArgs,
} = {}) {
  const encodedOutput = Buffer.from(output).toString('base64');
  const encodedAudioOutput = Buffer.from(audioOutput ?? output).toString('base64');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
${checkArgs ?? ''}
setTimeout(() => {
  const output = args.includes('0:a:0') ? ${JSON.stringify(encodedAudioOutput)} : ${JSON.stringify(encodedOutput)};
  process.stdout.write(Buffer.from(output, 'base64'));
  process.exit(${errorCode});
}, ${delayMs});
`;
  return writeFile(pathName, script, { mode: 0o700 }).then(() => chmod(pathName, 0o700));
}

async function setup(t, {
  probe = normalProbe,
  ffmpegOutput = png,
  ffprobeError = 0,
  ffmpegError = 0,
  ffprobeDelayMs = 0,
  ffmpegDelayMs = 0,
  limits = {},
  clock = () => Date.now(),
} = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'sf-video-'));
  await chmod(parent, 0o700);
  const directory = path.join(parent, 'video');
  const ffprobePath = path.join(parent, 'ffprobe-fake');
  const ffmpegPath = path.join(parent, 'ffmpeg-fake');
  await Promise.all([
    fakeEngine(ffprobePath, {
      output: Buffer.from(JSON.stringify(probe)),
      errorCode: ffprobeError,
      delayMs: ffprobeDelayMs,
      checkArgs: `if (args.length !== 9 || args[0] !== '-v' || args[1] !== 'error' ||
  args[2] !== '-show_entries' || args[4] !== '-of' || args[5] !== 'json' ||
  args[6] !== '-protocol_whitelist' || args[7] !== 'file,pipe' ||
  !args[8].endsWith('.input')) process.exit(21);`,
    }),
    fakeEngine(ffmpegPath, {
      output: ffmpegOutput,
      audioOutput: wav,
      errorCode: ffmpegError,
      delayMs: ffmpegDelayMs,
      checkArgs: `if (!args.includes('-nostdin') || args.includes('-y') || args.includes('-f')) {
  if (!args.includes('-f') || !args.includes('pipe:1')) process.exit(22);
}
if (args.filter(argument => argument === '-threads').length !== 2) process.exit(23);`,
    }),
  ]);
  const events = [];
  const service = await createVideoService({
    directory,
    tenancy: tenancy(),
    audit: { async append(context, event) { events.push({ context, event }); } },
    ffprobePath,
    ffmpegPath,
    limits,
    clock,
  });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, directory, service, events, ffprobePath, ffmpegPath };
}

function syntheticMp4() {
  const data = Buffer.alloc(64);
  data.writeUInt32BE(16, 0);
  data.write('ftyp', 4, 'ascii');
  data.write('isom', 8, 'ascii');
  data.writeUInt32BE(48, 16);
  data.write('mdat', 20, 'ascii');
  for (let index = 24; index < data.length; index += 1) data[index] = index;
  return data;
}

function ingestInput(overrides = {}) {
  return {
    ...auth(),
    consent: true,
    video: syntheticMp4(),
    ...overrides,
  };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof VideoModuleError && error.code === code);
}

test('probes opt-in local media and creates tenant-isolated frames, thumbnails, and audio', async t => {
  const fixture = await setup(t);
  assert.equal(videoContract.contractVersion, 1);
  assert.equal(videoContract.processing, 'explicit-opt-in-only');
  assert.equal((await readdir(path.join(fixture.directory, 'temporary'))).length, 0);

  const video = await fixture.service.ingest(ingestInput());
  assert.equal(video.mimeType, 'video/mp4');
  assert.equal(video.durationSeconds, 12.5);
  assert.deepEqual([video.width, video.height, video.videoCodec], [1920, 1080, 'h264']);
  assert.equal(video.audioAvailable, true);

  const frame = await fixture.service.frame({ ...auth(), videoId: video.id, atSeconds: 1 });
  const thumbnail = await fixture.service.thumbnail({
    ...auth(), videoId: video.id, atSeconds: 2, width: 160,
  });
  const audio = await fixture.service.extractAudio({ ...auth(), videoId: video.id });
  assert.deepEqual([frame.kind, thumbnail.kind, audio.kind], ['frame', 'thumbnail', 'audio']);
  assert.equal(frame.contentType, 'image/png');
  assert.equal(audio.contentType, 'audio/wav');
  assert.match(frame.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual((await fixture.service.readArtifact({ ...auth(), artifactId: audio.id })).data, wav);
  await expectCode(fixture.service.readArtifact({
    ...auth(TENANT_B), artifactId: frame.id,
  }), 'NOT_FOUND');
  assert.ok(fixture.events.every(({ event }) =>
    !Object.hasOwn(event, 'sha256') && !Object.hasOwn(event, 'videoId')));
  assert.equal((await lstat(path.join(fixture.directory, 'sources', TENANT_A))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(fixture.directory, 'sources', TENANT_A, `${video.id}.source`))).mode & 0o777, 0o600);
});

test('requires explicit consent and rejects invalid input before invoking FFprobe', async t => {
  const fixture = await setup(t);
  await expectCode(fixture.service.ingest(ingestInput({ consent: false })), 'CONSENT_REQUIRED');
  const bounded = await setup(t, { limits: { maxInputBytes: 1024 } });
  await expectCode(bounded.service.ingest(ingestInput({ video: Buffer.alloc(1025) })), 'FILE_TOO_LARGE');
  await expectCode(fixture.service.ingest(ingestInput({ unexpected: true })), 'INVALID_INPUT');
  assert.deepEqual(await readdir(path.join(fixture.directory, 'temporary')), []);
});

test('rejects excessive duration or resolution and codecs outside the allowlist', async t => {
  for (const [probe, limits, code] of [
    [{ ...normalProbe, format: { ...normalProbe.format, duration: '61' } },
      { maxDurationSeconds: 60 }, 'DURATION_LIMIT'],
    [{ ...normalProbe, streams: [{ ...normalProbe.streams[0], width: 4096 }, normalProbe.streams[1]] },
      { maxWidth: 3840 }, 'RESOLUTION_LIMIT'],
    [{ ...normalProbe, streams: [{ ...normalProbe.streams[0], codec_name: 'prores' }, normalProbe.streams[1]] },
      {}, 'UNSUPPORTED_CODEC'],
    [{ ...normalProbe, format: { format_name: 'avi', duration: '12.5' } },
      {}, 'UNSUPPORTED_CONTAINER'],
  ]) {
    const fixture = await setup(t, { probe, limits });
    await expectCode(fixture.service.ingest(ingestInput()), code);
    assert.deepEqual(await readdir(path.join(fixture.directory, 'temporary')), []);
    assert.deepEqual(await readdir(path.join(fixture.directory, 'sources', TENANT_A)), []);
  }
});

test('fails closed on unavailable engines, invalid engine output, cancellation, and timeout', async t => {
  const probeFailure = await setup(t, { ffprobeError: 1 });
  await expectCode(probeFailure.service.ingest(ingestInput()), 'ENGINE_FAILED');
  assert.deepEqual(await readdir(path.join(probeFailure.directory, 'temporary')), []);

  const outputFailure = await setup(t, { ffmpegError: 1 });
  const video = await outputFailure.service.ingest(ingestInput());
  await expectCode(outputFailure.service.frame({ ...auth(), videoId: video.id, atSeconds: 1 }),
    'ENGINE_FAILED');
  assert.deepEqual(await readdir(path.join(outputFailure.directory, 'temporary')), []);

  const invalidOutput = await setup(t, { ffmpegOutput: Buffer.from('not a png') });
  const invalidVideo = await invalidOutput.service.ingest(ingestInput());
  await expectCode(invalidOutput.service.frame({
    ...auth(), videoId: invalidVideo.id, atSeconds: 1,
  }), 'INVALID_ENGINE_OUTPUT');

  const timeout = await setup(t, {
    ffmpegDelayMs: 200,
    limits: { jobTimeoutMs: 50, temporaryTtlMs: 1000 },
  });
  const timedVideo = await timeout.service.ingest(ingestInput());
  await expectCode(timeout.service.frame({ ...auth(), videoId: timedVideo.id, atSeconds: 1 }),
    'ENGINE_TIMEOUT');

  const cancelled = new AbortController();
  cancelled.abort();
  await expectCode(timeout.service.thumbnail({
    ...auth(), videoId: timedVideo.id, atSeconds: 1, signal: cancelled.signal,
  }), 'INTERRUPTED');

  const outputLimit = await setup(t, {
    limits: { maxOutputBytes: 8 },
  });
  const boundedVideo = await outputLimit.service.ingest(ingestInput());
  await expectCode(outputLimit.service.frame({
    ...auth(), videoId: boundedVideo.id, atSeconds: 1,
  }), 'OUTPUT_TOO_LARGE');
});

test('enforces job and storage quotas and removes expired media and artifacts', async t => {
  let now = 1000;
  const fixture = await setup(t, {
    clock: () => now,
    limits: { retentionMs: 1000, maxTenantFiles: 2 },
  });
  const video = await fixture.service.ingest(ingestInput());
  const artifact = await fixture.service.frame({ ...auth(), videoId: video.id, atSeconds: 1 });
  const overQuota = await setup(t, { limits: { maxTenantFiles: 1 } });
  const limitedVideo = await overQuota.service.ingest(ingestInput());
  await expectCode(overQuota.service.frame({
    ...auth(), videoId: limitedVideo.id, atSeconds: 1,
  }), 'QUOTA_EXCEEDED');
  assert.deepEqual(await readdir(path.join(overQuota.directory, 'temporary')), []);
  now += 1000;
  const expired = await fixture.service.purgeExpired(auth());
  assert.deepEqual(expired, { deletedVideos: 1, deletedArtifacts: 1, cleanedTemporaryFiles: 0 });
  await expectCode(fixture.service.frame({ ...auth(), videoId: video.id, atSeconds: 1 }),
    'NOT_FOUND');
  await expectCode(fixture.service.readArtifact({ ...auth(), artifactId: artifact.id }), 'NOT_FOUND');
});

test('bounds concurrent media jobs and removes stale temporary files', async t => {
  const fixture = await setup(t, {
    ffmpegDelayMs: 100,
    limits: { maxConcurrentJobs: 1 },
  });
  const video = await fixture.service.ingest(ingestInput());
  const first = fixture.service.frame({ ...auth(), videoId: video.id, atSeconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await expectCode(fixture.service.thumbnail({
    ...auth(), videoId: video.id, atSeconds: 1,
  }), 'JOB_LIMIT');
  await first;

  const stale = path.join(fixture.directory, 'temporary', `${randomUUID()}.output`);
  await writeFile(stale, 'stale', { mode: 0o600 });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  const cleaned = await fixture.service.purgeExpired(auth());
  assert.equal(cleaned.cleanedTemporaryFiles, 1);
  await assert.rejects(lstat(stale), { code: 'ENOENT' });
});

test('rejects unauthorized tenants and unsafe storage paths', async t => {
  const fixture = await setup(t);
  await expectCode(fixture.service.ingest(ingestInput({
    ...auth(TENANT_B), cookieHeader: 'tenant-a',
  })), 'TENANT_ACCESS_DENIED');

  const outside = path.join(fixture.parent, 'outside');
  const linkedDirectory = path.join(fixture.parent, 'linked');
  await writeFile(outside, 'private');
  await symlink(outside, linkedDirectory);
  await assert.rejects(createVideoService({
    directory: linkedDirectory,
    tenancy: tenancy(),
    audit: { append: async () => {} },
  }), error => error instanceof VideoModuleError && error.code === 'INVALID_PATH');
});

test('verifies source hashes before processing stored media', async t => {
  const fixture = await setup(t);
  const video = await fixture.service.ingest(ingestInput());
  const sourcePath = path.join(fixture.directory, 'sources', TENANT_A, `${video.id}.source`);
  const tampered = await readFile(sourcePath);
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(sourcePath, tampered, { mode: 0o600 });
  await expectCode(fixture.service.frame({
    ...auth(), videoId: video.id, atSeconds: 1,
  }), 'CORRUPT_STORAGE');
});

test('cancellation during artifact persistence removes unpublished output', async t => {
  const controller = new AbortController();
  let clockCalls = 0;
  const fixture = await setup(t, {
    clock: () => {
      clockCalls += 1;
      if (clockCalls === 3) controller.abort();
      return 1000;
    },
  });
  const video = await fixture.service.ingest(ingestInput());
  await expectCode(fixture.service.frame({
    ...auth(), videoId: video.id, atSeconds: 1, signal: controller.signal,
  }), 'INTERRUPTED');
  assert.deepEqual(await readdir(path.join(fixture.directory, 'artifacts', TENANT_A)), []);
  assert.deepEqual(await readdir(path.join(fixture.directory, 'temporary')), []);
});
