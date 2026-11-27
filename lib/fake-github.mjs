// A stand-in for api.github.com in tests: routes answer by "METHOD path", and every call is kept.

/** `routes` maps "GET /repos/o/r/issues?..." (exact) to a value or a function of the body. */
export function fakeGitHub(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.replace('https://api.github.com', '');
    const key = `${init.method} ${path}`;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ key, body, auth: init.headers.authorization });
    if (!(key in routes)) return new Response(`no route for ${key}`, { status: 404 });
    const value = typeof routes[key] === 'function' ? routes[key](body) : routes[key];
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { fetch, calls };
}
