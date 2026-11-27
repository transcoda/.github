import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkPullRequest,
  folderOf,
  groupEntries,
  isNote,
  layoutOf,
  lintNotes,
  listNotes,
  parseNote,
  readNotes,
  renderGroups,
  textErrors,
} from './notes.mjs';

const note = (type = 'improved', body = 'The path is checked first.') =>
  `---\ntype: ${type}\n---\n${body}\n`;
const FLAT = { folders: null };
const PER = { folders: ['sonarr', 'arr', 'arr-common'], perFolder: 'plugins' };

/** A temp repository root with these files. */
function root(files) {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('parseNote and textErrors', () => {
  it('parses type and body, joining lines, CRLF too', () => {
    assert.deepEqual(parseNote('---\ntype: new\n---\nHello\nworld.\n'), {
      type: 'new',
      text: 'Hello world.',
    });
    assert.deepEqual(parseNote('---\r\ntype: fixed\r\n---\r\nDone.\r\n'), {
      type: 'fixed',
      text: 'Done.',
    });
  });

  it('reports a bad type and an empty body', () => {
    assert.equal(parseNote('---\ntype: wat\n---\n\n').errors.length, 2);
    assert.equal(parseNote('no front matter').errors.length, 2);
  });

  it('rejects commit hashes and pull request numbers, not ordinary words', () => {
    assert.deepEqual(textErrors(note('fixed', 'Fixed in 3f9c2a7e.')), [
      'no commit hashes in a note.',
    ]);
    assert.deepEqual(textErrors(note('fixed', 'Fixed commit deadbeef.')), [
      'no commit hashes in a note.',
    ]);
    assert.deepEqual(textErrors(note('fixed', 'Fixed (#123).')), [
      'no pull request numbers in a note.',
    ]);
    assert.deepEqual(textErrors(note('fixed', 'A faded decade of accessed files.')), []);
    assert.deepEqual(textErrors(note('fixed', 'Keeps 1080p files.')), []);
    assert.deepEqual(textErrors(note('changed')).length, 1);
  });
});

describe('where a note sits', () => {
  it('READMEs at any depth and the highlights are not notes', () => {
    assert.ok(isNote('.changes/a.md'));
    assert.ok(isNote('.changes/sonarr/a.md'));
    assert.ok(!isNote('.changes/README.md'));
    assert.ok(!isNote('.changes/sonarr/README.md'));
    assert.ok(!isNote('.changes/highlights.md'));
    assert.ok(!isNote('.changes/images/a.png'));
    assert.ok(!isNote('docs/a.md'));
  });

  it('flat: directly in .changes/', () => {
    assert.equal(folderOf('.changes/a.md', FLAT), null);
    assert.equal(folderOf('.changes/x/a.md', FLAT), undefined);
  });

  it('per folder: a known folder, or the flat form with the longest folder prefix', () => {
    assert.equal(folderOf('.changes/sonarr/a.md', PER), 'sonarr');
    assert.equal(folderOf('.changes/sonarr-a.md', PER), 'sonarr');
    assert.equal(folderOf('.changes/arr-common-x.md', PER), 'arr-common');
    assert.equal(folderOf('.changes/arr-x.md', PER), 'arr');
    assert.equal(folderOf('.changes/nope/a.md', PER), undefined);
    assert.equal(folderOf('.changes/a.md', PER), undefined);
    assert.equal(folderOf('.changes/sonarr/sub/a.md', PER), undefined);
  });

  it('layoutOf reads the folders from the directory', () => {
    const dir = root({
      'plugins/sonarr/package.json': '{}',
      'plugins/radarr/package.json': '{}',
      'plugins/x.txt': '',
    });
    assert.deepEqual(layoutOf(dir, 'plugins').folders.sort(), ['radarr', 'sonarr']);
    assert.deepEqual(layoutOf(dir, ''), { folders: null });
    assert.throws(() => layoutOf(dir, 'packages'), /No packages\/ directory/);
  });
});

describe('lintNotes', () => {
  it('flat: every note valid and in place', () => {
    const ok = root({
      '.changes/README.md': '# x',
      '.changes/highlights.md': 'Prose.',
      '.changes/a.md': note(),
    });
    assert.deepEqual(lintNotes(ok, FLAT), []);
    const bad = root({ '.changes/a.md': note('nope'), '.changes/x/b.md': note() });
    assert.deepEqual(lintNotes(bad, FLAT), [
      '.changes/a.md: front matter needs "type:" set to one of breaking, new, improved, fixed.',
      '.changes/x/b.md: a note is .changes/<short-name>.md, directly in .changes/.',
    ]);
  });

  it('per folder: names the missing folder, and rejects notes nested deeper', () => {
    const dir = root({
      '.changes/sonarr/README.md': '# not a note',
      '.changes/sonarr/a.md': note(),
      '.changes/nope/b.md': note(),
      '.changes/sonarr/sub/deep.md': note(),
      '.changes/c.md': note(),
    });
    assert.deepEqual(listNotes(dir), [
      '.changes/c.md',
      '.changes/nope/b.md',
      '.changes/sonarr/a.md',
      '.changes/sonarr/sub/deep.md',
    ]);
    const errors = lintNotes(dir, PER);
    assert.equal(errors.length, 3);
    assert.match(
      errors[0],
      /^\.changes\/c\.md: must be \.changes\/<folder>\/<short-name>\.md .* under plugins\/\.$/,
    );
    assert.equal(errors[1], '.changes/nope/b.md: no plugins/nope directory.');
    assert.match(errors[2], /^\.changes\/sonarr\/sub\/deep\.md: must be/);
  });

  it('no .changes/ directory is no problem', () => {
    assert.deepEqual(lintNotes(root({}), FLAT), []);
  });
});

describe('checkPullRequest', () => {
  const files = {
    '.changes/a.md': note(),
    '.changes/bad.md': note('', ''),
    '.changes/sonarr/a.md': note(),
  };
  const check = (over) =>
    checkPullRequest({ changed: [], labels: [], layout: FLAT, read: (p) => files[p], ...over });

  it('passes with a valid note', () => {
    assert.deepEqual(check({ changed: ['src/x.ts', '.changes/a.md'] }), {
      ok: true,
      messages: ['Release note found: .changes/a.md'],
    });
  });

  it('fails without a note, naming the layout and the label; a README is not a note', () => {
    const r = check({ changed: ['src/x.ts', '.changes/README.md'] });
    assert.equal(r.ok, false);
    assert.match(r.messages[0], /Add \.changes\/<short-name>\.md .* "no user-facing change" label/);
    assert.match(check({ layout: PER }).messages[0], /Add \.changes\/<folder>\/<short-name>\.md/);
  });

  it('fails an invalid or misplaced note', () => {
    assert.equal(check({ changed: ['.changes/bad.md'] }).messages.length, 2);
    assert.deepEqual(check({ changed: ['.changes/sonarr/a.md'] }).messages, [
      '.changes/sonarr/a.md: a note is .changes/<short-name>.md, directly in .changes/.',
    ]);
    assert.equal(check({ changed: ['.changes/sonarr/a.md'], layout: PER }).ok, true);
  });

  it('the label, or a skipped author, needs no note', () => {
    assert.equal(check({ labels: ['no user-facing change'] }).ok, true);
    assert.deepEqual(check({ author: 'renovate[bot]', skipAuthors: ['renovate[bot]'] }), {
      ok: true,
      messages: ['Opened by renovate[bot]: no release note needed.'],
    });
    assert.equal(check({ author: 'renovate[bot]' }).ok, false);
    assert.equal(check({ author: 'someone', skipAuthors: ['renovate[bot]'] }).ok, false);
  });
});

describe('readNotes and rendering', () => {
  it('reads one folder’s notes, flat form included, and skips other folders unread', () => {
    const dir = root({
      '.changes/README.md': '# x',
      '.changes/sonarr/a.md': note('fixed', 'Fixed a thing.'),
      '.changes/sonarr/b.md': note('new', 'Added a thing.\nOn two lines.'),
      '.changes/sonarr-c.md': note('improved', 'Flat form works.'),
      '.changes/arr/a.md': note('nope', 'Broken, but not this release’s.'),
    });
    const { notes, errors } = readNotes(dir, PER, 'sonarr');
    assert.deepEqual(errors, []);
    assert.equal(
      renderGroups(groupEntries(notes), 3),
      '### New\n\n- Added a thing. On two lines.\n\n### Improved\n\n- Flat form works.\n\n### Fixed\n\n- Fixed a thing.\n',
    );
    assert.deepEqual(readNotes(dir, PER, 'arr').errors.length, 1);
  });

  it('reads every flat note in path order, with errors for invalid ones', () => {
    const dir = root({
      '.changes/b.md': note('breaking', 'Change your config.'),
      '.changes/a.md': note('fixed', 'Fixed.'),
      '.changes/c.md': 'x',
    });
    const { notes, errors } = readNotes(dir, FLAT);
    assert.deepEqual(notes, [
      { path: '.changes/a.md', type: 'fixed', text: 'Fixed.' },
      { path: '.changes/b.md', type: 'breaking', text: 'Change your config.' },
    ]);
    assert.equal(errors.length, 2);
    assert.deepEqual(groupEntries(notes), [
      { type: 'breaking', text: 'Change your config.' },
      { type: 'fixed', text: 'Fixed.' },
    ]);
    assert.equal(
      renderGroups(groupEntries(notes), 2),
      '## Breaking\n\n- Change your config.\n\n## Fixed\n\n- Fixed.\n',
    );
    assert.equal(renderGroups([], 2), '');
  });
});
