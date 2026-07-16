// Hash-route URL builders. With the threads + overview pages folded into
// the diff page, the only routes left address the diff timeline variants.
// Threads are reopened on the diff page via `?thread=<id>`; the overview
// is a modal triggered from the diff header, not a route.
//
// Optional query objects:
// - `{ thread }`       — auto-open this thread's modal on the diff page.
// - `{ file, thread }` — focus the diff on a single file with a
//                        "← Back to thread" affordance that clears the
//                        file filter and reopens the modal.

export const ROUTES = {
  diffFull:       (q)        => withQuery('#/diff', q),
  diffLocalScope: (scope, q) => withQuery(`#/diff/local/${scope === 'staged' ? 'staged' : 'unstaged'}`, q),
  diffCommit:     (sha, q)   => withQuery(`#/diff/${sha.slice(0, 12)}`, q),
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
