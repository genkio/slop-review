import { api } from './api.js'
import { store, setState } from './store.js'
import { renderReposPage } from './pages/repos.js'
import { renderDiffPage } from './pages/diff.js'
import { renderThreadsPage } from './pages/threads.js'
import { disposeDiffView } from './diff.js'

export function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return {
    view: parts[0] || 'repos',
    id:   parts[1] ? decodeURIComponent(parts[1]) : null,
    sub:  parts[2] || null,                                                    // 'diff'
    rest: parts.slice(3).map((p) => decodeURIComponent(p)),                     // [] | ['local'] | ['c', '<sha>']
  }
}

export async function route() {
  if (!store.state) setState(await api('/api/state'))
  const { view, id, sub, rest } = parseHash()
  // Tear down the previous diff view (listeners + SSE) on any non-diff
  // route. The diff page itself runs disposeDiffView at the top of its
  // own mount, so this only matters when leaving diff for repos/threads.
  if (!(view === 'repo' && sub === 'diff')) disposeDiffView()

  // Single-repo bootstrap (npx slop-review): land directly on the
  // bootstrapped repo's threads page rather than the Repos browser, which
  // is empty/irrelevant in that mode.
  const bootstrapId = store.state?.config?.bootstrap_repo_id
  if (view === 'repos' && bootstrapId) {
    location.hash = `#/repo/${encodeURIComponent(bootstrapId)}`
    return
  }

  if (view === 'repos') return renderReposPage()
  if (view === 'repo' && id && sub === 'diff') return renderDiffPage(id, { rest })
  if (view === 'repo' && id) return renderThreadsPage(id)
  location.hash = '#/'
}
