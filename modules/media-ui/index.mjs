const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_WAVEFORM_INPUT_BYTES = 24 * 1024 * 1024;
const DEFAULT_WAVEFORM_BARS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOB_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const STATUS_LABELS = Object.freeze({
  queued: 'En attente',
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
});
const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,99}$/u;

export class MediaUiError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MediaUiError';
    this.code = code;
  }
}

function fail(code) {
  throw new MediaUiError(code);
}

function exactObject(value, fields, required = fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !fields.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_INPUT');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
  }
}

function authFields(value) {
  if (typeof value.cookieHeader !== 'string' || value.cookieHeader.length > 8192 ||
      typeof value.tenantId !== 'string' || !UUID.test(value.tenantId) ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.requestId)) {
    fail('INVALID_INPUT');
  }
  return {
    cookieHeader: value.cookieHeader,
    tenantId: value.tenantId,
    requestId: value.requestId,
  };
}

function validSignal(signal) {
  if (signal !== undefined && (!(signal instanceof AbortSignal) ||
      typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
    fail('INVALID_INPUT');
  }
}

function validBytes(value) {
  return Buffer.isBuffer(value) ||
    (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype);
}

function validateLimits(limits = {}) {
  exactObject(limits, Object.keys(limits));
  const allowed = ['maxUploadBytes', 'maxWaveformInputBytes', 'maxWaveformBars'];
  if (Object.keys(limits).some(key => !allowed.includes(key))) fail('INVALID_CONFIGURATION');
  const maxUploadBytes = limits.maxUploadBytes ?? 50 * 1024 * 1024;
  const maxWaveformInputBytes = limits.maxWaveformInputBytes ?? MAX_WAVEFORM_INPUT_BYTES;
  const maxWaveformBars = limits.maxWaveformBars ?? DEFAULT_WAVEFORM_BARS;
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > MAX_UPLOAD_BYTES ||
      !Number.isSafeInteger(maxWaveformInputBytes) || maxWaveformInputBytes < 44 ||
      maxWaveformInputBytes > MAX_WAVEFORM_INPUT_BYTES ||
      !Number.isSafeInteger(maxWaveformBars) || maxWaveformBars < 1 || maxWaveformBars > 128) {
    fail('INVALID_CONFIGURATION');
  }
  return Object.freeze({ maxUploadBytes, maxWaveformInputBytes, maxWaveformBars });
}

function validateService(service, methods, versioned = true) {
  return service && (!versioned || service.contractVersion === 1) &&
    methods.every(method => typeof service[method] === 'function');
}

