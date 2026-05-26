import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, copyToClipboard, toast, buildForgeDeepLink } from './util.js'
import { openThreadModal, confirmRemoveComment, makeModal, openHeadPreviewModal } from './modals.js'
import { languageForPath, highlightLine } from './syntax.js'
import { intraLineSegments } from './intra-line-diff.js'
import { ROUTES } from './routes.js'
import { setupOverviewNav } from './overview-nav.js'
import { store } from './store.js'

// v2: commit-diff files now include `is_unchanged_since_commit`, which
// drives the per-commit reviewed gate. Older cached payloads don't have
// the field and would let a click sneak past the gate, so we burn the
// cache by bumping the prefix.
const DIFF_CACHE_PREFIX = 'slop-review:diff:v2:'

// Whether to skip rendering the line-number gutter cells. Inline diffs
// without gutters render as a single text column — iOS Safari's
// table-layout: fixed doesn't reliably zero col widths, so we skip the
// gutter cells in HTML rather than fight engine quirks via CSS.
//
// Driven by a module-level flag that renderDiffView keeps in sync with
// state.showLineNumbers at the start of each render. Default reflects the
// mobile breakpoint (mobile = hide, desktop = show) but the user's saved
// preference (localStorage 'slop-review:line-numbers') wins on hydration.
let _hideGutter = window.matchMedia('(max-width: 768px)').matches
function isMobileDiffView() {
  return _hideGutter
}

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

function hunkHeaderRow(hunk, ctx = {}) {
  const meta = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  const hdr  = hunk.header ? ' ' + escapeHtml(hunk.header) : ''
  // Expand-up button: hidden when the hunk starts at file line 1, OR the
  // previous hunk's tail butts directly against this hunk's head. Either
  // way the gap above is empty — the button would be a no-op. Carries
  // everything the click handler needs so the handler stays stateless:
  // path / ref / mode for the fetch + render, target/floor lines for the
  // range math, old-vs-new offset so context rows know their old line.
  let expandBtn = ''
  if (ctx.gapAbove && ctx.newRef && ctx.path) {
    const target = hunk.newStart - 1
    const floor  = ctx.floorLine
    const offset = hunk.oldStart - hunk.newStart
    expandBtn =
      `<button type="button" class="diff-expand-btn" data-expand-direction="up"` +
      ` data-path="${escapeHtml(ctx.path)}" data-ref="${escapeHtml(ctx.newRef)}"` +
      ` data-target-line="${target}" data-floor-line="${floor}"` +
      ` data-old-new-offset="${offset}" data-mode="${ctx.mode}"` +
      ` data-sha="${escapeHtml(ctx.sha || '')}" data-lang="${escapeHtml(ctx.language || '')}"` +
      ` title="Expand ${ctx.chunkSize} lines up" aria-label="Expand context up">▲</button>`
  } else {
    expandBtn = `<span class="diff-expand-btn-slot" aria-hidden="true"></span>`
  }
  const cspan = isMobileDiffView() ? '' : ' colspan="4"'
  return `<tr class="diff-row diff-row-hunk"><td${cspan} class="diff-hunk-head">` +
    expandBtn +
    `<span class="diff-hunk-meta">${meta}</span>${hdr}` +
  `</td></tr>`
}

// Footer row after the last hunk — single full-width button to expand
// context downward into the un-rendered tail of the file. Total-lines is
// unknown until the first fetch resolves; the click handler stamps it
// onto the button so subsequent clicks know when to stop.
function expandDownRow(lastHunk, ctx) {
  if (!lastHunk || !ctx.newRef || !ctx.path) return ''
  const anchor = lastHunk.newStart + lastHunk.newLines
  const offset = (lastHunk.oldStart + lastHunk.oldLines) - anchor
  const cspan = isMobileDiffView() ? '' : ' colspan="4"'
  return `<tr class="diff-row diff-row-expand-down">` +
    `<td${cspan}>` +
      `<button type="button" class="diff-expand-btn is-full" data-expand-direction="down"` +
      ` data-path="${escapeHtml(ctx.path)}" data-ref="${escapeHtml(ctx.newRef)}"` +
      ` data-anchor-line="${anchor}" data-total-lines=""` +
      ` data-old-new-offset="${offset}" data-mode="${ctx.mode}"` +
      ` data-sha="${escapeHtml(ctx.sha || '')}" data-lang="${escapeHtml(ctx.language || '')}"` +
      ` title="Expand ${ctx.chunkSize} lines down" aria-label="Expand context down">▼</button>` +
    `</td>` +
  `</tr>`
}

function renderHunkSplit(hunk, path, sha, language, expandCtx = null) {
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
  return hunkHeaderRow(hunk, expandCtx || {}) + body
}

