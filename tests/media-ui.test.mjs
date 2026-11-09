import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMediaUiService,
  createWaveform,
  MediaUiError,
  renderImageCarousel,
  renderJobProgress,
  renderMediaPlayer,
  renderTranscriptEditor,
  renderWaveform,
  stopMediaPlayback,
} from '../modules/media-ui/index.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const AUDIO_ID = '22222222-2222-4222-8222-222222222222';
const TRANSCRIPT_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const auth = {
  cookieHeader: 'session',
  tenantId: TENANT_ID,
  requestId: 'media-ui-test',
};

function expectCode(operation, code) {
  return assert.rejects(operation, error =>
    error instanceof MediaUiError && error.code === code);
}

function makeWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write('fmt ', 0, 'ascii');
  fmtHeader.writeUInt32LE(fmt.length, 4);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(data.length, 4);
  const result = Buffer.concat([header, fmtHeader, fmt, dataHeader, data]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function mediaServices({ audioOverrides = {}, videoOverrides = {}, jobs, images, limits } = {}) {
  const calls = [];
  const audio = {
    contractVersion: 1,
    async ingest(input) { calls.push(['audio.ingest', input]); return { id: AUDIO_ID }; },
    async readAudio(input) { calls.push(['audio.readAudio', input]); },
    async createTranscript(input) { calls.push(['audio.createTranscript', input]); return { id: TRANSCRIPT_ID }; },
    async editTranscript(input) { calls.push(['audio.editTranscript', input]); return { status: 'draft' }; },
    async validateTranscript(input) { calls.push(['audio.validateTranscript', input]); return { status: 'validated' }; },
    async exportSubtitles(input) { calls.push(['audio.exportSubtitles', input]); return { data: 'WEBVTT\n' }; },
    async getRagDocument(input) {
      calls.push(['audio.getRagDocument', input]);
      return { id: `audio-transcript:${TRANSCRIPT_ID}`, source: { validated: true } };
    },
    async deleteAudio(input) { calls.push(['audio.deleteAudio', input]); return { deleted: true }; },
    async deleteTranscript(input) { calls.push(['audio.deleteTranscript', input]); return { deleted: true }; },
    ...audioOverrides,
  };
  const video = {
    contractVersion: 1,
    async ingest(input) { calls.push(['video.ingest', input]); return { id: AUDIO_ID }; },
    async readArtifact(input) { calls.push(['video.readArtifact', input]); },
    ...videoOverrides,
  };
  return {
    calls,
    service: createMediaUiService({
      audio, video, ...(jobs ? { jobs } : {}), ...(images ? { images } : {}),
      ...(limits ? { limits } : {}),
    }),
  };
}

test('uses native keyboard-operable media controls and same-origin captions tracks', () => {
  const audio = renderMediaPlayer({
    mediaType: 'audio',
    src: '/media/audio/1',
    title: 'Interview',
    captionsSrc: '/media/captions/1.vtt',
    captionsLanguage: 'fr-fr',
    captionsLabel: 'Français',
  });
  assert.match(audio, /<audio controls preload="metadata"/u);
  assert.match(audio, /<track kind="captions"/u);
  assert.match(audio, /srclang="fr-FR"/u);

  const video = renderMediaPlayer({ mediaType: 'video', src: '/media/video/1', title: 'Video' });
  assert.match(video, /<video controls preload="metadata"/u);
  assert.match(video, /No captions track is available/u);
  assert.throws(() => renderMediaPlayer({
    mediaType: 'video', src: 'https://external.example/video', title: 'Video',
  }), { code: 'INVALID_INPUT' });
});

test('renders transcript and carousel controls with labels, status, and escaped content', () => {
  const editor = renderTranscriptEditor({
    transcript: {
      id: TRANSCRIPT_ID,
      version: 3,
      segments: [{ startSeconds: 0, endSeconds: 2, text: '<img src=x onerror=alert(1)>' }],
    },
    actionUrl: '/media/transcripts/edit',
    label: 'Transcript',
  });
  assert.match(editor, /<fieldset><legend>Segment 1<\/legend>/u);
  assert.match(editor, /role="status" aria-live="polite"/u);
  assert.match(editor, /Validate transcript/u);
  assert.match(editor, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(editor, /<img src=x/u);

  const carousel = renderImageCarousel({
    carousel: {
      activeIndex: 0,
      items: [{ src: '/images/first.png', alt: 'First image' }, { src: '/images/second.png', alt: 'Second image' }],
    },
    label: 'Gallery',
    previousAction: '/gallery',
    nextAction: '/gallery',
  });
  assert.match(carousel, /aria-label="Gallery"/u);
  assert.match(carousel, /alt="First image"/u);
  assert.match(carousel, /Image 1 of 2/u);
  assert.match(carousel, /Next image/u);
  assert.match(carousel, /disabled>Previous image/u);
});

test('builds a bounded waveform only from normalized local PCM audio', () => {
  const bars = createWaveform(makeWav([0, 1000, -2000, 4000, -8000, 16000]), { maxBars: 3 });
  assert.equal(bars.length, 3);
  assert.ok(bars.every(value => value >= 0 && value <= 1));
  assert.match(renderWaveform(bars), /aria-hidden="true"/u);
  assert.throws(() => createWaveform(Buffer.from('not a wave')), { code: 'INVALID_AUDIO' });
  assert.throws(() => renderWaveform([1.2]), { code: 'INVALID_INPUT' });
});

test('requires explicit consent, enforces upload limits, and forwards only authorized media inputs', async () => {
  const limited = mediaServices({ limits: { maxUploadBytes: 16 } }).service;
  await expectCode(limited.upload({ ...auth, mediaType: 'audio', consent: false, data: Buffer.alloc(12) }), 'CONSENT_REQUIRED');
  await expectCode(limited.upload({ ...auth, mediaType: 'audio', consent: true, data: Buffer.alloc(17) }), 'FILE_TOO_LARGE');

  const uploadFixture = mediaServices();
  const upload = await uploadFixture.service.upload({
    ...auth, mediaType: 'video', consent: true, data: Buffer.alloc(16), signal: new AbortController().signal,
  });
  assert.equal(upload.id, AUDIO_ID);
  assert.deepEqual(Object.keys(uploadFixture.calls[0][1]).sort(),
    ['consent', 'cookieHeader', 'requestId', 'signal', 'tenantId', 'video'].sort());
  assert.equal(uploadFixture.calls[0][1].consent, true);
  assert.equal(uploadFixture.calls[0][1].video.byteLength, 16);
  assert.equal(uploadFixture.calls[0][1].signal.aborted, false);

  const denied = mediaServices({
    audioOverrides: { async ingest() { throw Object.assign(new Error('denied'), { code: 'TENANT_ACCESS_DENIED' }); } },
  });
  await assert.rejects(denied.service.upload({
    ...auth, mediaType: 'audio', consent: true, data: Buffer.alloc(12),
  }), error => error.code === 'TENANT_ACCESS_DENIED');
});

test('delegates transcript editing, validation, exports, and RAG provenance through ACL-backed audio service', async () => {
  const fixture = mediaServices();
  const edited = await fixture.service.editTranscript({
    ...auth, transcriptId: TRANSCRIPT_ID, expectedVersion: 1,
    segments: [{ startSeconds: 0, endSeconds: 1, text: 'Hello' }],
  });
  assert.equal(edited.status, 'draft');
  assert.equal((await fixture.service.validateTranscript({
    ...auth, transcriptId: TRANSCRIPT_ID, expectedVersion: 2,
  })).status, 'validated');
  assert.equal((await fixture.service.exportSubtitles({
    ...auth, transcriptId: TRANSCRIPT_ID, format: 'vtt',
  })).data, 'WEBVTT\n');
  assert.equal((await fixture.service.getRagDocument({ ...auth, transcriptId: TRANSCRIPT_ID }))
    .source.validated, true);
  assert.equal(fixture.calls.length, 4);
  await expectCode(fixture.service.validateTranscript({
    ...auth, transcriptId: TRANSCRIPT_ID, expectedVersion: 0,
  }), 'INVALID_INPUT');
  await expectCode(fixture.service.exportSubtitles({
    ...auth, transcriptId: TRANSCRIPT_ID, format: 'html',
  }), 'INVALID_INPUT');
});

test('delegates carousel and tenant-scoped job status/cancellation', async () => {
  const eventCalls = [];
  const fixture = mediaServices({
    images: {
      contractVersion: 1,
      async createCarousel(input) { eventCalls.push(['carousel', input]); return { items: [] }; },
    },
    jobs: {
      async get(input) {
        eventCalls.push(['get', input]);
        return { status: 'running', attempt: 2, maxAttempts: 3, updatedAt: 123 };
      },
      async events(input) {
        eventCalls.push(['events', input]);
        return [
          { jobId: JOB_ID, type: 'job.queued', occurredAt: 100, attempt: 0 },
          { jobId: AUDIO_ID, type: 'job.failed', occurredAt: 110, attempt: 1 },
          { jobId: JOB_ID, type: 'job.started', occurredAt: 120, attempt: 2 },
        ];
      },
      async cancel(input) { eventCalls.push(['cancel', input]); return { status: 'cancelled' }; },
    },
  });
  assert.deepEqual(await fixture.service.carousel({ ...auth, imageIds: [AUDIO_ID] }), { items: [] });
  assert.deepEqual(await fixture.service.jobStatus({ ...auth, jobId: JOB_ID }), {
    status: 'running', label: 'En cours', attempt: 2, maxAttempts: 3, updatedAt: 123,
  });
  const progress = await fixture.service.jobProgress({ ...auth, jobId: JOB_ID });
  assert.equal(progress.events.length, 2);
  assert.match(renderJobProgress(progress), /role="status" aria-live="polite"/u);
  assert.match(renderJobProgress(progress), /job.started/u);
  assert.deepEqual(await fixture.service.cancelJob({ ...auth, jobId: JOB_ID }), { status: 'cancelled' });
  assert.ok(eventCalls.every(([, input]) => input.tenantId === TENANT_ID));
  await expectCode(fixture.service.carousel({ ...auth, imageIds: Array(21).fill(AUDIO_ID) }), 'INVALID_INPUT');
});

test('stops and unloads media before a playback deletion action proceeds', () => {
  const calls = [];
  const track = { removeAttribute(name) { calls.push(`track:${name}`); } };
  const element = {
    pause() { calls.push('pause'); },
    removeAttribute(name) { calls.push(`media:${name}`); },
    querySelectorAll(selector) { assert.equal(selector, 'track'); return [track]; },
    load() { calls.push('load'); },
  };
  stopMediaPlayback(element);
  assert.deepEqual(calls, ['pause', 'media:src', 'track:src', 'load']);
  assert.throws(() => stopMediaPlayback({}), { code: 'INVALID_INPUT' });
});
