import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, copyToClipboard, toast } from './util.js'
import { openThreadModal, confirmRemoveComment } from './modals.js'
import { languageForPath, highlightLine } from './syntax.js'
import { intraLineSegments } from './intra-line-diff.js'
import { subscribeRepoEvents } from './sse.js'
import { ROUTES } from './routes.js'
import { setupOverviewNav } from './overview-nav.js'

const DIFF_CACHE_PREFIX = 'slop-review:diff:v1:'

function loadCachedDiff(sha) {
  try {
    const raw = sessionStorage.getItem(DIFF_CACHE_PREFIX + sha)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveCachedDiff(sha, data) {
  const key  = DIFF_CACHE_PREFIX + sha
  const json = JSON.stringify(data)
  try {
    sessionStorage.setItem(key, json)
  } catch (e) {
    if (e?.name !== 'QuotaExceededError') return
    try {
      const ours = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k && k.startsWith(DIFF_CACHE_PREFIX)) ours.push(k)
      }
      for (const k of ours) sessionStorage.removeItem(k)
      sessionStorage.setItem(key, json)
    } catch {}
  }
}

/**
 * Parse a unified-diff `patch` string (one file's worth) into hunks.
 * Resilient to: missing hunk-line counts, blank context lines without
 * the leading space, `\ No newline at end of file` markers, and patches
 * with preamble before the first `@@`.
 */
export function parsePatch(patch) {
  if (!patch) return []
  const lines = patch.split('\n')
  const hunks = []
  let cur = null

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (cur) hunks.push(cur)
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
      if (!m) { cur = null; continue }
      cur = {
        oldStart: +m[1], oldLines: m[2] != null ? +m[2] : 1,
        newStart: +m[3], newLines: m[4] != null ? +m[4] : 1,
        header:   m[5].replace(/^\s+/, ''),
        rows:     [],
        _oldNo:   +m[1],
        _newNo:   +m[3],
      }
      continue
    }
    if (!cur) continue
    const c = line[0]
    if (c === '-')      cur.rows.push({ kind: 'del',     oldNo: cur._oldNo++, newNo: null,         text: line.slice(1) })
    else if (c === '+') cur.rows.push({ kind: 'add',     oldNo: null,         newNo: cur._newNo++, text: line.slice(1) })
    else if (c === ' ') cur.rows.push({ kind: 'context', oldNo: cur._oldNo++, newNo: cur._newNo++, text: line.slice(1) })
    else if (c === '\\') {/* ignore */}
    else if (line === '') cur.rows.push({ kind: 'context', oldNo: cur._oldNo++, newNo: cur._newNo++, text: '' })
  }
  if (cur) hunks.push(cur)
  for (const h of hunks) annotateIntraLine(h.rows)
  return hunks
}

/**
 * Walk a hunk's rows, find each (del[i], add[i]) position-paired pair,
 * and stamp `_intraLeft` / `_intraRight` segment arrays onto the rows
 * when the lines are similar enough to be worth within-line highlighting.
 * Mutates rows in place. The split + inline renderers both consult these
 * stamps; rows without them fall back to whole-line wash.
 */
function annotateIntraLine(rows) {
  let dels = []
  let adds = []
  const flush = () => {
    const max = Math.min(dels.length, adds.length)
    for (let i = 0; i < max; i++) {
      const seg = intraLineSegments(dels[i].text, adds[i].text)
      if (!seg) continue
      dels[i]._intraLeft  = seg.left
      adds[i]._intraRight = seg.right
    }
    dels = []
    adds = []
  }
  for (const row of rows) {
    if      (row.kind === 'del') dels.push(row)
    else if (row.kind === 'add') adds.push(row)
    else                          flush()
  }
  flush()
}

function renderLineCell(row, language, side) {
  const segs = side === 'left' ? row._intraLeft : row._intraRight
  if (!segs) return highlightLine(row.text, language)
  // Render each segment through the syntax highlighter independently. A
  // string literal split across an intra-diff boundary loses its 'string'
  // coloring on the broken half — accepted tradeoff: the existing per-line
  // tokenizer already gives up multi-line context, and the change signal
  // is more important than precise token color on a changed line.
  return segs.map((s) => {
    const html = highlightLine(s.text, language)
    if (s.kind === 'eq') return html
    return `<span class="diff-intra-${s.kind}">${html}</span>`
  }).join('')
}

function pairRows(rows) {
  const out = []
  let dels = []
  let adds = []
  const flush = () => {
    const max = Math.max(dels.length, adds.length)
    for (let i = 0; i < max; i++) {
      out.push({
        kind:  dels[i] && adds[i] ? 'change' : dels[i] ? 'del' : 'add',
        left:  dels[i] || null,
        right: adds[i] || null,
      })
    }
    dels = []; adds = []
  }
  for (const row of rows) {
    if (row.kind === 'del') dels.push(row)
    else if (row.kind === 'add') adds.push(row)
    else { flush(); out.push({ kind: 'context', left: row, right: row }) }
  }
  flush()
  return out
}

function hunkHeaderRow(hunk) {
  const meta = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  const ctx  = hunk.header ? ' ' + escapeHtml(hunk.header) : ''
  return `<tr class="diff-row diff-row-hunk"><td colspan="4" class="diff-hunk-head"><span class="diff-hunk-meta">${meta}</span>${ctx}</td></tr>`
}

function renderHunkSplit(hunk, path, sha, language) {
  const paired = pairRows(hunk.rows)
  const body = paired.map((p) => {
    const lk = p.left ? p.left.kind : 'blank'
    const rk = p.right ? p.right.kind : 'blank'
    const lMark = p.left ? (p.left.kind === 'del' ? '-' : ' ') : ''
    const rMark = p.right ? (p.right.kind === 'add' ? '+' : ' ') : ''
    const lAttrs = p.left
      ? `data-side="old" data-line="${p.left.oldNo ?? ''}" data-path="${escapeHtml(path)}" data-sha="${sha}"`
      : ''
    const rAttrs = p.right
      ? `data-side="new" data-line="${p.right.newNo ?? ''}" data-path="${escapeHtml(path)}" data-sha="${sha}"`
      : ''
    return `<tr class="diff-row" data-pair-kind="${p.kind}">` +
      `<td class="diff-no diff-no-old">${p.left?.oldNo ?? ''}</td>` +
      `<td class="diff-text diff-${lk}" ${lAttrs}><span class="diff-marker">${lMark}</span><span class="diff-line">${p.left ? renderLineCell(p.left, language, 'left') : ''}</span></td>` +
      `<td class="diff-no diff-no-new">${p.right?.newNo ?? ''}</td>` +
      `<td class="diff-text diff-${rk}" ${rAttrs}><span class="diff-marker">${rMark}</span><span class="diff-line">${p.right ? renderLineCell(p.right, language, 'right') : ''}</span></td>` +
      `</tr>`
  }).join('')
  return hunkHeaderRow(hunk) + body
}

function renderHunkInline(hunk, path, sha, language) {
  const body = hunk.rows.map((r) => {
    const marker = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
    const side   = r.kind === 'del' ? 'old' : 'new'
    const lineNo = r.kind === 'del' ? (r.oldNo ?? '') : (r.newNo ?? '')
    const lineSide = r.kind === 'del' ? 'left' : 'right'
    return `<tr class="diff-row" data-pair-kind="${r.kind}">` +
      `<td class="diff-no diff-no-old">${r.oldNo ?? ''}</td>` +
      `<td class="diff-no diff-no-new">${r.newNo ?? ''}</td>` +
      `<td class="diff-text diff-${r.kind}" colspan="2" data-side="${side}" data-line="${lineNo}" data-path="${escapeHtml(path)}" data-sha="${sha}"><span class="diff-marker">${marker}</span><span class="diff-line">${renderLineCell(r, language, lineSide)}</span></td>` +
      `</tr>`
  }).join('')
  return hunkHeaderRow(hunk) + body
}

function compareForReview(a, b, priorities) {
  const pa = priorities?.[a.path]
  const pb = priorities?.[b.path]
  if (!pa && !pb) return (a.path || '').localeCompare(b.path || '')
  if (!pa) return 1
  if (!pb) return -1
  const refDelta     = (pb.ref_count    || 0) - (pa.ref_count    || 0)
  if (refDelta     !== 0) return refDelta
  const statusDelta  = (pa.status_rank  || 0) - (pb.status_rank  || 0)
  if (statusDelta  !== 0) return statusDelta
  const supportDelta = (pa.support_rank || 0) - (pb.support_rank || 0)
  if (supportDelta !== 0) return supportDelta
  return (a.path || '').localeCompare(b.path || '')
}

const STATUS_GLYPH = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' }

// Relationship chip glyphs + labels (filter mode, on non-anchor files).
// Arrow points FROM the dependent TO the dependency.
const RELATIONSHIP_LABELS = {
  'imports':     { arrow: '→', text: 'imports',     verb: 'imports' },
  'imported-by': { arrow: '←', text: 'imported by', verb: 'imported by' },
  'circular':    { arrow: '↔', text: 'circular',    verb: 'circular import with' },
}

