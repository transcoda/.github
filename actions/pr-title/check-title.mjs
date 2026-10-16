// Checks a pull request title against the Transcoda house style:
//   <Area>: <what changed>
// The area names the part of the project (`Plugins`, `CI`, `Damaged sources`,
// `Radarr, Sonarr`, `SDK 1.0.1`) and starts with a capital letter or a digit.
// Squash merges use the title as the commit message, so this also keeps main's history readable.
// Usage: PR_TITLE="..." node check-title.mjs (run by action.yml)

/** Problems with `title`, as strings; [] when it follows the house style. */
export function titleErrors(title) {
  if (title !== title.trim()) return ['Remove the spaces at the start or end of the title.'];
  const match = /^([^:]+): (.*)$/.exec(title);
  if (!match) {
    return ['Start the title with an area and a colon, e.g. "Plugins: warn when a mapping is missing".'];
  }
  const [, area, description] = match;
  const errors = [];
  if (!/^[A-Z0-9]/.test(area)) {
    errors.push(
      `The area "${area}" must start with a capital letter or a digit (house style, not conventional commits like "feat:" or "chore(deps):").`,
    );
  }
  if (/[()]/.test(area)) errors.push(`The area "${area}" can't have a (scope) in parentheses.`);
  if (!description.trim() || description !== description.trimStart()) {
    errors.push('Put one space after the colon, then say what changed.');
  }
  if (description.endsWith('.')) errors.push('Leave out the full stop at the end.');
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.env.PR_TITLE ?? '';
  const errors = titleErrors(title);
  if (errors.length > 0) {
    console.error(`Title: ${title}`);
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(`Title follows the house style: ${title}`);
}