function html(value) {
  return String(value).replace(/[&<>"']/gu, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function localUrl(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 2048 ||
      !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f#]/u.test(value)) {
    fail('INVALID_INPUT');
  }
  let parsed;
  try {
    parsed = new URL(value, 'https://media-ui.invalid');
  } catch {
    fail('INVALID_INPUT');
  }
  if (parsed.origin !== 'https://media-ui.invalid' || parsed.username || parsed.password || parsed.hash) {
    fail('INVALID_INPUT');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function languageTag(value) {
  if (typeof value !== 'string' || value.length > 35) fail('INVALID_INPUT');
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical;
  } catch {
    fail('INVALID_INPUT');
  }
}

export function renderMediaPlayer(input) {
  exactObject(input, [
    'mediaType', 'src', 'title', 'captionsSrc', 'captionsLanguage', 'captionsLabel',
  ], ['mediaType', 'src', 'title']);
  if (!['audio', 'video'].includes(input.mediaType) || typeof input.title !== 'string' ||
      input.title.trim().length === 0 || input.title.length > 200) fail('INVALID_INPUT');
  const src = localUrl(input.src);
  const captions = input.captionsSrc === undefined ? null : localUrl(input.captionsSrc);
  let track = '';
  if (captions !== null) {
    const lang = languageTag(input.captionsLanguage);
    if (typeof input.captionsLabel !== 'string' ||
        input.captionsLabel.trim().length === 0 || input.captionsLabel.length > 80) {
      fail('INVALID_INPUT');
    }
    track = `<track kind="captions" src="${html(captions)}" srclang="${html(lang)}" label="${html(input.captionsLabel)}" default>`;
  } else if (input.captionsLanguage !== undefined || input.captionsLabel !== undefined) {
    fail('INVALID_INPUT');
  }
  const title = html(input.title.trim());
  const player = input.mediaType === 'audio'
    ? `<audio controls preload="metadata" aria-label="${title}" src="${html(src)}">${track}</audio>`
    : `<video controls preload="metadata" aria-label="${title}" src="${html(src)}">${track}</video>`;
  return `<figure><figcaption>${title}</figcaption>${player}${captions === null
    ? '<p>No captions track is available.</p>'
    : ''}</figure>`;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT');
  return value;
}

export function renderTranscriptEditor(input) {
  exactObject(input, ['transcript', 'actionUrl', 'label']);
  const { transcript } = input;
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript) ||
      !Number.isSafeInteger(transcript.version) || transcript.version < 1 ||
      !Array.isArray(transcript.segments) || transcript.segments.length > 1000 ||
      typeof input.label !== 'string' || input.label.trim().length === 0 ||
      input.label.length > 200) fail('INVALID_INPUT');
  const transcriptId = uuid(transcript.id);
  const actionUrl = localUrl(input.actionUrl);
  const segments = transcript.segments.map((segment, index) => {
    if (!segment || typeof segment !== 'object' ||
        !Number.isFinite(segment.startSeconds) || segment.startSeconds < 0 ||
        !Number.isFinite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds ||
        typeof segment.text !== 'string' || segment.text.length > 2000) fail('INVALID_INPUT');
    const labelIndex = index + 1;
    return `<fieldset><legend>Segment ${labelIndex}</legend>` +
      `<label for="segment-${index}-start">Start time, seconds</label>` +
      `<input id="segment-${index}-start" name="segments[${index}][startSeconds]" type="number" min="0" step="0.001" required value="${html(segment.startSeconds)}">` +
      `<label for="segment-${index}-end">End time, seconds</label>` +
      `<input id="segment-${index}-end" name="segments[${index}][endSeconds]" type="number" min="0" step="0.001" required value="${html(segment.endSeconds)}">` +
      `<label for="segment-${index}-text">Text for segment ${labelIndex}</label>` +
      `<textarea id="segment-${index}-text" name="segments[${index}][text]" maxlength="2000" required>${html(segment.text)}</textarea></fieldset>`;
  }).join('');
  const empty = transcript.segments.length === 0
    ? '<p>No transcript segments yet.</p>'
    : '';
  return `<form method="post" action="${html(actionUrl)}"><h2>${html(input.label)}</h2>` +
    `<input type="hidden" name="transcriptId" value="${html(transcriptId)}">` +
    `<input type="hidden" name="expectedVersion" value="${transcript.version}">` +
    `${empty}${segments}<p role="status" aria-live="polite"></p>` +
    '<button type="submit" name="action" value="save">Save draft</button>' +
    '<button type="submit" name="action" value="validate">Validate transcript</button></form>';
}

export function renderImageCarousel(input) {
  exactObject(input, ['carousel', 'label', 'previousAction', 'nextAction']);
  const { carousel } = input;
  if (!carousel || !Array.isArray(carousel.items) || carousel.items.length < 1 ||
      carousel.items.length > 20 || !Number.isSafeInteger(carousel.activeIndex) ||
      carousel.activeIndex < 0 || carousel.activeIndex >= carousel.items.length ||
      typeof input.label !== 'string' || input.label.trim().length === 0 ||
      input.label.length > 200) fail('INVALID_INPUT');
  const active = carousel.items[carousel.activeIndex];
  if (!active || typeof active.alt !== 'string' || active.alt.length > 500) fail('INVALID_INPUT');
  const src = localUrl(active.src);
  const previous = carousel.activeIndex > 0
    ? `<form method="post" action="${html(localUrl(input.previousAction))}"><input type="hidden" name="activeIndex" value="${carousel.activeIndex - 1}"><button type="submit">Previous image</button></form>`
    : '<button type="button" disabled>Previous image</button>';
  const next = carousel.activeIndex < carousel.items.length - 1
    ? `<form method="post" action="${html(localUrl(input.nextAction))}"><input type="hidden" name="activeIndex" value="${carousel.activeIndex + 1}"><button type="submit">Next image</button></form>`
    : '<button type="button" disabled>Next image</button>';
  return `<section aria-label="${html(input.label)}"><figure><img src="${html(src)}" alt="${html(active.alt)}">` +
    `<figcaption>Image ${carousel.activeIndex + 1} of ${carousel.items.length}</figcaption></figure>` +
    `<p role="status" aria-live="polite">Image ${carousel.activeIndex + 1} of ${carousel.items.length}</p>` +
    `<nav aria-label="Image carousel controls">${previous}${next}</nav></section>`;
}