function renderFileSection(file, mode, sha, opts = {}) {
  const {
    isReviewed          = false,
    isCollapsed         = false,
    showRelateBtn       = false,
    showReviewedToggle  = false,
    isFilterAnchor      = false,
    priorityEntry       = null,
    relationship        = null,
    anchorPath          = null,
  } = opts
  const status      = file.status || 'modified'
  const statusGlyph = STATUS_GLYPH[status] || '?'
  const pathShown   = file.previous_path && file.path !== file.previous_path
    ? `${escapeHtml(file.previous_path)} → ${escapeHtml(file.path)}`
    : escapeHtml(file.path)

  // Force inline rendering for added / removed files — they have content
  // on only one side, so split mode would dedicate half the row to blank
  // pad cells. Inline collapses the layout to one column and uses the
  // full body width, matching what GitHub does for new / deleted files.
  // Modified / renamed / copied files have content on both sides and
  // continue to honor the user's split/inline preference.
  const isSingleSide = status === 'added' || status === 'removed'
  const effectiveMode = (mode === 'split' && isSingleSide) ? 'inline' : mode

  let body
  if (file.is_binary) {
    body = '<div class="diff-empty">Binary file — diff not shown.</div>'
  } else if (!file.patch) {
    body = '<div class="diff-empty">No content change shown (rename or oversized diff).</div>'
  } else {
    const hunks = parsePatch(file.patch)
    const renderHunk = effectiveMode === 'split' ? renderHunkSplit : renderHunkInline
    const language = languageForPath(file.path)
    const colgroup = effectiveMode === 'split'
      ? '<colgroup><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-no"><col class="diff-col-text"></colgroup>'
      : '<colgroup><col class="diff-col-no"><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-text"></colgroup>'
    body = `<table class="diff-table diff-${effectiveMode}">${colgroup}<tbody>${hunks.map((h) => renderHunk(h, file.path, sha, language)).join('')}</tbody></table>`
  }

  // Per-file related-filter button: shows count of incoming+outgoing among
  // the changed-file set. Hidden when no edges; the active anchor's button
  // doubles as "× clear filter".
  let relateBtn = ''
  if (showRelateBtn && priorityEntry) {
    const total = (priorityEntry.incoming?.length || 0) + (priorityEntry.outgoing?.length || 0)
    if (total > 0 || isFilterAnchor) {
      const label = isFilterAnchor ? '× clear filter' : `≡ ${total} related`
      const title = isFilterAnchor
        ? 'Clear related-files filter'
        : `Show only this file and its ${total} related changed file${total === 1 ? '' : 's'}`
      relateBtn = `<button type="button" class="diff-relate-btn${isFilterAnchor ? ' active' : ''}" data-relate-anchor="${escapeHtml(file.path)}" title="${title}">${label}</button>`
    }
  }
  // Per-file reviewed toggle — only rendered in Full diff view because the
  // reviewed-batches store is keyed by HEAD SHA against the full file set.
  // Per-commit and Local views don't persist this state, so the button is
  // suppressed there to avoid implying it does. Click stops propagation so
  // it doesn't trigger the file head's collapse-toggle.
  //
  // Split-placement: the `Mark reviewed` action lives at the *footer* of the
  // file (the user's natural moment to mark is after reading top-to-bottom),
  // while the `✓ reviewed` toggle stays in the *header* of an already-marked
  // file (a collapsed-reviewed file shows only its header — the unmark
  // affordance must be reachable without re-expanding). The button is never
  // rendered in both places at once, so the user is never confused about
  // which one to click.
  const headerReviewedToggle = (showReviewedToggle && isReviewed)
    ? `<button type="button" class="diff-file-mark active" data-toggle-reviewed="${escapeHtml(file.path)}" title="Marked reviewed — click to unmark" aria-pressed="true">✓ reviewed</button>`
    : ''
  const footerReviewedToggle = (showReviewedToggle && !isReviewed)
    ? `<button type="button" class="diff-file-mark" data-toggle-reviewed="${escapeHtml(file.path)}" title="Mark this file reviewed" aria-pressed="false">○ Mark reviewed</button>`
    : ''

  // Relationship chip — only on non-anchor files in filter mode
  let relChip = ''
  if (relationship && RELATIONSHIP_LABELS[relationship]) {
    const r = RELATIONSHIP_LABELS[relationship]
    const anchorBase = anchorPath ? anchorPath.split('/').pop() : 'anchor'
    const tip = `${r.verb} ${anchorPath || 'anchor'}`
    relChip = `<span class="diff-rel-chip diff-rel-${relationship}" title="${escapeHtml(tip)}">` +
                `<span class="diff-rel-arrow" aria-hidden="true">${r.arrow}</span> ` +
                `<span class="diff-rel-text">${r.text}</span> ` +
                `<span class="diff-rel-anchor">${escapeHtml(anchorBase)}</span>` +
              `</span>`
  }

  const sectionClass = `diff-file${isReviewed ? ' is-reviewed' : ''}${isFilterAnchor ? ' is-filter-anchor' : ''}${isCollapsed ? ' is-collapsed' : ''}`

  // Footer wrapper is suppressed when there's nothing to put in it (e.g.
  // per-commit / Local view, or an already-reviewed file). Keeps the
  // section clean and avoids an empty hairline strip under reviewed files.
  const footerHtml = footerReviewedToggle
    ? `<footer class="diff-file-footer">${footerReviewedToggle}</footer>`
    : ''

  return `<section class="${sectionClass}" data-path="${escapeHtml(file.path)}" data-status="${status}">` +
    `<header class="diff-file-head" data-toggle-collapse>` +
      `<button type="button" class="diff-file-toggle" data-toggle-collapse aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${isCollapsed ? 'Expand file' : 'Collapse file'} ${escapeHtml(file.path)}"></button>` +
      `<span class="diff-file-status" data-status="${status}" title="${status}">${statusGlyph}</span>` +
      `<code class="diff-file-path">${pathShown}</code>` +
      `<span class="diff-file-stats"><span class="diff-stat-add">+${file.additions ?? 0}</span> <span class="diff-stat-del">−${file.deletions ?? 0}</span></span>` +
      relChip +
      headerReviewedToggle +
      relateBtn +
    `</header>` +
    `<div class="diff-file-body">${body}</div>` +
    footerHtml +
  `</section>`
}

// Module-level cleanup: when the user navigates away from the diff page
// (router renders something else into #main), we need to tear down the
// SSE subscription and key handlers from the previous diff view. The page
// host calls `disposeDiffView()` on unmount.
let activeDispose = null
export function disposeDiffView() {
  if (activeDispose) {
    try { activeDispose() } catch {}
    activeDispose = null
  }
}

/**
 * Render the full diff view as a regular page (not a modal). Mounts into
 * #main directly; URL is governed by the router's `#/diff[/...]` routing.
 * Caller (pages/diff.js) supplies branch info + commits and the page
 * handles its own keyboard nav, SSE subscription, and URL sync.
 *
 * Returns when the initial load+render completes. The caller doesn't need
 * to await it for navigation; it's awaited mainly so `scrollToAnchor`
 * fires on the freshly-rendered DOM.
 */
