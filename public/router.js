import { api } from './api.js'
import { store, setState } from './store.js'
import { renderDiffPage } from './pages/diff.js'
import { renderThreadsPage, disposeThreadsView } from './pages/threads.js'
import { disposeDiffView } from './diff.js'
import { ROUTES, SHA_RE } from './routes.js'

let routeRunId = 0

// Hash routes (post multi-repo removal — only one repo, so no `/repo/<id>`
// segment in user-facing URLs):
//
//   #/                threads page (default home)
//   #/diff            full diff
//   #/diff/local      local diff
//   #/diff/<sha>      per-commit diff (sha = SHA_RE)
//
// Anything else redirects to `#/`. The active repo is always the bootstrap
// repo (state.config.bootstrap_repo_id), looked up via store.state.repos[0]
// inside the page renderers.

export function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts.length === 0) return { kind: 'threads' }
  if (parts[0] === 'diff') {
    if (parts.length === 1) return { kind: 'diff', variant: 'full' }
    if (parts[1] === 'local') return { kind: 'diff', variant: 'local' }
    if (SHA_RE.test(parts[1])) return { kind: 'diff', variant: 'commit', sha: parts[1] }
  }
  return { kind: 'unknown' }
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
  if (parsed.kind !== 'diff') disposeDiffView()
  if (parsed.kind !== 'threads') disposeThreadsView()

  if (!store.state?.config?.bootstrap_repo_id) {
    if (!isCurrent()) return
    document.getElementById('main').innerHTML =
      '<div class="branch-error">No repo configured. Run via <code>npx slop-review</code> inside a git repo.</div>'
    return
  }

  if (parsed.kind === 'diff') return renderDiffPage(parsed, isCurrent)
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
    return renderThreadsPage(isCurrent)
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