function parseNormalizedWav(value, maxInputBytes) {
  if (!validBytes(value) || value.byteLength < 44 || value.byteLength > maxInputBytes) {
    fail(value?.byteLength > maxInputBytes ? 'FILE_TOO_LARGE' : 'INVALID_AUDIO');
  }
  const data = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' ||
      data.readUInt32LE(4) + 8 !== data.length) fail('INVALID_AUDIO');
  let offset = 12;
  let format = null;
  let samples = null;
  while (offset + 8 <= data.length) {
    const chunkSize = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = body + chunkSize;
    if (end > data.length) fail('INVALID_AUDIO');
    const id = data.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') {
      if (chunkSize < 16 || format !== null) fail('INVALID_AUDIO');
      format = {
        encoding: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        sampleRate: data.readUInt32LE(body + 4),
        byteRate: data.readUInt32LE(body + 8),
        blockAlign: data.readUInt16LE(body + 12),
        bitsPerSample: data.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (samples !== null || chunkSize < 2 || chunkSize % 2 !== 0) fail('INVALID_AUDIO');
      samples = { start: body, count: chunkSize / 2 };
    }
    offset = end + (chunkSize % 2);
  }
  if (offset !== data.length || !format || !samples || format.encoding !== 1 ||
      format.channels !== 1 || format.sampleRate !== 16000 || format.byteRate !== 32000 ||
      format.blockAlign !== 2 || format.bitsPerSample !== 16) fail('INVALID_AUDIO');
  return { data, samples };
}

export function createWaveform(value, configuration = {}) {
  exactObject(configuration, ['maxInputBytes', 'maxBars'], []);
  const maxInputBytes = configuration.maxInputBytes ?? MAX_WAVEFORM_INPUT_BYTES;
  const maxBars = configuration.maxBars ?? DEFAULT_WAVEFORM_BARS;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 44 ||
      maxInputBytes > MAX_WAVEFORM_INPUT_BYTES || !Number.isSafeInteger(maxBars) ||
      maxBars < 1 || maxBars > 128) fail('INVALID_CONFIGURATION');
  const { data, samples } = parseNormalizedWav(value, maxInputBytes);
  const count = Math.min(maxBars, samples.count);
  const bars = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * samples.count / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.count / count));
    let total = 0;
    for (let sample = start; sample < end; sample += 1) {
      total += Math.abs(data.readInt16LE(samples.start + sample * 2));
    }
    bars.push(total / (end - start) / 32768);
  }
  return Object.freeze(bars);
}

export function renderWaveform(bars) {
  if (!Array.isArray(bars) || bars.length < 1 || bars.length > 128 ||
      bars.some(value => !Number.isFinite(value) || value < 0 || value > 1)) fail('INVALID_INPUT');
  const width = 512;
  const height = 64;
  const barWidth = width / bars.length;
  const rects = bars.map((amplitude, index) => {
    const barHeight = Math.max(1, Math.round(amplitude * 56));
    const y = Math.round((height - barHeight) / 2);
    return `<rect x="${(index * barWidth).toFixed(2)}" y="${y}" width="${Math.max(1, barWidth - 1).toFixed(2)}" height="${barHeight}"></rect>`;
  }).join('');
  return `<svg aria-hidden="true" focusable="false" viewBox="0 0 ${width} ${height}" role="presentation">${rects}</svg>`;
}

