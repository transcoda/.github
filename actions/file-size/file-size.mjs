#!/usr/bin/env node
// Fails when a file matching the globs has more lines than the budget. Files that are already over
// it are listed in an allowlist (JSON: { "path": lines }) with their current count, which may only
// shrink: a listed file that grows past its count fails, and one that got smaller fails too, asking
// for the lower number, so the list never hides room to grow again.
//   transcoda-file-size --max-lines 1200 [--allowlist file-size-allowlist.json] [--base <git-ref>]
//     <glob>... [!<glob>...]
// With --base (a pull request's base commit), the allowlist is also compared with the one at that
// commit: no entry may be added or raised there, so a file can't grow by raising its own number.
// A file that git sees as moved since the base keeps its old path's entry: the move alone adds none.
// Files are the ones git knows (tracked, plus new ones that are not ignored), from the current
// directory, which must be the repository root. Run by action.yml, and by a repository's own
// `pnpm check` through the @transcoda/dev-config bin.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { matcher } from '../../lib/glob.mjs';
import { isMain } from '../../lib/main.mjs';

/** Lines in a text, as an editor counts them: a final newline does not start another line. */
export function countLines(text) {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * Problems with the files' sizes; [] when every file is within its budget.
 * @param {Map<string, number>} sizes the lines of every file the globs match
 * @param {Record<string, number>} allowlist
 * @param {number} max
 * @param {string} allowlistPath for the messages
 * @returns {{ file: string, message: string }[]}
 */
export function sizeErrors(sizes, allowlist, max, allowlistPath) {
  const errors = [];
  for (const [file, lines] of sizes) {
    const allowed = allowlist[file];
    if (allowed === undefined) {
      if (lines > max) {
        errors.push({
          file,
          message: `${file} has ${lines} lines, over the budget of ${max}. Split it into smaller files.`,
        });
      }
    } else if (lines > allowed) {
      errors.push({
        file,
        message: `${file} grew to ${lines} lines; ${allowlistPath} allows ${allowed}, and that number may only go down. Move code out of it instead.`,
      });
    } else if (lines <= max) {
      errors.push({
        file,
        message: `${file} is down to ${lines} lines, within the budget of ${max}: remove it from ${allowlistPath}.`,
      });
    } else if (lines < allowed) {
      errors.push({
        file,
        message: `${file} shrank to ${lines} lines: lower its number in ${allowlistPath} from ${allowed} to ${lines}.`,
      });
    }
  }
  for (const file of Object.keys(allowlist)) {
    if (!sizes.has(file)) {
      errors.push({
        file: allowlistPath,
        message: `${allowlistPath} lists ${file}, which no longer exists or is no longer checked: remove it.`,
      });
    }
  }
  return errors;
}

export function parseArgs(argv) {
  const args = { max: Number.NaN, allowlist: '', base: '', globs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-lines') args.max = Number(argv[++i]);
    else if (a === '--allowlist') args.allowlist = argv[++i] ?? '';
    else if (a === '--base') args.base = argv[++i] ?? '';
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else args.globs.push(a);
  }
  if (!Number.isInteger(args.max) || args.max < 1) {
    throw new Error('Give the budget as --max-lines <n> (a whole number above 0).');
  }
  if (args.globs.length === 0) throw new Error('Give at least one glob of files to check.');
  return args;
}

function parseAllowlist(text, path) {
  const list = JSON.parse(text);
  for (const [file, lines] of Object.entries(list)) {
    if (!Number.isInteger(lines) || lines < 1) {
      throw new Error(
        `${path}: ${file} needs a whole number of lines, not ${JSON.stringify(lines)}.`,
      );
    }
  }
  return list;
}

function readAllowlist(path) {
  if (!path) return {};
  if (!existsSync(path)) throw new Error(`The allowlist ${path} does not exist.`);
  return parseAllowlist(readFileSync(path, 'utf8'), path);
}

/**
 * The allowlist at the base commit, fetched if the checkout lacks it; null when the allowlist did
 * not exist there yet (the pull request that adds it).
 */
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function readBaseAllowlist(path, base) {
  if (git('cat-file', '-e', `${base}^{commit}`).status !== 0) {
    git('fetch', '--no-tags', '--depth=1', 'origin', base);
    if (git('cat-file', '-e', `${base}^{commit}`).status !== 0) {
      throw new Error(`The base commit ${base} is not in the checkout and could not be fetched.`);
    }
  }
  const shown = git('show', `${base}:${path}`);
  return shown.status === 0 ? parseAllowlist(shown.stdout, `${path} at ${base}`) : null;
}

/**
 * Moved files from `git diff --name-status -z --find-renames` output: new path -> old path.
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function parseRenames(output) {
  const renames = new Map();
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    if (!status) break;
    if (status.startsWith('R')) {
      renames.set(fields[i + 2], fields[i + 1]);
      i += 3;
    } else {
      i += status.startsWith('C') ? 3 : 2;
    }
  }
  return renames;
}

/** Files moved between the base commit and the working tree, as git's rename detection sees them. */
function readRenames(base) {
  const diff = git('diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', base);
  if (diff.status !== 0) throw new Error(`Could not compare with ${base}: ${diff.stderr.trim()}`);
  return parseRenames(diff.stdout);
}

/**
 * Entries the allowlist adds or raises compared with the base's: both only hide growth. An entry
 * for a file moved since the base (`renames`: new path -> old path) compares with the old path's.
 * @param {Record<string, number>} allowlist
 * @param {Record<string, number>} base
 * @param {string} path
 * @param {Map<string, string>} [renames]
 */
export function baselineErrors(allowlist, base, path, renames = new Map()) {
  const errors = [];
  for (const [file, lines] of Object.entries(allowlist)) {
    const from = base[file] === undefined ? renames.get(file) : undefined;
    const before = from === undefined ? base[file] : base[from];
    const name = from !== undefined && before !== undefined ? `${file} (moved from ${from})` : file;
    if (before === undefined) {
      errors.push({
        file: path,
        message: `${path} adds ${file}; the allowlist only takes files away. Split the file instead.`,
      });
    } else if (lines > before) {
      errors.push({
        file: path,
        message: `${path} raises ${name} from ${before} to ${lines} lines; the numbers may only go down. Move code out of it instead.`,
      });
    }
  }
  return errors;
}

/** Runs the check in the current directory; returns the exit code. */
export function run(argv, env = process.env, out = console.log, err = console.error) {
  let args;
  let allowlist;
  let base = null;
  let renames = new Map();
  let matches;
  try {
    args = parseArgs(argv);
    matches = matcher(args.globs);
    allowlist = readAllowlist(args.allowlist);
    if (args.base && args.allowlist) base = readBaseAllowlist(args.allowlist, args.base);
    if (base) renames = readRenames(args.base);
  } catch (error) {
    err(error.message);
    return 2;
  }
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((f) => f && matches(f) && existsSync(f));
  const sizes = new Map(files.map((f) => [f, countLines(readFileSync(f, 'utf8'))]));
  const listName = args.allowlist || 'the allowlist';
  const errors = [
    ...(base ? baselineErrors(allowlist, base, listName, renames) : []),
    ...sizeErrors(sizes, allowlist, args.max, listName),
  ];
  for (const e of errors) {
    err(env.GITHUB_ACTIONS === 'true' ? `::error file=${e.file}::${e.message}` : e.message);
  }
  if (errors.length > 0) return 1;
  const listed = Object.keys(allowlist).length;
  out(
    `${files.length} files within ${args.max} lines${listed > 0 ? ` (${listed} allowlisted at their current size)` : ''}.`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
