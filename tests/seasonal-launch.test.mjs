import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchSeasonal } from '../seasonal/launch.mjs';
import { themes, stylesheet } from '../seasonal/templates.mjs';

test('seasonal presets are isolated, FR-only and dependency-free', () => {
  assert.deepEqual(Object.keys(themes), ['promo-flash', 'cadeaux-zen']);
  for (const [name, item] of Object.entries(themes)) {
    assert.match(name, /^[a-z0-9-]+$/);
    assert.match(item.domain, /\.example$/);
    assert.match(item.page, /^"use client";/);
    assert.match(item.page, /export default function Home/);
    assert.doesNotMatch(item.page, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|process\.env|<script/i);
  }
  assert.match(stylesheet, /:focus-visible/);
  assert.match(stylesheet, /@media/);
});

for (const preset of Object.keys(themes)) {
  test('seasonal ' + preset + ' is a real isolated starter, with dry-run and smoke tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-seasonal-'));
    const dest = path.join(root, preset);
    try {
      const dry = launchSeasonal({ preset, outputRoot: root });
      assert.equal(dry.mode, 'dry-run');
      assert.equal(dry.destination, dest);
      assert.equal(fs.existsSync(dest), false);
      const result = launchSeasonal({ preset, outputRoot: root, write: true });
      assert.equal(result.mode, 'write');
      assert.equal(result.paymentEnabled, false);
      assert.equal(result.publishEnabled, false);
      const page = fs.readFileSync(path.join(dest, 'app/page.tsx'), 'utf8');
      const smoke = fs.readFileSync(path.join(dest, 'tests/smoke.test.mjs'), 'utf8');
      assert.match(page, new RegExp(themes[preset].name));
      assert.doesNotMatch(smoke, /assert\.match\(page, \/Welcome\//);
      assert.match(smoke, new RegExp(themes[preset].name));
      assert.match(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), /Seasonal Fast-Track/);
      assert.equal(fs.readFileSync(path.join(dest, 'lib/ai-disabled.mjs'), 'utf8').trim(), 'export const aiEnabled = false;');
      execFileSync(process.execPath, ['--test', 'tests/smoke.test.mjs'], { cwd: dest, stdio: 'pipe', timeout: 20_000 });
      assert.throws(() => launchSeasonal({ preset, outputRoot: root, write: true }), /exist|collision|overwrite/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('invalid preset, target and unsafe destination fail before any write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-seasonal-'));
  const link = path.join(os.tmpdir(), 'saas-seasonal-link-' + path.basename(root));
  try {
    assert.throws(() => launchSeasonal({ preset: 'not-a-preset', outputRoot: root, write: true }), /Unknown/);
    assert.throws(() => launchSeasonal({ preset: 'promo-flash', outputRoot: root, write: true, target: 'production' }), /Unsupported/);
    fs.symlinkSync(root, link, 'dir');
    assert.throws(() => launchSeasonal({ preset: 'promo-flash', outputRoot: link, write: true }), /symbolic|canonical/i);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
