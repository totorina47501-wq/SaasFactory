import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDeterministicSpeechDemo,
  createLocalSpeechService,
  createPiperTtsEngine,
  createWhisperCppAsrEngine,
  LocalSpeechError,
  localSpeechContract,
} from '../modules/local-speech/index.mjs';

const WAV = Buffer.alloc(48);
WAV.write('RIFF', 0, 'ascii');
WAV.writeUInt32LE(WAV.length - 8, 4);
WAV.write('WAVE', 8, 'ascii');
const AUDIO = Buffer.from(WAV);
const TEST_LICENSE = 'MIT';

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-speech-test-'));
  const modelPath = path.join(directory, 'model.bin');
  const modelData = Buffer.from('synthetic-model');
  await writeFile(modelPath, modelData, { mode: 0o600 });
  const model = {
    path: modelPath,
    version: 'test-1',
    license: TEST_LICENSE,
    sizeBytes: modelData.length,
    sha256: createHash('sha256').update(modelData).digest('hex'),
  };
  return { directory, model };
}

async function fakeExecutable(directory, name, source) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

function whisperEngine(executable, model, options = {}) {
  return createWhisperCppAsrEngine({
    executable,
    runtimeVersion: '1.7.6',
    model,
    languages: ['en'],
    ...options,
  });
}

function piperEngine(executable, model, options = {}) {
  return createPiperTtsEngine({
    executable,
    runtimeVersion: '1.3.0',
    model,
    ...options,
  });
}

function speech(asrEngine, ttsEngine, limits) {
  return createLocalSpeechService({
    asrEngine,
    ...(ttsEngine ? { ttsEngine } : {}),
    ...(limits ? { limits } : {}),
  });
}

function errorCode(promise, code) {
  return assert.rejects(promise, error =>
    error instanceof LocalSpeechError && error.code === code);
}

test('declares real engines as opt-in, offline and CPU-capable', () => {
  assert.equal(localSpeechContract.defaultEnabled, false);
  assert.equal(localSpeechContract.networkRequired, false);
  assert.equal(localSpeechContract.engines.asr.timestamps, true);
  assert.deepEqual(localSpeechContract.requiredModelMetadata, ['version', 'license', 'sizeBytes', 'sha256']);
});

test('Whisper adapter uses fixed argv without a shell and returns bounded timestamped draft segments', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const executable = await fakeExecutable(state.directory, 'whisper', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const base = args[args.indexOf('-of') + 1];
    if (args.includes('--malicious')) process.exit(9);
    fs.writeFileSync(base + '.json', JSON.stringify({ transcription: [
      { offsets: { from: 0, to: 750 }, text: ' Hello from local ASR. ' },
    ] }));
  `);
  const audio = speech(whisperEngine(executable, state.model));
  const result = await audio.transcribe({ consent: true, audio: AUDIO, durationSeconds: 1, language: 'en' });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.status, 'draft');
  assert.equal(result.source, 'local-model');
  assert.equal(result.metadata.runtimeVersion, '1.7.6');
  assert.deepEqual(result.segments, [{
    startSeconds: 0,
    endSeconds: 0.75,
    text: 'Hello from local ASR.',
  }]);
});

test('rejects absent consent, overlong input, invalid language and invalid model fingerprints', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const executable = await fakeExecutable(state.directory, 'whisper-noop', 'process.exit(0);');
  const audio = speech(whisperEngine(executable, state.model));
  await errorCode(audio.transcribe({ consent: false, audio: AUDIO, durationSeconds: 1, language: 'en' }),
    'CONSENT_REQUIRED');
  await errorCode(audio.transcribe({
    consent: true, audio: AUDIO, durationSeconds: 601, language: 'en',
  }), 'INVALID_AUDIO');
  await errorCode(audio.transcribe({
    consent: true, audio: AUDIO, durationSeconds: 1, language: 'fr',
  }), 'UNSUPPORTED_LANGUAGE');
  const changedModel = { ...state.model, sha256: '0'.repeat(64) };
  await errorCode(whisperEngine(executable, changedModel).transcribe({
    audio: AUDIO, durationSeconds: 1, language: 'en',
  }), 'MODEL_INTEGRITY_FAILED');
});

test('maps unavailable executables and timeouts to stable errors', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  await errorCode(whisperEngine(path.join(state.directory, 'missing'), state.model).transcribe({
    audio: AUDIO, durationSeconds: 1, language: 'en',
  }), 'ENGINE_UNAVAILABLE');
  const sleeper = await fakeExecutable(state.directory, 'slow-whisper', 'setTimeout(() => {}, 5000);');
  await errorCode(whisperEngine(sleeper, state.model, { timeoutMs: 25 }).transcribe({
    audio: AUDIO, durationSeconds: 1, language: 'en',
  }), 'ENGINE_TIMEOUT');
});

test('rejects malformed, overlapping and out-of-range ASR output', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const executable = await fakeExecutable(state.directory, 'bad-whisper', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [
      { offsets: { from: 0, to: 900 }, text: 'First' },
      { offsets: { from: 800, to: 1200 }, text: 'Overlap' },
    ] }));
  `);
  await errorCode(whisperEngine(executable, state.model).transcribe({
    audio: AUDIO, durationSeconds: 1, language: 'en',
  }), 'INVALID_ENGINE_OUTPUT');
});

test('Piper receives text over stdin, never through shell arguments, and returns bounded WAV', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const marker = path.join(state.directory, 'injected');
  const receivedPath = path.join(state.directory, 'received.txt');
  const executable = await fakeExecutable(state.directory, 'piper', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--output_file') + 1];
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => {
      const wav = Buffer.alloc(48);
      wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
      fs.writeFileSync(${JSON.stringify(receivedPath)}, text);
      fs.writeFileSync(output, wav);
    });
  `);
  const engine = piperEngine(executable, state.model);
  const audio = speech(whisperEngine(
    await fakeExecutable(state.directory, 'whisper', 'process.exit(0);'),
    state.model,
  ), engine);
  const output = await audio.synthesize({
    consent: true,
    text: `safe input; touch "${marker}"; echo "not executed"`,
  });
  assert.equal(output.contentType, 'audio/wav');
  assert.equal(output.source, 'local-model');
  assert.equal(output.data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(await readFile(receivedPath, 'utf8'), `safe input; touch "${marker}"; echo "not executed"`);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('demo output is deterministic and explicitly not an ASR or TTS result', async () => {
  const demo = createDeterministicSpeechDemo();
  const first = await demo.demonstrate({ consent: true });
  const second = await demo.demonstrate({ consent: true });
  assert.deepEqual(first, second);
  assert.equal(first.source, 'demo-only');
  assert.match(first.label, /NOT A TRANSCRIPTION OR SYNTHESIS/u);
  await errorCode(demo.demonstrate({ consent: false }), 'CONSENT_REQUIRED');
});

test('rejects unknown configuration and public input fields', async t => {
  const state = await setup();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  assert.throws(() => createWhisperCppAsrEngine({
    executable: 'whisper-cli',
    runtimeVersion: '1.7.6',
    model: state.model,
    languages: ['en'],
    shell: true,
  }), error => error instanceof LocalSpeechError && error.code === 'INVALID_INPUT');
  const executable = await fakeExecutable(state.directory, 'whisper', 'process.exit(0);');
  const audio = speech(whisperEngine(executable, state.model));
  await errorCode(audio.transcribe({
    consent: true, audio: AUDIO, durationSeconds: 1, language: 'en', ignored: true,
  }), 'INVALID_INPUT');
});
