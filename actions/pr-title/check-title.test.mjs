import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { titleErrors } from './check-title.mjs';

const script = fileURLToPath(new URL('./check-title.mjs', import.meta.url));

test('house-style titles pass', () => {
  for (const title of [
    'Plugins: update check and update count in the menu',
    'CI: OpenSSF Scorecard',
    'Damaged sources: Render node, Check source, and a Damaged path',
    'Radarr, Sonarr: say which path was unknown, and when a mapping is missing',
    'Radarr/Sonarr: Replace damaged file',
    'SDK 1.0.1: the first SDK release published from CI',
    'Jobs: Cancel all',
    'Dependencies: update node.js to v24.22.2',
    'FFmpeg: update jellyfin-ffmpeg8 to 8.1.4-1-bookworm',
  ]) {
    assert.deepEqual(titleErrors(title), [], title);
  }
});

test('conventional-commit titles fail', () => {
  for (const title of [
    'feat: Intel GPUs (Quick Sync) next to NVIDIA',
    'chore(deps): update npm non-major',
    'docs: README screenshots',
    'release: 0.2.0',
  ]) {
    assert.notDeepEqual(titleErrors(title), [], title);
  }
  assert.match(titleErrors('chore(deps): x').join('\n'), /parentheses/);
});

test('a title without an area fails', () => {
  assert.match(titleErrors('Fix CodeQL regex alerts')[0], /area and a colon/);
  assert.match(titleErrors('UI consistency pass across all pages')[0], /area and a colon/);
});

test('spacing and a closing full stop fail', () => {
  assert.notDeepEqual(titleErrors(' CI: x'), []);
  assert.notDeepEqual(titleErrors('CI: x '), []);
  assert.notDeepEqual(titleErrors('CI:  x'), []);
  assert.notDeepEqual(titleErrors('CI: '), []);
  assert.notDeepEqual(titleErrors('CI:x'), []);
  assert.match(titleErrors('CI: pin actions.').join('\n'), /full stop/);
});

test('the script exits 1 with annotations for a bad title and 0 for a good one', () => {
  const run = (title) =>
    spawnSync(process.execPath, [script], { env: { PR_TITLE: title }, encoding: 'utf8' });
  const bad = run('chore(deps): update npm non-major');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /::error::/);
  const good = run('CI: OpenSSF Scorecard');
  assert.equal(good.status, 0, good.stderr);
});
