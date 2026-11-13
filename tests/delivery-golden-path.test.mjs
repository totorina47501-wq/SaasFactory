import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGoldenPath, _private } from '../delivery/golden-path.mjs';

test('golden-path CLI parser is strict and enforces verify gating', () => {
  assert.deepEqual(_private.parseCli(['--help']), {
    outputRoot: undefined,
    reportDir: undefined,
    write: false,
    verify: false,
    help: true,
  });
  assert.throws(() => _private.parseCli(['--verify']), /requires --write/);
  assert.throws(() => _private.parseCli(['--write']), /requires explicit --output-root/);
  assert.throws(() => _private.parseCli(['--unknown']), /Unknown option/);
  assert.throws(() => _private.parseCli(['--output-root', '/tmp/a', '--output-root', '/tmp/b']), /Duplicate/);
});

test('golden-path dry-run produces deterministic qualification summary without writes', async () => {
  const root = path.join(os.tmpdir(), 'golden-path-dry-' + Date.now().toString(36));
  const report = await runGoldenPath({ outputRoot: root, write: false, verify: false });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.results.length, 4);
  assert.equal(report.summary.FAIL, 0);
  assert.equal(report.summary.PASS + report.summary.INCOMPLETE, 4);
  assert.equal(fs.existsSync(root), false);
  for (const item of report.results) {
    assert.match(item.contentSha256, /^[a-f0-9]{64}$/);
    assert.ok(['PASS', 'FAIL', 'INCOMPLETE'].includes(item.status));
  }
});

test('write mode rejects unsafe output root via symlink', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-path-write-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-path-target-'));
  const link = path.join(base, 'linked-root');
  try {
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => _private.ensureSafeFreshRoot(link), /real directory|escapes|Unsafe/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('markdown report includes pass/fail/incomplete matrix rows', () => {
  const markdown = _private.markdownReport({
    sourceSha: 'abc123',
    mode: 'dry-run',
    tools: { node: 'v22', npm: '10', docker: null, dockerCompose: null },
    results: [
      { product: 'promo-flash', profile: 'seasonal', status: 'PASS', contentSha256: 'a'.repeat(64), notes: [], checks: [{ status: 'PASS', name: 'sample' }] },
      { product: 'minimal-saas', profile: 'docker+compose', status: 'INCOMPLETE', contentSha256: 'b'.repeat(64), notes: ['docker unavailable'], checks: [{ status: 'INCOMPLETE', name: 'docker-build-run', reason: 'Docker unavailable' }] },
    ],
  });
  assert.match(markdown, /Golden Path Qualification Report/);
  assert.match(markdown, /\| promo-flash \| seasonal \| PASS \|/);
  assert.match(markdown, /\| minimal-saas \| docker\+compose \| INCOMPLETE \|/);
  assert.match(markdown, /docker-build-run/);
});


test('CI evidence fails closed for incomplete qualification and protects Compose values', () => {
  const source = fs.readFileSync(new URL('../delivery/golden-path.mjs', import.meta.url), 'utf8');
  assert.match(source, /cli\.verify && report\.summary\.INCOMPLETE > 0/);
  assert.match(source, /'compose', 'config', '--quiet'/);
  assert.doesNotMatch(source, /--env-file|golden-path-compose\.env/);
  assert.match(source, /if \(!responseOk \|\| responseCode === null/);
});

// Regression for #130: npm's Next.js descendant must not keep inherited pipes or a port alive.
// Uses only a temporary local HTTP fixture; no package downloads or external services.
test('HTTP smoke terminates npm and its server descendant, releasing the port', async () => {
  if (process.platform === 'win32') return;
  const net = await import('node:net');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-path-process-'));
  const probe = net.createServer();
  let rebound;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'golden-path-process-fixture',
      private: true,
      scripts: { start: 'node server.mjs' },
    }));
    fs.writeFileSync(path.join(root, 'server.mjs'), [
      "import { createServer } from 'node:http';",
      'const port = Number(process.argv.at(-1));',
      "createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ready</html>'); }).listen(port, '127.0.0.1');",
    ].join('\n'));
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const smoke = await _private.runLocalHttpSmoke({ cwd: root, port, timeoutMs: 12_000 });
    assert.equal(smoke.statusCode, 200);

    // Rebinding the port proves the child server did not survive the smoke check.
    rebound = net.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', resolve);
    });
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
    if (rebound?.listening) await new Promise((resolve) => rebound.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
