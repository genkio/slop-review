import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, copyToClipboard, toast } from './util.js'
import { openThreadModal, confirmRemoveComment, makeModal } from './modals.js'
import { languageForPath, highlightLine } from './syntax.js'
import { intraLineSegments } from './intra-line-diff.js'
import { ROUTES } from './routes.js'
import { setupOverviewNav } from './overview-nav.js'

// v2: commit-diff files now include `is_unchanged_since_commit`, which
// drives the per-commit reviewed gate. Older cached payloads don't have
// the field and would let a click sneak past the gate, so we burn the
// cache by bumping the prefix.
const DIFF_CACHE_PREFIX = 'slop-review:diff:v2:'

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
    // Mirror data-side/data-line/data-path onto the gutter cells so the
    // line-number click handler (multi-line comment selection gesture)
    // can read them the same way the text-cell hover handler does.
    const lnAttrs = p.left?.oldNo != null
      ? ` data-side="old" data-line="${p.left.oldNo}" data-path="${escapeHtml(path)}"` : ''
    const rnAttrs = p.right?.newNo != null
      ? ` data-side="new" data-line="${p.right.newNo}" data-path="${escapeHtml(path)}"` : ''
    return `<tr class="diff-row" data-pair-kind="${p.kind}">` +
      `<td class="diff-no diff-no-old"${lnAttrs}>${p.left?.oldNo ?? ''}</td>` +
      `<td class="diff-text diff-${lk}" ${lAttrs}><span class="diff-marker">${lMark}</span><span class="diff-line">${p.left ? renderLineCell(p.left, language, 'left') : ''}</span></td>` +
      `<td class="diff-no diff-no-new"${rnAttrs}>${p.right?.newNo ?? ''}</td>` +
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
    // Same mirroring as renderHunkSplit: addressable gutter cells let the
    // selection click handler treat either gutter as the "click target".
    const lnAttrs = r.oldNo != null
      ? ` data-side="old" data-line="${r.oldNo}" data-path="${escapeHtml(path)}"` : ''
    const rnAttrs = r.newNo != null
      ? ` data-side="new" data-line="${r.newNo}" data-path="${escapeHtml(path)}"` : ''
    return `<tr class="diff-row" data-pair-kind="${r.kind}">` +
      `<td class="diff-no diff-no-old"${lnAttrs}>${r.oldNo ?? ''}</td>` +
      `<td class="diff-no diff-no-new"${rnAttrs}>${r.newNo ?? ''}</td>` +
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
  // Per-file reviewed state is expressed visually only — the
  // `.is-reviewed` green wash on `.diff-file-head` (see app.css) is the
  // sole indicator. There's no separate Mark/Unmark button: clicking the
  // header to collapse a file in Full OR commit view also marks it
  // reviewed; the header click to expand also unmarks. In commit view
  // the mark is gated to files whose blob at the commit equals their
  // blob at HEAD (`is_unchanged_since_commit`), so we never persist a
  // mark against content the user wasn't actually looking at. Local
  // view still toggles collapse alone — there's no stable blob to pin a
  // working-tree mark against.

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
      `<button type="button" class="diff-file-toggle" data-toggle-collapse aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${isCollapsed ? 'Expand file' : 'Collapse file'} ${escapeHtml(file.path)}"></button>` +
      `<span class="diff-file-status" data-status="${status}" title="${status}">${statusGlyph}</span>` +
      `<code class="diff-file-path">${pathShown}</code>` +
      `<span class="diff-file-stats"><span class="diff-stat-add">+${file.additions ?? 0}</span> <span class="diff-stat-del">−${file.deletions ?? 0}</span></span>` +
      relChip +
      relateBtn +
    `</header>` +
    `<div class="diff-file-body">${body}</div>` +
  `</section>`
}

// Module-level cleanup: when the user navigates away from the diff page
// (router renders something else into #main), we need to tear down the
// key handlers from the previous diff view. The page host calls
// `disposeDiffView()` on unmount.
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
 * handles its own keyboard nav and URL sync.
 *
 * Returns when the initial load+render completes. The caller doesn't need
 * to await it for navigation; it's awaited mainly so `scrollToAnchor`
 * fires on the freshly-rendered DOM.
 */
