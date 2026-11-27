// Fails a pull request that changes UI files (the globs) when its description shows no image: the
// before and after screenshots a UI change needs. A label skips the check.
// Run by action.yml on a pull_request event:
//   node screenshots.mjs
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, PR_BODY, PR_LABELS (JSON list of names), PATHS
// (globs, one per line, `!` excludes), SKIP_LABEL.
import { all, client } from '../../lib/github.mjs';
import { matcher } from '../../lib/glob.mjs';
import { isMain } from '../../lib/main.mjs';

/**
 * True when the text shows an image or a recording: a Markdown image, inline `![alt](url)` or by
 * reference `![alt][label]` with its `[label]: url` definition, an HTML `<img>` or `<video>`, or a
 * GitHub attachment link (an uploaded recording is a bare link on its own line). HTML comments
 * and code (fenced blocks and inline spans) do not count: GitHub shows those as text, so a
 * template's commented-out example or a code sample is not a screenshot.
 */
export function hasImage(body) {
  const text = (body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, '')
    // An inline span stays within one paragraph.
    .replace(/(`+)(?:(?!\n\s*\n)[\s\S])*?\1/g, '');
  if (
    /!\[[^\]]*\]\(\s*<?[^\s)>]+/.test(text) ||
    /<(?:img|video)\b[^>]*\bsrc\s*=\s*["']?[^\s"'>]+/i.test(text) ||
    /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/.test(text)
  ) {
    return true;
  }
  const label = (l) => l.trim().replace(/\s+/g, ' ').toLowerCase();
  const defined = new Set(
    [...text.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*\S/gm)].map(([, l]) => label(l)),
  );
  // `![alt][label]`, `![alt][]` and `![alt]` use the label, or the alt text when it is empty.
  return [...text.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?/g)].some(([, alt, ref]) =>
    defined.has(label(ref || alt)),
  );
}

/**
 * Why the pull request fails, or null when it passes.
 * @param {{ files: string[], body: string | null, labels: string[], paths: string, skipLabel: string }} pr
 */
export function screenshotError({ files, body, labels, paths, skipLabel }) {
  if (labels.includes(skipLabel)) return null;
  const ui = files.filter(matcher(paths));
  if (ui.length === 0 || hasImage(body)) return null;
  const shown = ui.slice(0, 10).map((f) => `  ${f}`);
  if (ui.length > 10) shown.push(`  … and ${ui.length - 10} more`);
  return [
    'This pull request changes the UI but its description has no screenshot:',
    ...shown,
    `Add before and after screenshots to the description (drag them in), or, when nothing visible changed, ask a maintainer for the "${skipLabel}" label.`,
  ].join('\n');
}

export async function main(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  const labels = JSON.parse(env.PR_LABELS || '[]');
  const skipLabel = env.SKIP_LABEL || 'no screenshots needed';
  if (labels.includes(skipLabel)) {
    log(`Label "${skipLabel}" present: no screenshots needed.`);
    return 0;
  }
  if (!env.PR_NUMBER) throw new Error('No pull request: run this action on pull_request events.');
  const api = client(env.GITHUB_TOKEN ?? '', fetchImpl);
  const changed = await all(api, `/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}/files`);
  // A renamed file counts by its new name and its old one, so moving a page out of the globs counts.
  const files = changed.flatMap((f) => [
    f.filename,
    ...(f.previous_filename ? [f.previous_filename] : []),
  ]);
  const error = screenshotError({
    files,
    body: env.PR_BODY ?? '',
    labels,
    paths: env.PATHS ?? '',
    skipLabel,
  });
  if (error) {
    for (const line of error.split('\n')) log(line);
    log(
      `::error::A UI change needs before and after screenshots in its description, or the "${skipLabel}" label.`,
    );
    return 1;
  }
  log('No UI change, or the description has a screenshot.');
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main();