export async function renderDiffView({ repo, branch, branchId, branchInfo, commits, initialIndex = 0, hasLocal = false, scrollToAnchor = null, singleFile = null, threadContextId = null, isCurrent = () => true }) {
  if (!isCurrent()) return
  // Tear down any previous diff view's listeners + SSE before we re-mount.
  disposeDiffView()
  if (!isCurrent()) return

  const isMobile = window.matchMedia('(max-width: 768px)').matches
  const maxIdx = commits.length + (hasLocal ? 1 : 0)
  const state = {
    index:    Math.max(0, Math.min(initialIndex, maxIdx)),
    commits,
    repo,
    branch,
    branchId,
    branchInfo,
    hasLocal,
    mode:     isMobile ? 'inline' : 'split',
    diff:     null,
    loading:  false,
    threads:  [],
    reviewed: new Set(),
    reviewedSha: null,
    collapsedPaths: new Set(),
    // Seed the single-file filter from URL params if present. Reuses the
    // same `state.filter` slot the threads-filter and related-filter use,
    // so the existing click delegation (Show all, view toggle) and
    // computeVisibleFiles branch naturally on the new `kind: 'file'`.
    // `threadId` rides along so the "← Back to thread" link knows where
    // to return the user when they're done with this file.
    filter:   singleFile ? { kind: 'file', path: singleFile, threadId: threadContextId } : null,
    // Multi-session symbol panel: each session = one parked symbol search
    // with its own matches, jumpStack, and currentAnchor. activeId points
    // at whichever session is currently expanded; null = all sessions are
    // minimized into right-edge strips. open=false hides the panel entirely.
    symbolPanel: { open: false, sessions: [], activeId: null },
    // One-shot flag: true on initial mount + on goto(); cleared by renderBody
    // after applying scrollTop=0. Subsequent renders triggered by
    // refreshReviewed / SSE / filter-toggle preserve the user's scroll
    // position — no more snap-back fighting maybeScrollToAnchor.
    shouldResetScroll: true,
  }

  const main = document.getElementById('main')
  // Keep the breadcrumb / shared header; main is the page surface.
  const root = document.createElement('div')
  root.className = 'diff-page'
  root.innerHTML = `
    <header class="diff-head">
      <div class="diff-head-left">
        <div class="diff-nav">
          <button type="button" class="diff-nav-btn" data-prev aria-label="Previous">‹</button>
          <span class="diff-position" data-position></span>
          <button type="button" class="diff-nav-btn" data-next aria-label="Next">›</button>
        </div>
        <div class="diff-meta-block">
          <div class="diff-meta-line">
            <code class="diff-sha" data-sha title="Click to copy"></code>
            <span class="diff-headline" data-headline></span>
          </div>
          <div class="diff-meta-line diff-meta-sub">
            <span data-author></span>
            <span class="diff-meta-sep">·</span>
            <span data-when></span>
            <span class="diff-meta-sep">·</span>
            <span data-stats></span>
          </div>
        </div>
      </div>
      <div class="diff-actions">
        <span data-overview-nav class="overview-nav-slot"></span>
        <a class="page-nav" data-threads-link href="${ROUTES.threads()}" hidden>Threads</a>
      </div>
    </header>
    <div class="diff-body" data-body>
      <div class="diff-loading">Loading diff…</div>
    </div>
    <aside class="diff-symbol-panel" data-symbol-panel hidden></aside>
    <style data-symbol-style></style>`
  main.replaceChildren(root)

  const $  = (sel) => root.querySelector(sel)

  // ------------------------------------------------------------------
  // URL sync — page owns the entire `#/diff[/...]` route shape.
  // The router will run on hashchange anyway; we use replaceState here
  // so prev/next nav doesn't add 100 history entries when walking commits.
  // ------------------------------------------------------------------
  function urlForIndex(idx) {
    if (state.hasLocal && idx === state.commits.length + 1) return ROUTES.diffLocal()
    if (idx === state.commits.length) return ROUTES.diffFull()
    const c = state.commits[idx]
    return c?.sha ? ROUTES.diffCommit(c.sha) : ROUTES.diffFull()
  }
  function syncUrl() {
    const next = urlForIndex(state.index)
    if (location.hash === next) return
    history.replaceState(null, '', next)
  }

  let unsubscribeSse = null
  let disposeOverviewNav = null
  let disposed = false
  let flashTimer = null
  const isStale = () => disposed || !isCurrent()
  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('keydown', onKey)
    if (unsubscribeSse) { try { unsubscribeSse() } catch {}; unsubscribeSse = null }
    if (disposeOverviewNav) { try { disposeOverviewNav() } catch {}; disposeOverviewNav = null }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    // Floating button lives on document.body — its parent isn't the
    // page root, so #main.replaceChildren() won't sweep it up.
    try { commentBtn?.remove() } catch {}
  }
  activeDispose = dispose

  const onKey = (e) => {
    if (disposed) return
    if (e.target?.closest?.('input, textarea')) return
    if (e.key === 'Escape') {
      // Layered Escape: minimize the active session into a parked strip
      // rather than closing it (preserves session state). To fully dismiss
      // a session, the user clicks × on its strip or expanded header.
      if (state.symbolPanel.activeId) { minimizeActive(); e.preventDefault() }
    }
    else if (e.key === 'Backspace' && state.symbolPanel.activeId) {
      const session = getActiveSession()
      if (session && session.jumpStack.length > 0) {
        popSymbolJump(state.symbolPanel.activeId)
        e.preventDefault()
      }
    }
    else if (e.key === 'ArrowLeft' || e.key === '[')  { goto(state.index - 1); e.preventDefault() }
    else if (e.key === 'ArrowRight' || e.key === ']') { goto(state.index + 1); e.preventDefault() }
  }
  document.addEventListener('keydown', onKey)
  syncUrl()
  disposeOverviewNav = setupOverviewNav($('[data-overview-nav]'), repo.id)

  $('[data-prev]').addEventListener('click', () => goto(state.index - 1))
  $('[data-next]').addEventListener('click', () => goto(state.index + 1))

  // ------------------------------------------------------------------
  // Inline `+ comment` floating button.
  // Per spec, comments are allowed in ALL three views (commit/full/local).
  // ------------------------------------------------------------------
  const commentBtn = document.createElement('button')
  commentBtn.type = 'button'
  commentBtn.className = 'diff-add-comment'
  commentBtn.title = 'Add inline comment'
  commentBtn.textContent = '+'
  commentBtn.hidden = true
  // Floating button is position:fixed against the viewport, so it lives
  // on document.body and gets cleaned up on dispose.
  document.body.appendChild(commentBtn)

  let hoveredCell = null
  let pendingCell = null
  let rafScheduled = false
  const hideHoverButtons = () => {
    commentBtn.hidden = true
    hoveredCell = null
    pendingCell = null
  }

  // rAF-coalesced mouseover handler. Trackpad inertia generates 50+ mouseover
  // events per second as the cursor crosses cells; doing a synchronous
  // getBoundingClientRect + style write per event triggers a forced reflow
  // each time, which against a 9k-cell DOM is ~80ms. Coalescing means at
  // most one positioning pass per frame, and the read+writes happen back-to-
  // back so the second forced reflow is cheap (layout already current).
  const positionHoverButtons = () => {
    rafScheduled = false
    const cell = pendingCell
    pendingCell = null
    if (!cell || !cell.isConnected) return
    const r = cell.getBoundingClientRect()
    commentBtn.style.top  = `${r.top + r.height / 2 - 11}px`
    commentBtn.style.left = `${r.left - 24}px`
    commentBtn.hidden = false
  }
  $('[data-body]').addEventListener('mouseover', (e) => {
    const cell = e.target.closest?.('.diff-text[data-side]')
    if (!cell || cell === hoveredCell) return
    hoveredCell = cell
    pendingCell = cell
    if (!rafScheduled) {
      rafScheduled = true
      requestAnimationFrame(positionHoverButtons)
    }
  }, { passive: true })
  $('[data-body]').addEventListener('scroll', hideHoverButtons, { passive: true })

  commentBtn.addEventListener('click', () => {
    if (!hoveredCell) return
    openEditorBelow(hoveredCell)
    hideHoverButtons()
  })

  // ------------------------------------------------------------------
  // Cross-file symbol panel — dblclick an identifier in the diff body
  // ------------------------------------------------------------------
  const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/

  $('[data-body]').addEventListener('dblclick', (e) => {
    if (e.target.closest('input, textarea, button, .diff-row-thread, .diff-row-editor')) return
    const sel = window.getSelection()?.toString().trim() || ''
    if (!IDENT_RE.test(sel)) return
    const cell = e.target.closest('.diff-text[data-path]')
    const anchor = cell ? { path: cell.dataset.path, line: cell.dataset.line, side: cell.dataset.side } : null
    openSymbolPanel(sel, cell?.dataset.path || null, anchor)
  })

  // All panel interactions are delegated through the panel container.
  // Each session's clickable bits carry data-action ('close'|'back'|
  // 'minimize'|'restore'); the session's data-session-id tells us which
  // session to operate on. Match-row clicks (jump-to-line) fall through
  // to the existing closest('[data-path][data-line][data-side]') logic.
  $('[data-symbol-panel]').addEventListener('click', (e) => {
    const sessionEl = e.target.closest('[data-session-id]')
    if (!sessionEl) return
    const sessionId = sessionEl.dataset.sessionId
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'close')    { closeSession(sessionId); return }
    if (action === 'back')     { popSymbolJump(sessionId); return }
    if (action === 'start')    { popSymbolJumpAll(sessionId); return }
    if (action === 'minimize') { minimizeActive(); return }
    if (action === 'restore')  { activateSession(sessionId); return }
    // Match click in the active session's list.
    const matchEl = e.target.closest('[data-path][data-line][data-side]')
    if (matchEl) {
      scrollToMatch(sessionId, matchEl.dataset.path, matchEl.dataset.line, matchEl.dataset.side)
      return
    }
    // Click anywhere else on a minimized strip = restore that session.
    if (!sessionEl.classList.contains('is-active')) {
      activateSession(sessionId)
    }
  })
  $('[data-symbol-panel]').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const sessionEl = e.target.closest('[data-session-id]')
    const matchEl   = e.target.closest('[data-path][data-line][data-side]')
    if (!sessionEl || !matchEl) return
    e.preventDefault()
    scrollToMatch(sessionEl.dataset.sessionId, matchEl.dataset.path, matchEl.dataset.line, matchEl.dataset.side)
  })

  function findSymbolMatches(symbol) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`)
    const matches = []
    for (const file of state.diff?.files || []) {
      if (!file.patch) continue
      const hunks = parsePatch(file.patch)
      for (const hunk of hunks) {
        for (const row of hunk.rows) {
          if (!re.test(row.text)) continue
          matches.push({
            path: file.path,
            line: row.kind === 'del' ? row.oldNo : row.newNo,
            side: row.kind === 'del' ? 'old' : 'new',
            kind: row.kind,
            text: row.text,
          })
        }
      }
    }
    return matches
  }

  // === Session-management primitives ==================================

  function newSessionId() {
    return 'sess_' + Math.random().toString(36).slice(2, 10)
  }
  function getSession(id) {
    return state.symbolPanel.sessions.find((s) => s.id === id) || null
  }
  function getActiveSession() {
    return getSession(state.symbolPanel.activeId)
  }

  // === Lifecycle =======================================================

  function openSymbolPanel(symbol, currentPath, anchor) {
    // A dblclick always creates a NEW session and makes it active. If a
    // previous session was expanded, it gets minimized into a parked strip
    // automatically (it's still in state.symbolPanel.sessions). The user's
    // existing search context is preserved and re-accessible by clicking
    // its strip.
    const matches = findSymbolMatches(symbol)
    const session = {
      id: newSessionId(),
      symbol,
      matches,
      currentPath,
      jumpStack: [],
      currentAnchor: anchor,
    }
    state.symbolPanel.sessions.push(session)
    state.symbolPanel.activeId = session.id
    state.symbolPanel.open = true
    root.classList.add('has-symbol-panel', 'disable-content-visibility')
    renderSymbolPanel()
    applySymbolHighlights()
  }

  function activateSession(id) {
    state.symbolPanel.activeId = id
    renderSymbolPanel()
    applySymbolHighlights()
  }

  function minimizeActive() {
    state.symbolPanel.activeId = null
    renderSymbolPanel()
    // Highlights track the active session; with none active, clear them
    // so the diff body isn't dotted with old-session match tints.
    clearSymbolHighlights()
  }

  function closeSession(id) {
    const sessions = state.symbolPanel.sessions
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx < 0) return
    sessions.splice(idx, 1)
    if (state.symbolPanel.activeId === id) {
      // When the active session goes away, fall back to the most-recent
      // remaining session (or null if none left). Most-recent = last in
      // array because we push on creation.
      state.symbolPanel.activeId = sessions.length > 0 ? sessions[sessions.length - 1].id : null
    }
    if (sessions.length === 0) {
      closeSymbolPanel()
    } else {
      renderSymbolPanel()
      applySymbolHighlights()
    }
  }

  function closeSymbolPanel() {
    state.symbolPanel = { open: false, sessions: [], activeId: null }
    clearActiveFlash()
    const panel = $('[data-symbol-panel]')
    if (panel) {
      panel.hidden = true
      panel.innerHTML = ''
    }
    root.classList.remove('has-symbol-panel')
    clearSymbolHighlights()
    // Panel floats over the diff body (no padding-right shift in CSS), so
    // closing it doesn't reflow the body. Whatever cell the user was on is
    // still at the same viewport position — the panel just stops covering
    // the right edge.
  }

  function scrollToMatch(sessionId, path, line, side) {
    // Push the current anchor so the back button can return here. Per-
    // session — each parked search has its own jumpStack.
    const session = getSession(sessionId)
    if (!session) return
    if (session.currentAnchor) {
      session.jumpStack.push(session.currentAnchor)
      if (session.jumpStack.length > 100) session.jumpStack.shift()
    }
    session.currentAnchor = { path, line, side }
    scrollToDiffCell(path, line, side)
    renderSymbolPanel()
  }

  function popSymbolJump(sessionId) {
    const session = getSession(sessionId)
    if (!session || session.jumpStack.length === 0) return
    const target = session.jumpStack.pop()
    session.currentAnchor = target
    scrollToDiffCell(target.path, target.line, target.side)
    renderSymbolPanel()
  }

  // One-click jump to the dblclick origin. jumpStack[0] is always the
  // original anchor — scrollToMatch pushes the *current* anchor before
  // moving, so the deepest stack entry is the session's starting point.
  function popSymbolJumpAll(sessionId) {
    const session = getSession(sessionId)
    if (!session || session.jumpStack.length === 0) return
    const target = session.jumpStack[0]
    session.jumpStack = []
    session.currentAnchor = target
    scrollToDiffCell(target.path, target.line, target.side)
    renderSymbolPanel()
  }

  // === Rendering =======================================================

  function renderSymbolPanel() {
    const panel = $('[data-symbol-panel]')
    if (!panel) return
    const { sessions, activeId } = state.symbolPanel
    if (sessions.length === 0) {
      panel.hidden = true
      panel.innerHTML = ''
      return
    }
    panel.hidden = false
    // Render newest-first (leftmost). The underlying array stays in
    // creation order — push appends, sessions[length-1] is still the
    // newest — only the visual layout reverses.
    panel.innerHTML = [...sessions].reverse().map((s) => renderSession(s, s.id === activeId)).join('')
  }

  function renderSession(session, isActive) {
    return isActive ? renderActiveSession(session) : renderMinimizedSession(session)
  }

  function renderActiveSession(session) {
    const grouped = new Map()
    for (const m of session.matches) {
      if (!grouped.has(m.path)) grouped.set(m.path, [])
      grouped.get(m.path).push(m)
    }
    const total     = session.matches.length
    const fileCount = grouped.size
    const meta = total === 0 ? '' :
      `${total} match${total === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`

    const stackLen = session.jumpStack.length
    // Segmented back-nav control:
    //   stackLen 0: neither shown
    //   stackLen 1: only [↩ back] (start would land on the same place)
    //   stackLen 2+: [↞ start │ ↩ back (N)] — start renders first so they
    //     butt up as a segmented pill via adjacent-sibling CSS.
    const startBtn = stackLen < 2 ? '' :
      `<button type="button" class="diff-symbol-start" data-action="start" title="Back to where you double-clicked" aria-label="Back to original location">↞ start</button>`
    const backBtn = stackLen === 0 ? '' :
      `<button type="button" class="diff-symbol-back" data-action="back" title="Back one location (Backspace)" aria-label="Back to previous location">${stackLen === 1 ? '↩ back' : `↩ back (${stackLen})`}</button>`

    let listHtml
    if (total === 0) {
      listHtml = '<div class="diff-symbol-empty">No occurrences in this diff.</div>'
    } else {
      const parts = []
      for (const [path, fileMatches] of grouped) {
        const isCurrent = path === session.currentPath
        const lang = languageForPath(path)
        parts.push(`<section class="diff-symbol-file${isCurrent ? ' is-current' : ''}">`)
        parts.push(`<header class="diff-symbol-file-head">`)
        parts.push(`<code class="diff-symbol-file-path" title="${escapeHtml(path)}">${escapeHtml(path)}</code>`)
        parts.push(`<span class="diff-symbol-file-count">${fileMatches.length}</span>`)
        if (isCurrent) parts.push(`<span class="diff-symbol-current-pill">this file</span>`)
        parts.push(`</header>`)
        parts.push(`<ul class="diff-symbol-file-list">`)
        for (const m of fileMatches) {
          const marker = m.kind === 'del' ? '−' : m.kind === 'add' ? '+' : ' '
          parts.push(`<li class="diff-symbol-match diff-symbol-match-${m.kind}" data-path="${escapeHtml(m.path)}" data-line="${m.line}" data-side="${m.side}" tabindex="0">`)
          parts.push(`<span class="diff-symbol-match-line"><span class="diff-symbol-match-mark">${marker}</span>L${m.line}</span>`)
          parts.push(`<code class="diff-symbol-match-text">${highlightLine(m.text, lang)}</code>`)
          parts.push(`</li>`)
        }
        parts.push(`</ul>`)
        parts.push(`</section>`)
      }
      listHtml = parts.join('')
    }

    return `<section class="diff-symbol-session is-active" data-session-id="${session.id}">` +
      `<header class="diff-symbol-head">` +
        startBtn +
        backBtn +
        `<span class="diff-symbol-meta">${escapeHtml(meta)}</span>` +
        `<button type="button" class="diff-symbol-minimize" data-action="minimize" title="Minimize (Esc)" aria-label="Minimize panel">−</button>` +
        `<button type="button" class="diff-symbol-close" data-action="close" aria-label="Close panel">×</button>` +
      `</header>` +
      `<div class="diff-symbol-list">${listHtml}</div>` +
    `</section>`
  }

  function renderMinimizedSession(session) {
    // Strip layout: chevron at top, rotated symbol name in middle (reads
    // top-to-bottom via writing-mode: vertical-rl), close button at bottom.
    // The whole strip is clickable to restore — children outside the
    // explicit data-action elements bubble up to the panel-root handler.
    return `<section class="diff-symbol-session is-minimized" data-session-id="${session.id}" title="${escapeHtml(session.symbol)}">` +
      `<button type="button" class="diff-symbol-mini-chevron" data-action="restore" aria-label="Restore panel">‹</button>` +
      `<code class="diff-symbol-mini-name">${escapeHtml(session.symbol)}</code>` +
      `<button type="button" class="diff-symbol-mini-close" data-action="close" aria-label="Close session">×</button>` +
    `</section>`
  }

  function flashCell(cell) {
    if (!cell || !cell.isConnected) return
    clearActiveFlash()
    requestAnimationFrame(() => {
      if (!isStale() && cell.isConnected) cell.classList.add('is-flash')
    })
    flashTimer = setTimeout(() => {
      if (cell.isConnected) cell.classList.remove('is-flash')
      flashTimer = null
    }, 1700)
  }

  function clearActiveFlash() {
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    root.querySelectorAll('.diff-text.is-flash').forEach((el) => el.classList.remove('is-flash'))
  }

  function scrollToDiffCell(path, line, side) {
    if (isStale()) return
    let needsRender = false
    if (state.filter) {
      // Drop any active filter that would hide the jump target — works
      // for both `related` and `threads` kinds with the same predicate.
      const visible = computeVisibleFiles().some((f) => f.path === path)
      if (!visible) { state.filter = null; needsRender = true }
    }
    // Reviewed files are always rendered (collapsed); the next block
    // handles uncollapsing them on jump-to.
    if (state.collapsedPaths.has(path)) {
      state.collapsedPaths.delete(path)
      const sec = root.querySelector(`.diff-file[data-path="${cssEscape(path)}"]`)
      if (sec) sec.classList.remove('is-collapsed')
    }
    if (needsRender) renderBody()
    const cell = root.querySelector(
      `.diff-text[data-path="${cssEscape(path)}"][data-line="${line}"][data-side="${side}"]`
    )
    if (!cell) return
    cell.scrollIntoView({ behavior: 'auto', block: 'center' })
    flashCell(cell)
  }

  // Highlight every line containing the active session's symbol. Only the
  // active session contributes highlights — minimized parked sessions stay
  // visually quiet so the diff body isn't dotted with overlapping searches.
  //
  // Two-layer highlight:
  //   (1) .is-symbol-hit on the cell → quiet row-marker (left-edge ribbon)
  //       so the eye can scan rows. Works even for keyword matches where
  //       no per-token span exists.
  //   (2) A single dynamic CSS rule in <style data-symbol-style> targets
  //       [data-token="<symbol>"] inside hit cells, lighting up only the
  //       matched token. Tokenizer stamps data-token on identifier spans
  //       (see public/syntax.js).
  //
  // Updating one <style>.textContent on session switch avoids the per-cell
  // text-node mutation that crashed Brave's renderer in earlier prototypes.
  function applySymbolHighlights() {
    clearSymbolHighlights()
    const session = getActiveSession()
    if (!session) return
    const seen = new Set()
    for (const m of session.matches) {
      const key = `${m.path}|${m.line}|${m.side}`
      if (seen.has(key)) continue
      seen.add(key)
      const cell = root.querySelector(
        `.diff-text[data-path="${cssEscape(m.path)}"][data-line="${m.line}"][data-side="${m.side}"]`
      )
      if (cell) cell.classList.add('is-symbol-hit')
    }
    const styleEl = root.querySelector('style[data-symbol-style]')
    if (styleEl) {
      // CSS.escape handles edge-case attribute values defensively, even
      // though IDENT_RE already excludes CSS special chars.
      const sym = window.CSS && CSS.escape ? CSS.escape(session.symbol) : session.symbol
      styleEl.textContent =
        `.diff-text.is-symbol-hit [data-token="${sym}"] {\n` +
        `  background: color-mix(in srgb, var(--lane-explain) 38%, transparent);\n` +
        `  box-shadow: 0 0 0 1px color-mix(in srgb, var(--lane-explain) 55%, transparent);\n` +
        `  border-radius: 3px;\n` +
        `}`
    }
  }

  function clearSymbolHighlights() {
    root.querySelectorAll('.diff-text.is-symbol-hit').forEach((cell) => cell.classList.remove('is-symbol-hit'))
    const styleEl = root.querySelector('style[data-symbol-style]')
    if (styleEl) styleEl.textContent = ''
  }

  function viewForCurrentIndex() {
    if (isLocalIndex(state.index)) return 'local'
    if (isFullIndex(state.index))  return 'full'
    return 'commit'
  }

  function openEditorBelow(cell) {
    root.querySelectorAll('.diff-row-editor').forEach((r) => r.remove())

    const row  = cell.closest('tr')
    const path = cell.dataset.path || ''
    const side = cell.dataset.side || 'new'
    const line = cell.dataset.line || ''
    const sha  = cell.dataset.sha  || ''
    // Snapshot the line text at create time. The .diff-line span carries
    // the syntax-highlighted markup; reading textContent strips the spans
    // and leaves just the source text. Trimmed to a sane upper bound; the
    // server further caps it.
    const lineEl = cell.querySelector('.diff-line')
    const anchorText = lineEl ? lineEl.textContent.replace(/\s+$/, '').slice(0, 500) : ''
    if (!path || !line) return

    const editor = document.createElement('tr')
    editor.className = 'diff-row diff-row-editor'
    editor.innerHTML =
      '<td colspan="4" class="diff-editor-cell">' +
        '<div class="diff-editor">' +
          `<div class="diff-editor-anchor">${escapeHtml(path)}:${escapeHtml(line)} <span class="diff-editor-side">(${escapeHtml(side)})</span></div>` +
          '<textarea class="diff-editor-input" rows="3" placeholder="Add a comment for this line…"></textarea>' +
          '<div class="diff-editor-actions">' +
            '<button type="button" data-cancel>Cancel</button>' +
            '<button type="button" class="primary" data-submit>Add comment</button>' +
          '</div>' +
        '</div>' +
      '</td>'
    row.parentNode.insertBefore(editor, row.nextSibling)
    const ta = editor.querySelector('.diff-editor-input')
    ta.focus()

    editor.querySelector('[data-cancel]').addEventListener('click', () => editor.remove())
    editor.querySelector('[data-submit]').addEventListener('click', async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      const submitBtn = editor.querySelector('[data-submit]')
      submitBtn.disabled = true
      submitBtn.textContent = 'Saving…'
      try {
        const res = await api(`/api/repos/${encodeURIComponent(repo.id)}/threads`, {
          method: 'POST',
          body: JSON.stringify({
            view: viewForCurrentIndex(),
            file: path,
            line: Number(line),
            side,
            sha,
            body,
            anchor_text: anchorText,
          }),
        })
        editor.remove()
        if (res.threads) state.threads = res.threads
        renderInlineComments()
        toast('Comment added')
      } catch (e) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Add comment'
        toast('Comment failed: ' + (e.message || 'unknown'))
      }
    })
  }

  $('[data-sha]').addEventListener('click', async (e) => {
    const sha = e.currentTarget.dataset.shaFull || e.currentTarget.textContent
    try { await copyToClipboard(sha) } catch {}
  })

  // Click delegation: relate-filter buttons, reviewed banner, collapse toggle.
  $('[data-body]').addEventListener('click', (e) => {
    // Handle data-show-thread BEFORE any other case + bubbling: the global
    // click handler in events.js can't open the thread (no repoId/getThread
    // context at that level), so we own it here where we have state.threads
    // and repo.id in scope. stopPropagation prevents the toast from firing.
    const showThread = e.target.closest('[data-show-thread]')
    if (showThread) {
      e.preventDefault(); e.stopPropagation()
      const tid = showThread.dataset.showThread
      openThreadModal(tid, {
        repoId: repo.id,
        getThread: (id) => state.threads.find((t) => t.id === id),
        onChanged: () => { loadThreads() },
      })
      return
    }

    // Per-comment ✎ edit on inline thread rows. Body-only mutation —
    // posted_at and the author role stay frozen so state pills don't move.
    const editBtn = e.target.closest('[data-edit-comment]')
    if (editBtn) {
      e.preventDefault(); e.stopPropagation()
      beginEditInlineComment(editBtn)
      return
    }

    // Per-comment × delete on inline thread rows (mine + LLM replies).
    const removeBtn = e.target.closest('[data-remove-comment]')
    if (removeBtn) {
      e.preventDefault(); e.stopPropagation()
      const cid = removeBtn.dataset.commentId
      const tid = removeBtn.dataset.threadId
      const thread = state.threads.find((t) => t.id === tid)
      if (!thread) return
      const isLast = (thread.comments?.length || 0) <= 1
      confirmRemoveComment({
        isLast,
        onConfirm: async () => {
          removeBtn.disabled = true
          try {
            await api(
              `/api/repos/${encodeURIComponent(repo.id)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}`,
              { method: 'DELETE' }
            )
            await loadThreads()
            toast(isLast ? 'Thread removed' : 'Comment removed')
          } catch (err) {
            removeBtn.disabled = false
            toast('Remove failed: ' + (err.message || 'unknown'))
          }
        },
      })
      return
    }

    const relate = e.target.closest('[data-relate-anchor]')
    if (relate) {
      e.preventDefault(); e.stopPropagation()
      const anchor = relate.dataset.relateAnchor
      // Toggle off the current anchor; otherwise switch (overriding any
      // active threads filter — only one filter can be active at a time).
      const isSameAnchor = state.filter?.kind === 'related' && state.filter.anchor === anchor
      state.filter = isSameAnchor ? null : { kind: 'related', anchor }
      renderBody()
      return
    }
    if (e.target.closest('[data-thread-filter]')) {
      e.preventDefault(); e.stopPropagation()
      // Toggle the global threads filter. Switches off any active related
      // filter — they're mutually exclusive on the single state.filter slot.
      state.filter = state.filter?.kind === 'threads' ? null : { kind: 'threads' }
      renderBody()
      return
    }
    const backToThread = e.target.closest('[data-back-to-thread]')
    if (backToThread) {
      e.preventDefault(); e.stopPropagation()
      // Navigate to the threads page with the same thread id in the URL
      // so it reopens the modal. The router will tear down this diff page
      // (disposeDiffPage on the cross-page transition), so we don't need
      // to clear state.filter here.
      const threadId = backToThread.dataset.threadId || ''
      location.hash = ROUTES.threads(threadId ? { thread: threadId } : null)
      return
    }
    if (e.target.closest('[data-clear-filter]')) {
      state.filter = null
      renderBody()
      return
    }
    const markFile = e.target.closest('[data-toggle-reviewed]')
    if (markFile) {
      e.preventDefault(); e.stopPropagation()
      toggleFileReviewed(markFile.dataset.toggleReviewed)
      return
    }
    const view = e.target.closest('[data-view]')
    if (view) {
      e.preventDefault(); e.stopPropagation()
      if (state.mode !== view.dataset.view) {
        state.mode = view.dataset.view
        renderBody()
      }
      return
    }
    if (e.target.closest('[data-reset-reviewed]'))     { resetReviewed(); return }

    const head = e.target.closest('[data-toggle-collapse]')
    if (!head) return
    const section = head.closest('.diff-file[data-path]')
    if (!section) return
    const path = section.dataset.path
    const willCollapse = !state.collapsedPaths.has(path)
    if (willCollapse) {
      state.collapsedPaths.add(path)
      section.classList.add('is-collapsed')
    } else {
      state.collapsedPaths.delete(path)
      section.classList.remove('is-collapsed')
    }
    // Keep the chevron button's a11y state in sync — this handler does a
    // lightweight DOM mutation rather than a full renderBody(), so the
    // aria attrs set at render time would otherwise go stale.
    const toggleBtn = section.querySelector('.diff-file-toggle')
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(!willCollapse))
      toggleBtn.setAttribute('aria-label', `${willCollapse ? 'Expand' : 'Collapse'} file ${path}`)
    }
  })

  const isFullIndex  = (idx) => idx === state.commits.length
  const isLocalIndex = (idx) => state.hasLocal && idx === state.commits.length + 1
  const maxIndex     = ()    => state.commits.length + (state.hasLocal ? 1 : 0)

  async function goto(idx) {
    if (idx < 0 || idx > maxIndex()) return
    if (idx === state.index) return
    state.index = idx
    state.diff  = null
    state.shouldResetScroll = true   // navigated to a different diff — start at the top
    hideHoverButtons()
    closeSymbolPanel()
    syncUrl()
    await load()
  }

  // ------------------------------------------------------------------
  // Reviewed-batches (Full diff only)
  // ------------------------------------------------------------------
  // Files containing at least one thread anchored in the *current* view.
  // Mirrors the view-filter logic that renderInlineComments uses, so the
  // count and the filtered file set agree with what the user actually
  // sees inline. Returned as a Set<string> of repo-relative paths.
  function threadFilesForCurrentView() {
    const view = viewForCurrentIndex()
    const currentSha = view === 'commit' ? state.commits[state.index]?.sha : null
    const set = new Set()
    for (const t of state.threads) {
      if ((t.view || 'full') !== view) continue
      if (view === 'commit' && t.sha !== currentSha) continue
      if (t.file) set.add(t.file)
    }
    return set
  }

  function computeVisibleFiles() {
    const all = state.diff?.files || []
    const filter = state.filter
    // Single-file thread-context filter (from `?file=…&thread=…` URLs).
    // Works across all views (Full / per-commit / Local) because the
    // thread's anchor is view-independent at the path level.
    if (filter?.kind === 'file' && filter.path) {
      return all.filter((f) => f.path === filter.path)
    }
    if (filter?.kind === 'threads') {
      const set = threadFilesForCurrentView()
      return all.filter((f) => set.has(f.path))
    }
    if (!isFullIndex(state.index)) return all
    const priorities = state.diff?.priorities
    const filterAnchor = filter?.kind === 'related' ? filter.anchor : null
    if (filterAnchor && priorities) {
      const p = priorities[filterAnchor]
      const set = new Set([filterAnchor, ...(p?.incoming || []), ...(p?.outgoing || [])])
      return all.filter((f) => set.has(f.path))
    }
    // Reviewed files are NOT filtered out — they render with `is-reviewed`
    // + `is-collapsed` so only the header shows. User can click to expand.
    return all
  }

  // Fetch + apply the reviewed set for `sha` into state. No renderBody().
  // Returns true if state changed, false otherwise. Split out from
  // refreshReviewed so loadDiff can await it *in parallel* with the diff
  // fetch and have the reviewed/collapsed set in place before the first
  // paint — without this, reviewed files first render expanded, then snap
  // closed on the trailing render, costing a second full tokenize pass over
  // every file and a visible flash on big diffs.
  async function applyReviewedState(sha) {
    if (!sha || state.reviewedSha === sha) return false
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed?head_sha=${encodeURIComponent(sha)}`)
      if (isStale()) return false
      state.reviewed    = new Set(r?.paths || [])
      state.reviewedSha = sha
      // Auto-fold reviewed files on hydration. The mark-time auto-fold in
      // toggleFileReviewed only covers fresh marks
      // — without this, files marked in a prior session render expanded
      // until the user manually refolds them. Within a session, manual
      // expand still works (collapsedPaths.delete on click); the next
      // hydration (page reload) re-folds, which matches the spec contract
      // "reviewed = folded unless user expanded it (this session)".
      for (const p of state.reviewed) state.collapsedPaths.add(p)
      return true
    } catch { return false }
  }

  async function refreshReviewed() {
    if (isStale()) return
    if (!isFullIndex(state.index)) {
      if (state.reviewed.size || state.reviewedSha) {
        state.reviewed    = new Set()
        state.reviewedSha = null
        renderBody()
      }
      return
    }
    const sha = state.diff?.sha
    if (!sha) return
    if (state.reviewedSha === sha) return
    const changed = await applyReviewedState(sha)
    if (!changed || isStale()) return
    renderBody()
  }

  /**
   * Toggle reviewed state for a single file. Optimistic: mutate state +
   * DOM immediately, then PUT in the background and roll back on failure.
   *
   * Why not `renderBody()`: re-running renderBody over a 67-file diff
   * re-tokenizes every file via syntax.js and rebuilds every hunk table
   * (collapse is CSS-only — the hunk HTML is always built, see
   * renderFileSection). That was 2–3 seconds on a big branch for a
   * one-section visual change. Mirrors the lightweight-DOM-mutation
   * pattern the collapse-toggle handler already uses above.
   */
  async function toggleFileReviewed(path) {
    const sha = state.diff?.sha
    if (!sha || !path) return
    const currently = state.reviewed.has(path)
    const becomingReviewed = !currently
    const next = new Set(state.reviewed)
    if (currently) next.delete(path); else next.add(path)

    // Optimistic state + DOM mutation. The auto-fold-on-mark contract
    // (spec §7) stays here so the in-memory + DOM views agree before the
    // PUT lands. Unmark deliberately does NOT auto-unfold — a previously-
    // reviewed file should keep whatever collapse state the user chose.
    state.reviewed    = next
    state.reviewedSha = sha
    if (becomingReviewed) state.collapsedPaths.add(path)
    applyReviewedToggleDom(path, becomingReviewed)

    try {
      await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
        method: 'PUT',
        body: JSON.stringify({ head_sha: sha, paths: [...next], mode: 'replace' }),
      })
      toast(currently ? `Unmarked ${path.split('/').pop()}` : `Marked ${path.split('/').pop()} reviewed`)
    } catch (e) {
      // Roll back — server didn't accept the write, so the on-disk
      // reviewed.json doesn't reflect what the user just saw.
      const rollback = new Set(state.reviewed)
      if (becomingReviewed) rollback.delete(path); else rollback.add(path)
      state.reviewed = rollback
      if (becomingReviewed) state.collapsedPaths.delete(path)
      applyReviewedToggleDom(path, !becomingReviewed)
      toast('Toggle failed: ' + (e.message || 'unknown'))
    }
  }

  /**
   * Targeted DOM mutation for one file's reviewed/unreviewed transition.
   * Flips classes on the section, moves the Mark/Unmark button between
   * header (reviewed) and footer (unreviewed) — mirroring the split-
   * placement in renderFileSection — and refreshes the review banner so
   * the "N of T remaining" summary stays in sync. Click handlers stay
   * live because the diff body uses event delegation (see [data-body]
   * listener), so we never need to rewire individual buttons.
   */
  function applyReviewedToggleDom(path, becomingReviewed) {
    const section = root.querySelector(`.diff-file[data-path="${cssEscape(path)}"]`)
    if (!section) return

    section.classList.toggle('is-reviewed', becomingReviewed)
    if (becomingReviewed) {
      // Auto-collapse on mark. Keep chevron aria in sync — same dance as
      // the collapse-toggle handler.
      section.classList.add('is-collapsed')
      const chev = section.querySelector('.diff-file-toggle')
      if (chev) {
        chev.setAttribute('aria-expanded', 'false')
        chev.setAttribute('aria-label', `Expand file ${path}`)
      }
      // Anchor the user to the now-collapsed section's header. Without
      // this, clicking "Mark reviewed" at the footer of a long file
      // (after scrolling through it) leaves the browser's scroll
      // anchoring latched onto the next file's content — so you overshoot
      // past the file you were supposed to read next. `block: 'nearest'`
      // is a no-op when the header is already visible (short files), and
      // pulls it just into view when it isn't (long files).
      section.scrollIntoView({ block: 'nearest' })
    }

    // Swap the toggle button: reviewed → header `✓ reviewed`, unreviewed
    // → footer `○ Mark reviewed`. The button is never rendered in both
    // places at once (spec §7).
    const header = section.querySelector('.diff-file-head')
    section.querySelector('.diff-file-head [data-toggle-reviewed]')?.remove()
    section.querySelector(':scope > .diff-file-footer')?.remove()

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('data-toggle-reviewed', path)
    if (becomingReviewed) {
      btn.className = 'diff-file-mark active'
      btn.title = 'Marked reviewed — click to unmark'
      btn.setAttribute('aria-pressed', 'true')
      btn.textContent = '✓ reviewed'
      // Header order per renderFileSection: ... reviewed-toggle, relate-btn.
      // Insert before the relate button so we don't swap their positions
      // on files that have related-file edges.
      const relateBtn = header?.querySelector('.diff-relate-btn')
      if (relateBtn) header.insertBefore(btn, relateBtn)
      else header?.appendChild(btn)
    } else {
      btn.className = 'diff-file-mark'
      btn.title = 'Mark this file reviewed'
      btn.setAttribute('aria-pressed', 'false')
      btn.textContent = '○ Mark reviewed'
      const footer = document.createElement('footer')
      footer.className = 'diff-file-footer'
      footer.appendChild(btn)
      section.appendChild(footer)
    }

    refreshReviewBanner()
  }

  /**
   * Replace the diff-control-strip ("review banner") in place. Used by
   * the reviewed-toggle's optimistic DOM path so the "N of T remaining"
   * summary and Reset button surface as soon as the first file is
   * marked, without re-rendering the 67-file body underneath.
   */
  function refreshReviewBanner() {
    const body = $('[data-body]')
    const existing = body?.querySelector('.diff-review-banner')
    const visibleCount = computeVisibleFiles().length
    const html = renderReviewBanner(visibleCount)
    if (!existing) {
      // No banner yet (e.g. first mark on a previously-empty reviewed
      // set) — prepend the freshly-rendered one above the file list.
      if (html && body) body.insertAdjacentHTML('afterbegin', html)
      return
    }
    if (!html) { existing.remove(); return }
    const tmp = document.createElement('template')
    tmp.innerHTML = html
    existing.replaceWith(tmp.content.firstChild)
  }

  async function resetReviewed() {
    try {
      await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, { method: 'DELETE' })
      state.reviewed     = new Set()
      state.reviewedSha  = state.diff?.sha || null
      renderBody()
      toast('Reviewed marks cleared')
    } catch (e) {
      toast('Reset failed: ' + (e.message || 'unknown'))
    }
  }

  // The diff control strip (a.k.a. review banner) lives directly under
  // the diff header. Its job is "controls that act on the diff body":
  // the view-mode toggle (Split/Inline) on the left, contextual filter
  // chips and reviewed-state info on the right. Page navigation chrome
  // (Overview, Threads) stays in the header above. The strip always
  // renders when files exist, since the view toggle is always relevant;
  // it also renders when a filter is active even if files === 0, so the
  // user can clear the filter from an empty result.
  function renderReviewBanner(visibleCount) {
    const filterKind  = state.filter?.kind
    const isFull      = isFullIndex(state.index)
    const totalFiles  = state.diff?.files?.length || 0
    const threadCount = threadFilesForCurrentView().size
    const hasFiles    = totalFiles > 0
    const hasFilter   = !!filterKind
    if (!hasFiles && !hasFilter) return ''

    // View-toggle markup — always rendered, anchors the left side. The
    // active class is baked at render time; clicks trigger renderBody()
    // which regenerates the banner with the new active state.
    const viewToggle =
      '<div class="diff-view-toggle" role="tablist" aria-label="Diff view mode">' +
        `<button type="button" data-view="split"  class="${state.mode === 'split'  ? 'active' : ''}" role="tab" aria-selected="${state.mode === 'split'}">Split</button>` +
        `<button type="button" data-view="inline" class="${state.mode === 'inline' ? 'active' : ''}" role="tab" aria-selected="${state.mode === 'inline'}">Inline</button>` +
      '</div>'

    // Active filter states — right side becomes a focused filter label
    // + clear action. The view toggle still anchors the left so the user
    // can switch Split/Inline without clearing the filter first.
    if (filterKind === 'file') {
      // Thread-context single-file view. The "← Back to thread" affordance
      // is the primary (and only) action here — it routes back to
      // `#/?thread=<id>` which reopens the thread modal on the threads
      // page. No "Viewing: <path>" label: the file path is already
      // displayed in big mono at the top of the file section right below,
      // so a second copy would be redundant chrome. If the URL didn't
      // carry a thread id (e.g. someone bookmarked `#/diff?file=…`), we
      // swap in a plain "Show all" so the user has an exit.
      const threadId = state.filter.threadId || ''
      const action = threadId
        ? `<button type="button" class="diff-filter-clear" data-back-to-thread data-thread-id="${escapeHtml(threadId)}">← Back to thread</button>`
        : '<button type="button" class="diff-filter-clear" data-clear-filter>Show all</button>'
      return '<div class="diff-review-banner is-filter is-filter-file">' +
        viewToggle +
        `<div class="diff-review-right">${action}</div>` +
      '</div>'
    }
    if (filterKind === 'threads') {
      return '<div class="diff-review-banner is-filter is-filter-threads">' +
        viewToggle +
        '<div class="diff-review-right">' +
          `<span class="diff-review-label"><span class="diff-filter-dot"></span>Filter: files with threads · ${visibleCount} file${visibleCount === 1 ? '' : 's'}</span>` +
          '<button type="button" class="diff-filter-clear" data-clear-filter>Show all</button>' +
        '</div>' +
      '</div>'
    }
    if (filterKind === 'related' && isFull) {
      const filterAnchor = state.filter.anchor
      return '<div class="diff-review-banner is-filter">' +
        viewToggle +
        '<div class="diff-review-right">' +
          `<span class="diff-review-label">Filter: related to <code>${escapeHtml(filterAnchor)}</code> · ${visibleCount} file${visibleCount === 1 ? '' : 's'}</span>` +
          '<button type="button" class="diff-filter-clear" data-clear-filter>Show all</button>' +
        '</div>' +
      '</div>'
    }

    // Resting state — right side hosts (in order) reviewed summary +
    // Reset action when any files are marked, then the threads-filter
    // chip when threads exist. Order is "info first, action last" so
    // the right side reads left-to-right as a sentence.
    const hasReviewed = isFull && state.reviewed.size > 0
    const rightParts  = []
    if (hasReviewed) {
      const remaining = Math.max(0, totalFiles - state.reviewed.size)
      rightParts.push(
        `<span class="diff-review-summary">${remaining} of ${totalFiles} remaining <span class="diff-review-meta">· ${state.reviewed.size} reviewed</span></span>` +
        '<button type="button" class="diff-review-reset" data-reset-reviewed title="Clear all reviewed marks">Reset</button>'
      )
    }
    if (threadCount > 0) {
      rightParts.push(
        `<button type="button" class="diff-filter-chip" data-thread-filter title="Show only files with comment threads (${threadCount} file${threadCount === 1 ? '' : 's'})">` +
          '<span class="diff-filter-chip-dot" aria-hidden="true"></span>' +
          `<span class="diff-filter-chip-text">${threadCount} with thread${threadCount === 1 ? '' : 's'}</span>` +
        '</button>'
      )
    }

    return '<div class="diff-review-banner is-summary">' +
      viewToggle +
      (rightParts.length
        ? `<div class="diff-review-right">${rightParts.join('<span class="diff-review-sep" aria-hidden="true">·</span>')}</div>`
        : '') +
    '</div>'
  }

  function renderHead() {
    if (isStale()) return
    const shaEl       = $('[data-sha]')
    const isFull      = isFullIndex(state.index)
    const isLocal     = isLocalIndex(state.index)
    const fd          = state.diff

    $('[data-prev]').disabled = state.index <= 0
    $('[data-next]').disabled = state.index >= maxIndex()
    $('[data-next]').title =
      state.index >= maxIndex() ? '' :
      state.index === state.commits.length - 1 ? 'Full diff →' :
      isFull && state.hasLocal ? 'Local changes →' :
      isFull || isLocal ? '' : 'Next commit'

    if (isLocal) {
      $('[data-position]').textContent = 'Local'
      shaEl.textContent     = 'local'
      shaEl.dataset.shaFull = ''
      $('[data-headline]').textContent = state.branch ? `${state.branch} · uncommitted` : 'Uncommitted changes'
      $('[data-author]').textContent   = fd?.sha ? `vs HEAD ${fd.sha.slice(0, 7)}` : ''
      const untracked = fd?.untracked_files?.length || 0
      $('[data-when]').textContent     = untracked ? `${untracked} untracked` : 'working tree'
      const fcount = fd?.files?.length || 0
      $('[data-stats]').textContent    = fd
        ? `${fcount} file${fcount === 1 ? '' : 's'}`
        : ''
      return
    }

    if (isFull) {
      $('[data-position]').textContent = 'Full diff'
      const headSha = fd?.sha || branchInfo?.head_sha || ''
      shaEl.textContent     = 'FULL'
      shaEl.dataset.shaFull = headSha
      const baseRef = branchInfo?.base_branch || ''
      const headRef = state.branch || ''
      // When on the base branch, `current === base` so `main ← main` would
      // be misleading — the actual diff base is HEAD~1 (the on-base review
      // fallback). Surface the branch + a neutral 'review' label instead.
      const onBase = !!branchInfo?.on_base
      $('[data-headline]').textContent = onBase && headRef
        ? `${headRef} · review`
        : (baseRef && headRef ? `${headRef} ← ${baseRef}` : 'Full diff')
      $('[data-author]').textContent   = headSha ? `head ${headSha.slice(0, 7)}` : ''
      $('[data-when]').textContent     = `${state.commits.length} commit${state.commits.length === 1 ? '' : 's'}`
      const fcount = fd?.files?.length || 0
      $('[data-stats]').textContent    = fd
        ? `${fcount} file${fcount === 1 ? '' : 's'}`
        : ''
      return
    }

    const c = state.commits[state.index]
    $('[data-position]').textContent = `${state.index + 1} of ${state.commits.length}`
    shaEl.textContent      = c.short_sha || (c.sha ? c.sha.slice(0, 7) : '')
    shaEl.dataset.shaFull  = c.sha || ''
    $('[data-headline]').textContent = c.headline || ''
    $('[data-author]').textContent   = '@' + (c.author || 'unknown')
    $('[data-when]').textContent     = c.authored_at ? relTime(c.authored_at) : ''
    $('[data-stats]').textContent    =
      `+${c.additions ?? 0} −${c.deletions ?? 0} in ${c.changed_files ?? 0} file${(c.changed_files ?? 0) === 1 ? '' : 's'}`
  }

  function renderBody() {
    if (isStale()) return
    const body = $('[data-body]')
    if (state.loading) {
      body.innerHTML = '<div class="diff-loading">Loading diff…</div>'
      return
    }
    if (!state.diff) {
      body.innerHTML = ''
      return
    }
    const isLocal     = isLocalIndex(state.index)
    const isFull      = isFullIndex(state.index)
    const priorities  = state.diff.priorities
    const filterAnchor = state.filter?.kind === 'related' ? state.filter.anchor : null

    const visibleFiles = computeVisibleFiles()
    let banners = renderReviewBanner(visibleFiles.length)
    const truncMsg = isLocal
      ? 'Showing first 100 files — large local diff truncated.'
      : isFull
      ? 'Showing first 100 files — large diff truncated.'
      : 'Showing first 100 files — large commit truncated.'
    if (state.diff.truncated) banners += `<div class="diff-warn">${truncMsg}</div>`
    const untracked = isLocal ? (state.diff.untracked_files || []) : []
    if (untracked.length) {
      const shown = untracked.slice(0, 10).map((p) => escapeHtml(p)).join(', ')
      const more  = untracked.length > 10 ? ` (and ${untracked.length - 10} more)` : ''
      const noun  = untracked.length === 1 ? 'file' : 'files'
      banners += `<div class="diff-warn">${untracked.length} untracked ${noun} not shown: ${shown}${more}</div>`
    }

    if (!visibleFiles.length) {
      let emptyMsg
      if (state.filter?.kind === 'threads') {
        emptyMsg = '<div class="diff-empty">No files with threads in this view.</div>'
      } else if (isLocal && untracked.length) {
        emptyMsg = '<div class="diff-empty">No tracked changes vs HEAD.</div>'
      } else if (isFull && filterAnchor) {
        emptyMsg = '<div class="diff-empty">No related files found for this anchor.</div>'
      } else {
        emptyMsg = '<div class="diff-empty">No file changes.</div>'
      }
      body.innerHTML = banners + emptyMsg
      return
    }
    const orderedFiles = priorities
      ? [...visibleFiles].sort((a, b) => compareForReview(a, b, priorities))
      : visibleFiles
    const showRelateBtn = isFull && !!priorities
    const filesHtml = orderedFiles.map((f) => {
      // Per-file relationship to the filter anchor. Only meaningful in
      // filter mode AND when this file isn't the anchor itself.
      let relationship = null
      if (filterAnchor && f.path !== filterAnchor && priorities) {
        const p = priorities[f.path]
        const importsAnchor    = p?.outgoing?.includes(filterAnchor)
        const importedByAnchor = p?.incoming?.includes(filterAnchor)
        if (importsAnchor && importedByAnchor)   relationship = 'circular'
        else if (importsAnchor)                  relationship = 'imports'
        else if (importedByAnchor)               relationship = 'imported-by'
      }
      return renderFileSection(f, state.mode, state.diff.sha, {
        isReviewed: state.reviewed.has(f.path),
        isCollapsed: state.collapsedPaths.has(f.path),
        showRelateBtn,
        showReviewedToggle: isFull,
        isFilterAnchor: filterAnchor === f.path,
        priorityEntry: priorities?.[f.path] || null,
        relationship,
        anchorPath: filterAnchor,
      })
    }).join('')
    body.innerHTML = banners + filesHtml
    if (state.shouldResetScroll) {
      body.scrollTop = 0
      state.shouldResetScroll = false
    }
    renderInlineComments()
    maybeScrollToAnchor()
    applySymbolHighlights()
  }

  // One-shot scroll: when the user clicked "Jump to diff" from the threads
  // page, this fires after the first successful body render. Auto-uncollapses
  // the file if needed, scrolls the matching cell into view, flashes briefly.
  // After firing once it nulls out scrollToAnchor so subsequent renders
  // (split↔inline toggle, etc.) don't keep scrolling.
  function maybeScrollToAnchor() {
    if (!scrollToAnchor) return
    const { file, line, side } = scrollToAnchor
    if (!file || !line) { scrollToAnchor = null; return }
    // Uncollapse the target file before scrolling. Covers both manual
    // collapse and the reviewed-auto-collapse case (reviewed files keep
    // `.is-reviewed` for the header tint; we only strip `.is-collapsed`
    // so the body becomes visible).
    if (state.collapsedPaths.has(file)) {
      state.collapsedPaths.delete(file)
      const sec = root.querySelector(`.diff-file[data-path="${cssEscape(file)}"]`)
      if (sec) {
        sec.classList.remove('is-collapsed')
        // Force a synchronous reflow so the cell's layout box is
        // materialized before scrollIntoView runs. Without this, the
        // .diff-file-body was display:none a moment ago and the cell
        // had no layout box; scrollIntoView is a no-op on layout-less
        // elements, so the jump silently fails for reviewed files
        // (the dominant collapsed case once auto-fold-on-reviewed lands).
        void sec.offsetHeight
      }
    }
    // Defer one frame so the body's just-set innerHTML has laid out.
    requestAnimationFrame(() => {
      if (isStale()) return
      const cell = root.querySelector(
        `.diff-text[data-path="${cssEscape(file)}"][data-line="${line}"][data-side="${side || 'new'}"]`
      )
      if (cell) {
        cell.scrollIntoView({ behavior: 'auto', block: 'center' })
        flashCell(cell)
      } else {
        toast(`${file.split('/').pop()}:${line} not in this diff (anchor lost)`)
      }
    })
    scrollToAnchor = null
  }

  function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1') }

  // ------------------------------------------------------------------
  // Inline thread display
  // ------------------------------------------------------------------
  function renderInlineComments() {
    const body = $('[data-body]')
    if (!body) return
    body.querySelectorAll('.diff-row-thread').forEach((r) => r.remove())

    if (!state.threads.length) return
    const view = viewForCurrentIndex()
    const cells = [...body.querySelectorAll('.diff-text[data-side][data-line][data-path]')]

    for (const t of state.threads) {
      // Only render threads created in the current view to keep anchor
      // semantics honest. Per-commit threads are anchored to a SHA and
      // only render in that commit; full/local threads only in their view.
      if ((t.view || 'full') !== view) continue
      // For commit view, also require the SHA to match the current commit
      if (view === 'commit') {
        const c = state.commits[state.index]
        if (t.sha !== c?.sha) continue
      }
      const file = t.file
      const line = String(t.line ?? '')
      const side = t.side ?? 'new'
      const cell = cells.find(
        (c) => c.dataset.path === file && c.dataset.line === line && c.dataset.side === side
      )
      if (!cell) continue
      const row = cell.closest('tr')
      if (!row?.parentNode) continue
      const display = makeThreadDisplayRow(t)
      row.parentNode.insertBefore(display, row.nextSibling)
    }
  }

  function makeThreadDisplayRow(thread) {
    const tr = document.createElement('tr')
    tr.className = 'diff-row diff-row-thread'
    tr.dataset.threadId = thread.id

    const stateClass = thread.state === 'resolved'  ? 'state-resolved'
                     : thread.state === 'your_turn' ? 'state-your-turn'
                     : thread.state === 'awaiting'  ? 'state-awaiting'
                     : 'state-read'
    // Highlight the inline thread the user just jumped from (URL carries
    // `?thread=…`, parsed into state.filter.threadId on file-kind filter).
    // Visual treatment mirrors the threads-page is-recent breadcrumb so
    // the cross-page "you came from here" cue is consistent.
    const jumpedFrom = state.filter?.kind === 'file' && state.filter.threadId === thread.id
      ? ' is-jumped-from'
      : ''
    const statePill = thread.state === 'resolved'
      ? '<span class="state-pill state-resolved" title="Thread resolved">✓ resolved</span>'
      : thread.state === 'your_turn'
      ? '<span class="state-pill state-your-turn" title="LLM replied — your turn">🟢 your turn</span>'
      : ''

    // Per-comment × delete button: applies to every comment regardless of
    // author (yours and LLM replies). Removing the last comment deletes the
    // whole thread + JSON file (server enforces; client confirms).
    const commentsHtml = (thread.comments || [])
      .map(
        (c) => `
        <div class="diff-thread-comment" data-comment-id="${escapeHtml(c.id)}">
          <div class="diff-thread-meta">
            <span class="diff-thread-user">@${escapeHtml(c.user)}</span>
            <span class="diff-thread-when">${escapeHtml(relTime(c.posted_at || c.created_at))}</span>
            <button type="button" class="diff-thread-edit" data-edit-comment data-comment-id="${escapeHtml(c.id)}" data-thread-id="${escapeHtml(thread.id)}" aria-label="Edit comment" title="Edit comment">✎</button>
            <button type="button" class="diff-thread-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" data-thread-id="${escapeHtml(thread.id)}" aria-label="Remove comment" title="Remove comment">×</button>
          </div>
          <div class="diff-thread-body" data-body>${inlineCode(c.body)}</div>
        </div>`
      )
      .join('')

    tr.innerHTML =
      '<td colspan="4" class="diff-thread-cell">' +
        `<div class="diff-thread ${stateClass}${jumpedFrom}" data-thread-id="${escapeHtml(thread.id)}">` +
          '<div class="diff-thread-header">' +
            `<button type="button" class="diff-thread-anchor" data-show-thread="${escapeHtml(thread.id)}" title="Open thread">${escapeHtml(thread.file)}:${escapeHtml(String(thread.line))} <span class="diff-thread-side">(${escapeHtml(thread.side || 'new')})</span></button>` +
            statePill +
            `<span class="card-local-pill view-${thread.view || 'full'}">${escapeHtml(thread.view || 'full')}</span>` +
          '</div>' +
          `<div class="diff-thread-comments">${commentsHtml}</div>` +
        '</div>' +
      '</td>'

    return tr
  }

  // In-place edit of an inline thread comment. Mirrors the modal flow:
  // swap `.diff-thread-body` for a textarea + Save/Cancel; PATCH on save;
  // restore raw markup on cancel. Re-rendering the whole diff via
  // `loadThreads()` would drop the inline thread row state (collapse,
  // intra-line highlight, scroll position), so we patch the single element
  // and let SSE pick up the JSON write afterwards.
  function beginEditInlineComment(btn) {
    const tid = btn.dataset.threadId
    const cid = btn.dataset.commentId
    const commentEl = btn.closest('.diff-thread-comment')
    const bodyEl = commentEl?.querySelector('[data-body]')
    if (!commentEl || !bodyEl) return
    if (commentEl.querySelector('[data-edit-form]')) return    // already editing
    const thread = state.threads.find((t) => t.id === tid)
    const comment = thread?.comments?.find((m) => m.id === cid)
    if (!comment) return

    const originalHtml = bodyEl.outerHTML
    const form = document.createElement('div')
    form.className = 'diff-thread-body diff-thread-edit-form'
    form.dataset.body = ''
    form.dataset.editForm = ''
    form.innerHTML =
      '<textarea class="diff-thread-edit-input" rows="3"></textarea>' +
      '<div class="diff-thread-edit-actions">' +
        '<button type="button" data-edit-cancel>Cancel</button>' +
        '<button type="button" class="primary" data-edit-save>Save</button>' +
      '</div>'
    bodyEl.replaceWith(form)
    const ta = form.querySelector('textarea')
    ta.value = comment.body || ''
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)

    const cancel = () => {
      const restored = document.createElement('template')
      restored.innerHTML = originalHtml.trim()
      form.replaceWith(restored.content.firstChild)
    }
    form.querySelector('[data-edit-cancel]').addEventListener('click', (ev) => {
      ev.stopPropagation()
      cancel()
    })
    form.querySelector('[data-edit-save]').addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const text = ta.value.trim()
      if (!text) { ta.focus(); return }
      if (text === (comment.body || '').trim()) { cancel(); return }
      const saveBtn = form.querySelector('[data-edit-save]')
      const cancelBtn = form.querySelector('[data-edit-cancel]')
      saveBtn.disabled = true; cancelBtn.disabled = true
      saveBtn.textContent = 'Saving…'
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repo.id)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}`,
          { method: 'PATCH', body: JSON.stringify({ body: text }) }
        )
        const newBody = document.createElement('div')
        newBody.className = 'diff-thread-body'
        newBody.dataset.body = ''
        newBody.innerHTML = inlineCode(res?.comment?.body ?? text)
        form.replaceWith(newBody)
        // Keep local state.threads in sync so subsequent edits read the
        // updated body without waiting for the SSE-triggered loadThreads.
        if (comment) comment.body = res?.comment?.body ?? text
        toast('Comment updated')
      } catch (err) {
        saveBtn.disabled = false; cancelBtn.disabled = false
        saveBtn.textContent = 'Save'
        toast('Edit failed: ' + (err.message || 'unknown'))
      }
    })
  }

  // ------------------------------------------------------------------
  // Diff load with cache
  // ------------------------------------------------------------------
  // Single-file thread-context view must always render the target file
  // expanded, even if it's marked reviewed. The user came here from a
  // thread to look at the comment in context — collapsed is the wrong
  // default for "this is the one file you care about right now". Called
  // after applyReviewedState (which seeds collapsedPaths from reviewed)
  // so the explicit-expand wins over the auto-fold.
  const ensureSingleFileExpanded = () => {
    if (state.filter?.kind === 'file' && state.filter.path) {
      state.collapsedPaths.delete(state.filter.path)
    }
  }

  async function loadDiff({ cacheKey, fetchUrl, errorPrefix }) {
    if (isStale()) return
    const cached = cacheKey ? loadCachedDiff(cacheKey) : null
    if (cached) {
      // Hydrate the reviewed set before the first paint so cached-diff
      // navigation doesn't show the same expanded→collapsed flash as a
      // fresh load. Cheap: most jumps hit the in-memory state.reviewedSha
      // === sha short-circuit; only the first cached load this session
      // actually hits the network here.
      if (isFullIndex(state.index) && cached.sha) await applyReviewedState(cached.sha)
      if (isStale()) return
      ensureSingleFileExpanded()
      state.loading = false
      state.diff    = cached
      renderHead()
      renderBody()
      return
    }
    const expectedIndex = state.index
    state.loading = true
    renderBody()
    try {
      // Kick off the reviewed fetch in parallel with the diff fetch for
      // Full view. Keyed off branchInfo.head_sha — known up front, and in
      // practice equal to the diff response's sha (HEAD doesn't move
      // between the back-to-back /branch and /diff calls). If they ever
      // diverge, the post-load refreshReviewed() pass catches the mismatch
      // and refetches; the worst case is reverting to today's behavior
      // for a single load.
      const reviewedKey = isFullIndex(expectedIndex) ? branchInfo?.head_sha : null
      const [diff] = await Promise.all([
        api(fetchUrl),
        reviewedKey ? applyReviewedState(reviewedKey) : Promise.resolve(null),
      ])
      if (isStale()) return
      const writeKey = isFullIndex(expectedIndex) && diff?.sha ? `full:${diff.sha}` : cacheKey
      if (state.index !== expectedIndex) {
        if (writeKey) saveCachedDiff(writeKey, diff)
        return
      }
      ensureSingleFileExpanded()
      state.loading = false
      state.diff    = diff
      if (writeKey) saveCachedDiff(writeKey, diff)
      renderHead()
      renderBody()
    } catch (e) {
      if (isStale()) return
      if (state.index !== expectedIndex) return
      state.loading = false
      $('[data-body]').innerHTML = `<div class="diff-error">${errorPrefix}: ${escapeHtml(e.message)}</div>`
    }
  }

  async function load() {
    if (isStale()) return
    renderHead()
    if (isLocalIndex(state.index)) {
      await loadDiff({
        cacheKey:    null,
        fetchUrl:    `/api/repos/${encodeURIComponent(repo.id)}/local-diff`,
        errorPrefix: 'Failed to load local diff',
      })
    } else if (isFullIndex(state.index)) {
      const observedHead = state.commits[state.commits.length - 1]?.sha || branchInfo?.head_sha
      await loadDiff({
        cacheKey:    observedHead ? `full:${observedHead}` : null,
        fetchUrl:    `/api/repos/${encodeURIComponent(repo.id)}/diff`,
        errorPrefix: 'Failed to load full diff',
      })
    } else {
      const c = state.commits[state.index]
      await loadDiff({
        cacheKey:    c.sha,
        fetchUrl:    `/api/repos/${encodeURIComponent(repo.id)}/commits/${encodeURIComponent(c.sha)}/diff`,
        errorPrefix: 'Failed to load diff',
      })
    }
    if (isStale()) return
    refreshReviewed()
  }

  // ------------------------------------------------------------------
  // Threads: initial fetch + SSE subscribe
  // ------------------------------------------------------------------
  async function loadThreads() {
    if (isStale()) return
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/threads`)
      if (isStale()) return
      state.threads = r?.threads || []
      renderInlineComments()
      // Threads button only makes sense once at least one thread exists —
      // otherwise it'd just bounce the router straight back here.
      const link = root.querySelector('[data-threads-link]')
      if (link) link.hidden = state.threads.length === 0
      // Banner hosts the threads-filter chip — re-render so newly-arrived
      // threads (e.g. via SSE) reveal the chip without a manual reload.
      renderBody()
    } catch {}
  }

  unsubscribeSse = subscribeRepoEvents(repo.id, (payload) => {
    if (isStale()) return
    if (payload?.branch_id !== state.branchId) return
    loadThreads()
  })

  await loadThreads()
  if (isStale()) return
  await load()
}
