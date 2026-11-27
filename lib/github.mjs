// A small GitHub REST client for the actions, on the runner's own fetch (no dependencies).

/**
 * `api(path, { method, body })` requests `https://api.github.com<path>` with the token and returns
 * the parsed JSON (null for 204). A response that is not ok throws with the status and its text.
 */
export function client(token, fetchImpl = globalThis.fetch) {
  return async function api(path, init = {}) {
    const method = init.method ?? 'GET';
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

/** Every item of a list endpoint (`?per_page=100&page=n`, appended to `path`). */
export async function all(api, path) {
  const out = [];
  const join = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${join}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}
