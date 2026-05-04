import { api } from '../api.js'
import { store } from '../store.js'
import { escapeHtml, renderCrumb } from '../util.js'
import { renderDiffView, disposeDiffView } from '../diff.js'

/**
 * Diff page. Owns the empty states (detached HEAD, on-base, no origin/HEAD)
 * and delegates the actual diff rendering to renderDiffView. Always calls
 * disposeDiffView at the top so a previous mount's listeners + SSE are
 * cleaned up before this mount takes over.
 *
 * URL `rest` segments:
 *   []           → Full diff (default)
 *   ['local']    → Local diff
 *   ['c', sha]   → Per-commit diff matching that SHA prefix
 */
export async function renderDiffPage(repoId, { rest = [] } = {}) {
  // Always tear down a previous diff view's listeners + SSE before deciding
  // what to render here. Running this even on empty-state branches is safe
  // — the function no-ops when nothing is mounted.
  disposeDiffView()

  const repo = store.state.repos.find((r) => r.id === repoId)
  if (!repo) { location.hash = '#/'; return }

  renderCrumb([
    { label: 'Repos', href: '#/' },
    { label: repo.display_name },
  ])

  const main = document.getElementById('main')
  main.innerHTML = `<div class="branch-loading">Loading…</div>`

  let branchInfo
  try {
    branchInfo = await api(`/api/repos/${encodeURIComponent(repo.id)}/branch`)
  } catch (e) {
    main.innerHTML = `<div class="branch-error">Failed to read branch info: ${escapeHtml(e.message)}</div>`
    return
  }

  // Update the breadcrumb with the current branch (or empty-state hint).
  if (branchInfo.current_branch) {
    renderCrumb([
      { label: 'Repos', href: '#/' },
      { label: repo.display_name, href: `#/repo/${encodeURIComponent(repo.id)}` },
      { label: branchInfo.current_branch + ' · diff' },
    ])
  }

  // Empty-state branches: render an explanatory card and stop.
  if (branchInfo.detached || !branchInfo.has_origin_head ||
      (branchInfo.on_base && !branchInfo.has_local_changes)) {
    main.innerHTML = `
      <div class="repo-page">
        <div class="page-head">
          <h1>${escapeHtml(repo.display_name)}</h1>
          <div class="actions">
            <a class="btn" href="#/repo/${encodeURIComponent(repo.id)}">Threads</a>
          </div>
        </div>
        <div class="branch-card">${renderBranchCard(branchInfo)}</div>
      </div>`
    return
  }

  // Fetch commits (only if there ARE any) so the diff view can navigate them.
  let commits = []
  if (branchInfo.has_commits_ahead) {
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/commits`)
      commits = r?.commits || []
    } catch {}
  }

  const hasLocal = !!branchInfo.has_local_changes

  // Resolve initialIndex from URL `rest`.
  let initialIndex = commits.length                               // default: Full
  if (rest[0] === 'local' && hasLocal) initialIndex = commits.length + 1
  else if (rest[0] === 'c' && rest[1]) {
    const wanted = rest[1]
    const idx = commits.findIndex((c) => (c.sha || '').startsWith(wanted))
    if (idx >= 0) initialIndex = idx
  }

  // On the base branch with only local changes → land on local view.
  if (branchInfo.on_base && hasLocal) initialIndex = commits.length + (hasLocal ? 1 : 0)

  // Read + clear the one-shot scroll target stashed by the threads page.
  let scrollToAnchor = null
  try {
    const raw = sessionStorage.getItem('slop-review:jump-to')
    if (raw) {
      scrollToAnchor = JSON.parse(raw)
      sessionStorage.removeItem('slop-review:jump-to')
    }
  } catch {}

  const branchId = sanitizeBranchId(branchInfo.current_branch || '')

  await renderDiffView({
    repo,
    branch: branchInfo.current_branch,
    branchId,
    branchInfo,
    commits,
    initialIndex,
    hasLocal,
    scrollToAnchor,
  })
}

function sanitizeBranchId(branch) {
  if (!branch) return ''
  let s = String(branch).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

function renderBranchCard(info) {
  if (info.detached) {
    return `<div class="branch-empty"><b>Detached HEAD.</b> Checkout a branch in your shell and refresh the page.</div>`
  }
  if (!info.has_origin_head) {
    return `<div class="branch-empty"><b>Can't detect base branch.</b> Run <code>git remote set-head origin -a</code> in your repo, then refresh.</div>`
  }
  if (info.on_base && !info.has_local_changes) {
    return `<div class="branch-empty">You're on <code>${escapeHtml(info.base_branch)}</code> with no local changes. Checkout a feature branch and refresh.</div>`
  }
  const lines = []
  if (info.current_branch)  lines.push(`<div><b>Branch:</b> <code>${escapeHtml(info.current_branch)}</code></div>`)
  if (info.base_branch)     lines.push(`<div><b>Base:</b> <code>${escapeHtml(info.base_branch)}</code></div>`)
  if (info.head_sha)        lines.push(`<div><b>HEAD:</b> <code>${escapeHtml(info.head_sha.slice(0, 12))}</code></div>`)
  if (info.has_commits_ahead === false && !info.has_local_changes) {
    lines.push(`<div class="branch-note">No commits ahead of base, no local changes — opening empty.</div>`)
  }
  return `<div class="branch-info">${lines.join('')}</div>`
}
