// The `.changes/` release-note format shared by the transcoda repositories: one small Markdown
// file per user-facing change,
//
//   ---
//   type: improved
//   ---
//   One or two sentences for people who use it.
//
// `type` is one of breaking, new, improved, fixed. Notes are grouped under those headings when a
// release is cut. A README.md (at any depth) is not a note, nor is `.changes/highlights.md` (the
// prose a minor release can open with; core's release script handles it).
//
// Two layouts:
// - flat (core): `.changes/<short-name>.md`.
// - per folder (plugins): `.changes/<folder>/<short-name>.md`, or the flat
//   `.changes/<folder>-<short-name>.md`, where <folder> names a directory under one directory of
//   the repository (`plugins/`), because each of those is released on its own.
// A layout is { folders: null } (flat) or { folders: ['sonarr', ...] }; layoutOf() builds it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR = '.changes';
export const TYPES = ['breaking', 'new', 'improved', 'fixed'];
export const HEADINGS = { breaking: 'Breaking', new: 'New', improved: 'Improved', fixed: 'Fixed' };
/** The label that says a pull request needs no note. */
export const NO_NOTE_LABEL = 'no user-facing change';
/** Optional prose and screenshots for a minor or major release, kept apart from the notes. */
export const HIGHLIGHTS = 'highlights.md';

/**
 * @typedef {{ folders: string[] | null }} Layout
 * @typedef {{ path: string, type: string, text: string }} Note
 */

/** The flat layout, or the per-folder one with a folder per directory under `root/perFolder`. */
export function layoutOf(root, perFolder) {
  if (!perFolder) return { folders: null };
  const dir = join(root, perFolder);
  if (!existsSync(dir)) throw new Error(`No ${perFolder}/ directory for the note folders.`);
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return { folders, perFolder };
}

/** Whether a repository path (with `/`) is a note: a .md under .changes/, but no README or highlights. */
export function isNote(path) {
  return (
    path.startsWith(`${DIR}/`) &&
    path.endsWith('.md') &&
    !/(?:^|\/)README\.md$/.test(path) &&
    path !== `${DIR}/${HIGHLIGHTS}`
  );
}

/**
 * The folder a note belongs to in the per-folder layout (null in the flat layout); undefined when
 * the note sits where the layout has no place for it. The flat per-folder form takes the longest
 * folder name it starts with.
 * @param {string} path
 * @param {Layout} layout
 * @returns {string | null | undefined}
 */
export function folderOf(path, layout) {
  const rest = path.slice(DIR.length + 1);
  const parts = rest.split('/');
  if (layout.folders === null) return parts.length === 1 ? null : undefined;
  if (parts.length === 2) return layout.folders.includes(parts[0]) ? parts[0] : undefined;
  if (parts.length !== 1) return undefined;
  const matches = layout.folders.filter((f) => rest.startsWith(`${f}-`));
  return matches.sort((a, b) => b.length - a.length)[0];
}

/** Why a note is in the wrong place, or null. */
export function locationError(path, layout) {
  if (folderOf(path, layout) !== undefined) return null;
  if (layout.folders === null)
    return `${path}: a note is .changes/<short-name>.md, directly in .changes/.`;
  const where = layout.perFolder ?? 'the note folders';
  const nested = /^\.changes\/([^/]+)\/[^/]+$/.exec(path);
  if (nested) return `${path}: no ${where}/${nested[1]} directory.`;
  return `${path}: must be .changes/<folder>/<short-name>.md (or .changes/<folder>-<short-name>.md), where <folder> is a directory under ${where}/.`;
}

/**
 * A note's type and text (its lines joined into one), or what is wrong with its format.
 * @returns {{ type: string, text: string } | { errors: string[] }}
 */
export function parseNote(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const type = match ? /^type:\s*(\S+)\s*$/m.exec(match[1])?.[1] : undefined;
  const body = match ? match[2].trim().replace(/\s*\n\s*/g, ' ') : '';
  const errors = [];
  if (!type || !TYPES.includes(type)) {
    errors.push(`front matter needs "type:" set to one of ${TYPES.join(', ')}.`);
  }
  if (!body) errors.push('the note text is empty.');
  return errors.length > 0 ? { errors } : { type, text: body };
}

/**
 * Everything wrong with a note's text: its format, and commit hashes or pull request numbers in
 * it (notes are for people who use the software, not for developers).
 */
