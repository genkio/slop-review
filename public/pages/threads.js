import { api } from '../api.js'
import { store } from '../store.js'
import { escapeHtml, inlineCode, relTime } from '../util.js'
import { openThreadModal, getLastOpenedThreadId } from '../modals.js'
import { subscribeRepoEvents, unsubscribeRepoEvents } from '../sse.js'
import { ROUTES } from '../routes.js'
import { setupOverviewNav } from '../overview-nav.js'

let currentSseUnsub = null
let currentOverviewNavDispose = null
// Module-scoped because the modal-reopen target arrives via the URL on
// mount but the actual opening happens later, after the first refresh()
// has populated the thread list. Nulled after first consumption so SSE-
// driven refreshes don't keep reopening the modal as threads tick over.
let pendingReopenThreadId = null

/**
 * Thread browser page. Lists every thread on the current branch with state
 * pills (your turn / awaiting / read), grouped by file in priority order,
 * with counts at the top. Live-updates via SSE.
 *
 * `parsed.threadId` (from the URL's `?thread=` query) auto-opens that
 * thread's modal after the first refresh — used by the diff page's
 * "← Back to thread" link to drop the user back into the conversation
 * they were just viewing. Closing the modal strips the param via
 * replaceState so a refresh doesn't re-open it.
 */
export async function renderThreadsPage(parsed = {}, isCurrent = () => true) {
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

  // One-shot: consumed by the first refresh, then nulled so SSE-driven
  // refreshes don't keep reopening the modal as threads tick over.
  pendingReopenThreadId = parsed?.threadId || null

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
  // Display order = file-alphabetical, then state/recency within file.
  // The modal uses this flat list to drive prev/next so navigation feels
  // identical whether the user clicks a row or steps with the chevrons.
  const orderedIds = orderThreadsForDisplay(threads).map((t) => t.id)
  document.getElementById('threads-list').innerHTML = renderThreadsList(threads)

  // Recently-viewed breadcrumb. The modal stashes the last-viewed thread
  // id in sessionStorage on every open/swap; we paint a thick left ribbon
  // on that row so the user can re-find where they were after closing
  // the modal or returning from the diff view.
  applyRecentMarker()

  const openModalFor = (id) => {
    openThreadModal(id, {
      repoId: repo.id,
      getThread: (tid) => threads.find((t) => t.id === tid),
      threadOrder: orderedIds,
      // Jump to the single-file diff view for this thread's anchor. The
      // file + thread id ride the URL so browser back/forward navigates
      // between thread and diff cleanly, and a refresh keeps the user in
      // the focused view they were in.
      jumpToDiff: (t) => {
        const q = { file: t.file, thread: t.id }
        if (t.view === 'commit' && t.sha) location.hash = ROUTES.diffCommit(t.sha, q)
        else if (t.view === 'local')      location.hash = ROUTES.diffLocal(q)
        else                              location.hash = ROUTES.diffFull(q)
      },
      // Closing the modal must strip `?thread=` from the URL so a refresh
      // doesn't immediately reopen what the user just closed. replaceState
      // (not push) keeps the user's history sane — back goes wherever they
      // were before the modal, not to the "modal still open" snapshot.
      onClose: () => {
        stripThreadQuery()
        // Repaint the recent marker — the modal may have stepped to a
        // different thread via prev/next, and we want the new "recently
        // viewed" row highlighted once the modal closes.
        applyRecentMarker()
      },
      onChanged: () => refresh(repo, isCurrent),
    })
  }

  document.querySelectorAll('[data-open-thread]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      openModalFor(el.dataset.openThread)
    })
  })

  // Consume the one-shot reopen target from the URL — fired by the diff
  // page's "← Back to thread" link. Only triggers when the target thread
  // actually exists in the current list; otherwise (e.g. thread deleted
  // while we were on the diff page) the URL param is silently dropped.
  if (pendingReopenThreadId) {
    const target = pendingReopenThreadId
    pendingReopenThreadId = null
    if (threads.find((t) => t.id === target)) openModalFor(target)
    else stripThreadQuery()
  }
}

/**
 * Paint the `is-recent` class on the row matching the last-opened
 * thread id (stashed by the modal in sessionStorage). Idempotent —
 * call after every list re-render or modal-close.
 */
function applyRecentMarker() {
  const id = getLastOpenedThreadId()
  if (!id) return
  document.querySelectorAll('.thread-row.is-recent').forEach((el) => el.classList.remove('is-recent'))
  document.querySelector(`.thread-row[data-open-thread="${cssEscape(id)}"]`)?.classList.add('is-recent')
}

function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1') }

// Drop `?thread=…` from the current hash without creating a new history
// entry. Used both when the user closes a modal-reopened-from-URL and
// when the URL points at a thread that no longer exists.
//
// Only operates on the threads-page hash. If the user just clicked Jump
// to diff, the close path fires *after* location.hash already advanced
// to `#/diff?file=…&thread=…`; the `?thread=` there is load-bearing for
// the diff page's "back to thread" link, so we leave it alone.
function stripThreadQuery() {
  const hash = location.hash
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return
  const pathPart  = hash.slice(0, qIdx)
  if (pathPart !== '#/' && pathPart !== '#') return
  const queryPart = hash.slice(qIdx + 1)
  const kept = queryPart.split('&').filter((p) => p && !p.startsWith('thread=')).join('&')
  const next = kept ? `${pathPart}?${kept}` : pathPart
  if (next === hash) return
  history.replaceState(null, '', next || '#/')
}

// Group threads by file, sort within each file by state (your_turn →
// awaiting → read → resolved) then most-recent-activity desc. Files
// themselves are alphabetical (no priorities available here without a
// diff fetch — could be upgraded later). Shared by the renderer AND by
// the flat-ordered-id list the modal's prev/next nav consumes.
function groupThreadsForDisplay(threads) {
  const byFile = new Map()
  for (const t of threads) {
    const f = t.file || '(no file)'
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(t)
  }
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
  const files = [...byFile.keys()].sort((a, b) => a.localeCompare(b))
  return { byFile, files }
}

function orderThreadsForDisplay(threads) {
  const { byFile, files } = groupThreadsForDisplay(threads)
  return files.flatMap((f) => byFile.get(f))
}

function renderThreadsList(threads) {
  if (threads.length === 0) {
    return '<div class="empty">No threads yet. Open the diff and click <b>+</b> on any line to start a conversation.</div>'
  }

  const counts = { your_turn: 0, awaiting: 0, read: 0, resolved: 0 }
  for (const t of threads) counts[t.state || 'awaiting']++

  const { byFile, files } = groupThreadsForDisplay(threads)

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
