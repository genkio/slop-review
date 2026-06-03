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
 * disposeDiffView at the top so a previous mount's keyboard listeners +
 * overview-nav polling are torn down before this mount takes over.
 *
 * `parsed` is the router's parsed-hash record:
 *   { kind: 'diff', variant: 'full' }
 *   { kind: 'diff', variant: 'local' }
 *   { kind: 'diff', variant: 'commit', sha: '<sha-prefix>' }
 */
export async function renderDiffPage(parsed = { variant: 'full' }, isCurrent = () => true) {
  // Always tear down a previous diff view's listeners + overview-nav
  // polling before deciding what to render here. Running this even on
  // empty-state branches is safe — the function no-ops when nothing is
  // mounted.
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

  // Tab title carries the branch so multi-tab review across branches/repos
  // stays scannable. Detached HEAD falls back to a short SHA; the repo name
  // tails as context for users running several slop-review instances at once.
  const branchLabel = branchInfo.current_branch
    || (branchInfo.head_sha ? `@${branchInfo.head_sha.slice(0, 7)}` : '(no HEAD)')
  document.title = `${branchLabel} · ${repo.display_name}`

  // Empty-state branches: render an explanatory card and stop.
  // The on-base case only counts as empty when there's literally nothing
  // to diff — no local changes AND no commits to review. The on-base
  // review fallback in `getBranchInfo` synthesises a merge-base from the
  // empty-tree SHA so `has_commits_ahead` flips to true whenever HEAD
  // resolves at all; if it stays false here, the branch is truly empty.
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
  const branchId = sanitizeBranchId(branchInfo.current_branch || '')

  // Resolve initialIndex. Precedence:
  //   1. Explicit URL variant — `#/diff/<sha>` or `#/diff/local` always
  //      wins. Honors shared/bookmarked links and the README's "URL
  //      explicitly names a sha or `local`" row.
  //   2. Saved last-visited view (per branch, in state.json) — resumes
  //      the user where they left off across restarts. Validated against
  //      the live commit list, so a force-push that removed the saved
  //      commit falls through to (3) instead of erroring.
  //   3. Smart default — feature branch lands on first commit, on-base
  //      lands on latest commit. See the table in README.
  let initialIndex = null

  // (1) Explicit variants from the URL.
  if (parsed.variant === 'local' && hasLocal) initialIndex = commits.length + 1
  else if (parsed.variant === 'commit' && parsed.sha) {
    const idx = commits.findIndex((c) => (c.sha || '').startsWith(parsed.sha))
    if (idx >= 0) initialIndex = idx
  }

  // (2) Saved last-visited view — only kicks in for bare `#/diff` (the
  // router collapses `#/` and `#/diff` both to variant 'full'). Stored
  // shape: 'full' | 'local' | 'commit:<sha>'. Anything else, or a sha
  // that no longer resolves, falls through.
  if (initialIndex === null && parsed.variant === 'full') {
    const saved = store.state?.config?.repo_ui_state?.[repo.id]?.[`last_view:${branchId}`]
    if (saved === 'full') initialIndex = commits.length
    else if (saved === 'local' && hasLocal) initialIndex = commits.length + 1
    else if (typeof saved === 'string' && saved.startsWith('commit:')) {
      const sha = saved.slice('commit:'.length)
      const idx = commits.findIndex((c) => (c.sha || '').startsWith(sha))
      if (idx >= 0) initialIndex = idx
    }
  }

  // (3) Smart default for bare `#/diff` with no saved view (or an
  // invalidated one). Two flavors keyed on whether this is a feature
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
  if (initialIndex === null) {
    initialIndex = commits.length                                 // fallback: Full
    if (commits.length > 0) initialIndex = branchInfo.on_base ? commits.length - 1 : 0
  }

  // On the base branch with only local changes → land on local view.
  if (branchInfo.on_base && hasLocal) initialIndex = commits.length + (hasLocal ? 1 : 0)

  // `?resume=1` (from `slop --sync --browser/--carbonyl`) is an opinionated
  // open: always land on the Full diff, where synced GitHub threads live, so
  // the resume step in renderDiffView has them in view regardless of the
  // saved last-view or smart default resolved above.
  if (parsed.resume) initialIndex = commits.length

  // Thread context: when `?file=…&thread=…` is in the hash, the diff
  // view filters to that one file and surfaces a "← Back to thread"
  // affordance. When only `?thread=…` is present, the diff view
  // auto-opens that thread's modal after the first thread load. Both
  // fields ride the URL (not sessionStorage) so back/forward, refresh,
  // and bookmark all route the user to the same focused view.
  const singleFile      = parsed.file || null
  const threadContextId = parsed.threadId || null
  const resumeThreads   = !!parsed.resume

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
    resumeThreads,
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
