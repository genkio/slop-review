import { api } from './api.js'
import { store, setState } from './store.js'
import { renderDiffPage, disposeDiffPage } from './pages/diff.js'
import { ROUTES, SHA_RE } from './routes.js'

let routeRunId = 0

// Hash routes (post-collapse to single-page diff app — threads and
// overview pages were folded into the diff page; threads reopen via
// `?thread=` and overview is a modal triggered from the diff header):
//
//   #/             → aliased to #/diff (full)
//   #/diff         → full diff
//   #/diff/local   → unstaged changes (legacy alias)
//   #/diff/local/staged | /unstaged → scoped local changes
//   #/diff/<sha>   → per-commit diff (sha = SHA_RE)
//
// Anything else redirects to #/diff. The active repo is always the
// bootstrap repo (state.config.bootstrap_repo_id), looked up via
// store.state.repos[0] inside the page renderer.

export function parseHash() {
  // Strip leading `#/`, then peel off any `?query` segment before path-
  // splitting. Query params survive on top of every route
  // (`?thread=…` for modal-reopen, `?file=…&thread=…` for single-file
  // thread-context view).
  const raw = location.hash.replace(/^#\/?/, '')
  const qIdx = raw.indexOf('?')
  const pathPart  = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
  const parts = pathPart.split('/').filter(Boolean)
  const query = parseQuery(queryPart)
  const file     = query.file     || null
  const threadId = query.thread   || null
  // One-shot resume hint set by `slop --sync --browser/--carbonyl`: after the
  // diff mounts, open the first unresolved thread's modal (see renderDiffView).
  const resume   = query.resume === '1'
  // One-shot hint set by `slop --overview`: after the diff mounts, open the
  // (just-generated) overview modal (see renderDiffPage).
  const overview = query.overview === '1'

  // Bare `#/` is the only non-diff path left — alias to the full diff so
  // bookmarks against the pre-collapse threads/overview homepages keep
  // landing somewhere useful.
  if (parts.length === 0) return { kind: 'diff', variant: 'full', file, threadId, resume, overview }
  if (parts[0] === 'diff') {
    if (parts.length === 1) return { kind: 'diff', variant: 'full', file, threadId, resume, overview }
    if (parts[1] === 'local') {
      const scope = parts[2] || 'unstaged'
      if (parts.length <= 3 && ['all', 'staged', 'unstaged'].includes(scope)) {
        return { kind: 'diff', variant: 'local', scope: scope === 'staged' ? 'staged' : 'unstaged', file, threadId, resume, overview }
      }
      return { kind: 'unknown' }
    }
    if (SHA_RE.test(parts[1])) return { kind: 'diff', variant: 'commit', sha: parts[1], file, threadId, resume, overview }
  }
  return { kind: 'unknown' }
}

function parseQuery(s) {
  if (!s) return {}
  const out = {}
  for (const pair of s.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const k = eq < 0 ? pair : pair.slice(0, eq)
    const v = eq < 0 ? ''   : pair.slice(eq + 1)
    try { out[decodeURIComponent(k)] = decodeURIComponent(v) }
    catch { /* malformed param — skip silently */ }
  }
  return out
}

export async function route() {
  const runId = ++routeRunId
  const isCurrent = () => runId === routeRunId

  if (!store.state) {
    const nextState = await api('/api/state')
    if (!isCurrent()) return
    setState(nextState)
  }
  const parsed = parseHash()

  if (!store.state?.config?.bootstrap_repo_id) {
    if (!isCurrent()) return
    disposeDiffPage()
    document.getElementById('main').innerHTML =
      '<div class="branch-error">No repo configured. Run via <code>npx slop-review</code> inside a git repo.</div>'
    return
  }

  if (parsed.kind === 'diff') return renderDiffPage(parsed, isCurrent)

  // Unknown route → home.
  if (!isCurrent()) return
  location.hash = ROUTES.diffFull()
}
