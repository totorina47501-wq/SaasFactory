import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNoelMemoryDeck, noelMemoryIcons, noelMemorySeedBase, themes } from '../seasonal/templates.mjs';

test('noel-memory deterministic deck is stable and complete', () => {
  const first = buildNoelMemoryDeck(0);
  const second = buildNoelMemoryDeck(0);
  const replay = buildNoelMemoryDeck(1);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, replay);
  assert.equal(first.length, noelMemoryIcons.length * 2);
  assert.equal(new Set(first).size, noelMemoryIcons.length);
  for (const icon of noelMemoryIcons) {
    assert.equal(first.filter(value => value === icon).length, 2);
    assert.equal(replay.filter(value => value === icon).length, 2);
  }
});

test('noel-memory deterministic vectors stay explicit for synthetic checks', () => {
  assert.equal(noelMemorySeedBase, 20261225);
  assert.deepEqual(buildNoelMemoryDeck(0).slice(0, 6), ['⛄', '🧣', '🍪', '🍪', '🎁', '🕯️']);
  assert.deepEqual(buildNoelMemoryDeck(1).slice(0, 6), ['🧣', '⛄', '⛄', '🕯️', '🎄', '🍪']);
  assert.throws(() => buildNoelMemoryDeck(-1), /bounded positive integer/);
});

test('noel-memory template stays offline and accessible by keyboard/touch', () => {
  const page = themes['noel-memory'].page;
  assert.match(page, /Noël Memory/);
  assert.match(page, /role="group"/);
  assert.match(page, /clearTimeout\(hideTimeout\.current\)/);
  assert.match(page, /hideTimeout\.current = setTimeout/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /Rejouer/);
  assert.match(page, /prefers-reduced-motion/);
  assert.match(page, /type="button"/);
  assert.doesNotMatch(page, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|process\.env|<script/i);
});

test('seasonal launcher list includes noel-memory preset', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const launchFile = path.join(repoRoot, 'seasonal', 'launch.mjs');
  const raw = execFileSync(process.execPath, [launchFile, '--list'], { cwd: repoRoot, encoding: 'utf8' });
  const listed = JSON.parse(raw);
  assert.ok(Array.isArray(listed.presets));
  assert.deepEqual(listed.presets, ['promo-flash', 'cadeaux-zen', 'noel-memory']);
});
