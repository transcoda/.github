// Fails with annotations when PR_TITLE breaks the house style (see title-rules.mjs).
// Usage: PR_TITLE="..." node check-title.mjs (run by action.yml)
import { titleErrors } from './title-rules.mjs';

const title = process.env.PR_TITLE ?? '';
const errors = titleErrors(title);
if (errors.length > 0) {
  console.error(`Title: ${title}`);
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`Title follows the house style: ${title}`);