function renderHunkInline(hunk, path, sha, language, expandCtx = null) {
  // Mobile collapses inline mode to a single text column (no gutter cells,
  // no colspan tricks) because iOS Safari doesn't reliably honor col
  // width: 0 + table-layout: fixed for zeroing the gutter — the gutter
  // cells claim layout space and push the code into the right half.
  // Rendering a single-cell row sidesteps the engine quirk entirely.
  const mobile = isMobileDiffView()
  const body = hunk.rows.map((r) => {
    const marker = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
    const side   = r.kind === 'del' ? 'old' : 'new'
    const lineNo = r.kind === 'del' ? (r.oldNo ?? '') : (r.newNo ?? '')
    const lineSide = r.kind === 'del' ? 'left' : 'right'
    if (mobile) {
      return `<tr class="diff-row" data-pair-kind="${r.kind}">` +
        `<td class="diff-text diff-${r.kind}" data-side="${side}" data-line="${lineNo}" data-path="${escapeHtml(path)}" data-sha="${sha}"><span class="diff-marker">${marker}</span><span class="diff-line">${renderLineCell(r, language, lineSide)}</span></td>` +
        `</tr>`
    }
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
  return hunkHeaderRow(hunk, expandCtx || {}) + body
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

// How many lines a single expand-button click pulls in. Matches GitHub's
// default behavior (their button is "expand 20 lines"); a multi-step
// approach (clicking again to expand more) is preferred over a dropdown
// because it keeps the diff body free of menus.
const EXPAND_CHUNK_SIZE = 20

function renderFileSection(file, mode, sha, opts = {}) {
  const {
    isReviewed          = false,
    isCollapsed         = false,
    showRelateBtn       = false,
    isFilterAnchor      = false,
    priorityEntry       = null,
    relationship        = null,
    anchorPath          = null,
    threadCount         = 0,
    openThreadCount     = 0,
    // Ref to fetch unchanged context lines from when the user clicks an
    // expand button. Full/Commit pass the new-side sha; Local passes the
    // sentinel 'WORKTREE'. Renamed/binary/deleted files don't get expand
    // buttons — they have no current new-side file to read from.
    newRef              = null,
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
  // Hiding the gutter forces inline rendering — renderHunkSplit always
  // emits 4 cells per row (no-gutter branch doesn't exist there), and a
  // split layout without line-number cells would leave the two text cols
  // floating with no visual anchor. Drops to inline whenever the user (or
  // the mobile default) has the gutter off.
  const effectiveMode = isMobileDiffView() ? 'inline'
    : (mode === 'split' && isSingleSide) ? 'inline'
    : mode

  let body
  if (file.is_binary) {
    body = '<div class="diff-empty">Binary file — diff not shown.</div>'
  } else if (!file.patch) {
    body = '<div class="diff-empty">No content change shown (rename or oversized diff).</div>'
  } else {
    const hunks = parsePatch(file.patch)
    const renderHunk = effectiveMode === 'split' ? renderHunkSplit : renderHunkInline
    const language = languageForPath(file.path)
    const colgroup = isMobileDiffView()
      ? '<colgroup><col class="diff-col-text"></colgroup>'
      : effectiveMode === 'split'
        ? '<colgroup><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-no"><col class="diff-col-text"></colgroup>'
        : '<colgroup><col class="diff-col-no"><col class="diff-col-no"><col class="diff-col-text"><col class="diff-col-text"></colgroup>'
    // Per-hunk expand context. Floor = first line of the gap above this
    // hunk = previous hunk's tail + 1 (or 1 for the first hunk). Pure
    // adds (deleted files) and binaries don't expose buttons — the file-
    // level status check above sets newRef to null in those cases.
    const expandable = !!newRef && status !== 'removed'
    const hunkHtml = hunks.map((h, i) => {
      let expandCtx = null
      if (expandable) {
        const prev = i > 0 ? hunks[i - 1] : null
        const floorLine = prev ? prev.newStart + prev.newLines : 1
        const gapAbove  = h.newStart > floorLine
        expandCtx = {
          gapAbove, floorLine,
          path: file.path, newRef, sha, mode: effectiveMode,
          language, chunkSize: EXPAND_CHUNK_SIZE,
        }
      }
      return renderHunk(h, file.path, sha, language, expandCtx)
    }).join('')
    const lastHunk = hunks[hunks.length - 1]
    const downRow = expandable && lastHunk
      ? expandDownRow(lastHunk, { path: file.path, newRef, sha, mode: effectiveMode, language, chunkSize: EXPAND_CHUNK_SIZE })
      : ''
    body = `<table class="diff-table diff-${effectiveMode}">${colgroup}<tbody>${hunkHtml}${downRow}</tbody></table>`
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

  // Mirror of the mark-reviewed toast at the gate site: when a commit-view
  // file has later changes, surface that *ambiently* under the head so the
  // user sees the limitation before they try the gesture. Strict `=== false`
  // because Full/Local diffs leave the flag undefined — only commit-diff
  // payloads populate it (see `server/git.js` `getCommitDiff`).
  const laterChangesWarn = file.is_unchanged_since_commit === false
    ? `<div class="diff-file-warn" role="note">This file has later changes — mark it reviewed from its last-touched commit or from the Full diff.</div>`
    : ''

  return `<section class="${sectionClass}" data-path="${escapeHtml(file.path)}" data-status="${status}">` +
    `<header class="diff-file-head" data-toggle-collapse>` +
      `<button type="button" class="diff-file-toggle" data-toggle-collapse aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${isCollapsed ? 'Expand file' : 'Collapse file'} ${escapeHtml(file.path)}"></button>` +
      `<span class="diff-file-status" data-status="${status}" title="${status}">${statusGlyph}</span>` +
      `<code class="diff-file-path">${pathShown}</code>` +
      // Thread count chip: surfaces "this file has discussions" even when
      // the file is collapsed (reviewed). Single muted number so the eye
      // doesn't compete with the +N −M stats next to it; the tooltip
      // breaks out open vs resolved if the user wants the detail.
      (threadCount > 0
        ? `<span class="diff-file-threads" title="${threadCount} thread${threadCount === 1 ? '' : 's'}${openThreadCount > 0 ? ` (${openThreadCount} open)` : ''}">${threadCount}</span>`
        : '') +
      `<span class="diff-file-stats"><span class="diff-stat-add">+${file.additions ?? 0}</span> <span class="diff-stat-del">−${file.deletions ?? 0}</span></span>` +
      relChip +
      relateBtn +
    `</header>` +
    laterChangesWarn +
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
  // Wrap default. Desktop is unconditionally on: the wrap toggle is hidden
  // on desktop (see .diff-wrap-toggle hide rule in app.css), so any stored
  // `false` from a past mobile session would otherwise leave a desktop user
  // permanently no-wrap with no UI to escape. Mobile honors the saved
  // preference so users who explicitly chose no-wrap on a phone keep it.
  let initialWrap = true
  if (isMobile) {
    try {
      const saved = localStorage.getItem('slop-review:wrap')
      if (saved === 'true')  initialWrap = true
      else if (saved === 'false') initialWrap = false
    } catch {}
  }
  // Same pattern for line-number visibility. Default hidden on mobile so
  // the narrow viewport hands all its horizontal space to code; default
  // shown on desktop where the gutter is useful for orientation. Whatever
  // the user explicitly chose persists.
  let initialShowLineNumbers = !isMobile
  try {
    const saved = localStorage.getItem('slop-review:line-numbers')
    if (saved === 'true')  initialShowLineNumbers = true
    else if (saved === 'false') initialShowLineNumbers = false
  } catch {}
  // Mirror the resolved preference into the module flag so the first
  // renderBody picks up the correct gutter mode without waiting for
  // applyLineNumbers() (which only runs after the diff loads).
  _hideGutter = !initialShowLineNumbers
  const state = {
    index:    Math.max(0, Math.min(initialIndex, maxIdx)),
    commits,
    repo,
    branch,
    branchId,
    branchInfo,
    hasLocal,
    mode:     isMobile ? 'inline' : 'split',
    lineWrap: initialWrap,
    showLineNumbers: initialShowLineNumbers,
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
    // Host / PR metadata for the "GitHub" deep-link button in the comment
    // CTA. Fetched once per renderDiffView mount (see below). Null until
    // the fetch lands — the CTA renderer reads state.prInfo at click-time
    // and simply hides the button when fields are missing, so the slow-
    // first-load case degrades gracefully without a loading spinner.
    prInfo: null,
  }

  // Fire-and-forget PR/host lookup. The server caches per (repo, branch),
  // so this is a fast subsequent call; first call shells out to `gh` and
  // can take a few hundred ms. We don't await — the diff renders without
  // it, and by the time the user has clicked a gutter to start a comment
  // selection (several seconds of reading minimum), the fetch has landed.
  // Failure (no `gh`, no PR, unsupported host) leaves prInfo null forever,
  // which is exactly the right signal for "hide the button".
  api(`/api/repos/${encodeURIComponent(repo.id)}/pr-info`)
    .then((info) => {
      if (!isCurrent()) return
      state.prInfo = info
      // Forge bindings (`o`/`O`) become available the moment prInfo
      // resolves. Refresh the hint so the bar advertises them without
      // waiting for the next cursor move.
      renderKeymapHint()
    })
    .catch(() => {})

  /**
   * Patch one field of this repo's UI-state bucket. Keeps the in-memory
   * store snapshot in lockstep with the persisted state.json so a future
   * renderDiffView re-mount (hashchange to a different diff variant)
   * picks up the live value without re-fetching /api/state. The PATCH
   * is fire-and-forget; failure leaves the prior value on disk and the
   * in-memory store still reflects the user's latest intent. Null
   * values delete the field on the server side (see endpoint docs).
   * Generic on purpose — future UI prefs (view mode default, filter
   * stickiness, etc.) ride this same setter with a different `key`.
   */
  const patchRepoUiState = (patch) => {
    if (store.state) {
      store.state.config = store.state.config || {}
      store.state.config.repo_ui_state = store.state.config.repo_ui_state || {}
      const bucket = store.state.config.repo_ui_state[repo.id] || {}
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete bucket[k]
        else bucket[k] = v
      }
      store.state.config.repo_ui_state[repo.id] = bucket
    }
    api(`/api/repos/${encodeURIComponent(repo.id)}/ui-state`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  /**
   * Storage key for the resume cursor of the *currently displayed* view.
   * Shape: `thread_cursor:<branchId>:<viewTag>` where viewTag is `full`,
   * `local`, or `commit:<sha>`.
   *
   * Why per-view (not per-branch): each view has its own thread walk
   * (see threadsInCurrentView / computeThreadOrderInCurrentView). A
   * cursor stamped while walking Full's 12 threads is meaningless when
   * the user later sits on commit-A's 3 threads — the thread id might
   * not even be in that view's order. Per-view keys keep each walk's
   * resume point isolated, matching the way the counts strip and modal
   * navigation are scoped.
   *
   * Why server-side persistence (not localStorage): slop-review picks a
   * free port each launch, and localStorage is origin-scoped — a new
   * port = empty namespace, which defeats the "resume across restarts"
   * intent. State lives in `~/.config/slop-review/state.json` via
   * router.js → /api/state.
   *
   * sanitizeBranchId emits only [A-Za-z0-9_-] and commit shas are hex,
   * so `:` is a safe separator (no collision with characters that can
   * appear in branchId or sha). Threads on disk are already branch-
   * isolated under `<repo>/.reviews/<branch_id>/`, so the UI cursor
   * matches that scoping at the outer layer and refines per view inside.
   */
  const currentCursorKey = () => {
    let viewTag
    if (isLocalIndex(state.index))     viewTag = 'local'
    else if (isFullIndex(state.index)) viewTag = 'full'
    else                               viewTag = `commit:${state.commits[state.index].sha}`
    return `thread_cursor:${branchId}:${viewTag}`
  }

  /**
   * Computed read — no in-memory mirror. Each call resolves the cursor
   * against the live store snapshot for whatever view the user is on
   * right now, so a view switch (commit ↔ Full ↔ Local) automatically
   * surfaces that view's cursor without any re-seed step. Returns null
   * when the bucket is empty or the snapshot hasn't loaded yet — read
   * sites already treat null as "no resume, walk from first".
   */
  const getResumeCursor = () =>
    store.state?.config?.repo_ui_state?.[repo.id]?.[currentCursorKey()] || null

  /**
   * Single write site for the resume cursor. Routes through the generic
   * UI-state PATCH so adding more bookmarks later (e.g., default view
   * mode, filter prefs) doesn't require new plumbing — just call
   * patchRepoUiState({ new_key: value }). The key is per-view (see
   * currentCursorKey), so writes from Full and commit-A never overwrite
   * each other. Also refreshes the review banner in place so the counts-
   * strip total label ("open N out of M threads") tracks the cursor —
   * the user sees where they'll land before they click. refreshReviewBanner
   * is a banner-only DOM swap, so this runs cheap even on every prev/next
   * nav click.
   */
  const setResumeCursor = (tid) => {
    patchRepoUiState({ [currentCursorKey()]: tid || null })
    refreshReviewBanner()
  }

  const main = document.getElementById('main')
  // Keep the breadcrumb / shared header; main is the page surface.
  const root = document.createElement('div')
  root.className = 'diff-page'
  root.innerHTML = `
    <header class="diff-head">
      <div class="diff-head-left">
        <div class="diff-nav">
          <button type="button" class="diff-nav-btn" data-first aria-label="First commit" title="Jump to first commit">«</button>
          <button type="button" class="diff-nav-btn" data-prev aria-label="Previous">‹</button>
          <span class="diff-position" data-position></span>
          <button type="button" class="diff-nav-btn" data-next aria-label="Next">›</button>
          <button type="button" class="diff-nav-btn" data-last aria-label="Full diff" title="Jump to full diff">»</button>
        </div>
        <div class="diff-meta-block">
          <div class="diff-meta-line">
            <code class="diff-sha" data-sha title="Click to copy diff"></code>
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
        <label class="diff-wrap-toggle" title="Toggle line wrap (long lines fold vs. scroll horizontally)">
          <input type="checkbox" data-wrap-toggle>
          <span>Wrap</span>
        </label>
        <label class="diff-wrap-toggle" title="Toggle line numbers (gutter column shown vs. hidden)">
          <input type="checkbox" data-linenums-toggle>
          <span>Line #</span>
        </label>
        <span data-overview-nav class="overview-nav-slot"></span>
      </div>
    </header>
    <div class="diff-body" data-body>
      <div class="diff-loading">Loading diff…</div>
    </div>
    <aside class="diff-symbol-panel" data-symbol-panel hidden></aside>
    <footer class="diff-keymap-hint" data-keymap-hint hidden></footer>
    <style data-symbol-style></style>`
  main.replaceChildren(root)

  const $  = (sel) => root.querySelector(sel)

  // ------------------------------------------------------------------
  // Line-wrap toggle — CSS-driven (`.diff-page.no-wrap`), state lives on
  // state.lineWrap, persisted under localStorage key 'slop-review:wrap'.
  // ------------------------------------------------------------------
  // Sync DOM to current state.lineWrap: toggles the .no-wrap class that
  // unwraps long code lines, and mirrors state into the checkbox's
  // `checked` property so the visible control matches.
  function applyLineWrap() {
    root.classList.toggle('no-wrap', !state.lineWrap)
    const input = root.querySelector('[data-wrap-toggle]')
    if (input) input.checked = state.lineWrap
  }
  applyLineWrap()
  // `change` (not `click`) is the right event for a checkbox — the browser
  // has already flipped `checked` by the time it fires, so we read it
  // directly rather than negating state.lineWrap and risking drift if a
  // click-without-change ever sneaks through (e.g. label-tap that's
  // preventDefault'd elsewhere).
  root.querySelector('[data-wrap-toggle]')?.addEventListener('change', (e) => {
    state.lineWrap = e.target.checked
    try { localStorage.setItem('slop-review:wrap', String(state.lineWrap)) } catch {}
    applyLineWrap()
  })

  // ------------------------------------------------------------------
  // Line-numbers toggle — structurally different from wrap: changes the
  // table shape (1-col vs 4-col), so requires a full renderBody() to take
  // effect. Module-level `_hideGutter` is the truth for render functions;
  // we mirror state.showLineNumbers into it before each render.
  // ------------------------------------------------------------------
  function applyLineNumbers() {
    _hideGutter = !state.showLineNumbers
    const input = root.querySelector('[data-linenums-toggle]')
    if (input) input.checked = state.showLineNumbers
  }
  applyLineNumbers()
  root.querySelector('[data-linenums-toggle]')?.addEventListener('change', (e) => {
    state.showLineNumbers = e.target.checked
    try { localStorage.setItem('slop-review:line-numbers', String(state.showLineNumbers)) } catch {}
    applyLineNumbers()
    // renderBody() rebuilds the table with the new colgroup + row shape.
    // Existing CTA / editor / thread rows would have a stale colspan after
    // the swap, but renderBody wipes them anyway as part of the rerender.
    renderBody()
  })

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
  // Stable tag identifying the *kind* of view (independent of URL shape).
  // Persisted as `last_view:<branchId>` so a cold relaunch can resume here
  // instead of falling back to the first-commit smart default. The page-
  // level resolver validates `commit:<sha>` against the live commit list,
  // so a force-push that removed the sha self-heals to the smart default.
  function viewTagForIndex(idx) {
    if (state.hasLocal && idx === state.commits.length + 1) return 'local'
    if (idx === state.commits.length) return 'full'
    const c = state.commits[idx]
    return c?.sha ? `commit:${c.sha}` : 'full'
  }
  function syncUrl() {
    const next = urlForIndex(state.index)
    // Persist the current view *before* the early-return below — the
    // initial mount calls syncUrl when the URL already matches (so `next
    // === currentPath`), and that first call is the one that re-stamps
    // the saved view after a cold launch. Without this ordering, the
    // saved view would only refresh on actual variant changes.
    patchRepoUiState({ [`last_view:${branchId}`]: viewTagForIndex(state.index) })
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
    teardownAutoReviewObserver()
  }
  activeDispose = dispose

  // Vim-style cursor: a single `tr.diff-row` is "focused" via .is-cursor.
  // We deliberately don't persist the cursor across re-renders — renderBody
  // wipes the DOM and the user re-anchors with a fresh j/k. (Persisting
  // through reflows would mean keying on path+line+side, which adds state
  // for a feature whose primary use is local, in-place navigation.)
  function getNavigableRows () {
    const body = $('[data-body]')
    if (!body) return []
    return Array.from(body.querySelectorAll(
      '.diff-file:not(.is-collapsed) tr.diff-row:not(.diff-row-thread):not(.diff-row-editor):not(.diff-row-comment-cta)'
    ))
  }
  // Dynamic which-key-style hint bar. Hidden until the first vim action;
  // once revealed, its contents re-compute from current state on every
  // render so the visible bindings always match what the user can actually
  // press right now. Callers fire `renderKeymapHint()` after any state
  // change that could shift the active context (cursor move, comment
  // selection start/clear). `revealKeymapHint()` is the one-way switch
  // that flips the bar from `hidden` to live; subsequent renders are
  // no-ops while still hidden, so we don't pay for DOM work pre-reveal.
  // ⌘ on macOS, Ctrl elsewhere — matches what `e.metaKey || e.ctrlKey`
  // accepts at the binding site, so the hint never lies about which
  // modifier the user should reach for.
  const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '')
  const SUBMIT_MOD = IS_MAC ? '⌘' : 'Ctrl'

  function getKeymapItems () {
    // Confirmation modal (e.g. Delete thread) — highest priority because
    // it sits on top of everything else and steals user attention. The
    // predicate matches ANY backdrop with a `[data-confirm]` button, so
    // future destructive dialogs (clear reviewed marks, etc.) pick this
    // hint up automatically.
    if (document.querySelector('.modal-backdrop [data-confirm]')) {
      return [
        { keys: ['↵'],   label: 'confirm' },
        { keys: ['Esc'], label: 'cancel' },
      ]
    }
    // Editor open — cursor nav is suppressed by the input-field guard
    // while typing, so only submit/cancel are actionable from inside the
    // textarea. Editor presence is the DOM-truth signal; checked BEFORE
    // the comment-selection branch because the selection is still set
    // while the editor is open (it clears on close).
    if ($('[data-body] .diff-row-editor')) {
      return [
        { keys: [SUBMIT_MOD, '↵'], label: 'submit' },
        { keys: ['Esc'],           label: 'cancel' },
      ]
    }
    if (state.commentSelection) {
      // Visual-line mode (entered via V, or via mouse gutter click). `c`
      // and Enter both commit — surface `c` because it's the vim-canonical
      // verb. Enter stays wired but un-advertised: showing both would
      // crowd the bar without teaching anything new (Enter is universally
      // intuitive). y/o stay live too but advertised at top-level only.
      return [
        { keys: ['c'],     label: 'add comment' },
        { keys: ['Esc'],   label: 'cancel' },
        { keys: ['j','k'], label: 'extend ↕' },
      ]
    }
    // `copy` is the default (new side, or whatever side exists on a
    // single-sided row). `Y copy old` and `O open GitHub (old)` are
    // surfaced only when the cursor row actually has an old side —
    // newly-created files, pure-add rows, and inline-view add rows have
    // no old side, so advertising those keys would be misleading.
    // Old-side variants (C, V, Y, O) are intentionally absent from the
    // hint bar — they take too much horizontal space relative to how
    // often they're used. The bindings themselves stay live (the onKey
    // handler reads e.key directly), they're just unadvertised — same
    // pattern as J/K's 5-line jump.
    const items = [
      { keys: ['j','k'], label: 'move' },
      { keys: ['c'],     label: 'comment' },
      { keys: ['v'],     label: 'multi-line' },
      { keys: ['y'],     label: 'copy' },
    ]
    // `r` toggles the cursor row's file between reviewed and unreviewed.
    // Local view has no stable blob to pin the mark against (see the
    // click handler at diff.js:1922), so the binding — and its hint —
    // are scoped to Full and Commit views. Always shown in those views
    // (no cursor-presence gate) because the action is file-level, not
    // line-level; pressing `r` with no cursor is a documented no-op.
    if (isFullIndex(state.index) || isCommitIndex(state.index)) {
      items.push({ keys: ['r'], label: 'toggle reviewed' })
    }
    // Forge bindings — only surface when `state.prInfo` has resolved a
    // host we can build URLs for. Same gate as the CTA forge button
    // (diff.js:1001) so the two hint surfaces agree on "forge available
    // right now?" — when prInfo is null, neither shows it. Old-side `O`
    // is live but un-hinted (see comment above the items array).
    const prInfo = state.prInfo
    if (prInfo?.host === 'github' && prInfo?.pr_url) {
      items.push({ keys: ['o'], label: 'open GitHub' })
    }
    // n — jump to next thread in view. Surfaced only when at least one
    // thread is currently rendered (view filter + non-collapsed file).
    // Capital `N` (prev thread) is live but unadvertised — same pattern
    // as J/K's 5-line jump and C/V/Y/O's old-side variants — to keep the
    // bar uncluttered. Reads the DOM (not state.threads) so the count
    // honors per-file collapse and the current view filter for free.
    const body = $('[data-body]')
    if (body?.querySelector('.diff-file:not(.is-collapsed) tr.diff-row-thread')) {
      items.push({ keys: ['n'], label: 'next thread' })
    }
    // Cursor-dependent: only surface `d` when there's actually a thread
    // to delete on the current line, so the hint bar never advertises a
    // no-op. revealKeymapHint() runs after every j/k, so this stays
    // accurate as the cursor moves through the diff.
    if (cursorThreadId()) items.push({ keys: ['d'], label: 'delete thread' })
    // `p` peek-HEAD shares the same cursor-dependent treatment: surfaced
    // only when the cursor row has a new-side line on a file with later
    // changes (in commit view). The triple gate matches the `p` key
    // handler exactly via rowHeadPreviewTarget, so the bar never lies.
    const cursor = $('[data-body] tr.diff-row.is-cursor')
    if (cursor && rowHeadPreviewTarget(cursor)) items.push({ keys: ['p'], label: 'peek HEAD' })
    // e — surface only when the cursor has a reachable target (▲ above
    // its hunk, or ▼ when in the last hunk). Single key, single hint;
    // the smart-fallback inside findExpandTarget keeps the user from
    // needing a second binding.
    if (findExpandTarget()) items.push({ keys: ['e'], label: 'expand' })
    return items
  }
  function renderKeymapHint () {
    const hint = $('[data-keymap-hint]')
    if (!hint || hint.hidden) return
    hint.innerHTML = getKeymapItems().map(({ keys, label }) =>
      `<span class="diff-keymap-item">${keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}<span class="diff-keymap-label">${escapeHtml(label)}</span></span>`
    ).join('')
  }
  function revealKeymapHint () {
    const hint = $('[data-keymap-hint]')
    if (!hint) return
    hint.hidden = false
    renderKeymapHint()
  }
  // Delete the whole thread (all comments + file). Confirmation modal is
  // mandatory because the operation is irreversible. Reuses the same
  // post-delete refresh sequence as the modal-driven delete flow:
  // `state.threads` swap, inline rerender, banner refresh, hint refresh.
  function confirmAndDeleteThread (tid) {
    const t = state.threads.find((x) => x.id === tid)
    const count = t?.comments?.length || 1
    const detail = count === 1
      ? 'Deletes the thread and its single comment.'
      : `Deletes the thread and all ${count} comments.`
    // onClose runs for Esc / backdrop-click / × paths; the confirm path
    // bypasses makeModal's close() by calling backdrop.remove() directly
    // (matching the existing confirmRemoveComment pattern), so the
    // confirm onclick also needs to refresh the hint explicitly.
    const backdrop = makeModal(
      '<h2>Delete thread?</h2>' +
      `<p class="modal-text">${escapeHtml(detail)} This can't be undone.</p>` +
      '<div class="modal-actions is-reversed">' +
        '<button class="danger" data-confirm>Delete</button>' +
        '<button data-close>Cancel</button>' +
      '</div>',
      { onClose: renderKeymapHint }
    )
    // Focus the primary button so Enter natively confirms — no parallel
    // keymap branch needed, native <button> semantics do the work. The
    // `danger` styling visually signals which action Enter will fire.
    backdrop.querySelector('[data-confirm]').focus()
    renderKeymapHint()
    backdrop.querySelector('[data-confirm]').onclick = async () => {
      backdrop.remove()
      renderKeymapHint()
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repo.id)}/threads/${encodeURIComponent(tid)}`,
          { method: 'DELETE' }
        )
        if (res.threads) state.threads = res.threads
        renderInlineComments()
        refreshReviewBanner()
        toast.ok('Thread removed')
      } catch (err) {
        toast('Remove failed: ' + (err.message || 'unknown'))
      }
    }
  }

  // Is the cursor on a line whose inline thread row is currently visible?
  // Single-line threads splice right after the anchor row; multi-line
  // threads splice after the LAST line (see renderInlineComments:2753 —
  // `ln >= anchorLine` picks the highest line as the anchor). So the
  // "thread for this line" question reduces to checking the cursor row's
  // immediate next sibling. Returns the thread id or null.
  function cursorThreadId () {
    const cursor = $('[data-body] tr.diff-row.is-cursor')
    const next = cursor?.nextElementSibling
    if (next?.classList?.contains('diff-row-thread')) return next.dataset.threadId || null
    return null
  }

  // Single `e` target picker. Walks back from the cursor to its enclosing
  // hunk-head and returns that header's ▲ button when it's visible. If
  // ▲ is missing or already exhausted AND the cursor sits in the file's
  // LAST hunk, falls back to the file's ▼ button so the keystroke also
  // covers the un-rendered tail. The fallback is gated on "cursor is in
  // the last hunk" specifically because that's when the ▼ button is
  // visually close to the cursor — clicking it inserts rows right below
  // the cursor's hunk, no scroll needed and no cursor jump. For cursors
  // in non-last hunks with the gap above already filled, we return null
  // and let the key handler toast — the user moves to the next hunk to
  // continue expanding, instead of being teleported to the file's tail.
  function findExpandTarget () {
    const body = $('[data-body]')
    if (!body) return null
    const cursor = body.querySelector('tr.diff-row.is-cursor')
    if (!cursor) {
      // No cursor: prefer the first visible ▲ across all files; fall back
      // to the first ▼ so a fresh page still does something useful.
      const files = Array.from(body.querySelectorAll('.diff-file:not(.is-collapsed)'))
      for (const f of files) {
        const up = f.querySelector('.diff-expand-btn[data-expand-direction="up"]')
        if (up && up.style.visibility !== 'hidden') return up
      }
      for (const f of files) {
        const down = f.querySelector('.diff-expand-btn[data-expand-direction="down"]')
        if (down) return down
      }
      return null
    }
    // Walk back to the cursor's enclosing hunk header.
    let row = cursor
    while (row && !row.classList.contains('diff-row-hunk')) {
      row = row.previousElementSibling
    }
    const upBtn = row?.querySelector('.diff-expand-btn[data-expand-direction="up"]')
    if (upBtn && upBtn.style.visibility !== 'hidden') return upBtn
    // ▲ unavailable. Try the file's ▼ only if the cursor's hunk IS the
    // file's last hunk — otherwise the ▼ lives far below the cursor and
    // the keystroke would feel like a teleport.
    const file = cursor.closest('.diff-file:not(.is-collapsed)')
    if (!file || !row) return null
    const hunks = file.querySelectorAll('tr.diff-row-hunk')
    if (hunks[hunks.length - 1] === row) {
      return file.querySelector('.diff-expand-btn[data-expand-direction="down"]') || null
    }
    return null
  }

  // Single-line forge deep-link used by bare `o`/`O` (no comment selection
  // active). Mirrors the CTA forge button's URL-synthesis path so the two
  // routes produce identical URLs for a single line. CRITICAL: window.open
  // is called synchronously to preserve the user-activation flag — the
  // synthetic .click() from this real keydown carries the gesture in, but
  // it expires on the next microtask, so the popup must open *before* the
  // buildForgeDeepLink promise resolves.
  function openForgeForRow (row, preferSide, strict = false) {
    if (!row) return
    const info = state.prInfo
    if (!info?.host || !info?.pr_url) return
    const pick = (side) => row.querySelector(`[data-side="${side}"][data-line][data-path]`)
    let cell = pick(preferSide)
    if (!cell && !strict) cell = pick(preferSide === 'new' ? 'old' : 'new')
    if (!cell) return
    const path = cell.dataset.path
    const line = Number(cell.dataset.line)
    const side = cell.dataset.side
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      toast('Popup blocked — allow popups for slop-review to open forge links')
      return
    }
    buildForgeDeepLink({
      host: info.host,
      prUrl: info.pr_url,
      path,
      lineStart: line,
      lineEnd: line,
      side,
    })
      .then((url) => {
        if (!url) { tab.close(); return }
        tab.opener = null
        tab.location.href = url
      })
      .catch((e) => {
        tab.close()
        toast('Failed to build forge URL: ' + (e.message || 'unknown'))
      })
  }

  // True when the current view is a commit-diff AND the given file is one
  // that has later changes between this commit and HEAD. Used to gate the
  // "Peek HEAD" affordances: the question "what does this look like now?"
  // is only meaningful in this corner — Full/Local are already at HEAD,
  // and unchanged files would show identical content.
  function fileHasLaterChanges (path) {
    if (!isCommitIndex(state.index)) return false
    const file = state.diff?.files?.find((f) => f.path === path)
    return file ? file.is_unchanged_since_commit === false : false
  }

  // Returns {path, line} for the new-side anchor on the given row if it
  // qualifies for HEAD preview, else null. We require new side because
  // an old-side line was *removed* by this commit — there's no
  // corresponding line at HEAD to follow forward to. The hint bar and
  // the `p` key handler both consult this so they stay in sync.
  function rowHeadPreviewTarget (row) {
    if (!row) return null
    const cell = row.querySelector('[data-side="new"][data-line][data-path]')
    if (!cell) return null
    const path = cell.dataset.path
    const line = Number(cell.dataset.line)
    if (!path || !Number.isFinite(line) || line < 1) return null
    if (!fileHasLaterChanges(path)) return null
    return { path, line }
  }

  function openHeadPreviewForRow (row) {
    const t = rowHeadPreviewTarget(row)
    if (!t) return
    openHeadPreviewModal({ repoId: repo.id, commitSha: state.diff.sha, path: t.path, line: t.line })
  }

  // Single-line copy used by bare `y`/`Y` (no comment selection active).
  // Mirrors the format the CTA copy button produces for a single-line
  // range — `path:line` for new side, `path:line (old)` for old — so the
  // two code paths produce identical refs and clipboard pastes stay
  // consistent regardless of how the user invoked copy.
  function copyLineRef (row, preferSide, strict = false) {
    if (!row) return
    const pick = (side) => row.querySelector(`[data-side="${side}"][data-line][data-path]`)
    let cell = pick(preferSide)
    if (!cell && !strict) cell = pick(preferSide === 'new' ? 'old' : 'new')
    if (!cell) return
    const path = cell.dataset.path
    const line = cell.dataset.line
    const side = cell.dataset.side
    const ref = side === 'old' ? `${path}:${line} (old)` : `${path}:${line}`
    copyToClipboard(ref)
      .then(() => toast.ok(`Copied ${ref}`))
      .catch((e) => toast('Copy failed: ' + (e.message || 'unknown')))
  }

  function moveCursor (delta) {
    let rows = getNavigableRows()
    // CTA mode: j/k extends the selection rather than just moving the
    // cursor. Restrict navigable rows to ones with a gutter on the same
    // (path, side) as the selection — this way j/k always lands on a
    // line we can include in the range, skipping hunk headers and rows
    // from other files that would otherwise force a fresh selection.
    const sel = state.commentSelection
    if (sel) {
      rows = rows.filter((r) => r.querySelector(
        `[data-side="${sel.side}"][data-line][data-path="${cssEscape(sel.path)}"]`
      ))
    }
    if (rows.length === 0) return
    const body = $('[data-body]')
    const current = body?.querySelector('tr.diff-row.is-cursor')
    let nextIdx
    if (!current) {
      // First press: j → first line, k → last line.
      nextIdx = delta > 0 ? 0 : rows.length - 1
    } else {
      const idx = rows.indexOf(current)
      if (idx === -1) {
        // The cursor row dropped out of the navigable set — typically
        // because `r` (or a mouse click on the header) just folded its
        // file. Jumping to absolute index 0 / last would teleport the
        // user away from where they were reading, so instead walk by
        // document order in the direction of travel: j → first row
        // *after* the lost cursor (next file's first line), k → last
        // row *before* it (previous file's last line). Falls back to
        // clamping at the edge when there's nothing further that way,
        // matching the normal "press j at the last row" behavior.
        if (delta > 0) {
          nextIdx = rows.findIndex((r) =>
            current.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING
          )
          if (nextIdx === -1) nextIdx = rows.length - 1
        } else {
          nextIdx = -1
          for (let i = rows.length - 1; i >= 0; i--) {
            if (current.compareDocumentPosition(rows[i]) & Node.DOCUMENT_POSITION_PRECEDING) {
              nextIdx = i
              break
            }
          }
          if (nextIdx === -1) nextIdx = 0
        }
      }
      else nextIdx = Math.max(0, Math.min(rows.length - 1, idx + delta))
    }
    if (current) current.classList.remove('is-cursor')
    const next = rows[nextIdx]
    next.classList.add('is-cursor')
    next.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    // Extend the selection to span [anchor, new cursor line]. Mirrors
    // the gutter-click extension at the body click handler — same anchor
    // pivot, same min/max logic — so mouse and keyboard converge on the
    // same selection shape. applyCommentSelection re-splices the CTA
    // beneath the new last-line and re-paints the range ribbon.
    if (sel) {
      const gutter = next.querySelector(`[data-side="${sel.side}"][data-line]`)
      const line = Number(gutter?.dataset?.line)
      if (Number.isFinite(line)) {
        const anchor = sel.anchor
        state.commentSelection = {
          path: sel.path,
          side: sel.side,
          lineStart: Math.min(anchor, line),
          lineEnd: Math.max(anchor, line),
          anchor,
          // Inherit `viaMouse` so a CTA started by a real gutter click
          // stays visible across keyboard extends — and a `c`-started
          // selection stays CTA-less even after j/k.
          viaMouse: sel.viaMouse,
        }
        applyCommentSelection()
      }
    }
  }

  // Returns the deduped list of "thread anchor" rows in the current view —
  // the diff-rows that have at least one inline thread attached. Walks
  // back past stacked threads (multiple comments on the same line render
  // as consecutive .diff-row-thread siblings) so each unique anchor
  // appears once. Driven by DOM, not state.threads, so the view filter
  // and per-file collapse are honored for free.
  function getThreadAnchorsInView () {
    const body = $('[data-body]')
    if (!body) return []
    const threadRows = body.querySelectorAll('.diff-file:not(.is-collapsed) tr.diff-row-thread')
    const seen = new Set()
    const anchors = []
    for (const tr of threadRows) {
      let el = tr.previousElementSibling
      while (el && !el.matches('tr.diff-row:not(.diff-row-thread):not(.diff-row-editor):not(.diff-row-comment-cta)')) {
        el = el.previousElementSibling
      }
      if (el && !seen.has(el)) {
        seen.add(el)
        anchors.push(el)
      }
    }
    return anchors
  }

  // Jump cursor to next/prev thread anchor. Wraps at the ends (vim `n`
  // convention). When the cursor is on a non-anchor row (just navigating
  // diff lines), finds the nearest anchor in the direction of travel
  // rather than jumping to absolute first/last — mirrors moveCursor's
  // "current dropped out of the set" logic so the jump feels continuous
  // with where the user was reading.
  function jumpToThread (direction) {
    const anchors = getThreadAnchorsInView()
    if (anchors.length === 0) return
    const body = $('[data-body]')
    const current = body.querySelector('tr.diff-row.is-cursor')
    let nextIdx
    if (!current) {
      nextIdx = direction > 0 ? 0 : anchors.length - 1
    } else {
      const idx = anchors.indexOf(current)
      if (idx !== -1) {
        nextIdx = (idx + direction + anchors.length) % anchors.length
      } else if (direction > 0) {
        nextIdx = anchors.findIndex((a) =>
          current.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING
        )
        if (nextIdx === -1) nextIdx = 0
      } else {
        nextIdx = -1
        for (let i = anchors.length - 1; i >= 0; i--) {
          if (current.compareDocumentPosition(anchors[i]) & Node.DOCUMENT_POSITION_PRECEDING) {
            nextIdx = i
            break
          }
        }
        if (nextIdx === -1) nextIdx = anchors.length - 1
      }
    }
    if (current) current.classList.remove('is-cursor')
    const next = anchors[nextIdx]
    next.classList.add('is-cursor')
    // `center` (not `nearest`) because n/N is a discrete jump, not a
    // continuous walk — putting the anchor mid-viewport keeps the thread
    // row (rendered below it) visible at the same time.
    next.scrollIntoView({ block: 'center', behavior: 'auto' })
  }

  const onKey = (e) => {
    if (disposed) return
    if (e.target?.closest?.('input, textarea')) return
    // j/k cursor nav — single-line. Bare letters only; Ctrl/Cmd/Alt
    // variants fall through so browser defaults (Ctrl+J downloads, etc.)
    // aren't shadowed. Shift goes to the J/K handler immediately below.
    if ((e.key === 'j' || e.key === 'k') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      moveCursor(e.key === 'j' ? 1 : -1)
      revealKeymapHint()
      e.preventDefault()
      return
    }
    // J/K — 5-line jump. Deliberately omitted from the hint bar: it's a
    // power-user shortcut and surfacing both `j` and `J` would crowd the
    // primary nav item without teaching much. `e.key` is already 'J'/'K'
    // when Shift is held (vs 'j'/'k' otherwise), so no separate shiftKey
    // check is needed — but we still bar Cmd/Ctrl/Alt+Shift+J to leave
    // browser-level chords (DevTools, etc.) intact.
    if ((e.key === 'J' || e.key === 'K') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      moveCursor(e.key === 'J' ? 5 : -5)
      revealKeymapHint()
      e.preventDefault()
      return
    }
    // c / C — "click" the cursored line's gutter to open the CTA via the
    // same click delegation as a mouse gutter-click. `c` prefers the new
    // side (falling back to old on pure-removals so the key isn't a
    // no-op); capital `C` is strict-old (matches Y/O strictness — silent
    // no-op on rows without an old side rather than risking a
    // semantically-wrong comment side). Cleanly no-ops on hunk-header
    // rows and any row missing the chosen gutter. Gated outside CTA mode
    // so `c` doesn't restart selection from under an in-progress range.
    if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Commit-on-existing-selection: `V` (visual-line) anchored a range
      // that the user may have extended with j/k. `c` here is the verb
      // that acts on it — open the editor on the full range. Mirrors
      // Enter's behavior in this state; offered as `c` too so vim users
      // can stay on a single verb across single- and multi-line flows.
      // Case-insensitive: side is already fixed by V, so `C`'s usual
      // strict-old gate doesn't apply here.
      if (state.commentSelection) {
        openEditorForSelection()
        e.preventDefault()
        return
      }
      const cursor = $('[data-body] tr.diff-row.is-cursor')
      if (!cursor) return
      const strict = e.key === 'C'
      const preferSide = strict ? 'old' : 'new'
      const pick = (side) => cursor.querySelector(`[data-side="${side}"][data-line][data-path]`)
      const gutter = pick(preferSide) || (strict ? null : pick('old'))
      if (gutter) {
        // Flag the synthetic click so the body click listener can tag the
        // resulting selection as keyboard-initiated (CTA stays hidden).
        // Sync set→click→reset: HTMLElement.click() invokes listeners
        // synchronously, so the flag is guaranteed to still be true when
        // the body click handler reads it, and reset before any subsequent
        // real click can land. (We use a flag rather than e.isTrusted
        // because .click() goes through the user-agent's internal fire
        // path and produces isTrusted=true — same as a real mouse click.)
        synthClickFromKey = true
        try { gutter.click() } finally { synthClickFromKey = false }
        // Open the editor directly on the cursor row. Skipping the
        // intermediate "press Enter to confirm" step because the CTA's
        // Add-comment button is hidden in keyboard mode — making the user
        // press Enter to click a button they can't see was friction with
        // no purpose. `c` is a verb that commits, vim-style.
        openEditorForSelection()
        e.preventDefault()
      }
      return
    }
    // v / V — enter visual-line mode: anchor a 1-line selection on the
    // cursor row WITHOUT opening the editor, so j/k can extend it before
    // the user commits with `c` (or Enter). The verb/visual split mirrors
    // vim: a single key can't both anchor a range and commit on it, so
    // v/V anchor and c commits. Case follows the c/C, y/Y, o/O convention:
    // lowercase prefers new with fallback to old; uppercase is strict-old
    // (silent no-op on rows missing an old side). Gated outside CTA mode
    // so v/V doesn't restart selection mid-range.
    if ((e.key === 'v' || e.key === 'V') && !state.commentSelection && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const cursor = $('[data-body] tr.diff-row.is-cursor')
      if (!cursor) return
      const strict = e.key === 'V'
      const preferSide = strict ? 'old' : 'new'
      const pick = (side) => cursor.querySelector(`[data-side="${side}"][data-line][data-path]`)
      const gutter = pick(preferSide) || (strict ? null : pick('old'))
      if (gutter) {
        synthClickFromKey = true
        try { gutter.click() } finally { synthClickFromKey = false }
        e.preventDefault()
      }
      return
    }
    // y / Y — copy line reference. Available in default cursor mode AND
    // CTA mode. In CTA mode we route through the existing copy button so
    // multi-line selections are formatted correctly; in default mode we
    // copy the cursored row's single-line ref directly. `e.key` already
    // encodes shift state ('y' vs 'Y'), so we don't need a separate
    // shiftKey check — but we still bar the cmd/ctrl/alt variants from
    // shadowing browser shortcuts like Cmd+Y (history).
    if ((e.key === 'y' || e.key === 'Y') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (state.commentSelection) {
        $('[data-cta-copy]')?.click()
      } else {
        const cursor = $('[data-body] tr.diff-row.is-cursor')
        // Capital-Y is strict (old only) — matches the hint, which hides
        // the `Y copy old` item when the row has no old side. Lowercase y
        // keeps the fallback so it always copies whichever side exists.
        if (cursor) copyLineRef(cursor, e.key === 'Y' ? 'old' : 'new', e.key === 'Y')
      }
      e.preventDefault()
      return
    }
    // Enter in CTA mode → "Add comment" button. Cursor nav already bailed
    // by here, and we know no modifier keys are held by the bare-Enter
    // requirement; further modifier-key combos pass through untouched.
    if (e.key === 'Enter' && state.commentSelection && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      $('[data-cta-add]')?.click()
      e.preventDefault()
      return
    }
    // o / O — open forge deep-link. Top-level (works in default cursor mode
    // AND CTA mode), mirroring the y/Y line-level pattern. CTA mode routes
    // through the existing forge button so multi-line ranges are formatted
    // correctly; default mode synthesizes a single-line URL from the
    // cursor row via openForgeForRow. Cmd/Ctrl/Alt+O passes through to
    // browser defaults (Cmd+O = open file dialog) untouched.
    if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (state.commentSelection) {
        // Selection has a fixed side, so capital-O has nothing extra to
        // do here — only the lowercase form routes through the button.
        if (e.key === 'o') $('[data-cta-forge]')?.click()
      } else {
        const cursor = $('[data-body] tr.diff-row.is-cursor')
        // Capital-O is strict (old only) — same reasoning as `Y` above.
        openForgeForRow(cursor, e.key === 'O' ? 'old' : 'new', e.key === 'O')
      }
      e.preventDefault()
      return
    }
    // r — toggle reviewed status for the cursor row's file. Synthesizes a
    // click on that file's `.diff-file-head` so all the gates (unresolved
    // threads, commit-view "later changes" check, optimistic state +
    // rollback, persistence, collapse↔reviewed sync) run through the
    // single delegated click handler at diff.js:1916. Gated on Full or
    // Commit view because Local view's header toggles collapse only.
    // Suppressed during CTA/editor flows for the same reason as `d` — a
    // stray `r` mid-selection shouldn't fold the file out from under the
    // in-progress comment.
    if (e.key === 'r' && !state.commentSelection && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const cursor = $('[data-body] tr.diff-row.is-cursor')
      if (!cursor) return
      if (!(isFullIndex(state.index) || isCommitIndex(state.index))) return
      const head = cursor.closest('.diff-file[data-path]')?.querySelector('[data-toggle-collapse]')
      if (head) {
        head.click()
        e.preventDefault()
      }
      return
    }
    // d — delete the thread on the cursored line. No-op when the cursor
    // isn't on a line with a visible thread; suppressed during CTA/editor
    // flows so a stray `d` in selection mode can't nuke an adjacent thread.
    if (e.key === 'd' && !state.commentSelection && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tid = cursorThreadId()
      if (tid) {
        confirmAndDeleteThread(tid)
        e.preventDefault()
      }
      return
    }
    // n / N — jump to next / prev thread anchor in the current view.
    // Wraps at the ends, vim `n`-style. Silent no-op when there are no
    // threads (the hint at getKeymapItems hides `n` in that case so the
    // bar never advertises a dead key). Suppressed during CTA/editor
    // flows so the cursor can't teleport out from under an in-progress
    // selection — matches d/r/p's gating.
    if ((e.key === 'n' || e.key === 'N') && !state.commentSelection && !e.metaKey && !e.ctrlKey && !e.altKey) {
      jumpToThread(e.key === 'n' ? 1 : -1)
      revealKeymapHint()
      e.preventDefault()
      return
    }
    // p — peek HEAD: open the head-preview modal for the cursor row.
    // Gated three ways (commit view + new side + file has later changes)
    // through rowHeadPreviewTarget, which the hint bar also consults, so
    // the key never advertises a no-op. Suppressed during CTA mode
    // because the CTA already exposes its own [data-cta-peek] button —
    // having `p` work simultaneously would be ambiguous if the cursor
    // sat on a different file than the CTA selection.
    if (e.key === 'p' && !state.commentSelection && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const cursor = $('[data-body] tr.diff-row.is-cursor')
      openHeadPreviewForRow(cursor)
      e.preventDefault()
      return
    }
    // e — expand diff context. Single key; the target picker decides
    // which ▲ or ▼ button to click based on the cursor's position
    // (see findExpandTarget). The cursor stays put across expansions
    // because either: (a) the ▲ inserts rows above the cursor's hunk
    // header (no cursor movement), or (b) the ▼ fallback only fires when
    // the cursor is in the last hunk — so the inserted rows land just
    // below the cursor and stay in view. Suppressed during CTA mode for
    // the same reason as `p`: the cursor row's file may not match the
    // file under selection.
    if (e.key === 'e' && !state.commentSelection && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const btn = findExpandTarget()
      if (btn) {
        btn.click()
        revealKeymapHint()
      } else {
        toast('Nothing more to expand here — move the cursor to another hunk')
      }
      e.preventDefault()
      return
    }
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
  // First-commit + Full-diff shortcuts. `»` targets Full (state.commits.length),
  // not maxIndex(): the Local view is its own thing and isn't really "the end".
  // No-op when already at the target (matches prev/next click semantics).
  $('[data-first]').addEventListener('click', () => goto(0))
  $('[data-last]').addEventListener('click', () => goto(state.commits.length))

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
  // Scope flag set by the `c`/`C` vim handler around its synthetic
  // `gutter.click()` so the body click listener below can tell a real
  // mouse click apart from one synthesized from a keypress. We can't use
  // `e.isTrusted` for this: HTMLElement.click() routes through the user
  // agent's internal fire-an-event path and produces isTrusted=true, same
  // as a real click. The flag is set→click→reset synchronously inside
  // .click(), so there's no window in which a real click could read it as
  // true.
  let synthClickFromKey = false

  $('[data-body]').addEventListener('click', (e) => {
    // Three intents, gated by where the user tapped and whether the gutter
    // is currently rendered:
    //   1. Tap on .diff-no    -> CTA  (always; desktop AND mobile-with-Line#)
    //   2. Tap on .diff-text  -> CTA  (mobile only, AND Line # is OFF)
    //   3. Tap on .diff-text  -> symbol panel  (mobile only, AND Line # is ON)
    // Desktop falls through to no-op on text taps so mouse text selection
    // and the existing dblclick-for-symbol gesture keep working unchanged.
    const isMobile = window.matchMedia('(max-width: 768px)').matches
    let gutter = e.target.closest?.('.diff-no[data-line][data-side][data-path]')
    if (!gutter) {
      const textCell = e.target.closest?.('.diff-text[data-line][data-side][data-path]')
      if (!textCell || !isMobile) return
      if (_hideGutter) {
        // (2) Line # OFF on mobile — text taps stand in for the missing
        // gutter and open the CTA.
        gutter = textCell
      } else {
        // (3) Line # ON on mobile — text taps open the symbol panel for
        // the identifier under the tap point. caretRangeFromPoint resolves
        // the coords; getWordAtTap walks the text node for word bounds.
        const word = getWordAtTap(e)
        if (word && IDENT_RE.test(word)) {
          e.preventDefault(); e.stopPropagation()
          const anchor = { path: textCell.dataset.path, line: textCell.dataset.line, side: textCell.dataset.side }
          openSymbolPanel(word, textCell.dataset.path, anchor)
        }
        return
      }
    }
    const path = gutter.dataset.path
    const side = gutter.dataset.side
    const line = Number(gutter.dataset.line)
    if (!path || !side || !Number.isFinite(line) || line < 1) return
    e.preventDefault(); e.stopPropagation()
    // The CTA button strip is mouse-only UX; vim users get Enter/Esc/y/o
    // from the hint bar instead. See applyCommentSelection for the
    // matching visual gate.
    const viaMouse = !synthClickFromKey
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
        viaMouse,
      }
    } else {
      // First click, or switch to a different file/side → fresh selection.
      state.commentSelection = {
        path,
        side,
        lineStart: line,
        lineEnd: line,
        anchor: line,
        viaMouse,
      }
    }
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
    renderKeymapHint()
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
    // Keyboard-started selections (the `c` vim key) still get a CTA in
    // the DOM — y/o vim keys dispatch `.click()` on its buttons for
    // multi-line range formatting — but it's display:none'd so the vim
    // user isn't shown a redundant mouse-only button strip. `viaMouse`
    // is stamped on the selection at its origin (gutter click handler
    // above) and inherited through j/k extension.
    cta.className = 'diff-row diff-row-comment-cta' + (sel.viaMouse ? '' : ' is-keyboard-only')
    const rangeLabel = sel.lineStart === sel.lineEnd
      ? `L${sel.lineStart}`
      : `L${sel.lineStart}–${sel.lineEnd}`
    // Forge deep-link button: only when the server resolved a host we
    // know how to format URLs for (currently GitHub) AND a PR exists for
    // the current branch. Both conditions degrade to "hide button" — no
    // disabled state, no tooltip — because either case is permanent for
    // the duration of the page load and a non-clickable button is noise.
    const HOST_LABELS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' }
    const prInfo = state.prInfo
    const forgeLabel = prInfo?.host === 'github' && prInfo?.pr_url
      ? HOST_LABELS[prInfo.host]
      : null
    const forgeBtn = forgeLabel
      ? `<button type="button" data-cta-forge>${escapeHtml(forgeLabel)}</button>`
      : ''
    // Peek-HEAD button: surfaces the same affordance the `p` vim key
    // exposes. Gated identically — commit view + new side + file has
    // later changes — so a commenter who triggers the CTA on a file with
    // no HEAD divergence isn't shown a button that would just echo what
    // they're already reading. We anchor on sel.lineStart for ranges;
    // the preview is a peek, not a literal range render.
    const peekHeadBtn = (sel.side === 'new' && fileHasLaterChanges(sel.path))
      ? '<button type="button" data-cta-peek>Peek HEAD</button>'
      : ''
    cta.innerHTML =
      `<td${isMobileDiffView() ? '' : ' colspan="4"'} class="diff-comment-cta-cell">` +
        '<div class="diff-comment-cta">' +
          `<span class="diff-comment-cta-label">Comment on ${escapeHtml(rangeLabel)} (${escapeHtml(sel.side)})</span>` +
          '<div class="diff-comment-cta-actions">' +
            '<button type="button" data-cta-cancel>Cancel</button>' +
            peekHeadBtn +
            forgeBtn +
            '<button type="button" data-cta-copy>Copy lines</button>' +
            '<button type="button" class="primary" data-cta-add>Add comment</button>' +
          '</div>' +
        '</div>' +
      '</td>'
    lastTextRow.parentNode.insertBefore(cta, lastTextRow.nextSibling)
    cta.querySelector('[data-cta-copy]').addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      // `(old)` suffix on the old side disambiguates pre-image references
      // from HEAD ones — and intentionally breaks the `path:line` editor-
      // jump format so a paste won't silently land on the wrong line in
      // the current checkout. New side is the default; no suffix.
      const range = sel.lineStart === sel.lineEnd
        ? `${sel.path}:${sel.lineStart}`
        : `${sel.path}:${sel.lineStart}-${sel.lineEnd}`
      const ref = sel.side === 'old' ? `${range} (old)` : range
      try {
        await copyToClipboard(ref)
        toast.ok(`Copied ${ref}`)
      } catch (e) {
        toast('Copy failed: ' + (e.message || 'unknown'))
      }
    })
    cta.querySelector('[data-cta-cancel]').addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      clearCommentSelection()
    })
    cta.querySelector('[data-cta-add]').addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      openEditorForSelection()
    })
    // Peek HEAD: opens the head-preview modal anchored on the range's
    // first line. The button only exists when fileHasLaterChanges was
    // true at CTA-render time, so we don't need to re-check here — but
    // we do double-check state.diff.sha because a navigation could in
    // theory race the click (the CTA persists across `applyCommentSelection`
    // calls, but state.diff is replaced wholesale on diff swap).
    cta.querySelector('[data-cta-peek]')?.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      const sha = state.diff?.sha
      if (!sha) return
      openHeadPreviewModal({ repoId: repo.id, commitSha: sha, path: sel.path, line: sel.lineStart })
    })
    // GitHub deep-link: synthesize the `pull/N/files#diff-<sha>R<line>` URL
    // and open in a new tab. Pre-opening the tab BEFORE the async hash
    // computation is deliberate — Safari/Chrome only allow `window.open`
    // inside a user gesture, so awaiting first and opening after would
    // get popup-blocked. We open about:blank synchronously and keep a
    // handle so we can redirect it once the URL is ready.
    //
    // Don't pass `noopener,noreferrer` to window.open: that flag makes
    // the call return `null` *by spec*, even on success. Without a
    // handle we can't redirect the new tab. Instead, after assigning
    // `tab.location.href`, we set `tab.opener = null` to manually sever
    // the reverse-tabnabbing channel — same security posture, working
    // reference.
    cta.querySelector('[data-cta-forge]')?.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      const info = state.prInfo
      if (!info?.host || !info?.pr_url) return
      const tab = window.open('about:blank', '_blank')
      if (!tab) {
        toast('Popup blocked — allow popups for slop-review to open forge links')
        return
      }
      try {
        const url = await buildForgeDeepLink({
          host: info.host,
          prUrl: info.pr_url,
          path: sel.path,
          lineStart: sel.lineStart,
          lineEnd: sel.lineEnd,
          side: sel.side,
        })
        if (!url) { tab.close(); return }
        tab.opener = null
        tab.location.href = url
      } catch (e) {
        tab.close()
        toast('Failed to build forge URL: ' + (e.message || 'unknown'))
      }
    })
    // Second hint refresh — the earlier call (line ~964) fires before the
    // CTA row is in the DOM, so it can't see `[data-cta-forge]`. This call
    // runs after the CTA + forge button are mounted, so the `o open …`
    // hint item shows up when the forge button is available.
    renderKeymapHint()
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

  // Resolve a tap to the word at that pixel, for mobile single-tap symbol
  // panel. Tries the modern caretPositionFromPoint first; falls back to
  // caretRangeFromPoint for older WebKit (Safari < 18.4). Either API
  // resolves the tap to a text-node + offset; we then walk character-by-
  // character through the node until we hit a non-identifier-char in
  // either direction. Returns '' if the tap landed off any text node.
  // Desktop continues to use window.getSelection() in the dblclick handler
  // below — dblclick natively word-selects, so no manual walk is needed.
  function getWordAtTap(e) {
    let node, offset
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY)
      if (!pos) return ''
      node = pos.offsetNode
      offset = pos.offset
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY)
      if (!range) return ''
      node = range.startContainer
      offset = range.startOffset
    } else {
      return ''
    }
    if (node?.nodeType !== Node.TEXT_NODE) return ''
    const text = node.textContent || ''
    const isWord = (c) => /[a-zA-Z0-9_$]/.test(c)
    let s = offset
    let end = s
    while (s > 0 && isWord(text[s - 1])) s--
    while (end < text.length && isWord(text[end])) end++
    return text.slice(s, end)
  }

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
    if (action === 'back') {
      popSymbolJump(sessionId)
      // Mirror the match-tap behavior: navigation succeeded, user wants to
      // SEE the result, so park the panel into a strip on mobile.
      if (window.matchMedia('(max-width: 768px)').matches) minimizeActive()
      return
    }
    if (action === 'start') {
      popSymbolJumpAll(sessionId)
      // "Back to original" is the user saying "I'm done navigating, send
      // me home" — close the session entirely on mobile so the panel is
      // out of the way. They can re-tap the original word to restart.
      if (window.matchMedia('(max-width: 768px)').matches) closeSession(sessionId)
      return
    }
    if (action === 'minimize') { minimizeActive(); return }
    if (action === 'restore')  { activateSession(sessionId); return }
    if (action === 'toggle-def') {
      const session = getSession(sessionId)
      if (session && session.definition?.state === 'found') {
        session.definitionExpanded = !session.definitionExpanded
        renderSymbolPanel()
      }
      return
    }
    // Match click in the active session's list.
    const matchEl = e.target.closest('[data-path][data-line][data-side]')
    if (matchEl) {
      scrollToMatch(sessionId, matchEl.dataset.path, matchEl.dataset.line, matchEl.dataset.side)
      // On mobile the active panel covers the entire viewport, so the
      // scroll-into-view we just triggered isn't visible until the panel
      // shrinks. Auto-minimize after navigating so the user immediately
      // sees the jumped-to cell. The parked strip stays on the right edge
      // and a tap on it brings the match list back when they want to jump
      // somewhere else.
      if (window.matchMedia('(max-width: 768px)').matches) {
        minimizeActive()
      }
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
      // Server-fetched "where is this defined at HEAD" snippet. Stays
      // 'loading' through the round trip and renders as a placeholder
      // chip; settles to 'found' / 'missing' / 'invalid' / 'error' once
      // /api/.../symbol-def replies. Collapsed by default — the user
      // expands explicitly because long bodies can dominate the panel.
      definition: { state: 'loading' },
      definitionExpanded: false,
    }
    // Snapshot the diff-body scroll position before the panel renders so we
    // can restore it on close. With Wrap off + Line # on, long lines extend
    // horizontally and the user may have been scrolled mid-line when they
    // tapped to open the panel; otherwise closing the panel would leave
    // them stranded on whatever the panel's last interaction scrolled to
    // (or on a position where short lines show as bare bg). Only stored on
    // the *first* session creation — re-opening from a parked session
    // keeps the original snapshot since the user's "reading position"
    // hasn't fundamentally changed.
    if (state.symbolPanel.sessions.length === 0) {
      const body = $('[data-body]')
      if (body) state.symbolPanel.scrollSnapshot = { left: body.scrollLeft, top: body.scrollTop }
    }
    state.symbolPanel.sessions.push(session)
    state.symbolPanel.activeId = session.id
    state.symbolPanel.open = true
    root.classList.add('has-symbol-panel', 'disable-content-visibility')
    renderSymbolPanel()
    applySymbolHighlights()
    fetchSymbolDefinition(session.id, symbol)
  }

  // Validate client-side first so we don't issue a round-trip for things
  // the server will reject anyway (selections containing dots, whitespace,
  // operators). Same shape gate the server uses.
  const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

  async function fetchSymbolDefinition(sessionId, symbol) {
    if (!SYMBOL_RE.test(symbol)) {
      setSessionDefinition(sessionId, { state: 'invalid' })
      return
    }
    try {
      const qs = new URLSearchParams({ name: symbol })
      const data = await api(`/api/repos/${encodeURIComponent(repo.id)}/symbol-def?${qs}`)
      if (data.found) {
        setSessionDefinition(sessionId, { state: 'found', ...data })
      } else {
        setSessionDefinition(sessionId, { state: 'missing', reason: data.reason || null })
      }
    } catch {
      setSessionDefinition(sessionId, { state: 'error' })
    }
  }

  function setSessionDefinition(sessionId, definition) {
    const session = getSession(sessionId)
    if (!session) return  // session was closed before the fetch resolved
    session.definition = definition
    // Only re-render when *this* session is what the user is looking at;
    // background fetches for parked sessions shouldn't reflow the active
    // panel.
    if (state.symbolPanel.activeId === sessionId) renderSymbolPanel()
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
    // Restore the diff-body scroll to where the user was reading before
    // the panel took over. Match-row scrollIntoView inside the panel can
    // have dragged the body to a different vertical/horizontal position;
    // minimize is a "return to my reading flow" gesture, same as full
    // close. Snapshot persists in state.symbolPanel so reopening keeps
    // the same reference point.
    const snapshot = state.symbolPanel.scrollSnapshot
    if (snapshot) {
      const body = $('[data-body]')
      if (body) {
        body.scrollLeft = snapshot.left
        body.scrollTop = snapshot.top
      }
    }
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
    const snapshot = state.symbolPanel.scrollSnapshot
    state.symbolPanel = { open: false, sessions: [], activeId: null }
    clearActiveFlash()
    const panel = $('[data-symbol-panel]')
    if (panel) {
      panel.hidden = true
      panel.innerHTML = ''
    }
    root.classList.remove('has-symbol-panel')
    clearSymbolHighlights()
    // Restore the diff-body scroll position captured when the panel first
    // opened. Without this, any match-row scrollIntoView the user invoked
    // while the panel was open (or any horizontal pan they did inside the
    // panel) leaves them stranded — on mobile with Wrap off, a 1500px
    // scrollLeft renders most short lines as bare bg, looking like a bug.
    if (snapshot) {
      const body = $('[data-body]')
      if (body) {
        body.scrollLeft = snapshot.left
        body.scrollTop = snapshot.top
      }
    }
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
    // User navigated to a match — drop the pre-panel scroll snapshot so
    // close/minimize doesn't snap them back to where they were before
    // opening the panel. On mobile this is critical because the active
    // panel covers the whole viewport: the scroll happens immediately but
    // the user can't see the result until they minimize/close, at which
    // point an unconditional restore would silently undo the jump.
    state.symbolPanel.scrollSnapshot = null
    renderSymbolPanel()
  }

  function popSymbolJump(sessionId) {
    const session = getSession(sessionId)
    if (!session || session.jumpStack.length === 0) return
    const target = session.jumpStack.pop()
    session.currentAnchor = target
    scrollToDiffCell(target.path, target.line, target.side)
    state.symbolPanel.scrollSnapshot = null
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
    state.symbolPanel.scrollSnapshot = null
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
      renderDefinitionHeader(session) +
      `<div class="diff-symbol-list">${listHtml}</div>` +
    `</section>`
  }

  // Collapsible "definition at HEAD" card pinned above the matches list.
  // Four observable states:
  //   loading  — in-flight fetch, shows a quiet spinner-pill placeholder
  //   found    — clickable header with file:line, expandable to show the
  //              snippet (line-numbered, syntax-highlighted via syntax.js)
  //   missing  — terse "not found" chip; no expand
  //   invalid  — symbol shape rejected client-side (had punctuation etc.)
  //   error    — server 5xx; collapsed pill, no expand
  // The 'is_def: false' subcase still renders as "found" but labels the
  // anchor as "first occurrence" rather than "Defined in" so the user
  // isn't misled when the heuristic regex didn't fire (e.g. methods inside
  // classes, comments, languages with no DEF_PATTERN entry).
  function renderDefinitionHeader(session) {
    const def = session.definition
    if (!def || def.state === 'invalid') return ''  // hide entirely — symbol selection wasn't a bare identifier

    if (def.state === 'loading') {
      return `<div class="diff-symbol-def is-loading"><span class="diff-symbol-def-spinner"></span>Looking up definition…</div>`
    }
    if (def.state === 'error') {
      return `<div class="diff-symbol-def is-error">Definition lookup failed.</div>`
    }
    if (def.state === 'missing') {
      return `<div class="diff-symbol-def is-missing">No definition found at HEAD.</div>`
    }
    // state === 'found'
    const expanded = !!session.definitionExpanded
    const loc      = `${def.path}:${def.line}`
    const label    = def.is_def ? 'Defined in' : 'First occurrence in'
    let bodyHtml = ''
    if (expanded) {
      const rows = def.snippet.lines.map((text, i) => {
        const isAnchor = (def.snippet.start + i) === def.line
        const lineHtml = highlightLine(text, def.lang)
        return `<div class="diff-symbol-def-row${isAnchor ? ' is-anchor' : ''}">` +
          `<code class="diff-symbol-def-code">${lineHtml || '&nbsp;'}</code>` +
        `</div>`
      }).join('')
      const moreBelow = def.snippet.end < def.snippet.total_lines
      bodyHtml = `<div class="diff-symbol-def-body">${rows}` +
        (moreBelow ? `<div class="diff-symbol-def-truncated">… ${def.snippet.total_lines - def.snippet.end} more line${def.snippet.total_lines - def.snippet.end === 1 ? '' : 's'} in file</div>` : '') +
      `</div>`
    }
    return `<div class="diff-symbol-def is-found${expanded ? ' is-expanded' : ''}">` +
      `<button type="button" class="diff-symbol-def-head" data-action="toggle-def" aria-expanded="${expanded ? 'true' : 'false'}">` +
        `<span class="diff-symbol-def-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>` +
        `<span class="diff-symbol-def-label">${label}</span>` +
        `<code class="diff-symbol-def-loc" title="${escapeHtml(loc)}">${escapeHtml(loc)}</code>` +
      `</button>` +
      bodyHtml +
    `</div>`
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
      `<td${isMobileDiffView() ? '' : ' colspan="4"'} class="diff-editor-cell">` +
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
    // Editor presence is what the hint-bar context check keys off — render
    // now so the bar flips to "submit / cancel" the moment the textarea
    // appears, not on the next state change.
    renderKeymapHint()

    const closeAndClear = () => {
      editor.remove()
      // Editor close always clears selection — the next selection should
      // start fresh, not inherit the just-cancelled range.
      clearCommentSelection()
    }
    editor.querySelector('[data-cancel]').addEventListener('click', closeAndClear)
    // Editor-local keybindings. Scoped to the editor row (bubble phase),
    // so when the textarea is focused the document-level onKey still
    // bails on its input/textarea guard — no cross-talk. Both bindings
    // target the visible buttons via .click() so the submit/cancel side
    // effects (saving, toast, scroll preservation) all run through the
    // single existing implementation.
    editor.addEventListener('keydown', (e) => {
      if (e.target?.tagName !== 'TEXTAREA') return
      if (e.key === 'Escape') {
        e.preventDefault()
        editor.querySelector('[data-cancel]')?.click()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        editor.querySelector('[data-submit]')?.click()
      }
    })
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
        // New thread bumps the counts-strip "N total" + the reviewer-
        // messages pill — refresh the banner in place so the user sees
        // those numbers tick without waiting for the next loadThreads
        // (which only fires on modal-driven mutations).
        refreshReviewBanner()
        if (bodyEl && savedScroll > 0) preserveScrollTo(bodyEl, savedScroll)
        toast.ok('Comment added')
      } catch (e) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Add comment'
        toast('Comment failed: ' + (e.message || 'unknown'))
      }
    })
  }

  $('[data-sha]').addEventListener('click', async () => {
    // Reconstruct the unified diff from the already-fetched files: each
    // `f.patch` is the file's own `diff --git ...` chunk (see
    // getDiffFiles in server/git.js), so joining them mirrors what
    // `git diff <range>` or `git show <sha>` would print. No server
    // round trip needed — the data is in hand the moment the head
    // renders. Works the same for commit / Full / Local views.
    const files = state.diff?.files || []
    if (!files.length) { toast('Diff not loaded yet'); return }
    const text = files.map((f) => f.patch).filter(Boolean).join('\n')
    if (!text) { toast('No patch text to copy'); return }
    try {
      await copyToClipboard(text)
      toast.ok(`Copied diff (${files.length} file${files.length === 1 ? '' : 's'})`)
    } catch (e) {
      toast('Copy failed: ' + (e.message || 'unknown'))
    }
  })

  /**
   * Decide the [start, end] line range to fetch for a single expand click.
   *
   * Inputs:
   *  - direction: 'up' (gap above current hunk; lower line numbers) or
   *    'down' (below the last hunk; higher line numbers).
   *  - anchor: the next line we want to load. For 'up' it's the line
   *    just above the visible hunk; for 'down' it's the line just below
   *    the last visible row. The fetch should INCLUDE this line.
   *  - floor: 'up' only — the lowest line we may fetch (1 for the first
   *    hunk, prev-hunk-tail + 1 otherwise). For 'down' this is null.
   *  - ceiling: 'down' only — the file's total_lines if known. null on
   *    the first 'down' click (we discover it from the response).
   *  - chunkSize: caller's default request size (EXPAND_CHUNK_SIZE).
   *
   * Returns { start, end } (1-indexed, inclusive) — or null if there's
   * nothing left to expand (anchor has already crossed the boundary).
   */
  function computeExpandRange(direction, anchor, floor, ceiling, chunkSize) {
    if (direction === 'up') {
      if (anchor < floor) return null
      return { start: Math.max(floor, anchor - chunkSize + 1), end: anchor }
    }
    if (ceiling != null && anchor > ceiling) return null
    const tentativeEnd = anchor + chunkSize - 1
    return { start: anchor, end: ceiling != null ? Math.min(ceiling, tentativeEnd) : tentativeEnd }
  }

  // Build one context-row tr for either split or inline mode. Mirrors the
  // shape renderHunkSplit / renderHunkInline produce so the inserted rows
  // are layout-identical to the diff-table's existing context lines — same
  // gutters, same data-side/data-line attrs so the comment-selection gutter
  // click handler picks them up too.
  function renderContextRowHtml({ text, oldLine, newLine, path, sha, language, mode }) {
    const pathAttr = escapeHtml(path)
    const html = highlightLine(text, language)
    if (mode === 'split') {
      return `<tr class="diff-row" data-pair-kind="context" data-expanded="1">` +
        `<td class="diff-no diff-no-old" data-side="old" data-line="${oldLine}" data-path="${pathAttr}">${oldLine}</td>` +
        `<td class="diff-text diff-context" data-side="old" data-line="${oldLine}" data-path="${pathAttr}" data-sha="${sha}"><span class="diff-marker"> </span><span class="diff-line">${html}</span></td>` +
        `<td class="diff-no diff-no-new" data-side="new" data-line="${newLine}" data-path="${pathAttr}">${newLine}</td>` +
        `<td class="diff-text diff-context" data-side="new" data-line="${newLine}" data-path="${pathAttr}" data-sha="${sha}"><span class="diff-marker"> </span><span class="diff-line">${html}</span></td>` +
      `</tr>`
    }
    if (isMobileDiffView()) {
      // Mobile inline: single text col, no gutter cells (see
      // renderHunkInline mobile branch for the matching primary-row shape).
      return `<tr class="diff-row" data-pair-kind="context" data-expanded="1">` +
        `<td class="diff-text diff-context" data-side="new" data-line="${newLine}" data-path="${pathAttr}" data-sha="${sha}"><span class="diff-marker"> </span><span class="diff-line">${html}</span></td>` +
      `</tr>`
    }
    return `<tr class="diff-row" data-pair-kind="context" data-expanded="1">` +
      `<td class="diff-no diff-no-old" data-side="old" data-line="${oldLine}" data-path="${pathAttr}">${oldLine}</td>` +
      `<td class="diff-no diff-no-new" data-side="new" data-line="${newLine}" data-path="${pathAttr}">${newLine}</td>` +
      `<td class="diff-text diff-context" colspan="2" data-side="new" data-line="${newLine}" data-path="${pathAttr}" data-sha="${sha}"><span class="diff-marker"> </span><span class="diff-line">${html}</span></td>` +
    `</tr>`
  }

  // Fetch + splice handler. Reads everything it needs from the button's
  // data-* attrs so the function stays free of closures over hunk state —
  // expanded rows mutate the DOM but not state.diff, and a fresh renderBody
  // (filter toggle, view switch) is the natural reset.
  async function expandContext(btn) {
    if (btn.disabled) return
    const direction = btn.dataset.expandDirection
    const path  = btn.dataset.path
    const ref   = btn.dataset.ref
    const sha   = btn.dataset.sha
    const mode  = btn.dataset.mode
    const language = btn.dataset.lang || ''
    const offset = Number(btn.dataset.oldNewOffset) || 0

    let anchor, floor = null, ceiling = null
    if (direction === 'up') {
      anchor = Number(btn.dataset.targetLine)
      floor  = Number(btn.dataset.floorLine) || 1
    } else {
      anchor = Number(btn.dataset.anchorLine)
      const tot = Number(btn.dataset.totalLines)
      ceiling = Number.isFinite(tot) && tot > 0 ? tot : null
    }
    if (!Number.isFinite(anchor) || anchor < 1) return

    const range = computeExpandRange(direction, anchor, floor, ceiling, EXPAND_CHUNK_SIZE)
    if (!range) return

    btn.disabled = true
    let payload
    try {
      const url = `/api/repos/${encodeURIComponent(repo.id)}/file-lines` +
        `?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}` +
        `&start=${range.start}&end=${range.end}`
      payload = await api(url)
    } catch (e) {
      btn.disabled = false
      toast('Expand failed: ' + (e.message || 'unknown'))
      return
    }
    btn.disabled = false

    if (payload.binary || payload.missing) {
      toast(payload.binary ? 'Cannot expand: binary file' : 'Cannot expand: file not found at ref')
      // Remove the affordance so the user doesn't keep clicking — the
      // underlying condition won't resolve without a fresh diff payload.
      btn.closest('tr.diff-row-expand-down')?.remove()
      btn.style.visibility = 'hidden'
      return
    }

    const lines = payload.lines || []
    if (!lines.length) {
      // Nothing came back (probably hit EOF or empty file). Retire the
      // button so it stops advertising an action that does nothing.
      btn.closest('tr.diff-row-expand-down')?.remove()
      if (direction === 'up') btn.style.visibility = 'hidden'
      // Keyboard users can't see the footer row disappear if it was
      // off-screen — surface a brief toast so the keystroke isn't
      // experienced as a no-op. (Mouse users already have the affordance
      // visibly retire under their cursor.)
      toast(direction === 'up' ? 'Top of file reached' : 'End of file reached')
      renderKeymapHint()
      return
    }

    const rowsHtml = lines.map((text, i) => {
      const newLine = payload.start + i
      const oldLine = newLine + offset
      return renderContextRowHtml({ text, oldLine, newLine, path, sha, language, mode })
    }).join('')
    const tmp = document.createElement('tbody')
    tmp.innerHTML = rowsHtml
    const newRows = Array.from(tmp.children)

    if (direction === 'up') {
      // Splice rows BEFORE the hunk-head that owns this button. The hunk
      // header itself stays put — its @@ meta still describes the next
      // hunk's actual changes; only the un-rendered gap above gets filled.
      const headRow = btn.closest('tr.diff-row-hunk')
      if (!headRow) return
      for (const r of newRows) headRow.parentNode.insertBefore(r, headRow)
      const nextTarget = payload.start - 1
      if (nextTarget < floor) {
        btn.style.visibility = 'hidden'
      } else {
        btn.dataset.targetLine = String(nextTarget)
      }
    } else {
      // Splice rows BEFORE the expand-down row, so the button keeps
      // hovering at the bottom for another click.
      const footRow = btn.closest('tr.diff-row-expand-down')
      if (!footRow) return
      for (const r of newRows) footRow.parentNode.insertBefore(r, footRow)
      const nextAnchor = payload.end + 1
      const total = payload.total_lines || 0
      btn.dataset.anchorLine = String(nextAnchor)
      btn.dataset.totalLines = String(total)
      if (total && nextAnchor > total) footRow.remove()
    }
    // Hint bar may need to drop `e` / `E` now that this direction's
    // target retired (button hidden / footer removed). Cheap DOM walk;
    // safe to call on every successful expand.
    renderKeymapHint()
  }

  // Click delegation: relate-filter buttons, reviewed banner, collapse toggle.
  $('[data-body]').addEventListener('click', (e) => {
    // Expand-context buttons get top-priority routing. They're nested in
    // hunk-head / expand-down rows that don't have any of the other
    // delegated targets, but stopPropagation keeps future handlers honest.
    const expandBtn = e.target.closest?.('.diff-expand-btn')
    if (expandBtn) {
      e.preventDefault(); e.stopPropagation()
      expandContext(expandBtn)
      return
    }

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

    // Counts-strip total → resume the last-opened thread when it lives in
    // the current view, or fall back to the first thread in that view's
    // document order. Resolved at click-time (not render-time) because
    // the inline thread rows aren't in the DOM yet when renderReviewBanner
    // runs — see the comment on `data-show-first-thread` in
    // renderCountsPills.
    if (e.target.closest('[data-show-first-thread]')) {
      if (window.getSelection?.()?.toString().trim()) return
      e.preventDefault(); e.stopPropagation()
      // Resume is *unresolved-only* — the button surfaces outstanding work,
      // not the full backlog. Cursor pointing at a resolved thread (user
      // resolved it then closed the modal) falls through to "first
      // unresolved", which matches the user's intent: walk the next thing
      // that needs attention. Inline `.diff-thread-body` clicks still use
      // the unfiltered order, so revisiting a resolved thread is one click
      // away on the diff itself.
      const order = computeUnresolvedThreadOrderInCurrentView()
      if (order.length === 0) return  // button is hidden in this case; guard anyway
      const cursor = getResumeCursor()
      const resumeId = cursor && order.includes(cursor) ? cursor : null
      const target = resumeId || order[0]
      if (target) openThread(target, { threadOrder: order })
      return
    }

    // Sibling of data-show-first-thread for the resolved walk. Always starts
    // at the first resolved thread (no resume cursor): revisiting closed
    // work isn't a task-tracking activity, so picking up "where I left off
    // among the resolved" isn't a useful concept.
    if (e.target.closest('[data-show-first-resolved-thread]')) {
      if (window.getSelection?.()?.toString().trim()) return
      e.preventDefault(); e.stopPropagation()
      const order = computeResolvedThreadOrderInCurrentView()
      if (order.length === 0) return
      openThread(order[0], { threadOrder: order })
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
    closeSymbolPanel()
    syncUrl()
    await load()
  }

  // ------------------------------------------------------------------
  // Reviewed-batches (Full diff only)
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // Auto-review-on-scroll observer. Watches each `.diff-file` section
  // through an IntersectionObserver rooted at the scroll container. A
  // section transitioning from "not above the viewport" to "fully above
  // the viewport" is what we count as "user scrolled past it." On that
  // edge, we collapse the file with scrollTop compensation (so the
  // viewport content doesn't visibly jump) and call toggleFileReviewed
  // to persist the mark. Always-on behavior: no user toggle.
  //
  // Lifecycle: torn down and rebuilt on each renderBody (since innerHTML
  // wipes the .diff-file nodes the observer was holding), and torn down
  // in the global dispose() path.
  // ------------------------------------------------------------------
  let autoReviewObserver = null
  // Per-path prior "is above viewport" state. The IntersectionObserver
  // fires once on observe() with the current state of every section, and
  // we don't want that initial batch to mass-mark every file currently
  // above a thread-anchored landing point. Seeding this map on the first
  // fire (and only acting on transitions afterward) gives us "real scroll
  // past" semantics.
  let autoReviewWasAbove = new Map()

  function teardownAutoReviewObserver() {
    if (autoReviewObserver) {
      try { autoReviewObserver.disconnect() } catch {}
      autoReviewObserver = null
    }
    autoReviewWasAbove = new Map()
  }

  function setupAutoReviewObserver() {
    teardownAutoReviewObserver()
    const body = $('[data-body]')
    if (!body) return
    autoReviewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const section = entry.target
        const path = section.dataset.path
        if (!path) continue
        const rootTop = entry.rootBounds?.top ?? 0
        const isAbove = entry.boundingClientRect.bottom < rootTop
        const was = autoReviewWasAbove.get(path)
        autoReviewWasAbove.set(path, isAbove)
        // Skip the seeding fire so a mid-page landing doesn't auto-mark
        // every section already above the viewport.
        if (was === undefined) continue
        // Only act on the "was below or visible, now fully above" edge.
        // Scrolling back up (above to visible) is a no-op: the user is
        // re-reading, not finishing.
        if (!was && isAbove && shouldAutoMarkReviewed(path)) {
          autoCollapseOffscreen(section, body)
          toggleFileReviewed(path)
        }
      }
    }, { root: body, threshold: 0 })
    body.querySelectorAll('.diff-file[data-path]').forEach((s) => autoReviewObserver.observe(s))
  }

  /**
   * Collapse a file section that lives above the current viewport, then
   * shrink body.scrollTop by the same delta. The file is off-screen above
   * us: collapsing it (display:none on .diff-file-body) yanks every
   * visible row upward by the body's height. Subtracting the delta from
   * scrollTop cancels the shift, so the user sees no jump. They'll see
   * the file as collapsed only when they scroll back up.
   *
   * Skips if already collapsed (idempotent: the observer can re-fire
   * across renderBody rebuilds even though we seed `was` from undefined).
   */
  function autoCollapseOffscreen(section, body) {
    const path = section.dataset.path
    if (!path || state.collapsedPaths.has(path)) return
    const before = section.getBoundingClientRect().height
    state.collapsedPaths.add(path)
    section.classList.add('is-collapsed')
    const after = section.getBoundingClientRect().height
    const delta = before - after
    if (delta > 0) body.scrollTop = Math.max(0, body.scrollTop - delta)
    // Mirror the click-handler's a11y attribute updates so the chevron's
    // expanded/collapsed state is honest for screen readers.
    const btn = section.querySelector('.diff-file-toggle')
    if (btn) {
      btn.setAttribute('aria-expanded', 'false')
      btn.setAttribute('aria-label', `Expand file ${path}`)
    }
  }

  /**
   * Gate for the auto-mark-on-scroll path. Mirrors the rules enforced by
   * the header-click handler at `[data-toggle-collapse]`, except we fail
   * silently here (no toast). The click handler's toasts exist because
   * the user invoked the gesture and expects feedback when it refuses;
   * the scroll path is ambient, so a barrage of toasts as the user
   * scrolls past blocked files would be noise.
   *
   * Return true iff every gate passes:
   *   1. The current view supports reviewed marks (Full or Commit, not
   *      Local). Local has no stable blob to pin a mark against.
   *   2. The file is not already in state.reviewed (no-op otherwise).
   *   3. There are no unresolved threads on this file
   *      (unresolvedThreadCountFor returns 0).
   *   4. In commit view, the file's blob at this commit equals its blob
   *      at HEAD: `state.diff.files[*].is_unchanged_since_commit !==
   *      false`. Full + Local payloads leave this flag undefined; strict
   *      `=== false` is the guard.
   */
  function shouldAutoMarkReviewed(path) {
    if (!path) return false
    if (state.reviewed.has(path)) return false
    const isFull   = isFullIndex(state.index)
    const isCommit = isCommitIndex(state.index)
    if (!isFull && !isCommit) return false
    if (unresolvedThreadCountFor(path) > 0) return false
    if (isCommit) {
      const file = state.diff?.files?.find((f) => f.path === path)
      if (file && file.is_unchanged_since_commit === false) return false
    }
    return true
  }

  /**
   * Targeted DOM mutation for one file's reviewed/unreviewed transition.
   * Just flips `.is-reviewed` on the section (drives the green-wash
   * header tint) and refreshes the review banner so the "N of T
   * remaining" summary stays in sync. Collapse class is owned by the
   * header click handler, not touched here.
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

  /**
   * Auto-mark files reviewed when the user resolves their last open
   * thread, mirroring the manual click-the-header gesture. Runs against
   * a freshly-arrived /resolve response so we can spot the open→resolved
   * transition before state.threads gets clobbered by loadThreads.
   *
   * Gates (must match the manual flow in the click handler above):
   *   - View: only Full + commit. Local view doesn't pin to a stable
   *     blob, so the persisted mark would have no anchor.
   *   - Existing: skip files already in state.reviewed (idempotent).
   *   - In-view: file must be in state.diff.files for the current view.
   *     A thread resolved on a Local-only file (or a file outside the
   *     current commit's diff) gets no auto-mark from this view — the
   *     user can navigate to a view where the file IS visible and the
   *     gate is satisfiable, and mark it manually.
   *   - Later-changes: in commit view, file.is_unchanged_since_commit
   *     must be true. Same toast-on-block rule as the manual click —
   *     except here we just silently skip, since the user didn't
   *     directly request the mark (and a noisy toast on every resolve
   *     would be the wrong default).
   *
   * Batched into a single PUT with mode=add so two concurrent resolves
   * (e.g. rapid keyboard navigation) can't race two replace-writes
   * against the sidecar and lose one of them.
   */
  function autoMarkOnLastResolve(res) {
    if (!res?.threads) return
    const isFull   = isFullIndex(state.index)
    const isCommit = isCommitIndex(state.index)
    if (!isFull && !isCommit) return
    const sha = branchInfo?.head_sha
    if (!sha) return

    // Files where SOME thread just transitioned open → resolved. Filters
    // out delete/reply mutations: a delete that empties a file's thread
    // list isn't an "I'm done with this file" gesture in the same way
    // resolving is, so we don't auto-mark on it.
    const wasResolvedById = new Map((state.threads || []).map((t) => [t.id, !!t.resolved_at]))
    const justResolvedFiles = new Set()
    for (const t of res.threads) {
      if (!t.file) continue
      if (!wasResolvedById.get(t.id) && t.resolved_at) justResolvedFiles.add(t.file)
    }
    if (!justResolvedFiles.size) return

    // Per-file open-thread count in the NEW state. Files still carrying
    // an open thread aren't candidates — the user has more work left
    // there before "reviewed" is honest.
    const openByFile = new Map()
    for (const t of res.threads) {
      if (!t.file || t.resolved_at) continue
      openByFile.set(t.file, (openByFile.get(t.file) || 0) + 1)
    }

    const toMark = []
    for (const file of justResolvedFiles) {
      if ((openByFile.get(file) || 0) > 0) continue
      if (state.reviewed.has(file)) continue
      const f = state.diff?.files?.find((x) => x.path === file)
      if (!f) continue
      if (isCommit && f.is_unchanged_since_commit === false) continue
      toMark.push(file)
    }
    if (!toMark.length) return

    // Optimistic local update first so the trailing loadThreads →
    // renderBody picks up the new state.reviewed in its repaint — the
    // green wash + auto-collapse appear without a second render cycle.
    const prev = new Set(state.reviewed)
    const next = new Set(state.reviewed)
    for (const p of toMark) { next.add(p); state.collapsedPaths.add(p) }
    state.reviewed    = next
    state.reviewedSha = sha

    api(`/api/repos/${encodeURIComponent(repo.id)}/reviewed`, {
      method: 'PUT',
      body: JSON.stringify({ head_sha: sha, paths: toMark, mode: 'add' }),
    }).catch((e) => {
      state.reviewed = prev
      for (const p of toMark) state.collapsedPaths.delete(p)
      toast('Auto-mark reviewed failed: ' + (e.message || 'unknown'))
      renderBody()
    })
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

    // Pills live in the right cluster of the controls row, in front of
    // any filter-state content. They render in resting AND filter states
    // so the count surface stays visible regardless of which filter is
    // active — same behaviour as when they had their own row above,
    // just visually merged into the single controls strip.
    const pillsHtml = renderCountsPills()

    // Filter-state content (label + dismiss) trails the pills in the
    // right cluster. `variant` carries the banner-shell class so the
    // active filter colour ribbon paints the left border.
    let variant = 'is-summary'
    let filterHtml = ''

    if (filterKind === 'file') {
      // Thread-context single-file view. "← Back to thread" clears the
      // filter and reopens the modal same-page (see [data-back-to-thread]
      // handler). No "Viewing: <path>" label — the file path is already
      // displayed in big mono at the top of the file section right below.
      // If the URL didn't carry a thread id, fall back to plain "Show all".
      const threadId = state.filter.threadId || ''
      filterHtml = threadId
        ? `<button type="button" class="diff-filter-clear" data-back-to-thread data-thread-id="${escapeHtml(threadId)}">← Back to thread</button>`
        : '<button type="button" class="diff-filter-close" data-clear-filter aria-label="Show all" title="Show all">×</button>'
      variant = 'is-filter is-filter-file'
    } else if (filterKind === 'related' && isFull) {
      const filterAnchor = state.filter.anchor
      variant = 'is-filter'
      filterHtml =
        `<span class="diff-review-label">Filter: related to <code>${escapeHtml(filterAnchor)}</code> · ${visibleCount} file${visibleCount === 1 ? '' : 's'}</span>` +
        '<button type="button" class="diff-filter-close" data-clear-filter aria-label="Show all" title="Show all">×</button>'
    }

    const rightInner = pillsHtml + filterHtml
    const rightHtml = rightInner
      ? `<div class="diff-review-right">${rightInner}</div>`
      : ''

    const controlsRow = '<div class="diff-review-controls">' + viewToggle + rightHtml + '</div>'
    return `<div class="diff-review-banner ${variant}">${controlsRow}</div>`
  }

  /**
   * Threads belonging to the current view, using the same rule as the
   * inline painter (paintInlineThreads): in commit view, only threads
   * anchored against THIS commit (`view === 'commit'` AND matching sha);
   * in Full or Local, every thread (those views render any thread whose
   * anchor cell exists in the DOM, so the count surface mirrors them).
   * Centralised so the counts-strip display and the bulk-delete action
   * driven by its × button can't disagree about what "the current view"
   * means — a single change to the rule lands in one place.
   */
  function threadsInCurrentView() {
    const all = state.threads || []
    if (!isCommitIndex(state.index)) return all
    const sha = state.commits[state.index]?.sha
    return all.filter((t) => (t.view || 'full') === 'commit' && t.sha === sha)
  }

  /**
   * Pills cluster injected into the controls row's right side. Three
   * `state-pill is-count` chips, ordered left-to-right:
   *
   *   "N threads →"   (when this view has threads)
   *     → opens the resume cursor (or first thread when the cursor is
   *     missing / out-of-view). Position indicator lives in the icon's
   *     tooltip, not the label, to keep the pill visually parallel.
   *
   *   "N replies ×"   (when this view has threads)
   *     Total comments by anyone else (LLM agent replies, etc.); ×
   *     bulk-deletes the last reply of every multi-comment thread in
   *     scope. The × only renders when there's at least one reply.
   *
   *   "Y/T reviewed ×" (Full / per-commit only, when ≥1 file marked)
   *     Y = files marked in this view, T = view's total file count. ×
   *     triggers confirmResetReviewed scoped to this view (Full → all
   *     marks branch-wide; commit → marks for files visible here).
   *
   * Thread-group scope mirrors the inline painter (paintInlineThreads):
   * in commit view we count only threads anchored against THIS commit.
   * Returns '' when both groups are empty so the caller can decide
   * whether to render the right-cluster wrapper at all. Resolved-thread
   * count is intentionally omitted (the inline thread row's left ribbon
   * surfaces per-thread state, and the threads pill's → covers the
   * headline open).
   */
  function renderCountsPills() {
    const allThreads = state.threads || []
    const threads = allThreads.length ? threadsInCurrentView() : []
    const hasThreads = threads.length > 0

    const isFull   = isFullIndex(state.index)
    const isCommit = isCommitIndex(state.index)
    const totalFiles = state.diff?.files?.length || 0
    const reviewedInView = (isFull || isCommit) && totalFiles
      ? (state.diff?.files || []).filter((f) => state.reviewed.has(f.path)).length
      : 0
    const hasReviewedPill = reviewedInView > 0

    if (!hasThreads && !hasReviewedPill) return ''

    let threadsPill  = ''
    let resolvedPill = ''
    let repliesPill  = ''
    if (hasThreads) {
      let revieweeMsgs = 0
      for (const t of threads) {
        for (const c of (t.comments || [])) {
          if (c.user !== 'reviewer') revieweeMsgs++
        }
      }
      // Threads pill (leading): visible label is the *total* count; the
      // trailing → link icon resumes the *unresolved* walk. Two distinct
      // numbers in one pill is intentional — the count is the headline
      // ("how many threads exist in this view?") while the action is
      // task-oriented ("walk what still needs attention"). Position
      // (`N of M`) lives in the tooltip and is scoped to the unresolved
      // order so the modal's "N of M" label stays in lockstep. When the
      // resume cursor points at a resolved thread, indexOf returns -1,
      // +1 lands at 0, and the title degrades to "Open the first
      // unresolved thread". Resolution is deferred to click-time via
      // the data-show-first-thread sentinel — eager id stamping here
      // would go stale if state.threads mutates between render and
      // click.
      const unresolvedOrder = computeUnresolvedThreadOrderInCurrentView()
      const cursor = getResumeCursor()
      const resumePos = cursor ? unresolvedOrder.indexOf(cursor) + 1 : 0
      const totalTitle = resumePos > 0
        ? `Resume unresolved thread ${resumePos} of ${unresolvedOrder.length}`
        : 'Open the first unresolved thread'
      // Drop the → button entirely when nothing's outstanding. Inline
      // thread-body clicks remain the way to revisit resolved threads.
      const totalLinkBtn = unresolvedOrder.length > 0
        ? `<button type="button" class="state-pill-link" data-show-first-thread ` +
          `aria-label="${escapeHtml(totalTitle)}" title="${escapeHtml(totalTitle)}">→</button>`
        : ''
      // Label tracks the *action* (Resume walks unresolved only), not the
      // raw total — keeps the headline and the → button telling the same
      // story. Total count is still discoverable via the per-file pills
      // in the diff body and the inline thread row state ribbons. The
      // wrapper `title=` keeps the total one hover away for power users.
      // Zero-count pills are hidden entirely (consistent with the resolved
      // and reviewed pills below): no count, no pill.
      if (unresolvedOrder.length > 0) {
        const totalTooltip = `${threads.length} thread${threads.length === 1 ? '' : 's'} total in this view`
        const openLabel = `${unresolvedOrder.length} open`
        threadsPill = `<span class="state-pill is-count" title="${escapeHtml(totalTooltip)}">${openLabel}${totalLinkBtn}</span>`
      }

      // Sibling pill for the resolved walk. Symmetric to the open one but
      // stateless: no resume cursor (revisiting closed work isn't task-
      // tracked). Hidden when there's nothing resolved in this view.
      const resolvedOrder = computeResolvedThreadOrderInCurrentView()
      if (resolvedOrder.length > 0) {
        const resolvedTitle = `Walk ${resolvedOrder.length} resolved thread${resolvedOrder.length === 1 ? '' : 's'} in this view`
        const resolvedLinkBtn =
          `<button type="button" class="state-pill-link" data-show-first-resolved-thread ` +
          `aria-label="${escapeHtml(resolvedTitle)}" title="${escapeHtml(resolvedTitle)}">→</button>`
        const resolvedLabel = `${resolvedOrder.length} resolved`
        resolvedPill = `<span class="state-pill is-count" title="${escapeHtml(resolvedTitle)}">${resolvedLabel}${resolvedLinkBtn}</span>`
      }

      // × inside the reviewee-replies pill triggers a bulk-delete of the
      // *last reply* of every multi-comment thread, scoped to the current
      // view (see confirmBulkDeleteLastReplies). Only shown when there
      // are replies to delete.
      const repliesScopeText = isCommit
        ? 'Delete the last reply from every thread in this commit'
        : 'Delete the last reply from every thread'
      // Same zero-gate as the open / resolved pills above.
      if (revieweeMsgs > 0) {
        const repliesClearBtn =
          `<button type="button" class="state-pill-x" data-clear-replies aria-label="${escapeHtml(repliesScopeText)}" title="${escapeHtml(repliesScopeText)}">×</button>`
        repliesPill = `<span class="state-pill is-count">${revieweeMsgs} repl${revieweeMsgs === 1 ? 'y' : 'ies'}${repliesClearBtn}</span>`
      }
    }

    let reviewedPill = ''
    if (hasReviewedPill) {
      // × is view-sensitive: in Full it clears every mark on the branch;
      // in commit view it only clears marks on files visible right here.
      // Tooltip + aria-label tell the truth either way so the gesture
      // isn't a surprise.
      const resetAria  = isFull ? 'Clear all reviewed marks' : 'Clear reviewed marks in this commit'
      const resetTitle = isFull
        ? 'Clear all reviewed marks across the branch'
        : `Clear ${reviewedInView} reviewed mark${reviewedInView === 1 ? '' : 's'} in this commit`
      const resetBtn = `<button type="button" class="state-pill-x" data-reset-reviewed aria-label="${escapeHtml(resetAria)}" title="${escapeHtml(resetTitle)}">×</button>`
      reviewedPill = `<span class="state-pill is-count">${reviewedInView}/${totalFiles} reviewed${resetBtn}</span>`
    }

    // Order: open threads (resume) → resolved threads (revisit walk)
    // → replies → reviewed. Open leads as the most actionable action;
    // resolved sits next to it per the user-facing "open / resolved"
    // pairing; reviewed trails as a passive progress indicator.
    return threadsPill + resolvedPill + repliesPill + reviewedPill
  }

  /**
   * Bulk-delete the latest reply from every thread *in the current view*
   * that has more than one comment. Scope follows threadsInCurrentView
   * so the count next to the × pill and the action triggered by it can't
   * drift apart. Threads with a single comment (the initial reviewer
   * message with no follow-up) are left untouched. Drops one comment per
   * thread — never deletes a whole thread, since by definition the
   * targets all have at least 2 comments remaining after the delete.
   *
   * Each DELETE is issued in parallel via Promise.allSettled — thread
   * files are independent on disk (separate JSON files per thread), so
   * there's no cross-thread contention to serialise around. `allSettled`
   * (not `all`) keeps a single network or file-system hiccup from aborting
   * the rest of the batch; partial-success reporting via toast tells the
   * user exactly what happened.
   */
  function confirmBulkDeleteLastReplies() {
    // Scope must match the count + × button copy rendered by
    // renderCountsPills — both surfaces flow through threadsInCurrentView
    // so a "2 replies ×" pill in commit view deletes exactly those 2.
    const inView = threadsInCurrentView()
    const targets = []
    for (const t of inView) {
      const comments = t.comments || []
      if (comments.length <= 1) continue
      targets.push({ tid: t.id, cid: comments[comments.length - 1].id })
    }
    if (!targets.length) {
      toast.ok('No replies to delete')
      return
    }
    const count = targets.length
    const scope = isCommitIndex(state.index) ? ' in this commit' : ''
    const detail = `Removes the most recent reply from ${count} thread${count === 1 ? '' : 's'}${scope}. Threads with no replies are unaffected. This can't be undone.`
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
    // Bookend buttons disable when already pinned at the target. The
    // Full-diff button stays active in the Local view, so the user has a
    // one-click path back from Local without retracing through prev.
    $('[data-first]').disabled = state.index <= 0
    $('[data-last]').disabled  = state.index === state.commits.length
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
      // Position label gets abbreviated on mobile so it fits next to the
      // nav pill without forcing the meta block to wrap or truncate
      // harder. Re-read viewport on every refresh: it's cheap and stays
      // honest across DevTools-driven viewport flips.
      const narrow = window.matchMedia('(max-width: 768px)').matches
      $('[data-position]').textContent = narrow ? 'Full' : 'Full diff'
      const headSha = fd?.sha || branchInfo?.head_sha || ''
      shaEl.textContent     = 'FULL'
      shaEl.dataset.shaFull = headSha
      const baseRef = branchInfo?.base_branch || ''
      const headRef = state.branch || ''
      // When on the base branch, `current === base` so `main ← main` would
      // be misleading — the actual diff base is the empty-tree SHA (the
      // on-base review fallback in `getBranchInfo`). Surface the branch +
      // a neutral 'review' label instead.
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
    // Per-commit-only "later changes" counter: number of files whose blob
    // at this commit no longer matches HEAD. is_unchanged_since_commit is
    // only populated on commit-diff payloads (see server/git.js), and
    // strict `=== false` is the flagged shape; undefined means "not
    // applicable" (Full/Local diffs).
    const laterCount = (fd?.files || []).filter((f) => f.is_unchanged_since_commit === false).length
    const laterSuffix = laterCount > 0 ? ` (${laterCount} has later changes)` : ''
    $('[data-stats]').textContent    =
      `+${c.additions ?? 0} −${c.deletions ?? 0} in ${c.changed_files ?? 0} file${(c.changed_files ?? 0) === 1 ? '' : 's'}${laterSuffix}`
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
    // Per-file thread counts (total + still-open). Computed once before
    // the map so renderFileSection doesn't re-walk state.threads per call
    // — single O(threads) pass instead of O(files × threads).
    const threadCountByFile = new Map()
    const openCountByFile   = new Map()
    for (const t of state.threads || []) {
      if (!t.file) continue
      threadCountByFile.set(t.file, (threadCountByFile.get(t.file) || 0) + 1)
      if (!t.resolved_at) openCountByFile.set(t.file, (openCountByFile.get(t.file) || 0) + 1)
    }
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
      // Pick the ref the expand-context endpoint reads unchanged lines
      // from. Local view has no ref for its new side — the working tree
      // *is* the new side — so we pass 'WORKTREE' (the server branches
      // to fs.readFile for that sentinel). Full + Commit both use the
      // diff's `sha` (head_sha and the commit's sha respectively).
      const newRef = isLocal ? 'WORKTREE' : (state.diff.sha || null)
      return renderFileSection(f, state.mode, state.diff.sha, {
        isReviewed: state.reviewed.has(f.path),
        isCollapsed: state.collapsedPaths.has(f.path),
        showRelateBtn,
        isFilterAnchor: filterAnchor === f.path,
        priorityEntry: priorities?.[f.path] || null,
        relationship,
        anchorPath: filterAnchor,
        threadCount: threadCountByFile.get(f.path) || 0,
        openThreadCount: openCountByFile.get(f.path) || 0,
        newRef,
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
    // The innerHTML swap above wiped the .diff-file nodes the auto-review
    // observer was holding. Re-attach (or stay torn down if the feature
    // is off). No-op cost when off.
    setupAutoReviewObserver()
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

  // One-shot scroll: when the user lands on a `?file=…&thread=…` URL or
  // navigates between threads in the modal, this fires after the first
  // successful body render. Auto-uncollapses the file if needed, scrolls
  // the matching cell into view, flashes briefly. After firing once it
  // nulls out scrollToAnchor so subsequent renders (split↔inline toggle,
  // etc.) don't keep scrolling.
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

    if (!state.threads.length) {
      // Empty-threads early return still needs to refresh the hint —
      // otherwise a `d delete thread` item lingers after the last thread
      // is deleted. The trailing render at the bottom of this function
      // covers the splice path but is unreachable here.
      renderKeymapHint()
      return
    }
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
    // After thread DOM mutates, the cursor-dependent `d delete thread`
    // hint item can appear or disappear without the cursor moving — refresh
    // so the bar tracks the visible state.
    renderKeymapHint()
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
    //
    // `(old)` side badge: `thread.side` is per-thread, but the inline block
    // has no thread-level header — so it rides in the FIRST comment's meta
    // row only (idx === 0). Slots before the auto-margin edit/remove
    // cluster, so the buttons stay flush right and the badge tucks next
    // to the timestamp without adding a new row. New-side is the default,
    // so we don't label it.
    const commentsHtml = (thread.comments || [])
      .map(
        (c, idx) => {
          const sideTag = idx === 0 && thread.side === 'old'
            ? '<span class="diff-thread-side">(old)</span>'
            : ''
          return `
        <div class="diff-thread-comment" data-comment-id="${escapeHtml(c.id)}">
          <div class="diff-thread-meta">
            <span class="diff-thread-user">@${escapeHtml(c.user)}</span>
            <span class="diff-thread-when">${escapeHtml(relTime(c.posted_at || c.created_at))}</span>
            ${sideTag}
            <button type="button" class="diff-thread-edit" data-edit-comment data-comment-id="${escapeHtml(c.id)}" data-thread-id="${escapeHtml(thread.id)}" aria-label="Edit comment" title="Edit comment">✎</button>
            <button type="button" class="diff-thread-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" data-thread-id="${escapeHtml(thread.id)}" aria-label="Remove comment" title="Remove comment">×</button>
          </div>
          <div class="diff-thread-body" data-body data-show-thread="${escapeHtml(thread.id)}" role="button">${inlineCode(c.body)}</div>
        </div>`
        }
      )
      .join('')

    tr.innerHTML =
      `<td${isMobileDiffView() ? '' : ' colspan="4"'} class="diff-thread-cell">` +
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
   * Order ALL threads on the branch by (file, line, id) — view-agnostic
   * and DOM-independent. Used both for the counts-strip total fallback
   * ("which thread is 'first' when there's no cursor") and as the
   * modal's prev/next walk order. The earlier rendered-DOM-walk
   * implementation put threads visible in the current view at the
   * front, which made "click total" land on the topmost rendered
   * thread — usually NOT what the user expects after a cold launch,
   * because the default per-commit view typically only renders a
   * subset of the branch's threads, leaving the rest in the orphan
   * tail. Now that auto-view-switching (in openThread) jumps the diff
   * to each thread's natural view on navigate, the visual-congruence
   * argument for rendered-first ordering no longer holds — threads
   * have a stable position across views (their anchor coordinate),
   * and walking by that anchor is the most predictable reader order.
   * File priority sorting (compareForReview) still drives the diff
   * view's file rendering, but is intentionally NOT applied here:
   * priorities are a "what to focus my eye on" signal, while thread
   * order is a "what order to visit comments in" signal. The `id`
   * tiebreaker keeps the sort fully deterministic when two threads
   * share an exact (file, line) anchor.
   */
  function computeThreadOrderInclusive() {
    return [...state.threads]
      .filter((t) => t.id)
      .sort((a, b) => {
        const fa = a.file || ''
        const fb = b.file || ''
        if (fa !== fb) return fa.localeCompare(fb)
        const la = Number(a.line) || 0
        const lb = Number(b.line) || 0
        if (la !== lb) return la - lb
        return (a.id || '').localeCompare(b.id || '')
      })
      .map((t) => t.id)
  }

  /**
   * Same order as Inclusive, restricted to threads belonging to the
   * current view (see threadsInCurrentView). Drives the thread modal's
   * prev/next walk and the counts-strip resume-position label so both
   * surfaces agree on "the N threads in this view" — without this, the
   * modal opens claiming "1 of 7" while the counts strip said "1 of 5".
   * In Full / Local this collapses back to Inclusive (no scope), so the
   * pre-existing branch-wide walk in those views is preserved.
   */
  function computeThreadOrderInCurrentView() {
    const inView = new Set(threadsInCurrentView().map((t) => t.id))
    return computeThreadOrderInclusive().filter((id) => inView.has(id))
  }

  /**
   * Same order as computeThreadOrderInCurrentView, filtered to threads
   * whose state is not 'resolved'. Powers the counts-strip Resume button
   * (data-show-first-thread) so it only walks outstanding work — inline
   * `.diff-thread-body` clicks still use the unfiltered order so a
   * deliberate revisit of a resolved thread is one click away.
   *
   * Captured once at modal-open time. Resolving a thread mid-walk does
   * NOT shrink the captured order (matches how the all-threads order
   * behaves — only delete splices, see modals.js adjacentThreadId). The
   * walk stays predictable for the session; the *next* time the user
   * clicks Resume, the recomputed order reflects the new resolved state.
   */
  function computeUnresolvedThreadOrderInCurrentView() {
    const byId = new Map(state.threads.map((t) => [t.id, t]))
    return computeThreadOrderInCurrentView().filter((id) => {
      const t = byId.get(id)
      return t && (t.state || 'awaiting') !== 'resolved'
    })
  }

  // Symmetric to the unresolved variant: powers the "X resolved threads"
  // pill in the controls strip. Same document order; opposite predicate.
  function computeResolvedThreadOrderInCurrentView() {
    const byId = new Map(state.threads.map((t) => [t.id, t]))
    return computeThreadOrderInCurrentView().filter((id) => {
      const t = byId.get(id)
      return t && (t.state || 'awaiting') === 'resolved'
    })
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
   *
   * `opts.threadOrder` overrides the default all-threads-in-view walk —
   * used by the counts-strip Resume button to restrict navigation to
   * unresolved threads. When omitted, the modal walks every thread in
   * the current view (the historical default for inline-row clicks and
   * URL-driven reopens).
   */
  function openThread(tid, opts = {}) {
    if (!tid) return
    // Stamp the resume cursor first — the counts-strip total reads this
    // on its next click. Captured here (and again in onNavigate below)
    // so every transition into the modal updates the bookmark, including
    // auto-advance-after-resolve and auto-advance-after-delete (both
    // route through onNavigate). setResumeCursor persists the cursor to
    // state.json (via patchRepoUiState → /api/repos/:id/ui-state) so the
    // bookmark survives a page reload — the user's flow is "close modal,
    // refresh, click total to resume", which depends on the cursor
    // outliving the in-memory state object.
    setResumeCursor(tid)
    // The diff body stays in whatever view the user clicked from — no
    // on-open swap, no on-navigate swap. The modal is a read-and-walk
    // overlay; it never rewrites the URL or reloads the diff. Threads
    // in the captured order whose anchor cell isn't rendered in the
    // current view still open in the modal (comments are readable);
    // jumpToThreadAnchor surfaces the existing "anchor lost" toast in
    // that case instead of teleporting the user across views.
    openThreadModal(tid, {
      repoId: repo.id,
      getThread: (id) => state.threads.find((t) => t.id === id),
      // Lets the modal upgrade its file:line sub-label into a forge
      // deep-link (same URL the CTA "GitHub" button produces). Null
      // when no PR/host is resolved; the modal degrades to plain text.
      prInfo: state.prInfo,
      // View-scoped order: threads belonging to the current view (no
      // on-open swap any more — see above), in (file, line, id) document
      // order. The modal's prev/next and "N of M" position label stay
      // bounded to that view, matching the counts-strip total the user
      // just clicked. In Full / Local this is every thread (those views
      // aggregate), so the prior branch-wide walk is preserved there;
      // only commit view tightens to a per-commit walk.
      // `opts.threadOrder` lets the Resume button narrow further to
      // unresolved threads only.
      threadOrder: opts.threadOrder || computeThreadOrderInCurrentView(),
      // Prev/next stays in the current diff view — no swap, no URL rewrite.
      // The modal was opened against a specific view (Full, Local, or a
      // commit), and the user's expectation is that walking threads from
      // that modal keeps them in that view. If the destination thread was
      // anchored in a different view and its row isn't rendered in the
      // current diff's DOM, jumpToThreadAnchor → maybeScrollToAnchor will
      // surface the existing "anchor lost" toast — the comments stay
      // readable in the modal regardless of where the anchor lives.
      // Cross-file prev/next: when the target thread sits in a file the
      // current single-file filter excludes, clear the filter so the
      // anchor becomes visible. Then jump to the new anchor.
      onNavigate: (newId) => {
        const t = state.threads.find((x) => x.id === newId)
        if (!t) return
        setResumeCursor(newId)
        if (state.filter?.kind === 'file' && state.filter.path !== t.file) {
          state.filter = null
          stripFileQuery()
          renderBody()
        }
        jumpToThreadAnchor(t)
      },
      onClose: () => { stripThreadQuery(); releaseJumpLayout() },
      onChanged: (res) => {
        // Detect "user just resolved the last open thread on a file" and
        // auto-mark that file reviewed (subject to the same view + later-
        // changes gates the manual header click enforces). Must run BEFORE
        // loadThreads — loadThreads overwrites state.threads with the new
        // snapshot, which would erase the "what did this look like before
        // the mutation?" signal the diff below depends on.
        autoMarkOnLastResolve(res)
        loadThreads()
      },
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
  // so state.threads is populated and computeThreadOrderInclusive can
  // hand back a non-empty threadOrder — without the deferral, the modal
  // closure would capture an empty array and the prev/next nav would
  // silently disappear.
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
