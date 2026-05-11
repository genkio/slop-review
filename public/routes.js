// Hash-route URL builders. Centralised so all link-construction sites use
// the same shape — drift here would silently break navigation.
//
// Lives in its own module (rather than router.js) to avoid a circular
// import: pages/* and diff.js both need ROUTES, and router.js imports
// pages/*. ES-module lazy bindings would handle the cycle correctly today,
// but a future refactor that touches ROUTES at top-level in router.js
// would tip into a TDZ crash. One tiny file removes that risk.
//
// Optional query objects on each builder support cross-page state that
// should survive back/forward navigation:
// - `{ thread }`     — auto-open this thread's modal on the threads page.
// - `{ file, thread }` — focus the diff view on a single file with a
//                        "← Back to thread" affordance routing back to the
//                        threads page with the same thread id in the URL.

export const ROUTES = {
  threads:    (q)      => withQuery('#/', q),
  overview:   ()       => '#/overview',
  diffFull:   (q)      => withQuery('#/diff', q),
  diffLocal:  (q)      => withQuery('#/diff/local', q),
  diffCommit: (sha, q) => withQuery(`#/diff/${sha.slice(0, 12)}`, q),
}

function withQuery(path, q) {
  if (!q) return path
  const parts = []
  if (q.file)   parts.push(`file=${encodeURIComponent(q.file)}`)
  if (q.thread) parts.push(`thread=${encodeURIComponent(q.thread)}`)
  return parts.length ? `${path}?${parts.join('&')}` : path
}

// SHA shape — must not match the literal `local` (it doesn't, since
// `l`/`o` aren't hex). Kept here so the router's parseHash and any
// future caller share one definition.
export const SHA_RE = /^[0-9a-f]{7,40}$/