export function renderJobProgress(input) {
  exactObject(input, ['status', 'events']);
  if (!input.status || !JOB_STATUSES.has(input.status.status) ||
      typeof input.status.label !== 'string' || !Number.isSafeInteger(input.status.attempt) ||
      !Number.isSafeInteger(input.status.maxAttempts) || input.status.attempt < 0 ||
      input.status.maxAttempts < 1 || input.status.attempt > input.status.maxAttempts ||
      !Array.isArray(input.events) || input.events.length > 50) fail('INVALID_INPUT');
  const events = input.events.map(event => {
    if (!event || !EVENT_TYPE.test(event.type) || !Number.isSafeInteger(event.occurredAt) ||
        !Number.isSafeInteger(event.attempt) || event.attempt < 0) fail('INVALID_INPUT');
    const time = new Date(event.occurredAt);
    if (!Number.isFinite(time.getTime())) fail('INVALID_INPUT');
    return `<li><time datetime="${time.toISOString()}">${time.toISOString()}</time> ${html(event.type)} (attempt ${event.attempt})</li>`;
  }).join('');
  const error = input.status.errorCode
    ? typeof input.status.errorCode === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(input.status.errorCode)
      ? `<p role="alert">Processing failed: ${html(input.status.errorCode)}</p>`
      : fail('INVALID_INPUT')
    : '';
  return `<section aria-label="Media processing progress"><p role="status" aria-live="polite">${html(input.status.label)} ` +
    `(attempt ${input.status.attempt} of ${input.status.maxAttempts})</p>${error}` +
    `<ol aria-label="Processing events">${events}</ol></section>`;
}

export function stopMediaPlayback(element) {
  if (!element || typeof element.pause !== 'function' ||
      typeof element.removeAttribute !== 'function' || typeof element.load !== 'function') {
    fail('INVALID_INPUT');
  }
  element.pause();
  element.removeAttribute('src');
  for (const track of element.querySelectorAll?.('track') ?? []) track.removeAttribute('src');
  element.load();
}

