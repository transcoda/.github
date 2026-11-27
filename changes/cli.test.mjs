import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli.mjs';

const script = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const note = (type = 'improved', body = 'The path is checked first.') =>
  `---\ntype: ${type}\n---\n${body}\n`;

/** A temp repo with `plugins/sonarr` committed, then a second commit adding `files`. */
function repo(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'release note '));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 't@example.invalid');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, 'plugins', 'sonarr'), { recursive: true });
  writeFileSync(join(cwd, 'plugins', 'sonarr', 'package.json'), '{}');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'change');
  return { cwd, base, head: git(cwd, 'rev-parse', 'HEAD') };
}
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

it('check: a flat note passes, and fails in the per-folder layout', () => {
  const { cwd, base, head } = repo({ '.changes/verify.md': note() });
  const r = run(cwd, 'check', base, head, '[]', 'someone');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Release note found: .changes/verify.md\n');
  const p = run(cwd, 'check', base, head, '[]', '--per-folder', 'plugins');
  assert.equal(p.status, 1);
  assert.match(p.stderr, /must be \.changes\/<folder>\//);
});

it('check: per folder, the folder form and the flat form pass', () => {
  for (const path of ['.changes/sonarr/verify.md', '.changes/sonarr-verify.md']) {
    const { cwd, base, head } = repo({ [path]: note('fixed') });
    const r = run(cwd, 'check', base, head, '[]', '', '--per-folder', 'plugins');
    assert.equal(r.status, 0, r.stderr);
  }
});

it('check: no note fails; the label and a skipped author pass', () => {
  const { cwd, base, head } = repo({ 'README.md': 'x' });
  const r = run(cwd, 'check', base, head, '[]', 'renovate[bot]');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No release note found/);
  assert.equal(run(cwd, 'check', base, head, '["no user-facing change"]').status, 0);
  const skip = run(
    cwd,
    'check',
    base,
    head,
    '[]',
    'renovate[bot]',
    '--skip-authors',
    'renovate[bot], other',
  );
  assert.equal(skip.status, 0, skip.stderr);
});

it('check: a deleted note does not count', () => {
  const { cwd, head } = repo({ '.changes/old.md': note() });
  git(cwd, 'rm', '-q', '.changes/old.md');
  git(cwd, 'commit', '-q', '-m', 'drop');
  assert.equal(run(cwd, 'check', head, git(cwd, 'rev-parse', 'HEAD'), '[]').status, 1);
});

it('lint: validates every note in either layout', () => {
  const { cwd } = repo({ '.changes/README.md': '# x', '.changes/sonarr/a.md': note() });
  assert.equal(run(cwd, 'lint', '--per-folder', 'plugins').status, 0);
  const flat = run(cwd, 'lint');
  assert.equal(flat.status, 1);
  assert.match(flat.stderr, /\.changes\/sonarr\/a\.md: a note is/);
});

it('bad arguments exit 2 with the usage', () => {
  const { cwd } = repo({});
  assert.equal(run(cwd).status, 2);
  assert.match(run(cwd, 'check', 'a').stderr, /usage:/);
  assert.equal(run(cwd, 'lint', '--per-folder', 'nope').status, 2);
  assert.throws(() => parseArgs(['lint', '--wat']), /Unknown option --wat/);
  assert.deepEqual(parseArgs(['check', 'a', 'b', '[]', '--skip-authors', 'x,y']).skipAuthors, [
    'x',
    'y',
  ]);
});

it('check: a note moved into .changes/, and a name with non-ASCII letters, count', () => {
  const { cwd, head } = repo({ 'draft.md': note() });
  git(cwd, 'mv', 'draft.md', 'café.md');
  git(cwd, 'commit', '-q', '-m', 'rename in place');
  const mid = git(cwd, 'rev-parse', 'HEAD');
  mkdirSync(join(cwd, '.changes'));
  git(cwd, 'mv', 'café.md', '.changes/café.md');
  git(cwd, 'commit', '-q', '-m', 'move');
  const r = run(cwd, 'check', mid, git(cwd, 'rev-parse', 'HEAD'), '[]');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Release note found: .changes/café.md\n');
  assert.equal(run(cwd, 'check', head, mid, '[]').status, 1);
});
