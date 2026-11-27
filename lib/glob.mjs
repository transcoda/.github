// Glob patterns for repository paths (always with `/`), shared by the file-size and screenshots
// checks. `**` matches any number of directories, `*` and `?` stay within one path segment, and
// `{a,b}` is either alternative. A pattern that starts with `!` excludes what it matches.

/** A regular expression for one pattern (without its `!`). */
export function globToRegExp(pattern) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` is zero or more directories; a trailing `**` is anything.
      if (pattern[i + 2] === '/') {
        re += '(?:[^/]*/)*';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * A test for paths: true when a path matches at least one pattern and no `!` pattern.
 * `patterns` is text or a list of texts, one pattern per line (blank lines and `#` comments skipped).
 */
export function matcher(patterns) {
  const list = [patterns]
    .flat()
    .flatMap((p) => p.split('\n'))
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
  const include = list.filter((p) => !p.startsWith('!')).map(globToRegExp);
  const exclude = list.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  if (include.length === 0) throw new Error('No glob patterns to match (only exclusions).');
  return (path) => include.some((r) => r.test(path)) && !exclude.some((r) => r.test(path));
}
