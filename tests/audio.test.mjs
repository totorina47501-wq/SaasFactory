import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  audioContract,
  AudioModuleError,
  createAudioService,
} from '../modules/audio/index.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const wav = Buffer.alloc(128);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVE', 8, 'ascii');
const normalProbe = {
  format: { format_name: 'wav', duration: '12.5', bit_rate: '256000' },
  streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 }],
};

const auth = (tenantId = TENANT_A) => ({
  cookieHeader: tenantId === TENANT_A ? 'tenant-a' : 'tenant-b',
  tenantId,
  requestId: 'audio-request-1',
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

async function fakeEngine(pathName, { output = '', errorCode = 0, delayMs = 0, checkArgs = '' } = {}) {
  const encoded = Buffer.from(output).toString('base64');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
${checkArgs}
setTimeout(() => {
  process.stdout.write(Buffer.from(${JSON.stringify(encoded)}, 'base64'));
  process.exit(${errorCode});
}, ${delayMs});
`;
  await writeFile(pathName, script, { mode: 0o700 });
  await chmod(pathName, 0o700);
}

async function setup(t, {
  probe = normalProbe,
  probeError = 0,
  ffmpegOutput = wav,
  ffmpegError = 0,
  limits = {},
  clock = () => Date.now(),
  ffprobePath,
  videoService,
} = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'sf-audio-'));
  await chmod(parent, 0o700);
  const directory = path.join(parent, 'audio');
  const probePath = ffprobePath ?? path.join(parent, 'ffprobe-fake');
  const ffmpegPath = path.join(parent, 'ffmpeg-fake');
  if (!ffprobePath) {
    await fakeEngine(probePath, {
      output: JSON.stringify(probe),
      errorCode: probeError,
      checkArgs: `if (args.length !== 9 || args[0] !== '-v' || args[1] !== 'error' ||
  args[2] !== '-show_entries' || args[4] !== '-of' || args[5] !== 'json' ||
  args[6] !== '-protocol_whitelist' || args[7] !== 'file,pipe' ||
  !args[8].endsWith('.input')) process.exit(21);`,
    });
  }
  await fakeEngine(ffmpegPath, {
    output: ffmpegOutput,
    errorCode: ffmpegError,
    checkArgs: `if (!args.includes('-nostdin') || args.includes('-y') ||
  !args.includes('-protocol_whitelist') || !args.includes('file,pipe') ||
  !args.includes('pipe:1')) process.exit(22);`,
  });
  const events = [];
  const service = await createAudioService({
    directory,
    tenancy: tenancy(),
    audit: { async append(context, event) { events.push({ context, event }); } },
    ffprobePath: probePath,
    ffmpegPath,
    videoService,
    limits,
    clock,
  });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, directory, service, events, ffprobePath: probePath, ffmpegPath };
}

function ingestInput(overrides = {}) {
  return { ...auth(), consent: true, audio: wav, ...overrides };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof AudioModuleError && error.code === code);
}

async function ingested(service, overrides = {}) {
  return service.ingest(ingestInput(overrides));
}

test('validates and stores explicitly allowlisted local audio with probed metadata', async t => {
  const fixture = await setup(t);
  assert.equal(audioContract.contractVersion, 1);
  assert.deepEqual(audioContract.supportedContainers, ['wav', 'mp3', 'flac', 'ogg', 'm4a']);
  const result = await ingested(fixture.service);
  assert.deepEqual(
    [result.mimeType, result.container, result.durationSeconds, result.codec, result.sampleRate, result.channels],
    ['audio/wav', 'wav', 12.5, 'pcm_s16le', 16000, 1],
  );
  assert.equal(result.bitRate, 256000);
  assert.equal((await fixture.service.readAudio({ ...auth(), audioId: result.id })).contentType, 'audio/wav');
  assert.equal((await lstat(path.join(fixture.directory, 'sources', TENANT_A, `${result.id}.source`))).mode & 0o777, 0o600);
  assert.ok(fixture.events.every(({ event }) => !Object.hasOwn(event, 'sha256')));
  await expectCode(fixture.service.readAudio({ ...auth(TENANT_B), audioId: result.id }), 'NOT_FOUND');
});

test('accepts each additional audio container only when its signature, probe format, and codec agree', async t => {
  const examples = [
    {
      container: 'mp3',
      data: Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0]),
      format: 'mp3',
      codec: 'mp3',
      mime: 'audio/mpeg',
    },
    { container: 'flac', data: Buffer.from('fLaC synthetic flac'), format: 'flac', codec: 'flac', mime: 'audio/flac' },
    { container: 'ogg', data: Buffer.from('OggS synthetic ogg'), format: 'ogg', codec: 'vorbis', mime: 'audio/ogg' },
    { container: 'm4a', data: Buffer.from('0000ftypM4A synthetic'), format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', mime: 'audio/mp4' },
  ];
  for (const example of examples) {
    const fixture = await setup(t, {
      probe: {
        format: { format_name: example.format, duration: '3.5' },
        streams: [{ codec_type: 'audio', codec_name: example.codec, sample_rate: '44100', channels: 2 }],
      },
    });
    const item = await ingested(fixture.service, { audio: example.data });
    assert.deepEqual([item.container, item.mimeType], [example.container, example.mime]);
  }
});

test('requires consent, rejects unknown fields, invalid signatures, and configured size limits', async t => {
  const fixture = await setup(t, { limits: { maxInputBytes: 1024 } });
  await expectCode(fixture.service.ingest(ingestInput({ consent: false })), 'CONSENT_REQUIRED');
  await expectCode(fixture.service.ingest(ingestInput({ unknown: true })), 'INVALID_INPUT');
  await expectCode(fixture.service.ingest(ingestInput({ audio: Buffer.from('not audio data') })), 'INVALID_MEDIA');
  await expectCode(fixture.service.ingest(ingestInput({ audio: Buffer.concat([wav, Buffer.alloc(1024)]) })), 'FILE_TOO_LARGE');
  assert.deepEqual(await readdir(path.join(fixture.directory, 'temporary')), []);
});

test('rejects probe metadata outside duration, container, codec, and channel policies', async t => {
  for (const [probe, limits, code] of [
    [{ ...normalProbe, format: { ...normalProbe.format, duration: '61' } }, { maxDurationSeconds: 60 }, 'DURATION_LIMIT'],
    [{ ...normalProbe, format: { ...normalProbe.format, format_name: 'avi' } }, {}, 'UNSUPPORTED_CONTAINER'],
    [{ ...normalProbe, streams: [{ ...normalProbe.streams[0], codec_name: 'mp3' }] }, {}, 'UNSUPPORTED_CODEC'],
    [{ ...normalProbe, streams: [{ ...normalProbe.streams[0], channels: 9 }] }, {}, 'INVALID_MEDIA'],
    [{ ...normalProbe, streams: [{ ...normalProbe.streams[0], codec_type: 'video' }] }, {}, 'UNSUPPORTED_CODEC'],
  ]) {
    const fixture = await setup(t, { probe, limits });
    await expectCode(ingested(fixture.service), code);
    assert.deepEqual(await readdir(path.join(fixture.directory, 'sources', TENANT_A)), []);
  }
});

test('fails closed when ffprobe or ffmpeg is unavailable or fails', async t => {
  const missing = await setup(t, { ffprobePath: path.join(tmpdir(), 'missing-ffprobe-for-audio-test') });
  await expectCode(ingested(missing.service), 'ENGINE_UNAVAILABLE');
  assert.deepEqual(await readdir(path.join(missing.directory, 'temporary')), []);

  const failedProbe = await setup(t, { probeError: 1 });
  await expectCode(ingested(failedProbe.service), 'ENGINE_FAILED');

  const failedConversion = await setup(t, { ffmpegError: 1 });
  const audio = await ingested(failedConversion.service);
  await expectCode(failedConversion.service.normalize({ ...auth(), audioId: audio.id }), 'ENGINE_FAILED');
  assert.deepEqual(await readdir(path.join(failedConversion.directory, 'temporary')), []);
});

test('normalizes to bounded mono PCM and can reuse the video module audio artifact', async t => {
  const fixture = await setup(t);
  const audio = await ingested(fixture.service);
  const normalized = await fixture.service.normalize({ ...auth(), audioId: audio.id });
  assert.deepEqual([normalized.contentType, normalized.sampleRate, normalized.channels], ['audio/wav', 16000, 1]);
  assert.deepEqual(
    (await fixture.service.readAudio({ ...auth(), audioId: audio.id, normalized: true })).data,
    wav,
  );
  const normalizedPath = path.join(fixture.directory, 'sources', TENANT_A, `${audio.id}.normalized.wav`);
  const tampered = await readFile(normalizedPath);
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(normalizedPath, tampered, { mode: 0o600 });
  await expectCode(fixture.service.readAudio({
    ...auth(), audioId: audio.id, normalized: true,
  }), 'CORRUPT_STORAGE');
  await expectCode(fixture.service.normalize({ ...auth(), audioId: audio.id }), 'ALREADY_NORMALIZED');

  const calls = [];
  const videoService = {
    async extractAudio(input) {
      calls.push(['extract', input.videoId]);
      return { id: '33333333-3333-4333-8333-333333333333', contentType: 'audio/wav' };
    },
    async readArtifact(input) {
      calls.push(['read', input.artifactId]);
      return { contentType: 'audio/wav', data: wav };
    },
  };
  const importing = await setup(t, { videoService });
  const imported = await importing.service.ingestVideoAudio({
    ...auth(), consent: true, videoId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(imported.mimeType, 'audio/wav');
  assert.deepEqual(calls, [
    ['extract', '44444444-4444-4444-8444-444444444444'],
    ['read', '33333333-3333-4333-8333-333333333333'],
  ]);
});

test('edits versioned transcripts, enforces segment bounds, and blocks draft exports and RAG', async t => {
  const fixture = await setup(t);
  const audio = await ingested(fixture.service);
  const transcript = await fixture.service.createTranscript({ ...auth(), audioId: audio.id });
  await expectCode(fixture.service.getRagDocument({ ...auth(), transcriptId: transcript.id }),
    'TRANSCRIPT_NOT_VALIDATED');
  await expectCode(fixture.service.exportSubtitles({
    ...auth(), transcriptId: transcript.id, format: 'srt',
  }), 'TRANSCRIPT_NOT_VALIDATED');

  const segments = [
    { startSeconds: 0, endSeconds: 2, text: '<script>alert(1)</script> & hello' },
    { startSeconds: 2, endSeconds: 3.25, text: 'next cue' },
  ];
  await expectCode(fixture.service.editTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 1,
    segments: [{ startSeconds: -1, endSeconds: 1, text: 'before' }],
  }), 'INVALID_TRANSCRIPT');
  await expectCode(fixture.service.editTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 1,
    segments: [
      { startSeconds: 0, endSeconds: 2, text: 'first' },
      { startSeconds: 1.99, endSeconds: 3, text: 'overlap' },
    ],
  }), 'INVALID_TRANSCRIPT');
  await expectCode(fixture.service.editTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 1,
    segments: [{ startSeconds: 0, endSeconds: 12.51, text: 'past end' }],
  }), 'INVALID_TRANSCRIPT');

  const edited = await fixture.service.editTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 1, segments,
  });
  assert.deepEqual([edited.version, edited.status], [2, 'draft']);
  await expectCode(fixture.service.editTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 1, segments,
  }), 'VERSION_CONFLICT');
  const validated = await fixture.service.validateTranscript({
    ...auth(), transcriptId: transcript.id, expectedVersion: 2,
  });
  assert.deepEqual([validated.version, validated.status], [3, 'validated']);

  const srt = await fixture.service.exportSubtitles({ ...auth(), transcriptId: transcript.id, format: 'srt' });
  assert.equal(srt.contentType, 'application/x-subrip; charset=utf-8');
  assert.match(srt.data, /00:00:00,000 --> 00:00:02,000/u);
  assert.match(srt.data, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; hello/u);
  const vtt = await fixture.service.exportSubtitles({ ...auth(), transcriptId: transcript.id, format: 'vtt' });
  assert.match(vtt.data, /^WEBVTT\n/u);
  assert.match(vtt.data, /00:00:02\.000 --> 00:00:03\.250/u);

  const ragDocument = await fixture.service.getRagDocument({ ...auth(), transcriptId: transcript.id });
  assert.equal(ragDocument.source.validated, true);
  assert.equal(ragDocument.version, validated.version);
  assert.equal(ragDocument.text, '<script>alert(1)</script> & hello\nnext cue');
});

test('enforces quota, retention, authorized deletion, and safe storage paths', async t => {
  let now = 1000;
  const fixture = await setup(t, {
    clock: () => now,
    limits: { retentionMs: 1000, maxTenantFiles: 2 },
  });
  const audio = await ingested(fixture.service);
  await expectCode(fixture.service.createTranscript({ ...auth(), audioId: audio.id }), 'QUOTA_EXCEEDED');
  now += 1000;
  assert.deepEqual(await fixture.service.purgeExpired(auth()), {
    deletedAudio: 1, deletedTranscripts: 0, cleanedTemporaryFiles: 0, cleanedOrphanFiles: 0,
  });
  await expectCode(fixture.service.readAudio({ ...auth(), audioId: audio.id }), 'NOT_FOUND');

  const outside = path.join(fixture.parent, 'outside');
  const linked = path.join(fixture.parent, 'linked');
  await writeFile(outside, 'private');
  await symlink(outside, linked);
  await assert.rejects(createAudioService({
    directory: linked, tenancy: tenancy(), audit: { append: async () => {} },
  }), error => error instanceof AudioModuleError && error.code === 'INVALID_PATH');
  assert.equal(await readFile(outside, 'utf8'), 'private');
});

test('purges abandoned source files left by interrupted publication after the temporary TTL', async t => {
  let now = Date.now();
  const fixture = await setup(t, {
    clock: () => now,
    limits: { jobTimeoutMs: 100, temporaryTtlMs: 200 },
  });
  const audio = await ingested(fixture.service);
  const metadataPath = path.join(fixture.directory, 'sources', TENANT_A, `${audio.id}.json`);
  const sourcePath = path.join(fixture.directory, 'sources', TENANT_A, `${audio.id}.source`);
  await rm(metadataPath);
  const old = new Date(now - 1000);
  await utimes(sourcePath, old, old);

  const purged = await fixture.service.purgeExpired(auth());
  assert.deepEqual(purged, {
    deletedAudio: 0, deletedTranscripts: 0, cleanedTemporaryFiles: 0, cleanedOrphanFiles: 1,
  });
  await assert.rejects(lstat(sourcePath), { code: 'ENOENT' });
});

test('deleting audio cascades to its transcripts and missing audits fail closed', async t => {
  const fixture = await setup(t);
  const audio = await ingested(fixture.service);
  const transcript = await fixture.service.createTranscript({ ...auth(), audioId: audio.id });
  await fixture.service.deleteAudio({ ...auth(), audioId: audio.id });
  await expectCode(fixture.service.getRagDocument({ ...auth(), transcriptId: transcript.id }), 'NOT_FOUND');
  await assert.rejects(createAudioService({
    directory: path.join(fixture.parent, 'no-audit'),
    tenancy: tenancy(),
  }), error => error instanceof AudioModuleError && error.code === 'INVALID_CONFIGURATION');
});
