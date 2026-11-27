// Issues that track one thing each (a failing test, a red workflow): found again by a marker in the
// body, commented on while it still fails, and closed once it passes. Shared by the nightly-issues
// and main-red actions; each plans its own actions and hands them to apply().

import { all } from './github.mjs';

/**
 * @typedef {{ number: number, id: string }} OpenIssue  an open issue and the id from its marker
 * @typedef {{ kind: 'create', id: string, title: string, body: string }
 *   | { kind: 'comment', number: number, body: string }
 *   | { kind: 'close', number: number, body: string }} Action
 */

/** The hidden line an issue body carries so the issue is found again: `<!-- kind: id -->`. */
export function marker(kind, id) {
  return `<!-- ${kind}: ${id} -->`;
}

/** The id in an issue body's marker of this kind; null for a body without one. */
export function idOf(body, kind) {
  const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!-- ${escaped}: (.+?) -->`).exec(body ?? '')?.[1] ?? null;
}

/** The open issues (not pull requests) with this label that carry a marker of this kind. */
export async function openIssues(api, repo, label, kind) {
  const issues = await all(
    api,
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
  );
  const out = [];
  for (const i of issues) {
    const id = i.pull_request ? null : idOf(i.body, kind);
    if (id !== null) out.push({ number: i.number, id });
  }
  return out;
}

/**
 * Carries out the actions: opens issues with the label, comments, and comments then closes. Right
 * before each create it lists the open issues again and skips the create when one with the same
 * marker has appeared since the plan (another run of the same workflow got there first).
 */
export async function apply(api, repo, label, kind, actions, log = console.log) {
  for (const a of actions) {
    if (a.kind === 'create') {
      const open = (await openIssues(api, repo, label, kind)).find((i) => i.id === a.id);
      if (open) {
        log(`#${open.number} is already open for ${a.id}`);
        continue;
      }
      const issue = await api(`/repos/${repo}/issues`, {
        method: 'POST',
        body: { title: a.title, body: a.body, labels: [label] },
      });
      log(`opened #${issue.number}: ${a.title}`);
      continue;
    }
    await api(`/repos/${repo}/issues/${a.number}/comments`, {
      method: 'POST',
      body: { body: a.body },
    });
    if (a.kind === 'close') {
      await api(`/repos/${repo}/issues/${a.number}`, {
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      });
    }
    log(`${a.kind === 'close' ? 'closed' : 'commented on'} #${a.number}`);
  }
}

/** One line per action, for a dry run. */
export function describe(actions) {
  return actions.map((a) =>
    a.kind === 'create' ? `would open: ${a.title}` : `would ${a.kind} #${a.number}`,
  );
}