export function createMediaUiService(options) {
  exactObject(options, ['audio', 'video', 'images', 'jobs', 'limits'], ['audio', 'video']);
  if (!validateService(options.audio, [
    'ingest', 'readAudio', 'createTranscript', 'editTranscript', 'validateTranscript',
    'exportSubtitles', 'getRagDocument', 'deleteAudio', 'deleteTranscript',
  ], false) || !validateService(options.video, ['ingest', 'readArtifact'], false) ||
      (options.images !== undefined && !validateService(options.images, ['createCarousel'])) ||
      (options.jobs !== undefined && (!options.jobs || typeof options.jobs.get !== 'function' ||
        typeof options.jobs.events !== 'function' || typeof options.jobs.cancel !== 'function'))) {
    fail('INVALID_CONFIGURATION');
  }
  const limits = validateLimits(options.limits ?? {});
  const audio = options.audio;
  const video = options.video;

  return Object.freeze({
    contractVersion: 1,
    moduleVersion: '1.0.0',
    async upload(input) {
      exactObject(input, [
        'cookieHeader', 'tenantId', 'requestId', 'mediaType', 'consent', 'data', 'signal',
      ], ['cookieHeader', 'tenantId', 'requestId', 'mediaType', 'consent', 'data']);
      const auth = authFields(input);
      validSignal(input.signal);
      if (!['audio', 'video'].includes(input.mediaType)) fail('INVALID_INPUT');
      if (input.consent !== true) fail('CONSENT_REQUIRED');
      if (!validBytes(input.data)) fail('INVALID_INPUT');
      if (input.data.byteLength < 12) fail('INVALID_INPUT');
      if (input.data.byteLength > limits.maxUploadBytes) fail('FILE_TOO_LARGE');
      if (input.signal?.aborted) fail('INTERRUPTED');
      return input.mediaType === 'audio'
        ? audio.ingest({ ...auth, consent: true, audio: input.data, ...(input.signal ? { signal: input.signal } : {}) })
        : video.ingest({ ...auth, consent: true, video: input.data, ...(input.signal ? { signal: input.signal } : {}) });
    },
    async createTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      return audio.createTranscript({ ...authFields(input), audioId: uuid(input.audioId) });
    },
    async editTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'expectedVersion', 'segments']);
      uuid(input.transcriptId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
          !Array.isArray(input.segments) || input.segments.length > 1000) fail('INVALID_INPUT');
      return audio.editTranscript({ ...authFields(input), transcriptId: input.transcriptId,
        expectedVersion: input.expectedVersion, segments: input.segments });
    },
    async validateTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'expectedVersion']);
      uuid(input.transcriptId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT');
      return audio.validateTranscript({ ...authFields(input), transcriptId: input.transcriptId,
        expectedVersion: input.expectedVersion });
    },
    async exportSubtitles(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId', 'format']);
      uuid(input.transcriptId);
      if (!['srt', 'vtt'].includes(input.format)) fail('INVALID_INPUT');
      return audio.exportSubtitles({ ...authFields(input), transcriptId: input.transcriptId, format: input.format });
    },
    async getRagDocument(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId']);
      return audio.getRagDocument({ ...authFields(input), transcriptId: uuid(input.transcriptId) });
    },
    async deleteAudio(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'audioId']);
      return audio.deleteAudio({ ...authFields(input), audioId: uuid(input.audioId) });
    },
    async deleteTranscript(input) {
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'transcriptId']);
      return audio.deleteTranscript({ ...authFields(input), transcriptId: uuid(input.transcriptId) });
    },
    async carousel(input) {
      if (!options.images) fail('FEATURE_UNAVAILABLE');
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'imageIds', 'activeIndex', 'signal'],
        ['cookieHeader', 'tenantId', 'requestId', 'imageIds']);
      if (!Array.isArray(input.imageIds) || input.imageIds.length > 20) fail('INVALID_INPUT');
      return options.images.createCarousel(input);
    },
    async jobStatus(input) {
      if (!options.jobs) fail('FEATURE_UNAVAILABLE');
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'jobId']);
      const job = await options.jobs.get({ ...authFields(input), jobId: uuid(input.jobId) });
      if (!job || !JOB_STATUSES.has(job.status)) fail('INVALID_JOB');
      return Object.freeze({
        status: job.status,
        label: STATUS_LABELS[job.status],
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        updatedAt: job.updatedAt,
        ...(job.errorCode ? { errorCode: job.errorCode } : {}),
      });
    },
    async jobProgress(input) {
      if (!options.jobs) fail('FEATURE_UNAVAILABLE');
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'jobId']);
      const auth = authFields(input);
      const jobId = uuid(input.jobId);
      const status = await options.jobs.get({ ...auth, jobId });
      if (!status || !JOB_STATUSES.has(status.status)) fail('INVALID_JOB');
      const events = await options.jobs.events(auth);
      if (!Array.isArray(events)) fail('INVALID_JOB');
      const history = events.filter(event => event?.jobId === jobId).slice(-50).map(event => {
        if (typeof event.type !== 'string' || !EVENT_TYPE.test(event.type) ||
            !Number.isSafeInteger(event.occurredAt) || !Number.isSafeInteger(event.attempt) ||
            event.attempt < 0) fail('INVALID_JOB');
        return Object.freeze({
          type: event.type,
          occurredAt: event.occurredAt,
          attempt: event.attempt,
        });
      });
      return Object.freeze({
        status: Object.freeze({
          status: status.status,
          label: STATUS_LABELS[status.status],
          attempt: status.attempt,
          maxAttempts: status.maxAttempts,
          ...(status.errorCode ? { errorCode: status.errorCode } : {}),
        }),
        events: Object.freeze(history),
      });
    },
    async cancelJob(input) {
      if (!options.jobs) fail('FEATURE_UNAVAILABLE');
      exactObject(input, ['cookieHeader', 'tenantId', 'requestId', 'jobId']);
      return options.jobs.cancel({ ...authFields(input), jobId: uuid(input.jobId) });
    },
  });
}

export const mediaUiContract = Object.freeze({
  contractVersion: 1,
  moduleVersion: '1.0.0',
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxWaveformInputBytes: MAX_WAVEFORM_INPUT_BYTES,
  maxWaveformBars: DEFAULT_WAVEFORM_BARS,
  networkRequired: false,
});
