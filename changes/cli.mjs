#!/usr/bin/env node
// The release-note checks on the command line (bin `transcoda-release-note` of
// @transcoda/dev-config, and the release-note action):
//   transcoda-release-note lint [--per-folder <dir>]
//       validates every note in .changes/ (for a repository's `pnpm check`)
//   transcoda-release-note check <base-sha> <head-sha> <labels-json> [<author>]
//       [--per-folder <dir>] [--skip-authors <login,login>]
//       a pull request must add or change a valid note, or carry the "no user-facing change"
//       label; pull requests by a skipped author need neither
// --per-folder <dir> selects the per-folder layout, with a note folder per directory under <dir>.
// Runs in the repository root (a git checkout).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from '../lib/main.mjs';
import { checkPullRequest, layoutOf, lintNotes } from './notes.mjs';

const USAGE = `usage: transcoda-release-note lint [--per-folder <dir>]
       transcoda-release-note check <base-sha> <head-sha> <labels-json> [<author>] [--per-folder <dir>] [--skip-authors <a,b>]`;

export function parseArgs(argv) {
  const args = { command: argv[0], perFolder: '', skipAuthors: [], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--per-folder') args.perFolder = argv[++i] ?? '';
    else if (a === '--skip-authors') {
      args.skipAuthors = (argv[++i] ?? '').split(/[\s,]+/).filter(Boolean);
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.\n${USAGE}`);
    else args.positional.push(a);
  }
  const counts = { lint: [0, 0], check: [3, 4] };
  const [min, max] = counts[args.command] ?? [];
  if (min === undefined || args.positional.length < min || args.positional.length > max) {
    throw new Error(USAGE);
  }
  return args;
}

/** Runs a command in `root`; returns the exit code. */
export function run(argv, root = process.cwd(), out = console.log, err = console.error) {
  let args;
  let layout;
  try {
    args = parseArgs(argv);
    layout = layoutOf(root, args.perFolder);
  } catch (error) {
    err(error.message);
    return 2;
  }
  if (args.command === 'lint') {
    const errors = lintNotes(root, layout);
    for (const e of errors) err(e);
    if (errors.length === 0) out('Every release note in .changes/ is valid.');
    return errors.length === 0 ? 0 : 1;
  }
  const [base, head, labelsJson, author = ''] = args.positional;
  const changed = execFileSync(
    'git',
    // Renamed counts by its new name (a note moved into .changes/); -z keeps names unquoted.
    ['diff', '--name-only', '-z', '--diff-filter=AMR', `${base}...${head}`],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean);
  const { ok, messages } = checkPullRequest({
    changed,
    labels: JSON.parse(labelsJson),
    author,
    skipAuthors: args.skipAuthors,
    layout,
    read: (p) => readFileSync(`${root}/${p}`, 'utf8'),
  });
  for (const m of messages) (ok ? out : err)(m);
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