export async function renderDiffView({ repo, branch, branchId, branchInfo, commits, initialIndex = 0, hasLocal = false, scrollToAnchor = null, singleFile = null, threadContextId = null, isCurrent = () => true }) {
  if (!isCurrent()) return
  // Tear down any previous diff view's listeners before we re-mount.
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
    // Pending multi-line comment selection. Plain-click on a gutter line
    // number sets { path, side, lineStart: clicked, lineEnd: clicked };
    // a second click on the same (path, side) extends whichever endpoint
    // is closer toward the anchor. Cleared on Esc, on submit/cancel of
    // the editor, and on commit navigation. While non-null, an inline CTA
    // row is spliced beneath the last-selected row and the selected
    // gutter cells are ribbon-marked. The hover-+ button is suppressed
    // until selection clears.
    commentSelection: null,
    // One-shot flag: true on initial mount + on goto(); cleared by renderBody
    // after applying scrollTop=0. Subsequent renders triggered by
    // refreshReviewed / filter-toggle / loadThreads preserve the user's
    // scroll position — no more snap-back fighting maybeScrollToAnchor.
    shouldResetScroll: true,
    // Set true while a thread-jump scroll is converging — the scroll-
    // preservation paths in renderBody/loadThreads bow out for this
    // window so they don't undo the jump.
    jumpInFlight: false,
    // True while the diff body's content-visibility override is applied
    // (every `.diff-file` carrying `is-jumping`). Set when a thread-jump
    // pins layout for the modal session; cleared by `releaseJumpLayout`
    // from the modal's onClose so off-screen sections can re-evict.
    jumpLayoutApplied: false,
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
    // Preserve any query params on the current URL — `?file=…` and
    // `?thread=…` carry state independent of the diff variant, and
    // clobbering them here would break the Jump-to-file modal flow and
    // the auto-reopen-on-?thread path. Only the path portion is
    // controlled by syncUrl.
    const hash = location.hash
    const qIdx = hash.indexOf('?')
    const currentPath = qIdx < 0 ? hash : hash.slice(0, qIdx)
    if (currentPath === next) return
    const query = qIdx < 0 ? '' : hash.slice(qIdx)
    history.replaceState(null, '', next + query)
  }

  let disposeOverviewNav = null
  let disposed = false
  let flashTimer = null
  const isStale = () => disposed || !isCurrent()
  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('keydown', onKey)
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
      // Comment selection clears too — Esc is the universal "back out" key.
      if (state.symbolPanel.activeId) { minimizeActive(); e.preventDefault() }
      else if (state.commentSelection) { clearCommentSelection(); e.preventDefault() }
    }
    else if (e.key === 'Backspace' && state.symbolPanel.activeId) {
      const session = getActiveSession()
      if (session && session.jumpStack.length > 0) {
        popSymbolJump(state.symbolPanel.activeId)
        e.preventDefault()
      }
    }
    // Commit / variant navigation: Shift+arrow only. Plain arrows are
    // reserved for the thread modal's thread-by-thread navigation
    // (see modals.js onArrowNav); a Shift modifier is the explicit
    // signal that the user wants to move *between* diffs rather than
    // between threads.
    else if (e.key === 'ArrowLeft'  && e.shiftKey) { goto(state.index - 1); e.preventDefault() }
    else if (e.key === 'ArrowRight' && e.shiftKey) { goto(state.index + 1); e.preventDefault() }
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
    // While a multi-line selection is in flight, the inline CTA row is the
    // canonical "go" affordance. The floating hover-+ would visually
    // compete and might mislead the user into a single-line comment, so
    // suppress it until selection clears.
    if (state.commentSelection) return
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
  // Multi-line comment selection — click any gutter line number to begin,
  // click another on the same (path, side) to extend. No modifier keys:
  // the gesture itself (gutter click vs hover-+) already distinguishes
  // multi-line from single-line intent, so a shift modifier would be
  // redundant ceremony. The first click anchors; subsequent clicks pull
  // whichever endpoint is closer toward the anchor. To start over with a
  // different line: Esc or Cancel, then click. Switching (path, side)
  // resets the selection automatically.
  // ------------------------------------------------------------------
  $('[data-body]').addEventListener('click', (e) => {
    const gutter = e.target.closest?.('.diff-no[data-line][data-side][data-path]')
    if (!gutter) return
    const path = gutter.dataset.path
    const side = gutter.dataset.side
    const line = Number(gutter.dataset.line)
    if (!path || !side || !Number.isFinite(line) || line < 1) return
    e.preventDefault(); e.stopPropagation()
    const sel = state.commentSelection
    if (sel && sel.path === path && sel.side === side) {
      // Extend the existing selection. Anchor stays where the user first
      // clicked; the new click pulls lineEnd down or lineStart up.
      const anchor = sel.anchor
      state.commentSelection = {
        path,
        side,
        lineStart: Math.min(anchor, line),
        lineEnd: Math.max(anchor, line),
        anchor,
      }
    } else {
      // First click, or switch to a different file/side → fresh selection.
      state.commentSelection = {
        path,
        side,
        lineStart: line,
        lineEnd: line,
        anchor: line,
      }
    }
    // Hover-+ is suppressed while a selection is active so the two
    // affordances don't fight for position next to the same cell.
    hideHoverButtons()
    applyCommentSelection()
  })

  function clearCommentSelection() {
    if (!state.commentSelection) return
    state.commentSelection = null
    applyCommentSelection()
  }

  // Render selection markers + CTA row. Idempotent: removes stale state
  // first, then applies fresh state from state.commentSelection. Called
  // after renderBody (which wipes innerHTML), after each gutter click,
  // and on clear.
  function applyCommentSelection() {
    const body = $('[data-body]')
    if (!body) return
    body.querySelectorAll('.is-comment-selected').forEach((el) => el.classList.remove('is-comment-selected'))
    body.querySelectorAll('.diff-row-comment-cta').forEach((r) => r.remove())
    const sel = state.commentSelection
    if (!sel) return
    // Mark every (path, side) cell whose data-line falls in the range.
    // Both gutter and text cells get the class so the left ribbon paints
    // continuously across the gutter+content seam.
    const cells = body.querySelectorAll(
      `[data-path="${cssEscape(sel.path)}"][data-side="${sel.side}"][data-line]`
    )
    let lastTextRow = null
    let lastLineSeen = -1
    cells.forEach((cell) => {
      const ln = Number(cell.dataset.line)
      if (!Number.isFinite(ln) || ln < sel.lineStart || ln > sel.lineEnd) return
      cell.classList.add('is-comment-selected')
      if (cell.classList.contains('diff-text') && ln >= lastLineSeen) {
        lastLineSeen = ln
        lastTextRow = cell.closest('tr')
      }
    })
    if (!lastTextRow?.parentNode) return
    // Splice the CTA row beneath the last visible row in the range. If
    // some lines in the range aren't rendered (hunk gap), we land on
    // whichever last in-range line IS rendered — matches the
    // "render what we can" anchor-loss semantics elsewhere.
    const cta = document.createElement('tr')
    cta.className = 'diff-row diff-row-comment-cta'
    const rangeLabel = sel.lineStart === sel.lineEnd
      ? `L${sel.lineStart}`
      : `L${sel.lineStart}–${sel.lineEnd}`
    cta.innerHTML =
      '<td colspan="4" class="diff-comment-cta-cell">' +
        '<div class="diff-comment-cta">' +
          `<span class="diff-comment-cta-label">Comment on ${escapeHtml(rangeLabel)} (${escapeHtml(sel.side)})</span>` +
          '<div class="diff-comment-cta-actions">' +
            '<button type="button" data-cta-cancel>Cancel</button>' +
            '<button type="button" class="primary" data-cta-add>Add comment</button>' +
          '</div>' +
        '</div>' +
      '</td>'
    lastTextRow.parentNode.insertBefore(cta, lastTextRow.nextSibling)
    cta.querySelector('[data-cta-cancel]').addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      clearCommentSelection()
    })
    cta.querySelector('[data-cta-add]').addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      openEditorForSelection()
    })
  }

  function openEditorForSelection() {
    const sel = state.commentSelection
    if (!sel) return
    const body = $('[data-body]')
    if (!body) return
    // Find the text cell at lineEnd to anchor the editor row below it
    // (matches single-line behavior). If lineEnd isn't rendered, fall
    // back to the largest in-range line that IS rendered.
    let target = body.querySelector(
      `.diff-text[data-path="${cssEscape(sel.path)}"][data-line="${sel.lineEnd}"][data-side="${sel.side}"]`
    )
    if (!target) {
      const cells = [...body.querySelectorAll(
        `.diff-text[data-path="${cssEscape(sel.path)}"][data-side="${sel.side}"][data-line]`
      )]
      target = cells
        .filter((c) => {
          const ln = Number(c.dataset.line)
          return Number.isFinite(ln) && ln >= sel.lineStart && ln <= sel.lineEnd
        })
        .sort((a, b) => Number(b.dataset.line) - Number(a.dataset.line))[0] || null
    }
    if (!target) { clearCommentSelection(); return }
    openEditorBelow(target, { lineStart: sel.lineStart, lineEnd: sel.lineEnd, side: sel.side, path: sel.path })
  }

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

  function openEditorBelow(cell, range = null) {
    root.querySelectorAll('.diff-row-editor').forEach((r) => r.remove())
    // CTA row is replaced by the editor — the user committed to commenting.
    root.querySelectorAll('.diff-row-comment-cta').forEach((r) => r.remove())

    const row  = cell.closest('tr')
    const path = range?.path ?? (cell.dataset.path || '')
    const side = range?.side ?? (cell.dataset.side || 'new')
    const sha  = cell.dataset.sha  || ''
    // Resolve the line range. For a single-line click (range == null) the
    // anchor cell IS the only line. For range mode we trust the supplied
    // start/end; the cell is just where we anchor the editor DOM-wise.
    const lineStart = range?.lineStart ?? Number(cell.dataset.line || 0)
    const lineEnd   = range?.lineEnd   ?? lineStart
    if (!path || !lineStart) return
    // Snapshot text. Single-line: the cell's own .diff-line textContent.
    // Multi-line: join textContents of all rendered cells in the range on
    // the same (path, side), in line order. Missing lines (hunk gaps) are
    // skipped — better to capture what the user saw than to invent text.
    let anchorText = ''
    if (lineStart === lineEnd) {
      const lineEl = cell.querySelector('.diff-line')
      anchorText = lineEl ? lineEl.textContent.replace(/\s+$/, '') : ''
    } else {
      const cells = [...root.querySelectorAll(
        `.diff-text[data-path="${cssEscape(path)}"][data-side="${side}"][data-line]`
      )]
        .filter((c) => {
          const ln = Number(c.dataset.line)
          return Number.isFinite(ln) && ln >= lineStart && ln <= lineEnd
        })
        .sort((a, b) => Number(a.dataset.line) - Number(b.dataset.line))
      anchorText = cells
        .map((c) => c.querySelector('.diff-line')?.textContent ?? '')
        .join('\n')
        .replace(/\s+$/, '')
    }
    anchorText = anchorText.slice(0, 500)

    const rangeLabel = lineStart === lineEnd
      ? `${path}:${lineStart}`
      : `${path}:${lineStart}–${lineEnd}`
    const placeholder = lineStart === lineEnd
      ? 'Add a comment for this line…'
      : `Add a comment for lines ${lineStart}–${lineEnd}…`

    const editor = document.createElement('tr')
    editor.className = 'diff-row diff-row-editor'
    editor.innerHTML =
      '<td colspan="4" class="diff-editor-cell">' +
        '<div class="diff-editor">' +
          `<div class="diff-editor-anchor">${escapeHtml(rangeLabel)} <span class="diff-editor-side">(${escapeHtml(side)})</span></div>` +
          `<textarea class="diff-editor-input" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea>` +
          '<div class="diff-editor-actions">' +
            '<button type="button" data-cancel>Cancel</button>' +
            '<button type="button" class="primary" data-submit>Add comment</button>' +
          '</div>' +
        '</div>' +
      '</td>'
    row.parentNode.insertBefore(editor, row.nextSibling)
    const ta = editor.querySelector('.diff-editor-input')
    ta.focus()

    const closeAndClear = () => {
      editor.remove()
      // Editor close always clears selection — the next selection should
      // start fresh, not inherit the just-cancelled range.
      clearCommentSelection()
    }
    editor.querySelector('[data-cancel]').addEventListener('click', closeAndClear)
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
            line: lineStart,
            line_end: lineEnd > lineStart ? lineEnd : null,
            side,
            sha,
            body,
            anchor_text: anchorText,
          }),
        })
        // Capture scroll BEFORE the editor row is removed and inline
        // threads are re-rendered. `editor.remove()` shrinks the
        // containing .diff-file by the editor's height, and
        // renderInlineComments wipes-and-re-adds every `.diff-row-thread`
        // across the whole diff. With `overflow-anchor: none` on
        // .diff-body, the browser does NOT compensate for these layout
        // shifts — without preserveScrollTo, the viewport drifts.
        const bodyEl = $('[data-body]')
        const savedScroll = bodyEl?.scrollTop ?? 0
        editor.remove()
        if (res.threads) state.threads = res.threads
        clearCommentSelection()
        renderInlineComments()
        if (bodyEl && savedScroll > 0) preserveScrollTo(bodyEl, savedScroll)
        toast.ok('Comment added')
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
    // data-show-thread sits on both the file:line anchor button AND each
    // comment body — clicking either opens the modal. We bail on active
    // text selection so users can still highlight comment text to copy
    // without the click being interpreted as "open modal."
    const showThread = e.target.closest('[data-show-thread]')
    if (showThread) {
      if (window.getSelection?.()?.toString().trim()) return
      e.preventDefault(); e.stopPropagation()
      openThread(showThread.dataset.showThread)
      return
    }

    // Counts-strip total → open the first thread in visual document order.
    // Resolved at click-time (not render-time) because the inline thread
    // rows aren't in the DOM yet when renderReviewBanner runs — see the
    // comment on `data-show-first-thread` in renderThreadCounts.
    if (e.target.closest('[data-show-first-thread]')) {
      if (window.getSelection?.()?.toString().trim()) return
      e.preventDefault(); e.stopPropagation()
      // `*Inclusive` includes anchor-lost threads (different view, or all
      // threads anchored to a SHA the user isn't currently on) appended
      // after the rendered ones in (file, line) order, so the click still
      // resolves to a real thread id and the modal that opens has a
      // populated `threadOrder` for prev/next + "N of M".
      const firstId = computeThreadOrderInclusive()[0]
      if (firstId) openThread(firstId)
      return
    }

    // Bulk-delete: drop the last reply from every thread with >1 comment.
    // Stays inside the diff page (not modals.js) because the action is
    // host-state-coupled (state.threads, repo.id, loadThreads).
    if (e.target.closest('[data-clear-replies]')) {
      e.preventDefault(); e.stopPropagation()
      confirmBulkDeleteLastReplies()
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
            toast.ok(isLast ? 'Thread removed' : 'Comment removed')
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
      // Same-page back-to-thread: clear the file filter, drop ?file= from
      // the URL, and reopen the thread modal. The modal's syncThreadInUrl
      // will re-add ?thread= on mount, so we don't need to push it here.
      const threadId = backToThread.dataset.threadId || ''
      state.filter = null
      stripFileQuery()
      renderBody()
      if (threadId) openThread(threadId)
      return
    }
    if (e.target.closest('[data-clear-filter]')) {
      state.filter = null
      renderBody()
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
    if (e.target.closest('[data-reset-reviewed]'))     { confirmResetReviewed(); return }

    const head = e.target.closest('[data-toggle-collapse]')
    if (!head) return
    const section = head.closest('.diff-file[data-path]')
    if (!section) return
    const path = section.dataset.path
    const willCollapse = !state.collapsedPaths.has(path)
    // Full AND commit views conflate collapse with mark-reviewed. Local
    // view doesn't — there's no stable blob to pin a working-tree mark
    // against, so its header toggles collapse alone.
    const isFull   = isFullIndex(state.index)
    const isCommit = isCommitIndex(state.index)
    const supportsReviewed = isFull || isCommit
    const willMarkReviewed = willCollapse && supportsReviewed && !state.reviewed.has(path)
    // Mark-reviewed gates. Bail before any DOM/state mutation so the file
    // stays expanded too — the toast is the user's only signal that the
    // gesture refused, and silently collapsing would erase it.
    if (willMarkReviewed) {
      const unresolved = unresolvedThreadCountFor(path)
      if (unresolved > 0) {
        toast(`Resolve ${unresolved} open thread${unresolved === 1 ? '' : 's'} on ${path.split('/').pop()} before marking it reviewed`)
        return
      }
      // Commit-view-only gate: the file must have no later changes. The
      // server reaches the same conclusion on its own (the blob it would
      // store wouldn't match the user's intended review target), but
      // letting the user mark and then silently re-invalidate on next
      // read would be hostile. We block here and toast instead.
      if (isCommit) {
        const file = state.diff?.files?.find((f) => f.path === path)
        if (file && file.is_unchanged_since_commit === false) {
          toast(`${path.split('/').pop()} has later changes — mark it reviewed from its last-touched commit or from the Full diff`)
          return
        }
      }
    }
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
    // Sync collapse → reviewed (not the other way) so the persisted
    // reviewed set follows from the user's last collapse gesture. The
    // reviewed set is global per path, so unmarking from any view
    // (expanding a previously-reviewed file) clears the mark everywhere
    // — symmetric with marking from any view that the gate above allows.
    if (supportsReviewed) {
      const currentlyReviewed = state.reviewed.has(path)
      if (willCollapse !== currentlyReviewed) toggleFileReviewed(path)
    }
  })

  const isFullIndex   = (idx) => idx === state.commits.length
  const isCommitIndex = (idx) => idx >= 0 && idx < state.commits.length
  const isLocalIndex  = (idx) => state.hasLocal && idx === state.commits.length + 1
  const maxIndex      = ()    => state.commits.length + (state.hasLocal ? 1 : 0)

  async function goto(idx) {
    if (idx < 0 || idx > maxIndex()) return
    if (idx === state.index) return
    state.index = idx
    state.diff  = null
    state.shouldResetScroll = true   // navigated to a different diff — start at the top
    state.commentSelection = null    // selection is per-diff; nav clears it
    hideHoverButtons()
    closeSymbolPanel()
    syncUrl()
    await load()
  }

  // ------------------------------------------------------------------
  // Reviewed-batches (Full diff only)
  // ------------------------------------------------------------------
  // Files containing at least one thread, regardless of which view the
  // thread was anchored in. View-agnostic on purpose: a thread left on a
  // per-commit anchor still represents real feedback on the file, so the
  // "with threads" chip count and the threads-filter file set must surface
  // it even when the user is on a different view than where the thread
  // was created. This matches the precedent set by `unresolvedThreadCountFor`
  // (which already scans every view) and by the counts-strip total. The
  // earlier "current-view only" semantic produced a confusing UI where the
  // chip would silently vanish in one view but reappear in another even
  // though the same threads existed.
  function threadFiles() {
    const set = new Set()
    for (const t of state.threads) {
      if (t.file) set.add(t.file)
    }
    return set
  }

  // Count of unresolved threads anchored on `path`. Scans every view —
  // a thread left on a per-commit anchor still represents unaddressed
  // feedback on the file, so the gate for "can this file be marked
  // reviewed?" treats it the same as a Full-view thread. Everything not
  // explicitly `resolved` counts (your_turn / awaiting / read).
  function unresolvedThreadCountFor(path) {
    if (!path) return 0
    let n = 0
    for (const t of state.threads) {
      if (t.file !== path) continue
      if ((t.state || 'awaiting') === 'resolved') continue
      n++
    }
    return n
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
      const set = threadFiles()
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
    // Full + commit views both consult state.reviewed (per-file blob
    // validation lives on the server, so the same set is meaningful in
    // either view). Local view doesn't support reviewed marks — drop the
    // set when we land there so the green wash doesn't leak in.
    const supportsReviewed = isFullIndex(state.index) || isCommitIndex(state.index)
    if (!supportsReviewed) {
      if (state.reviewed.size || state.reviewedSha) {
        state.reviewed    = new Set()
        state.reviewedSha = null
        renderBody()
      }
      return
    }
    // Keyed on branchInfo.head_sha rather than state.diff.sha — the latter
    // is the commit SHA in commit view, which would re-fetch on every
    // commit-nav even though the underlying reviewed set is HEAD-scoped.
    const sha = branchInfo?.head_sha
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
    // Always key off HEAD, never the per-commit diff's sha. In commit view
    // state.diff.sha is the commit's SHA, but the reviewed store is
    // HEAD-scoped — sending the commit SHA as head_sha would corrupt the
    // stored metadata and cause subsequent reads to thrash the in-memory
    // cache key (state.reviewedSha === sha mismatches on every nav).
    const sha = branchInfo?.head_sha
    if (!sha || !path) return
    const currently = state.reviewed.has(path)
    const becomingReviewed = !currently
    const next = new Set(state.reviewed)
    if (currently) next.delete(path); else next.add(path)

    // Optimistic state + DOM mutation. Collapse is the caller's
    // responsibility — this function only owns the persisted reviewed
    // state and the `.is-reviewed` green wash on the header. The header
    // click handler that drives this also flips `.is-collapsed`, so by
    // the time the PUT lands the two states already match.
    state.reviewed    = next
    state.reviewedSha = sha
    applyReviewedToggleDom(path, becomingReviewed)

    try {
      await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
        method: 'PUT',
        body: JSON.stringify({ head_sha: sha, paths: [...next], mode: 'replace' }),
      })
    } catch (e) {
      // Roll back the reviewed state. We deliberately don't touch
      // .is-collapsed here — the user's collapse gesture stands on its
      // own. The next interaction will resync if the mismatch matters.
      const rollback = new Set(state.reviewed)
      if (becomingReviewed) rollback.delete(path); else rollback.add(path)
      state.reviewed = rollback
      applyReviewedToggleDom(path, !becomingReviewed)
      toast('Reviewed toggle failed: ' + (e.message || 'unknown'))
    }
  }

  /**
   * Targeted DOM mutation for one file's reviewed/unreviewed transition.
   * Just flips `.is-reviewed` on the section (drives the green-wash
   * header tint) and refreshes the review banner so the "N of T
   * remaining" summary stays in sync. Collapse class is owned by the
   * header click handler — not touched here.
   */
  function applyReviewedToggleDom(path, becomingReviewed) {
    const section = root.querySelector(`.diff-file[data-path="${cssEscape(path)}"]`)
    if (!section) return
    section.classList.toggle('is-reviewed', becomingReviewed)
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

  // Confirmation-gated wrapper around `resetReviewed`. The scope is
  // view-sensitive: in Full view the × clears every reviewed mark on the
  // branch, but in a per-commit view it should only clear marks for files
  // visible in THIS commit — anything else would make the confirmation
  // contradict the "N of T files remaining" promise next to it. Mirrors
  // the `confirmBulkDeleteLastReplies` modal shape below.
  function confirmResetReviewed() {
    const isFull   = isFullIndex(state.index)
    const isCommit = isCommitIndex(state.index)
    let targetPaths
    if (isFull) {
      targetPaths = new Set(state.reviewed)
    } else if (isCommit) {
      targetPaths = new Set(
        (state.diff?.files || [])
          .map((f) => f.path)
          .filter((p) => state.reviewed.has(p))
      )
    } else {
      return
    }
    const count = targetPaths.size
    if (!count) return
    const scope = isFull ? 'across the branch' : 'in this commit'
    const heading = isFull ? 'Clear all reviewed marks?' : 'Clear reviewed marks in this commit?'
    const detail = `Clears the reviewed mark on ${count} file${count === 1 ? '' : 's'} ${scope}. You'll need to re-mark them.`
    const backdrop = makeModal(`
      <h2>${escapeHtml(heading)}</h2>
      <p class="modal-text">${escapeHtml(detail)}</p>
      <div class="modal-actions is-reversed">
        <button class="danger" data-confirm>Clear marks</button>
        <button data-close>Cancel</button>
      </div>`)
    const confirmBtn = backdrop.querySelector('[data-confirm]')
    const cancelBtn = backdrop.querySelector('[data-close]')
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true
      cancelBtn.disabled = true
      confirmBtn.textContent = 'Clearing…'
      try { await resetReviewed({ paths: targetPaths }) } finally { backdrop.remove() }
    }
  }

  /**
   * Clear the reviewed marks named in `paths` (or all marks when omitted).
   * Routes through DELETE when the remaining set would be empty — the
   * branch sidecar is unlinked cleanly — and through PUT mode=replace
   * otherwise, so a commit-view reset peels off exactly the visible
   * subset and leaves marks on files outside this commit untouched.
   */
  async function resetReviewed({ paths } = {}) {
    const sha = branchInfo?.head_sha
    if (!sha) return
    const removeSet = paths || new Set(state.reviewed)
    const next = new Set([...state.reviewed].filter((p) => !removeSet.has(p)))
    try {
      if (next.size === 0) {
        await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, { method: 'DELETE' })
      } else {
        await api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
          method: 'PUT',
          body: JSON.stringify({ head_sha: sha, paths: [...next], mode: 'replace' }),
        })
      }
      state.reviewed    = next
      state.reviewedSha = sha
      renderBody()
      toast.ok('Reviewed marks cleared')
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
    const threadCount = threadFiles().size
    const hasFiles    = totalFiles > 0
    const hasFilter   = !!filterKind
    if (!hasFiles && !hasFilter) return ''

    // Thread counts strip — only when the current branch has at least one
    // thread. Relocated from the (now-removed) threads page; rendered as
    // a row inside the same banner so the counts read as "controls scoped
    // to this diff" rather than as a separate header chrome strip.
    const countsStrip = renderThreadCounts()

    // View-toggle markup — always rendered, anchors the left side. The
    // active class is baked at render time; clicks trigger renderBody()
    // which regenerates the banner with the new active state.
    const viewToggle =
      '<div class="diff-view-toggle" role="tablist" aria-label="Diff view mode">' +
        `<button type="button" data-view="split"  class="${state.mode === 'split'  ? 'active' : ''}" role="tab" aria-selected="${state.mode === 'split'}">Split</button>` +
        `<button type="button" data-view="inline" class="${state.mode === 'inline' ? 'active' : ''}" role="tab" aria-selected="${state.mode === 'inline'}">Inline</button>` +
      '</div>'

    // Each filter / resting branch produces { variant, rightHtml }. The
    // outer wrap (below) composes the counts strip + controls row in a
    // single banner element so layout is consistent across branches.
    let variant = 'is-summary'
    let rightHtml = ''

    if (filterKind === 'file') {
      // Thread-context single-file view. "← Back to thread" clears the
      // filter and reopens the modal same-page (see [data-back-to-thread]
      // handler). No "Viewing: <path>" label — the file path is already
      // displayed in big mono at the top of the file section right below.
      // If the URL didn't carry a thread id, fall back to plain "Show all".
      const threadId = state.filter.threadId || ''
      const action = threadId
        ? `<button type="button" class="diff-filter-clear" data-back-to-thread data-thread-id="${escapeHtml(threadId)}">← Back to thread</button>`
        : '<button type="button" class="diff-filter-close" data-clear-filter aria-label="Show all" title="Show all">×</button>'
      variant = 'is-filter is-filter-file'
      rightHtml = `<div class="diff-review-right">${action}</div>`
    } else if (filterKind === 'threads') {
      variant = 'is-filter is-filter-threads'
      rightHtml = '<div class="diff-review-right">' +
        `<span class="diff-review-label"><span class="diff-filter-dot"></span>filtered ${visibleCount} file${visibleCount === 1 ? '' : 's'} with threads</span>` +
        '<button type="button" class="diff-filter-close" data-clear-filter aria-label="Show all" title="Show all">×</button>' +
        '</div>'
    } else if (filterKind === 'related' && isFull) {
      const filterAnchor = state.filter.anchor
      variant = 'is-filter'
      rightHtml = '<div class="diff-review-right">' +
        `<span class="diff-review-label">Filter: related to <code>${escapeHtml(filterAnchor)}</code> · ${visibleCount} file${visibleCount === 1 ? '' : 's'}</span>` +
        '<button type="button" class="diff-filter-close" data-clear-filter aria-label="Show all" title="Show all">×</button>' +
        '</div>'
    } else {
      // Resting state — right side hosts (in order) reviewed summary +
      // Reset action when any files in this view are marked, then the
      // threads-filter chip when threads exist. Order is "info first,
      // action last" so the right side reads left-to-right as a sentence.
      // Counts are scoped to files in THIS view, not the global reviewed
      // set: in Full view that's equivalent (every reviewed file is in
      // scope), but in commit view it's what the user means by "X of T
      // remaining" — anything else would compare the commit's file count
      // against marks made elsewhere on the branch and read as gibberish.
      const isCommit = isCommitIndex(state.index)
      const supportsReviewed = isFull || isCommit
      const reviewedInView = supportsReviewed
        ? (state.diff?.files || []).filter((f) => state.reviewed.has(f.path)).length
        : 0
      const hasReviewed = reviewedInView > 0
      const rightParts  = []
      if (hasReviewed) {
        const remaining = Math.max(0, totalFiles - reviewedInView)
        // The × is view-sensitive: in Full view it clears every mark on
        // the branch; in a per-commit view it only clears the marks
        // visible right here. Tooltip + aria-label tell the truth either
        // way so the gesture isn't a surprise.
        const resetAria  = isFull ? 'Clear all reviewed marks' : 'Clear reviewed marks in this commit'
        const resetTitle = isFull
          ? 'Clear all reviewed marks across the branch'
          : `Clear ${reviewedInView} reviewed mark${reviewedInView === 1 ? '' : 's'} in this commit`
        // Group the summary text with its × so the pair reads as one unit
        // — the wrapper's tight gap pulls the affordance up against the
        // count it acts on, while the outer .diff-review-right gap keeps
        // the threads-filter chip a normal step away.
        rightParts.push(
          '<span class="diff-review-summary-group">' +
            `<span class="diff-review-summary">${remaining} of ${totalFiles} files remaining</span>` +
            `<button type="button" class="diff-review-reset" data-reset-reviewed aria-label="${escapeHtml(resetAria)}" title="${escapeHtml(resetTitle)}">×</button>` +
          '</span>'
        )
      }
      if (threadCount > 0) {
        rightParts.push(
          `<button type="button" class="diff-filter-chip" data-thread-filter title="Show only files with comment threads (${threadCount} file${threadCount === 1 ? '' : 's'})">` +
            '<span class="diff-filter-chip-dot" aria-hidden="true"></span>' +
            `<span class="diff-filter-chip-text">filter ${threadCount} file${threadCount === 1 ? '' : 's'} with threads</span>` +
          '</button>'
        )
      }
      rightHtml = rightParts.length
        ? `<div class="diff-review-right">${rightParts.join('<span class="diff-review-sep" aria-hidden="true">·</span>')}</div>`
        : ''
    }

    const controlsRow = '<div class="diff-review-controls">' + viewToggle + rightHtml + '</div>'
    return `<div class="diff-review-banner ${variant}">${countsStrip}${controlsRow}</div>`
  }

  /**
   * Counts strip rendered as the top row of the diff control banner when
   * the current branch has at least one thread. Three pills:
   *   - reviewer: total comments authored by the local human reviewer
   *     (server stamps these with `user: 'reviewer'`; see
   *     server/routes/threads.js DEVELOPER_USER)
   *   - reviewee: total comments authored by anyone else (LLM agent
   *     replies, etc. — anything that isn't the 'reviewer' marker)
   *   - resolved: count of threads whose state is 'resolved'
   * No more your_turn / awaiting / read pills — the reviewer/reviewee
   * split is a more direct answer to "who's said what so far?" than the
   * state machine ever was, and the underlying `t.state` field still
   * drives the inline thread row's left ribbon (see makeThreadDisplayRow).
   */
  function renderThreadCounts() {
    const threads = state.threads || []
    if (!threads.length) return ''
    let reviewerMsgs = 0
    let revieweeMsgs = 0
    let resolvedCount = 0
    for (const t of threads) {
      if ((t.state || 'awaiting') === 'resolved') resolvedCount++
      for (const c of (t.comments || [])) {
        if (c.user === 'reviewer') reviewerMsgs++
        else revieweeMsgs++
      }
    }
    // The total link opens the first thread in visual order. Resolution is
    // deferred to click-time via the `data-show-first-thread` sentinel
    // (resolved by the delegated click handler below): at render-time the
    // inline thread rows don't exist yet (renderInlineComments runs after
    // renderBody), so `computeThreadOrder()` can't be called here. The
    // server returns threads in readdir order (alphabetical hex), which is
    // *not* visual order — baking `threads[0].id` in would land the user
    // on a random thread. Resolving lazily uses the DOM walk that already
    // drives the modal's prev/next nav, guaranteeing the click matches the
    // topmost rendered thread row.
    const totalLabel = `open 1 out of ${threads.length} thread${threads.length === 1 ? '' : 's'}`
    const total = `<button type="button" class="diff-review-counts-total" data-show-first-thread title="Open the first thread">${totalLabel}</button>`
    // The × inside the reviewee-replies pill triggers a bulk delete of the
    // *last reply* of every thread that has more than one comment. Only
    // shown when there are replies to delete — otherwise an empty
    // affordance is just confusing.
    const repliesClearBtn = revieweeMsgs > 0
      ? '<button type="button" class="state-pill-x" data-clear-replies aria-label="Delete the last reply from every thread" title="Delete the last reply from every thread">×</button>'
      : ''
    return '<div class="diff-review-counts">' +
      `<span class="state-pill is-count">${reviewerMsgs} reviewer comment${reviewerMsgs === 1 ? '' : 's'}</span>` +
      `<span class="state-pill is-count">${revieweeMsgs} reviewee repl${revieweeMsgs === 1 ? 'y' : 'ies'}${repliesClearBtn}</span>` +
      `<span class="state-pill state-resolved">✓ ${resolvedCount} resolved</span>` +
      total +
      '</div>'
  }

  /**
   * Bulk-delete the latest reply from every thread that has more than one
   * comment. Threads with a single comment (the initial reviewer message
   * with no follow-up) are left untouched. Drops one comment per thread —
   * never deletes a whole thread, since by definition the targets all have
   * at least 2 comments remaining after the delete.
   *
   * Each DELETE is issued in parallel via Promise.allSettled — thread
   * files are independent on disk (separate JSON files per thread), so
   * there's no cross-thread contention to serialise around. `allSettled`
   * (not `all`) keeps a single network or file-system hiccup from aborting
   * the rest of the batch; partial-success reporting via toast tells the
   * user exactly what happened.
   */
  function confirmBulkDeleteLastReplies() {
    const targets = []
    for (const t of state.threads) {
      const comments = t.comments || []
      if (comments.length <= 1) continue
      targets.push({ tid: t.id, cid: comments[comments.length - 1].id })
    }
    if (!targets.length) {
      toast.ok('No replies to delete')
      return
    }
    const count = targets.length
    const detail = `Removes the most recent reply from ${count} thread${count === 1 ? '' : 's'}. Threads with no replies are unaffected. This can't be undone.`
    const backdrop = makeModal(`
      <h2>Delete ${count} last repl${count === 1 ? 'y' : 'ies'}?</h2>
      <p class="modal-text">${escapeHtml(detail)}</p>
      <div class="modal-actions is-reversed">
        <button class="danger" data-confirm>Delete</button>
        <button data-close>Cancel</button>
      </div>`)
    const confirmBtn = backdrop.querySelector('[data-confirm]')
    const cancelBtn = backdrop.querySelector('[data-close]')
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true
      cancelBtn.disabled = true
      confirmBtn.textContent = 'Deleting…'
      const results = await Promise.allSettled(targets.map(({ tid, cid }) =>
        api(`/api/repos/${encodeURIComponent(repo.id)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}`, { method: 'DELETE' })
      ))
      const failed = results.filter((r) => r.status === 'rejected').length
      const succeeded = results.length - failed
      backdrop.remove()
      await loadThreads()
      if (failed === 0) {
        toast.ok(`Deleted ${succeeded} repl${succeeded === 1 ? 'y' : 'ies'}`)
      } else if (succeeded === 0) {
        toast('All deletes failed')
      } else {
        toast(`Deleted ${succeeded}, ${failed} failed`)
      }
    }
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
        isFilterAnchor: filterAnchor === f.path,
        priorityEntry: priorities?.[f.path] || null,
        relationship,
        anchorPath: filterAnchor,
      })
    }).join('')
    // Preserve scroll across `innerHTML` swaps. `overflow-anchor: none`
    // (see .diff-body) means the browser won't compensate when content
    // is replaced — and renderBody is called for every filter toggle,
    // every split↔inline switch, and every loadThreads refresh
    // (modal open stamps last_read_at, comment add/edit/delete, resolve
    // toggle). Without this, those triggers would scroll the diff page
    // to a random position.
    //
    // The deferred-restore part matters: directly after innerHTML, the
    // body's scrollHeight transiently drops (collapse/expand of file
    // sections happens in subsequent ticks via reviewed-state hydration
    // and other async fixups), so a sync `scrollTop = prev` gets clamped
    // to whatever maxScroll currently is. preserveScrollTo schedules a
    // ResizeObserver that retries the assignment as the content grows
    // back, then disconnects once the target fits. The initial-mount
    // path (state.shouldResetScroll) still wins so the first render
    // lands at the top of the file as intended.
    const prevScroll = body.scrollTop
    body.innerHTML = banners + filesHtml
    // Re-apply the content-visibility override to all freshly-rendered
    // .diff-file sections if a thread-jump is holding the modal session
    // open. Without this, a renderBody triggered mid-session (loadThreads,
    // filter toggle, etc.) would let off-screen files revert to
    // placeholder heights and the target cell would drift out of viewport
    // center.
    if (state.jumpLayoutApplied) {
      body.querySelectorAll('.diff-file').forEach((s) => s.classList.add('is-jumping'))
    }
    if (state.shouldResetScroll) {
      body.scrollTop = 0
      state.shouldResetScroll = false
    } else if (prevScroll > 0 && !state.jumpInFlight) {
      // Suppress scroll preservation while a thread-jump is converging —
      // the convergence loop is the source of truth for scrollTop during
      // that window. Without this guard, preserveScrollTo wins the race
      // and parks the diff at the pre-jump position.
      preserveScrollTo(body, prevScroll)
    }
    renderInlineComments()
    maybeScrollToAnchor()
    applySymbolHighlights()
    // innerHTML wipe cleared any stale selection ribbons + CTA row;
    // re-apply from state.commentSelection. No-op when null.
    applyCommentSelection()
  }

  function preserveScrollTo(el, target) {
    const maxNow = el.scrollHeight - el.clientHeight
    if (maxNow >= target) {
      el.scrollTop = target
      return
    }
    // Content height isn't sufficient yet — wait for it to grow.
    // Multiple ticks because layout passes settle over a few frames.
    el.scrollTop = maxNow
    const ro = new ResizeObserver(() => {
      const max = el.scrollHeight - el.clientHeight
      if (max >= target) {
        el.scrollTop = target
        ro.disconnect()
      }
    })
    ro.observe(el)
    setTimeout(() => ro.disconnect(), 2000)
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
      if (!cell) {
        toast(`${file.split('/').pop()}:${line} not in this diff (anchor lost)`)
        return
      }
      // `content-visibility: auto` on `.diff-file` means off-screen file
      // sections render as 800px placeholders (the `contain-intrinsic-size`
      // hint). A single `scrollIntoView` computes a target against those
      // placeholders; as the scroll progresses and intermediate sections
      // come into view, they stamp their real heights and the cell jumps
      // somewhere else. Re-converge: scroll, measure, scroll again, until
      // the cell sits near viewport center (or the layout stabilizes).
      // Bounded to 6 iterations so a pathological case can't spin.
      convergeScrollToCenter(cell)
      flashCell(cell)
    })
    scrollToAnchor = null
  }

  /**
   * Drive `scrollTop` on the diff body until the cell's vertical position
   * settles near viewport center. Uses an rAF-driven re-aim loop because
   * `content-visibility: auto` on each `.diff-file` lets off-screen
   * sections render as 800 px placeholders; as the user scrolls, those
   * sections come into the rendering window and stamp their real heights,
   * which shifts every cell below them. A one-shot `scrollIntoView` (or
   * a synchronous loop) sees only the layout *at scroll-time*; the cell
   * jumps to the wrong absolute position once heights settle a few
   * frames later. Re-aiming each frame until the target stops moving
   * makes the scroll converge on the final (real-height) layout.
   * Bounded to 500 ms so a noisy content tree can't spin forever.
   */
  function convergeScrollToCenter(cell) {
    // Tell the scroll-preservation paths in `renderBody` and `loadThreads`
    // to stand down for the convergence window — those paths exist to keep
    // the user's scroll position stable across re-renders, but during an
    // intentional jump they fight the scroll (the modal's POST /read kicks
    // off loadThreads which captures scrollTop and tries to restore it).
    state.jumpInFlight = true
    // Defeat `content-visibility: auto` on every `.diff-file` for the
    // duration of the modal session — removed in `releaseJumpLayout`
    // when the user closes the modal. Without this, sections that were
    // 800 px placeholders during the scroll target computation re-stamp
    // their real heights as they enter the rendering window, which shifts
    // the target cell out of the viewport center. Keeping the override
    // applied for the whole modal session means the layout is stable
    // while the user navigates threads.
    const sections = root.querySelectorAll('.diff-file')
    sections.forEach((s) => s.classList.add('is-jumping'))
    state.jumpLayoutApplied = true
    // Force a synchronous reflow so the new heights stamp before
    // scrollIntoView measures.
    void cell.offsetHeight
    cell.scrollIntoView({ behavior: 'auto', block: 'center' })
    // Re-aim across a few frames to absorb any residual layout settle.
    // After ~250 ms we drop jumpInFlight (preserveScrollTo can resume),
    // but `is-jumping` stays on the sections so layout doesn't shift
    // under the user as they step through threads.
    const body = $('[data-body]')
    if (!body) { state.jumpInFlight = false; return }
    const aim = () => {
      const cellRect = cell.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const target   = body.scrollTop + (cellRect.top - bodyRect.top) - (body.clientHeight - cellRect.height) / 2
      const maxTop   = Math.max(0, body.scrollHeight - body.clientHeight)
      body.scrollTop = Math.max(0, Math.min(target, maxTop))
    }
    const startedAt = performance.now()
    const tick = () => {
      if (isStale()) { state.jumpInFlight = false; return }
      aim()
      if (performance.now() - startedAt > 250) { state.jumpInFlight = false; return }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /**
   * Released by the thread-modal's onClose so off-screen `.diff-file`
   * sections can re-evict to placeholders once the user is done browsing.
   */
  function releaseJumpLayout() {
    if (!state.jumpLayoutApplied) return
    state.jumpLayoutApplied = false
    root.querySelectorAll('.diff-file.is-jumping').forEach((s) => s.classList.remove('is-jumping'))
  }

  function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1') }

  // ------------------------------------------------------------------
  // Inline thread display
  // ------------------------------------------------------------------
  function renderInlineComments() {
    const body = $('[data-body]')
    if (!body) return
    body.querySelectorAll('.diff-row-thread').forEach((r) => r.remove())
    // Clear stale multi-line range ribbons before re-applying.
    body.querySelectorAll('.has-thread-range').forEach((el) => el.classList.remove('has-thread-range'))

    if (!state.threads.length) return
    const view = viewForCurrentIndex()
    // Gutter cells now carry the same (path, side, line) attrs as text
    // cells (for the multi-line selection gesture), so widen the query
    // to both — `has-thread-range` should paint across gutter+text.
    const cells = [...body.querySelectorAll('[data-side][data-line][data-path]')]

    for (const t of state.threads) {
      // View-cross-render rules:
      //   - Full / Local (aggregate views): render any thread whose anchor
      //     cell exists in the current DOM, including ones created against
      //     a per-commit view. Discoverability over strict isolation — the
      //     counts-strip total and the "with threads" chip already promise
      //     a global tally, so the inline rendering needs to match.
      //     Caveat: a commit-view thread's `line` is in that commit's
      //     line-number frame. If a later commit edited the same file,
      //     line N at branch tip may be a different statement than line N
      //     at the commit. The inline row still appears, just possibly
      //     next to drifted content. The comment body carries the author's
      //     intent regardless, so this is acceptable noise.
      //   - Commit view: stay strict — same `view` AND same SHA. Showing
      //     commit-A threads on commit-B lines would point comments at
      //     code from a different history entirely (not just frame drift),
      //     which is the fully misleading case.
      if (view === 'commit') {
        if ((t.view || 'full') !== 'commit') continue
        const c = state.commits[state.index]
        if (t.sha !== c?.sha) continue
      }
      const file = t.file
      const lineStart = Number(t.line)
      const lineEnd = Number.isFinite(Number(t.line_end)) && t.line_end ? Number(t.line_end) : lineStart
      const side = t.side ?? 'new'
      if (!Number.isFinite(lineStart)) continue
      // Collect every rendered cell (gutter or text) on (file, side) whose
      // data-line falls in the thread's range. For single-line threads
      // this collapses to one text cell — the existing splice-below path.
      let anchorTextCell = null
      let anchorLine = -1
      for (const c of cells) {
        if (c.dataset.path !== file || c.dataset.side !== side) continue
        const ln = Number(c.dataset.line)
        if (!Number.isFinite(ln) || ln < lineStart || ln > lineEnd) continue
        if (lineEnd > lineStart) c.classList.add('has-thread-range')
        if (c.classList.contains('diff-text') && ln >= anchorLine) {
          anchorLine = ln
          anchorTextCell = c
        }
      }
      if (!anchorTextCell) continue
      const row = anchorTextCell.closest('tr')
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
    // 4 px accent ribbon + accent wash so the focus thread is unambiguous
    // when several threads sit in the same file.
    const jumpedFrom = state.filter?.kind === 'file' && state.filter.threadId === thread.id
      ? ' is-jumped-from'
      : ''

    // No header row inside the inline thread display — the file:line is
    // already obvious from the diff row right above, the view (full/commit/
    // local) is implicit in the active diff variant, and the state cue lives
    // on the `.diff-thread`'s coloured left ribbon plus the counts strip in
    // the banner. Clicks on any comment body still open the modal via
    // `data-show-thread` on `.diff-thread-body`.

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
          <div class="diff-thread-body" data-body data-show-thread="${escapeHtml(thread.id)}" role="button">${inlineCode(c.body)}</div>
        </div>`
      )
      .join('')

    tr.innerHTML =
      '<td colspan="4" class="diff-thread-cell">' +
        `<div class="diff-thread ${stateClass}${jumpedFrom}" data-thread-id="${escapeHtml(thread.id)}">` +
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
  // and update `state.threads` locally — see the body update at the end of
  // the Save handler.
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
        // updated body. No re-fetch — the in-memory state IS the truth
        // until the next loadThreads (modal close, comment add/delete, etc.).
        if (comment) comment.body = res?.comment?.body ?? text
        toast.ok('Comment updated')
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
      const supportsReviewed = isFullIndex(state.index) || isCommitIndex(state.index)
      if (supportsReviewed && branchInfo?.head_sha) await applyReviewedState(branchInfo.head_sha)
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
      // Kick off the reviewed fetch in parallel with the diff fetch.
      // Keyed off branchInfo.head_sha — stable across commit nav within
      // one branch state, so a single fetch covers Full + every commit
      // view, and state.reviewedSha === sha short-circuits subsequent
      // nav with no network call.
      const supportsReviewed = isFullIndex(expectedIndex) || isCommitIndex(expectedIndex)
      const reviewedKey = supportsReviewed ? branchInfo?.head_sha : null
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
  // Thread modal — opens with prev/next nav across every thread on the
  // branch (rendered ones in visual order, anchor-lost ones appended by
  // file:line), jump-to-file (single-file filter), and auto-scroll-on-
  // navigate. Anchor-lost targets just toast "anchor lost" instead of
  // scrolling; the modal still shows their comments.
  // ------------------------------------------------------------------

  /**
   * Order threads for the modal's prev/next nav by walking inline thread
   * rows in document order. This guarantees the modal walk matches the
   * visual top-to-bottom order in the diff body — including priority-
   * based file ordering (the reference-graph sort `compareForReview`
   * applies), intra-file line ordering, and any active filter. Threads
   * whose anchor isn't rendered (anchor_lost, view mismatch, filtered
   * out) are correctly excluded because they have no `.diff-row-thread`.
   */
  function computeThreadOrder() {
    const body = $('[data-body]')
    if (!body) return []
    return [...body.querySelectorAll('.diff-row-thread[data-thread-id]')]
      .map((el) => el.dataset.threadId)
      .filter(Boolean)
  }

  /**
   * Like `computeThreadOrder` but also includes threads whose anchor isn't
   * in the current DOM (different view, anchored on a SHA the user isn't
   * currently looking at). Rendered ones keep their visual document order
   * up front; the rest get appended sorted by (file, line) so the user can
   * still step through every thread from the modal — exactly what the
   * counts-strip "N total" promises. Without the appended tail, prev/next
   * and the "N of M" position label would silently disappear whenever the
   * total was opened against an anchor-lost thread (or in the all-orphan
   * case my recent fallback fix introduced).
   */
  function computeThreadOrderInclusive() {
    const rendered = computeThreadOrder()
    const seen = new Set(rendered)
    const orphans = state.threads
      .filter((t) => t.id && !seen.has(t.id))
      .sort((a, b) => {
        const fa = a.file || ''
        const fb = b.file || ''
        if (fa !== fb) return fa.localeCompare(fb)
        return (Number(a.line) || 0) - (Number(b.line) || 0)
      })
      .map((t) => t.id)
    return [...rendered, ...orphans]
  }

  /**
   * Aim the diff at a thread's anchor cell. Reuses the existing one-shot
   * `scrollToAnchor` + `maybeScrollToAnchor` machinery so reviewed-file
   * uncollapse, defer-a-frame layout, scroll-to-center, and flash-cell
   * all behave identically to the jump-from-URL path.
   */
  function jumpToThreadAnchor(t) {
    if (!t?.file || !Number.isFinite(Number(t.line))) return
    scrollToAnchor = { file: t.file, line: Number(t.line), side: t.side || 'new' }
    // Set the flag *synchronously* — the rAF inside maybeScrollToAnchor +
    // convergeScrollToCenter would otherwise leave a ~16 ms window where
    // POST /read can resolve, fire onChanged, and trigger loadThreads →
    // renderBody → preserveScrollTo before jumpInFlight blocks them.
    state.jumpInFlight = true
    maybeScrollToAnchor()
  }

  /**
   * Open the thread modal with prev/next nav wired. Centralised because
   * multiple call sites (inline thread click, ?thread= auto-reopen on
   * mount, "← Back to thread" clear-filter path) need identical opts.
   */
  function openThread(tid) {
    if (!tid) return
    openThreadModal(tid, {
      repoId: repo.id,
      getThread: (id) => state.threads.find((t) => t.id === id),
      // Inclusive order: rendered threads in visual order, then anchor-lost
      // threads sorted by (file, line). Lets the modal's prev/next and the
      // "N of M" position label stay populated even when the user opened
      // the modal against a thread whose anchor isn't in the current view.
      // For anchor-lost targets `jumpToThreadAnchor` will surface its own
      // "anchor lost" toast (see maybeScrollToAnchor) instead of scrolling
      // — acceptable: the user can still read the comments in the modal.
      threadOrder: computeThreadOrderInclusive(),
      // Cross-file prev/next: when the target thread sits in a file the
      // current single-file filter excludes, clear the filter so the
      // anchor becomes visible. Then jump to the new anchor.
      onNavigate: (newId) => {
        const t = state.threads.find((x) => x.id === newId)
        if (!t) return
        if (state.filter?.kind === 'file' && state.filter.path !== t.file) {
          state.filter = null
          stripFileQuery()
          renderBody()
        }
        jumpToThreadAnchor(t)
      },
      onClose: () => { stripThreadQuery(); releaseJumpLayout() },
      onChanged: () => { loadThreads() },
      // /read is a soft mutation — only the single thread's state-pill
      // changes. We bypass loadThreads (which would renderBody and risk
      // drifting the diff-body scroll position) and instead just adopt
      // the server's freshly-stamped thread snapshot in memory. The
      // visible state pill in the inline thread row is repainted by
      // renderInlineComments, which removes-and-re-adds .diff-row-thread
      // rows without touching body.innerHTML — no preserveScrollTo
      // dance needed, scroll stays put. The counts-strip pills (which
      // live in the sticky banner) lag by one user action; that's the
      // explicit trade and the user opted into it.
      onRead: (res) => {
        if (res?.threads) {
          state.threads = res.threads
          renderInlineComments()
        }
      },
    })
  }

  // Drop `?thread=…` from the current hash without creating a new history
  // entry. Used when the user closes the modal so a refresh doesn't pop
  // it back open. Skipped when `?file=…` is also present — that pair
  // marks the single-file filter view, and the threadId is load-bearing
  // for the "← Back to thread" affordance there. The user clearing the
  // filter via "Show all" drops the whole query separately.
  function stripThreadQuery() {
    const hash = location.hash
    const qIdx = hash.indexOf('?')
    if (qIdx < 0) return
    const queryPart = hash.slice(qIdx + 1)
    const parts = queryPart.split('&').filter(Boolean)
    if (parts.some((p) => p.startsWith('file='))) return
    const pathPart = hash.slice(0, qIdx)
    const kept = parts.filter((p) => !p.startsWith('thread=')).join('&')
    const next = kept ? `${pathPart}?${kept}` : pathPart
    if (next === hash) return
    history.replaceState(null, '', next)
  }

  // Drop `?file=…` from the current hash. Used by the "← Back to thread"
  // path which clears the single-file filter same-page.
  function stripFileQuery() {
    const hash = location.hash
    const qIdx = hash.indexOf('?')
    if (qIdx < 0) return
    const pathPart  = hash.slice(0, qIdx)
    const queryPart = hash.slice(qIdx + 1)
    const kept = queryPart.split('&').filter((p) => p && !p.startsWith('file=')).join('&')
    const next = kept ? `${pathPart}?${kept}` : pathPart
    if (next === hash) return
    history.replaceState(null, '', next)
  }

  // ------------------------------------------------------------------
  // Threads: initial fetch and post-mutation refresh
  // ------------------------------------------------------------------
  async function loadThreads() {
    if (isStale()) return
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/threads`)
      if (isStale()) return
      state.threads = r?.threads || []
      // Capture scroll BEFORE any DOM mutation. renderInlineComments
      // briefly removes-then-re-adds inline thread rows, and renderBody
      // below replaces body.innerHTML wholesale — both can clamp scrollTop
      // due to `overflow-anchor: none` on .diff-body. Without this save,
      // every refresh (modal open stamping last_read_at, comment add/edit/
      // delete, resolve toggle, modal prev/next) would yank the diff
      // view's scroll position to a different spot.
      const bodyEl = $('[data-body]')
      const savedScroll = bodyEl?.scrollTop ?? 0
      renderInlineComments()
      // Banner hosts the threads-filter chip + counts strip — re-render so
      // newly-arrived threads reveal them without a manual reload.
      // Skipped while a jump is converging — renderBody wipes body.innerHTML
      // which would detach the cell reference the jump loop is holding and
      // strip the `is-jumping` classes that defeat content-visibility for
      // the duration of the scroll. Inline thread rows still get refreshed
      // via renderInlineComments above.
      if (!state.jumpInFlight) renderBody()
      else                     refreshReviewBanner()
      // Belt-and-suspenders restore: renderBody's preservation already
      // handles the innerHTML swap inside that call (deferred via
      // ResizeObserver while the content settles), but if anything outside
      // renderBody has shifted scroll between our entry capture and now,
      // re-apply the saved value through the same deferred-restore helper.
      // Suppressed while a thread-jump is converging — the convergence
      // loop owns scrollTop during that window (see convergeScrollToCenter).
      if (bodyEl && savedScroll > 0 && bodyEl.scrollTop !== savedScroll && !state.jumpInFlight) {
        preserveScrollTo(bodyEl, savedScroll)
      }
    } catch {}
  }

  await loadThreads()
  if (isStale()) return

  // Auto-scroll to the jumped-from thread's anchor on Jump-to-file. The
  // URL's `?thread=` was already plumbed into state.filter.threadId at
  // mount (see renderDiffView's `filter:` initializer); pair it with the
  // freshly-loaded thread record to derive `{file, line, side}` and let
  // the existing one-shot `scrollToAnchor` machinery do the rest — it
  // auto-uncollapses reviewed files, defers a frame for layout, scrolls
  // to center, flashes the cell, and toasts gracefully if the anchor
  // line is missing from the current diff (e.g. anchor lost after a
  // rebase). If the thread record is missing (deleted between page
  // loads), we silently no-op.
  if (!scrollToAnchor && state.filter?.kind === 'file' && state.filter.threadId) {
    const t = state.threads.find((x) => x.id === state.filter.threadId)
    if (t?.file && t?.line) {
      scrollToAnchor = { file: t.file, line: t.line, side: t.side || 'new' }
    }
  }

  // ?thread=<id> with no ?file= → bare modal-reopen on the diff page,
  // e.g. a refresh while the modal was open. Two things need to happen:
  // (1) the diff scrolls to the thread's anchor so the user lands at the
  // referenced row (consumes scrollToAnchor inside the first renderBody
  // via maybeScrollToAnchor); (2) the modal opens AFTER load() finishes
  // so computeThreadOrder can walk the freshly-rendered .diff-row-thread
  // elements and supply a populated threadOrder — without the deferral,
  // the modal closure captured an empty array and the prev/next nav
  // never appeared.
  let pendingThreadOpen = null
  if (state.filter?.kind !== 'file' && threadContextId) {
    const t = state.threads.find((x) => x.id === threadContextId)
    if (t) {
      pendingThreadOpen = threadContextId
      if (!scrollToAnchor && t.file && t.line) {
        scrollToAnchor = { file: t.file, line: t.line, side: t.side || 'new' }
      }
    } else {
      stripThreadQuery()
    }
  }

  await load()

  if (pendingThreadOpen && !isStale()) {
    openThread(pendingThreadOpen)
  }
}
