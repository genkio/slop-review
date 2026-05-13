import { api } from '../api.js'
import { store } from '../store.js'
import { escapeHtml, sanitizeBranchId } from '../util.js'
import { renderDiffView, disposeDiffView } from '../diff.js'
import { setupOverviewNav } from '../overview-nav.js'

let emptyOverviewNavDispose = null

export function disposeDiffPage() {
  disposeDiffView()
  if (emptyOverviewNavDispose) { try { emptyOverviewNavDispose() } catch {}; emptyOverviewNavDispose = null }
}

/**
 * Diff page. Owns the empty states (detached HEAD, on-base, no origin/HEAD)
 * and delegates the actual diff rendering to renderDiffView. Always calls
 * disposeDiffView at the top so a previous mount's listeners + SSE are
 * cleaned up before this mount takes over.
 *
 * `parsed` is the router's parsed-hash record:
 *   { kind: 'diff', variant: 'full' }
 *   { kind: 'diff', variant: 'local' }
 *   { kind: 'diff', variant: 'commit', sha: '<sha-prefix>' }
 */
export async function renderDiffPage(parsed = { variant: 'full' }, isCurrent = () => true) {
  // Always tear down a previous diff view's listeners + SSE before deciding
  // what to render here. Running this even on empty-state branches is safe
  // — the function no-ops when nothing is mounted.
  disposeDiffPage()

  const repo = store.state.repos[0]
  if (!repo) return
  if (!isCurrent()) return

  const main = document.getElementById('main')
  main.innerHTML = `<div class="branch-loading">Loading…</div>`

  let branchInfo
  try {
    branchInfo = await api(`/api/repos/${encodeURIComponent(repo.id)}/branch`)
    if (!isCurrent()) return
  } catch (e) {
    if (!isCurrent()) return
    main.innerHTML = `<div class="branch-error">Failed to read branch info: ${escapeHtml(e.message)}</div>`
    return
  }

  // Empty-state branches: render an explanatory card and stop.
  // The on-base case only counts as empty when there's literally nothing
  // to diff — no local changes AND no commits to review against either
  // origin or HEAD~1 (the on-base review fallback in `getBranchInfo`
  // flips `has_commits_ahead` to true when HEAD has a parent).
  if (branchInfo.detached || !branchInfo.has_origin_head ||
      (branchInfo.on_base && !branchInfo.has_local_changes && !branchInfo.has_commits_ahead)) {
    main.innerHTML = `
      <div class="app-page repo-page">
        <div class="page-head">
          <h1>${escapeHtml(repo.display_name)}</h1>
          <div class="actions">
            <span data-overview-nav class="overview-nav-slot"></span>
          </div>
        </div>
        <div class="branch-card">${renderBranchCard(branchInfo)}</div>
      </div>`
    emptyOverviewNavDispose = setupOverviewNav(main.querySelector('[data-overview-nav]'), repo.id)
    return
  }

  // Fetch commits (only if there ARE any) so the diff view can navigate them.
  let commits = []
  if (branchInfo.has_commits_ahead) {
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/commits`)
      if (!isCurrent()) return
      commits = r?.commits || []
    } catch {
      if (!isCurrent()) return
    }
  }

  const hasLocal = !!branchInfo.has_local_changes

  // Resolve initialIndex from the parsed-hash variant.
  let initialIndex = commits.length                               // fallback: Full
  if (parsed.variant === 'local' && hasLocal) initialIndex = commits.length + 1
  else if (parsed.variant === 'commit' && parsed.sha) {
    const idx = commits.findIndex((c) => (c.sha || '').startsWith(parsed.sha))
    if (idx >= 0) initialIndex = idx
  }
  else if (commits.length > 0) {
    // Bare `#/diff` (cold launch, no explicit variant) → land on a
    // per-commit view rather than dumping the reviewer into the whole
    // cumulative diff. Two flavors keyed on whether this is a feature
    // branch or the on-base browse mode:
    //
    //   - Feature branch  → FIRST commit. The natural review flow is
    //                       "walk forward from base", so we start at
    //                       the bottom of the stack.
    //   - On-base browse  → LATEST commit. The empty-tree merge-base
    //                       fallback can synthesize hundreds of commits
    //                       (whole repo history), so anchoring at the
    //                       dawn of the project is rarely useful — the
    //                       most recent change is.
    //
    // Reload-on-Full caveat: `#/diff` is also what we emit when the user
    // is sitting on Full, so reloading there lands on first/last commit
    // instead. Acceptable: Full is one Next-click away. A separate
    // explicit-Full URL would be the cleaner fix but isn't worth the
    // route churn right now.
    initialIndex = branchInfo.on_base ? commits.length - 1 : 0
  }

  // On the base branch with only local changes → land on local view.
  if (branchInfo.on_base && hasLocal) initialIndex = commits.length + (hasLocal ? 1 : 0)

  const branchId = sanitizeBranchId(branchInfo.current_branch || '')

  // Thread context: when `?file=…&thread=…` is in the hash, the diff
  // view filters to that one file and surfaces a "← Back to thread"
  // affordance. When only `?thread=…` is present, the diff view
  // auto-opens that thread's modal after the first thread load. Both
  // fields ride the URL (not sessionStorage) so back/forward, refresh,
  // and bookmark all route the user to the same focused view.
  const singleFile      = parsed.file || null
  const threadContextId = parsed.threadId || null

  if (!isCurrent()) return
  await renderDiffView({
    repo,
    branch: branchInfo.current_branch,
    branchId,
    branchInfo,
    commits,
    initialIndex,
    hasLocal,
    singleFile,
    threadContextId,
    isCurrent,
  })
}

function renderBranchCard(info) {
  if (info.detached) {
    return `<div class="branch-empty"><b>Detached HEAD.</b> Checkout a branch in your shell and refresh the page.</div>`
  }
  if (!info.has_origin_head) {
    return `<div class="branch-empty"><b>Can't detect base branch.</b> Run <code>git remote set-head origin -a</code> in your repo, then refresh.</div>`
  }
  if (info.on_base && !info.has_local_changes && !info.has_commits_ahead) {
    return `<div class="branch-empty">You're on <code>${escapeHtml(info.base_branch)}</code> with nothing to review — no local changes and no prior commit. Make some changes or checkout a feature branch and refresh.</div>`
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
