import { api } from './api.js'
import { store, setState } from './store.js'
import { renderDiffPage, disposeDiffPage } from './pages/diff.js'
import { renderThreadsPage, disposeThreadsView } from './pages/threads.js'
import { renderOverviewPage, disposeOverviewView } from './pages/overview.js'
import { ROUTES, SHA_RE } from './routes.js'

let routeRunId = 0

// Hash routes (post multi-repo removal — only one repo, so no `/repo/<id>`
// segment in user-facing URLs):
//
//   #/                threads page (default home)
//   #/overview        generated branch overview
//   #/diff            full diff
//   #/diff/local      local diff
//   #/diff/<sha>      per-commit diff (sha = SHA_RE)
//
// Anything else redirects to `#/`. The active repo is always the bootstrap
// repo (state.config.bootstrap_repo_id), looked up via store.state.repos[0]
// inside the page renderers.

export function parseHash() {
  // Strip leading `#/`, then peel off any `?query` segment before path-
  // splitting. Query params survive on top of every recognised route
  // (e.g. `#/?thread=…` for modal-reopen, `#/diff?file=…&thread=…` for
  // the single-file thread-context view).
  const raw = location.hash.replace(/^#\/?/, '')
  const qIdx = raw.indexOf('?')
  const pathPart  = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const queryPart = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
  const parts = pathPart.split('/').filter(Boolean)
  const query = parseQuery(queryPart)
  const file     = query.file     || null
  const threadId = query.thread   || null

  if (parts.length === 0) return { kind: 'threads', threadId }
  if (parts[0] === 'overview' && parts.length === 1) return { kind: 'overview' }
  if (parts[0] === 'diff') {
    if (parts.length === 1) return { kind: 'diff', variant: 'full', file, threadId }
    if (parts[1] === 'local') return { kind: 'diff', variant: 'local', file, threadId }
    if (SHA_RE.test(parts[1])) return { kind: 'diff', variant: 'commit', sha: parts[1], file, threadId }
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
  // Tear down each page's external resources (DOM listeners, SSE) when
  // leaving it. Each page also disposes itself at the top of its mount,
  // so these calls only matter on the cross-page transition.
  if (parsed.kind !== 'diff') disposeDiffPage()
  if (parsed.kind !== 'threads') disposeThreadsView()
  if (parsed.kind !== 'overview') disposeOverviewView()

  if (!store.state?.config?.bootstrap_repo_id) {
    if (!isCurrent()) return
    document.getElementById('main').innerHTML =
      '<div class="branch-error">No repo configured. Run via <code>npx slop-review</code> inside a git repo.</div>'
    return
  }

  if (parsed.kind === 'diff') return renderDiffPage(parsed, isCurrent)
  if (parsed.kind === 'overview') return renderOverviewPage(isCurrent)
  if (parsed.kind === 'threads') {
    // Diff is the default landing page on a repo with no threads — the
    // empty threads page would just tell the user to "open the diff",
    // so we send them there directly. Once a thread exists, the threads
    // page becomes useful and this redirect is skipped.
    if (await currentBranchHasNoThreads()) {
      if (!isCurrent()) return
      location.hash = ROUTES.diffFull()
      return
    }
    if (!isCurrent()) return
    return renderThreadsPage(parsed, isCurrent)
  }
  // Unknown route → home.
  if (!isCurrent()) return
  location.hash = ROUTES.threads()
}

async function currentBranchHasNoThreads() {
  try {
    const id = store.state.config.bootstrap_repo_id
    const r = await api(`/api/repos/${encodeURIComponent(id)}/threads`)
    return (r?.threads || []).length === 0
  } catch {
    // On error (no current branch, repo missing, etc.) fall through to the
    // threads page so its own error handling can show the message.
    return false
  }
}
