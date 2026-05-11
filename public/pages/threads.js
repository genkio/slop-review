import { api } from '../api.js'
import { store } from '../store.js'
import { escapeHtml, inlineCode, relTime } from '../util.js'
import { openThreadModal } from '../modals.js'
import { subscribeRepoEvents, unsubscribeRepoEvents } from '../sse.js'
import { ROUTES } from '../routes.js'
import { setupOverviewNav } from '../overview-nav.js'

let currentSseUnsub = null
let currentOverviewNavDispose = null

/**
 * Thread browser page. Lists every thread on the current branch with state
 * pills (your turn / awaiting / read), grouped by file in priority order,
 * with counts at the top. Live-updates via SSE.
 */
export async function renderThreadsPage(isCurrent = () => true) {
  const repo = store.state.repos[0]
  if (!repo) { location.hash = ROUTES.threads(); return }
  if (!isCurrent()) return

  // Tear down any prior SSE subscription before rebinding to this page.
  if (currentSseUnsub) { try { currentSseUnsub() } catch {}; currentSseUnsub = null }
  if (currentOverviewNavDispose) { try { currentOverviewNavDispose() } catch {}; currentOverviewNavDispose = null }

  let branchInfo
  try {
    branchInfo = await api(`/api/repos/${encodeURIComponent(repo.id)}/branch`)
    if (!isCurrent()) return
  } catch (e) {
    if (!isCurrent()) return
    document.getElementById('main').innerHTML = `<div class="branch-error">Failed to read branch info: ${escapeHtml(e.message)}</div>`
    return
  }

  const main = document.getElementById('main')
  main.innerHTML = `
    <div class="app-page threads-page">
      <div class="page-head">
        <h1>Threads</h1>
        <div class="actions">
          <span data-overview-nav class="overview-nav-slot"></span>
          <a class="page-nav" href="${ROUTES.diffFull()}">Diff</a>
        </div>
      </div>
      <div class="threads-meta">${branchInfo.current_branch
        ? `<span><b>Branch:</b> <code>${escapeHtml(branchInfo.current_branch)}</code></span>`
        : '<span class="branch-warn">No current branch</span>'}</div>
      <div id="threads-list">Loading…</div>
    </div>`

  await refresh(repo, isCurrent)
  if (!isCurrent()) return

  currentOverviewNavDispose = setupOverviewNav(main.querySelector('[data-overview-nav]'), repo.id)
  currentSseUnsub = subscribeRepoEvents(repo.id, () => refresh(repo, isCurrent))
}

/**
 * Tear down the threads page's SSE subscription. Called by the router
 * when navigating away from the threads page so the EventSource doesn't
 * leak (the DOM is reclaimed by #main.innerHTML overwrites, but the
 * EventSource lives outside the DOM and stays open until close()).
 */
export function disposeThreadsView() {
  if (currentSseUnsub) { try { currentSseUnsub() } catch {}; currentSseUnsub = null }
  if (currentOverviewNavDispose) { try { currentOverviewNavDispose() } catch {}; currentOverviewNavDispose = null }
}

async function refresh(repo, isCurrent = () => true) {
  if (!isCurrent()) return
  let payload
  try {
    payload = await api(`/api/repos/${encodeURIComponent(repo.id)}/threads`)
    if (!isCurrent()) return
  } catch (e) {
    if (!isCurrent()) return
    document.getElementById('threads-list').innerHTML = `<div class="branch-error">Failed to load threads: ${escapeHtml(e.message)}</div>`
    return
  }
  if (!document.getElementById('threads-list')) return
  const threads = payload?.threads || []
  document.getElementById('threads-list').innerHTML = renderThreadsList(threads)

  document.querySelectorAll('[data-open-thread]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      openThreadModal(el.dataset.openThread, {
        repoId: repo.id,
        getThread: (id) => threads.find((t) => t.id === id),
        jumpToDiff: (t) => {
          // Stash the scroll target in sessionStorage before navigating —
          // the diff page reads it once on mount and clears it. One-shot
          // semantics so reloading mid-session doesn't re-jump.
          try {
            sessionStorage.setItem('slop-review:jump-to', JSON.stringify({
              file: t.file, line: t.line, side: t.side || 'new',
              thread_id: t.id,
            }))
          } catch {}
          if (t.view === 'commit' && t.sha) {
            location.hash = ROUTES.diffCommit(t.sha)
          } else if (t.view === 'local') {
            location.hash = ROUTES.diffLocal()
          } else {
            location.hash = ROUTES.diffFull()
          }
        },
        onChanged: () => refresh(repo, isCurrent),
      })
    })
  })
}

