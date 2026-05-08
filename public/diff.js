import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, copyToClipboard, toast } from './util.js'
import { openCopyAggregateModal, openThreadModal, confirmRemoveComment } from './modals.js'
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
    isReviewed     = false,
    isCollapsed    = false,
    showRelateBtn  = false,
    isFilterAnchor = false,
    priorityEntry  = null,
    relationship   = null,
    anchorPath     = null,
  } = opts
  const status      = file.status || 'modified'
  const statusGlyph = STATUS_GLYPH[status] || '?'
  const pathShown   = file.previous_path && file.path !== file.previous_path
    ? `${escapeHtml(file.previous_path)} → ${escapeHtml(file.path)}`
    : escapeHtml(file.path)

  let body
  if (file.is_binary) {
    body = '<div class="diff-empty">Binary file — diff not shown.</div>'
  } else if (!file.patch) {
    body = '<div class="diff-empty">No content change shown (rename or oversized diff).</div>'
  } else {
    const hunks = parsePatch(file.patch)
    const renderHunk = mode === 'split' ? renderHunkSplit : renderHunkInline
    const language = languageForPath(file.path)
    const colgroup = mode === 'split'
      ? '<colgroup><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-no"><col class="diff-col-text"></colgroup>'
      : '<colgroup><col class="diff-col-no"><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-text"></colgroup>'
    body = `<table class="diff-table diff-${mode}">${colgroup}<tbody>${hunks.map((h) => renderHunk(h, file.path, sha, language)).join('')}</tbody></table>`
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
  // Per-file reviewed toggle. Click stops propagation so it doesn't trigger
  // the file head's collapse-toggle. When marking, the click handler also
  // adds the path to collapsedPaths so the file folds — the GitHub-PR-review
  // pattern of "I'm done with this one, get it out of my way".
  const reviewedToggle = `<button type="button" class="diff-file-mark${isReviewed ? ' active' : ''}" data-toggle-reviewed="${escapeHtml(file.path)}" title="${isReviewed ? 'Marked reviewed — click to unmark' : 'Mark this file reviewed'}" aria-pressed="${isReviewed}">${isReviewed ? '✓ reviewed' : '○ mark'}</button>`

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

  return `<section class="${sectionClass}" data-path="${escapeHtml(file.path)}" data-status="${status}">` +
    `<header class="diff-file-head" data-toggle-collapse>` +
      `<span class="diff-file-toggle" aria-hidden="true"></span>` +
      `<span class="diff-file-status" data-status="${status}" title="${status}">${statusGlyph}</span>` +
      `<code class="diff-file-path">${pathShown}</code>` +
      `<span class="diff-file-stats"><span class="diff-stat-add">+${file.additions ?? 0}</span> <span class="diff-stat-del">−${file.deletions ?? 0}</span></span>` +
      relChip +
      reviewedToggle +
      relateBtn +
    `</header>` +
    `<div class="diff-file-body">${body}</div>` +
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
export async function renderDiffView({ repo, branch, branchId, branchInfo, commits, initialIndex = 0, hasLocal = false, scrollToAnchor = null, isCurrent = () => true }) {
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
    filter:   null,
    symbolPanel: { open: false, symbol: null, matches: [], currentPath: null, jumpStack: [], currentAnchor: null },
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
        <div class="diff-view-toggle" role="tablist" aria-label="Diff view mode">
          <button type="button" data-view="split"  class="${state.mode === 'split'  ? 'active' : ''}" role="tab">Split</button>
          <button type="button" data-view="inline" class="${state.mode === 'inline' ? 'active' : ''}" role="tab">Inline</button>
        </div>
        <button type="button" class="diff-copy-prompt" data-copy-prompt title="Copy aggregate-comments prompt for the agent">Copy</button>
        <span data-overview-nav class="overview-nav-slot"></span>
        <a class="btn diff-back" data-threads-link href="${ROUTES.threads()}" hidden>Threads</a>
      </div>
    </header>
    <div class="diff-body" data-body>
      <div class="diff-loading">Loading diff…</div>
    </div>
    <aside class="diff-symbol-panel" data-symbol-panel hidden>
      <header class="diff-symbol-head">
        <button type="button" class="diff-symbol-back" data-symbol-back hidden title="Back to previous location (Backspace)" aria-label="Back to previous location">↩ back</button>
        <code class="diff-symbol-name" data-symbol-name></code>
        <span class="diff-symbol-meta" data-symbol-meta></span>
        <button type="button" class="diff-symbol-close" data-symbol-close aria-label="Close panel">×</button>
      </header>
      <div class="diff-symbol-list" data-symbol-list></div>
    </aside>`
  main.replaceChildren(root)

  const $  = (sel) => root.querySelector(sel)
  const $$ = (sel) => root.querySelectorAll(sel)

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
      // Layered Escape: close symbol panel if open; otherwise no-op (the
      // page is the page — Escape doesn't navigate away).
      if (state.symbolPanel.open) { closeSymbolPanel(); e.preventDefault() }
    }
    else if (e.key === 'Backspace' && state.symbolPanel.open && state.symbolPanel.jumpStack.length > 0) {
      popSymbolJump(); e.preventDefault()
    }
    else if (e.key === 'ArrowLeft' || e.key === '[')  { goto(state.index - 1); e.preventDefault() }
    else if (e.key === 'ArrowRight' || e.key === ']') { goto(state.index + 1); e.preventDefault() }
  }
  document.addEventListener('keydown', onKey)
  syncUrl()
  disposeOverviewNav = setupOverviewNav($('[data-overview-nav]'), repo.id)

  $$('[data-view]').forEach((b) => {
    b.addEventListener('click', () => {
      if (state.mode === b.dataset.view) return
      state.mode = b.dataset.view
      $$('[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === state.mode))
      renderBody()
    })
  })

  $('[data-prev]').addEventListener('click', () => goto(state.index - 1))
  $('[data-next]').addEventListener('click', () => goto(state.index + 1))

  $('[data-copy-prompt]').addEventListener('click', () => {
    openCopyAggregateModal({
      repo, branch, branchId, branchInfo,
      threads: state.threads,
    })
  })

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

  $('[data-symbol-close]').addEventListener('click', closeSymbolPanel)
  $('[data-symbol-back]').addEventListener('click', popSymbolJump)
  $('[data-symbol-panel]').addEventListener('click', (e) => {
    const match = e.target.closest('[data-path][data-line][data-side]')
    if (!match) return
    scrollToMatch(match.dataset.path, match.dataset.line, match.dataset.side)
  })
  $('[data-symbol-panel]').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const match = e.target.closest('[data-path][data-line][data-side]')
    if (!match) return
    e.preventDefault()
    scrollToMatch(match.dataset.path, match.dataset.line, match.dataset.side)
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

  function openSymbolPanel(symbol, currentPath, anchor) {
    const matches = findSymbolMatches(symbol)
    // jumpStack starts empty per panel session; the dblclick origin lives
    // in currentAnchor and is pushed onto the stack on the first jump.
    state.symbolPanel = { open: true, symbol, matches, currentPath, jumpStack: [], currentAnchor: anchor }
    const panel = $('[data-symbol-panel]')
    if (panel) panel.hidden = false
    root.classList.add('has-symbol-panel', 'disable-content-visibility')
    renderSymbolPanel()
    renderSymbolBackButton()
    applySymbolHighlights()
  }

  function closeSymbolPanel() {
    if (!state.symbolPanel.open) return
    state.symbolPanel = { open: false, symbol: null, matches: [], currentPath: null, jumpStack: [], currentAnchor: null }
    clearActiveFlash()
    const panel = $('[data-symbol-panel]')
    if (panel) panel.hidden = true
    const list = $('[data-symbol-list]')
    if (list) list.textContent = ''
    root.classList.remove('has-symbol-panel')
    renderSymbolBackButton()
    clearSymbolHighlights()
  }

  function renderSymbolPanel() {
    const { symbol, matches, currentPath } = state.symbolPanel
    if (!symbol) return
    const grouped = new Map()
    for (const m of matches) {
      if (!grouped.has(m.path)) grouped.set(m.path, [])
      grouped.get(m.path).push(m)
    }
    $('[data-symbol-name]').textContent = symbol
    const fileCount = grouped.size
    const total     = matches.length
    $('[data-symbol-meta]').textContent =
      total === 0 ? '' :
      `${total} match${total === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`

    if (total === 0) {
      $('[data-symbol-list]').innerHTML = '<div class="diff-symbol-empty">No occurrences in this diff.</div>'
      return
    }
    const html = []
    for (const [path, fileMatches] of grouped) {
      const isCurrent = path === currentPath
      const lang = languageForPath(path)
      html.push(`<section class="diff-symbol-file${isCurrent ? ' is-current' : ''}">`)
      html.push(`<header class="diff-symbol-file-head">`)
      html.push(`<code class="diff-symbol-file-path" title="${escapeHtml(path)}">${escapeHtml(path)}</code>`)
      html.push(`<span class="diff-symbol-file-count">${fileMatches.length}</span>`)
      if (isCurrent) html.push(`<span class="diff-symbol-current-pill">this file</span>`)
      html.push(`</header>`)
      html.push(`<ul class="diff-symbol-file-list">`)
      for (const m of fileMatches) {
        const marker = m.kind === 'del' ? '−' : m.kind === 'add' ? '+' : ' '
        html.push(`<li class="diff-symbol-match diff-symbol-match-${m.kind}" data-path="${escapeHtml(m.path)}" data-line="${m.line}" data-side="${m.side}" tabindex="0">`)
        html.push(`<span class="diff-symbol-match-line"><span class="diff-symbol-match-mark">${marker}</span>L${m.line}</span>`)
        html.push(`<code class="diff-symbol-match-text">${highlightLine(m.text, lang)}</code>`)
        html.push(`</li>`)
      }
      html.push(`</ul>`)
      html.push(`</section>`)
    }
    $('[data-symbol-list]').innerHTML = html.join('')
  }

  function scrollToMatch(path, line, side) {
    // Push the current anchor so the back button can return here. The
    // anchor is either the dblclick origin (first jump) or the previous
    // jump target (subsequent jumps in the same panel session).
    if (state.symbolPanel.currentAnchor) {
      state.symbolPanel.jumpStack.push(state.symbolPanel.currentAnchor)
      if (state.symbolPanel.jumpStack.length > 100) state.symbolPanel.jumpStack.shift()
    }
    state.symbolPanel.currentAnchor = { path, line, side }
    scrollToDiffCell(path, line, side)
    renderSymbolBackButton()
  }

  function popSymbolJump() {
    const stack = state.symbolPanel.jumpStack
    if (stack.length === 0) return
    const target = stack.pop()
    state.symbolPanel.currentAnchor = target
    scrollToDiffCell(target.path, target.line, target.side)
    renderSymbolBackButton()
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
    if (state.filter?.kind === 'related') {
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

  function renderSymbolBackButton() {
    const btn = $('[data-symbol-back]')
    if (!btn) return
    const n = state.symbolPanel.jumpStack.length
    if (n === 0) {
      btn.hidden = true
      btn.textContent = '↩ back'
    } else {
      btn.hidden = false
      btn.textContent = n === 1 ? '↩ back' : `↩ back (${n})`
    }
  }

  // Highlight every line containing the active symbol. This deliberately
  // marks cells instead of wrapping text nodes inside the diff table; Brave
  // can renderer-crash after repeated text-node mutations followed by a
  // close-panel reflow and normal scrolling on large diffs.
  function applySymbolHighlights() {
    if (!state.symbolPanel.open || !state.symbolPanel.symbol) return
    clearSymbolHighlights()
    const { matches } = state.symbolPanel
    const seen = new Set()
    for (const m of matches) {
      const key = `${m.path}|${m.line}|${m.side}`
      if (seen.has(key)) continue
      seen.add(key)
      const cell = root.querySelector(
        `.diff-text[data-path="${cssEscape(m.path)}"][data-line="${m.line}"][data-side="${m.side}"]`
      )
      if (cell) cell.classList.add('is-symbol-hit')
    }
  }

  function clearSymbolHighlights() {
    root.querySelectorAll('.diff-text.is-symbol-hit').forEach((cell) => cell.classList.remove('is-symbol-hit'))
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
      // Toggle off the current anchor; otherwise switch.
      state.filter = state.filter?.anchor === anchor ? null : { kind: 'related', anchor }
      renderBody()
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
    if (e.target.closest('[data-mark-reviewed]'))      { markCurrentBatchReviewed(); return }
    if (e.target.closest('[data-reset-reviewed]'))     { resetReviewed(); return }

    const head = e.target.closest('[data-toggle-collapse]')
    if (!head) return
    const section = head.closest('.diff-file[data-path]')
    if (!section) return
    const path = section.dataset.path
    if (state.collapsedPaths.has(path)) {
      state.collapsedPaths.delete(path)
      section.classList.remove('is-collapsed')
    } else {
      state.collapsedPaths.add(path)
      section.classList.add('is-collapsed')
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
  function computeVisibleFiles() {
    const all = state.diff?.files || []
    if (!isFullIndex(state.index)) return all
    const priorities = state.diff?.priorities
    const filterAnchor = state.filter?.kind === 'related' ? state.filter.anchor : null
    if (filterAnchor && priorities) {
      const p = priorities[filterAnchor]
      const set = new Set([filterAnchor, ...(p?.incoming || []), ...(p?.outgoing || [])])
      return all.filter((f) => set.has(f.path))
    }
    // Reviewed files are NOT filtered out — they render with `is-reviewed`
    // + `is-collapsed` so only the header shows. User can click to expand.
    return all
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
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed?head_sha=${encodeURIComponent(sha)}`)
      if (isStale()) return
      state.reviewed    = new Set(r?.paths || [])
      state.reviewedSha = sha
      // Auto-fold reviewed files on hydration. The mark-time auto-fold in
      // toggleFileReviewed/markCurrentBatchReviewed only covers fresh marks
      // — without this, files marked in a prior session render expanded
      // until the user manually refolds them. Within a session, manual
      // expand still works (collapsedPaths.delete on click); the next
      // hydration (page reload) re-folds, which matches the spec contract
      // "reviewed = folded unless user expanded it (this session)".
      for (const p of state.reviewed) state.collapsedPaths.add(p)
      renderBody()
    } catch {}
  }

  /**
   * Toggle reviewed state for a single file. Computes the new full set
   * client-side and PUTs with mode='replace' so the server doesn't have
   * to expose a per-path remove endpoint. Auto-folds the file (adds to
   * collapsedPaths) when newly reviewed — matches GitHub's "I'm done
   * with this one, get it out of my way" review pattern.
   */
  async function toggleFileReviewed(path) {
    const sha = state.diff?.sha
    if (!sha || !path) return
    const currently = state.reviewed.has(path)
    const next = new Set(state.reviewed)
    if (currently) next.delete(path); else next.add(path)
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
        method: 'PUT',
        body: JSON.stringify({ head_sha: sha, paths: [...next], mode: 'replace' }),
      })
      state.reviewed    = new Set(r?.paths || [])
      state.reviewedSha = sha
      // Auto-fold on mark; don't auto-unfold on unmark (a reviewed-then-
      // unreviewed file should stay in whatever collapse state the user
      // last chose).
      if (!currently) state.collapsedPaths.add(path)
      renderBody()
      toast(currently ? `Unmarked ${path.split('/').pop()}` : `Marked ${path.split('/').pop()} reviewed`)
    } catch (e) {
      toast('Toggle failed: ' + (e.message || 'unknown'))
    }
  }

  async function markCurrentBatchReviewed() {
    const sha = state.diff?.sha
    if (!sha) return
    const paths = computeVisibleFiles().map((f) => f.path)
    if (!paths.length) return
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
        method: 'PUT',
        body: JSON.stringify({ head_sha: sha, paths }),
      })
      state.reviewed     = new Set(r?.paths || [])
      state.reviewedSha  = sha
      state.filter       = null
      // Auto-fold every file we just marked (matches the per-file toggle).
      // Previously-reviewed files stay in whatever state the user last left.
      for (const p of paths) state.collapsedPaths.add(p)
      renderBody()
      toast(`Marked ${paths.length} file${paths.length === 1 ? '' : 's'} reviewed`)
    } catch (e) {
      toast('Mark reviewed failed: ' + (e.message || 'unknown'))
    }
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

  function renderReviewBanner(visibleCount) {
    if (!isFullIndex(state.index)) return ''
    const filterAnchor = state.filter?.kind === 'related' ? state.filter.anchor : null
    if (filterAnchor) {
      return '<div class="diff-review-banner is-filter">' +
        `<span class="diff-review-label">Filter: related to <code>${escapeHtml(filterAnchor)}</code> · ${visibleCount} file${visibleCount === 1 ? '' : 's'}</span>` +
        '<span class="diff-review-actions">' +
          '<button type="button" data-clear-filter>Show all</button>' +
          '<button type="button" class="primary" data-mark-reviewed>Mark all reviewed</button>' +
        '</span>' +
      '</div>'
    }
    if (state.reviewed.size > 0) {
      const total     = state.diff?.files?.length || 0
      const remaining = Math.max(0, total - state.reviewed.size)
      return '<div class="diff-review-banner is-summary">' +
        `<span class="diff-review-label">${remaining} file${remaining === 1 ? '' : 's'} remaining <span class="diff-review-meta">· ${state.reviewed.size} of ${total} reviewed</span></span>` +
        '<span class="diff-review-actions">' +
          '<button type="button" class="danger" data-reset-reviewed>Reset</button>' +
          '<button type="button" class="primary" data-mark-reviewed>Mark visible reviewed</button>' +
        '</span>' +
      '</div>'
    }
    if ((state.diff?.files?.length || 0) > 0) {
      return '<div class="diff-review-banner is-summary">' +
        '<span class="diff-review-label">Mark files reviewed as you go</span>' +
        '<span class="diff-review-actions">' +
          '<button type="button" class="primary" data-mark-reviewed>Mark visible reviewed</button>' +
        '</span>' +
      '</div>'
    }
    return ''
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
      $('[data-headline]').textContent = baseRef && headRef ? `${headRef} ← ${baseRef}` : 'Full diff'
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
      if (isLocal && untracked.length) {
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
    if (state.collapsedPaths.has(file)) {
      state.collapsedPaths.delete(file)
      const sec = root.querySelector(`.diff-file[data-path="${cssEscape(file)}"]`)
      if (sec) sec.classList.remove('is-collapsed')
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

    const stateClass = thread.state === 'your_turn' ? 'state-your-turn'
                     : thread.state === 'awaiting'  ? 'state-awaiting'
                     : 'state-read'
    const statePill = thread.state === 'your_turn'
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
            <button type="button" class="diff-thread-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" data-thread-id="${escapeHtml(thread.id)}" aria-label="Remove comment" title="Remove comment">×</button>
          </div>
          <div class="diff-thread-body">${inlineCode(c.body)}</div>
        </div>`
      )
      .join('')

    tr.innerHTML =
      '<td colspan="4" class="diff-thread-cell">' +
        `<div class="diff-thread ${stateClass}" data-thread-id="${escapeHtml(thread.id)}">` +
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

  // ------------------------------------------------------------------
  // Diff load with cache
  // ------------------------------------------------------------------
  async function loadDiff({ cacheKey, fetchUrl, errorPrefix }) {
    if (isStale()) return
    const cached = cacheKey ? loadCachedDiff(cacheKey) : null
    if (cached) {
      if (isStale()) return
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
      const diff = await api(fetchUrl)
      if (isStale()) return
      const writeKey = isFullIndex(expectedIndex) && diff?.sha ? `full:${diff.sha}` : cacheKey
      if (state.index !== expectedIndex) {
        if (writeKey) saveCachedDiff(writeKey, diff)
        return
      }
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