export function textErrors(text) {
  const parsed = parseNote(text);
  if ('errors' in parsed) return parsed.errors;
  const errors = [];
  // A hash with digits and letters anywhere, or any hex word after "commit" or "sha" (so an
  // all-letter abbreviation such as deadbeef counts there, but ordinary words do not).
  if (
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.test(parsed.text) ||
    /\b(?:commit|sha)\s*:?\s+[0-9a-f]{7,40}\b/i.test(parsed.text)
  ) {
    errors.push('no commit hashes in a note.');
  }
  if (/(?<![\w&])#\d+\b/.test(parsed.text)) errors.push('no pull request numbers in a note.');
  return errors;
}

/** Everything wrong with one note: where it sits first, then its text. Each starts with the path. */
export function noteErrors(path, text, layout) {
  const where = locationError(path, layout);
  if (where) return [where];
  return textErrors(text).map((e) => `${path}: ${e}`);
}

/** Every note path under root/.changes (any depth, so misplaced ones are found), sorted. */
export function listNotes(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (isNote(path)) out.push(path);
    }
  };
  if (existsSync(join(root, DIR))) walk(DIR);
  return out.sort();
}

/** The problems of every note in the repository; [] when all are fine. */
export function lintNotes(root, layout) {
  return listNotes(root).flatMap((p) => noteErrors(p, readFileSync(join(root, p), 'utf8'), layout));
}

/**
 * The pull request check: it passes with the no-note label, for a skipped author (Renovate), or
 * when it adds or changes at least one note and every such note is valid.
 * @param {{ changed: string[], labels: string[], author?: string, skipAuthors?: string[],
 *   layout: Layout, read: (path: string) => string }} pr  `changed`: paths added or modified
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function checkPullRequest({ changed, labels, author = '', skipAuthors = [], layout, read }) {
  if (author && skipAuthors.includes(author)) {
    return { ok: true, messages: [`Opened by ${author}: no release note needed.`] };
  }
  if (labels.includes(NO_NOTE_LABEL)) {
    return { ok: true, messages: [`Label "${NO_NOTE_LABEL}" present: no release note needed.`] };
  }
  const notes = changed.filter(isNote);
  if (notes.length === 0) {
    const where =
      layout.folders === null ? '.changes/<short-name>.md' : '.changes/<folder>/<short-name>.md';
    return {
      ok: false,
      messages: [
        `No release note found. Add ${where} (see .changes/README.md), or ask a maintainer to add the "${NO_NOTE_LABEL}" label.`,
      ],
    };
  }
  const errors = notes.flatMap((p) => noteErrors(p, read(p), layout));
  if (errors.length > 0) return { ok: false, messages: errors };
  return { ok: true, messages: [`Release note found: ${notes.join(', ')}`] };
}

/**
 * The notes waiting for a release, sorted by path: all of them, or only one folder's in the
 * per-folder layout. Invalid or misplaced notes come back as errors instead (another folder's
 * notes are left out unread).
 * @returns {{ notes: Note[], errors: string[] }}
 */
export function readNotes(root, layout, folder) {
  const notes = [];
  const errors = [];
  for (const path of listNotes(root)) {
    // Another folder's notes are not this release's business; a misplaced note is.
    const owner = folderOf(path, layout);
    if (folder !== undefined && owner !== undefined && owner !== folder) continue;
    const text = readFileSync(join(root, path), 'utf8');
    const problems = noteErrors(path, text, layout);
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    const parsed = /** @type {{ type: string, text: string }} */ (parseNote(text));
    notes.push({ path, ...parsed });
  }
  return { notes, errors };
}

/** The notes as { type, text } entries in heading order (breaking, new, improved, fixed). */
export function groupEntries(notes) {
  return TYPES.flatMap((type) =>
    notes.filter((n) => n.type === type).map(({ text }) => ({ type, text })),
  );
}

/**
 * The entries as Markdown: a heading of `level` per type that has entries, then a bullet per entry.
 * Empty text for no entries.
 */
export function renderGroups(entries, level) {
  return TYPES.map((type) => {
    const items = entries.filter((e) => e.type === type);
    if (items.length === 0) return '';
    return `${'#'.repeat(level)} ${HEADINGS[type]}\n\n${items.map((e) => `- ${e.text}`).join('\n')}\n`;
  })
    .filter(Boolean)
    .join('\n');
}