function renderThreadsList(threads) {
  if (threads.length === 0) {
    return '<div class="empty">No threads yet. Open the diff and click <b>+</b> on any line to start a conversation.</div>'
  }

  const counts = { your_turn: 0, awaiting: 0, read: 0, resolved: 0 }
  for (const t of threads) counts[t.state || 'awaiting']++

  // Group by file
  const byFile = new Map()
  for (const t of threads) {
    const f = t.file || '(no file)'
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(t)
  }

  // Within each file, sort by state (your_turn → awaiting → read → resolved),
  // then by most-recent-activity desc. Resolved drops to the bottom of each
  // file's group — visible-but-out-of-the-way, never folded.
  const stateRank = { your_turn: 0, awaiting: 1, read: 2, resolved: 3 }
  for (const arr of byFile.values()) {
    arr.sort((a, b) => {
      const sd = (stateRank[a.state] ?? 4) - (stateRank[b.state] ?? 4)
      if (sd !== 0) return sd
      const at = Date.parse(a.last_comment_at || '') || 0
      const bt = Date.parse(b.last_comment_at || '') || 0
      return bt - at
    })
  }

  // File order: alphabetical for now (we don't have priorities here without
  // a diff fetch). Could be upgraded to priorities later.
  const files = [...byFile.keys()].sort((a, b) => a.localeCompare(b))

  const head = `<div class="threads-counts">
    <span class="state-pill state-your-turn">🟢 ${counts.your_turn} your turn</span>
    <span class="state-pill state-awaiting">⚪ ${counts.awaiting} awaiting LLM</span>
    <span class="state-pill state-read">◌ ${counts.read} read</span>
    <span class="state-pill state-resolved">✓ ${counts.resolved} resolved</span>
    <span class="threads-total">${threads.length} total</span>
  </div>`

  const body = files.map((f) => {
    const items = byFile.get(f).map(renderThreadRow).join('')
    return `<section class="thread-file">
      <header class="thread-file-head"><code>${escapeHtml(f)}</code></header>
      <div class="thread-file-list">${items}</div>
    </section>`
  }).join('')

  return head + body
}

function renderThreadRow(t) {
  const stateClass = t.state === 'resolved'  ? 'state-resolved'
                   : t.state === 'your_turn' ? 'state-your-turn'
                   : t.state === 'awaiting'  ? 'state-awaiting'
                   : 'state-read'
  const stateLabel = t.state === 'resolved'  ? '✓'
                   : t.state === 'your_turn' ? '🟢'
                   : t.state === 'awaiting'  ? '⚪'
                   : '◌'
  const first = t.comments?.[0]
  const commentPreview = first ? inlineCode((first.body || '').split('\n')[0].slice(0, 200)) : ''
  const replies = (t.comments?.length || 0)
  const last = t.comments?.[t.comments.length - 1]
  const when = last?.posted_at || t.created_at
  // Two-line layout: top line carries state + anchor + view + reply count + time;
  // second line carries the anchored code snippet (if captured) and the comment preview.
  const codeSnippet = t.anchor_text
    ? `<code class="thread-row-code">${escapeHtml(t.anchor_text)}</code>`
    : ''
  return `<button type="button" class="thread-row ${stateClass}" data-open-thread="${escapeHtml(t.id)}">
    <div class="thread-row-top">
      <span class="thread-row-state">${stateLabel}</span>
      <span class="thread-row-anchor">L${escapeHtml(String(t.line ?? ''))}</span>
      <span class="thread-row-view view-${t.view || 'full'}">${escapeHtml(t.view || 'full')}</span>
      <span class="thread-row-replies">${replies} ${replies === 1 ? 'msg' : 'msgs'}</span>
      <span class="thread-row-when">${escapeHtml(relTime(when))}</span>
    </div>
    ${codeSnippet ? `<div class="thread-row-snippet">${codeSnippet}</div>` : ''}
    <div class="thread-row-preview">${commentPreview}</div>
  </button>`
}

// Re-export for tree-shaking parity (router imports from this module)
export { unsubscribeRepoEvents }
