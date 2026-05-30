// ----------------------------------------------------------------------
// Build the TUI diff render model: an array of line objects
//   { text, nav?, file? }
// `text` is the ANSI body (the app prepends a 1-col cursor gutter); `nav`
// marks a navigable diff row { path, side, oldNo, newNo, kind, threadIds };
// `file` marks a file header { path }. Review threads are woven inline under
// their anchored row (matching the browser's inline thread rows). Reuses the
// shared core: parsePatch, tokenize/languageForPath, compareForReview, plus
// relTime for comment timestamps.
// ----------------------------------------------------------------------
import { parsePatch } from '../core/patch.js'
import { tokenize, languageForPath } from '../core/syntax.js'
import { compareForReview, STATUS_GLYPH } from '../core/diff-order.js'
import { relTime } from '../core/format.js'
import { tokensToSgr } from './sgr.js'

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const FG_DEFAULT = `${ESC}[39m`
const BOLD = `${ESC}[1m`
const DIM_FG = `${ESC}[38;5;244m`
const HUNK_FG = `${ESC}[38;5;39m`
const ADD_FG = `${ESC}[38;5;42m`
const DEL_FG = `${ESC}[38;5;167m`
// Add/del washes use truecolor when the terminal advertises it ($COLORTERM),
// else fall back to the nearest xterm-256 cube cell so the wash still reads on
// 256-color terminals (the carbonyl-proven values quantize to 22 / 52).
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '')
const ADD_BG = TRUECOLOR ? `${ESC}[48;2;31;58;37m` : `${ESC}[48;5;22m`
const DEL_BG = TRUECOLOR ? `${ESC}[48;2;58;31;31m` : `${ESC}[48;5;52m`
const REVIEWED_FG = `${ESC}[38;5;42m`
const AUTHOR_FG = `${ESC}[38;5;180m`

// thread state -> pill color + label
const STATE_FG = { your_turn: 226, awaiting: 75, read: 244, resolved: 42 }
const STATE_LABEL = { your_turn: 'YOUR TURN', awaiting: 'awaiting', read: 'read', resolved: 'resolved' }
const BAR = String.fromCharCode(0x2503) // heavy vertical bar

const GW = 5
const PREFIX_W = GW + 1 + GW + 1 + 1 + 1

function gut(n) {
  return (n == null ? '' : String(n)).padStart(GW).slice(-GW)
}
// Strip control bytes so a comment body / branch name can't inject ANSI.
function sanitize(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')
}

function anchorKey(file, side, line) {
  return `${file}|${side}|${line}`
}

export function buildDiffLines(diff, cols, opts = {}) {
  const reviewed = opts.reviewed || new Set()
  const collapsed = opts.collapsed || new Set()
  const wrap = !!opts.wrap
  const showGutter = opts.showGutter !== false
  const rowOpts = { wrap, showGutter }
  const innerCols = Math.max(20, cols - 1)

  // index threads by their anchor (file, side, start line)
  const byAnchor = new Map()
  for (const t of opts.threads || []) {
    const k = anchorKey(t.file, t.side, t.line)
    if (!byAnchor.has(k)) byAnchor.set(k, [])
    byAnchor.get(k).push(t)
  }

  const lines = []
  const files = [...(diff.files || [])].sort((a, b) => compareForReview(a, b, diff.priorities))

  const threadCount = (opts.threads || []).length
  const tsummary = threadCount ? `${DIM_FG} · ${threadCount} thread${threadCount === 1 ? '' : 's'}${FG_DEFAULT}` : ''
  lines.push({ text: `${BOLD}${sanitize(diff.branch) || ''}${RESET}  ${DIM_FG}${files.length} file${files.length === 1 ? '' : 's'} changed${FG_DEFAULT}${tsummary}${RESET}` })
  lines.push({ text: '' })

  if (!files.length) {
    lines.push({ text: `${DIM_FG}  (no changes in this view)${RESET}` })
    return lines
  }

  for (const file of files) {
    const glyph = STATUS_GLYPH[file.status] || '?'
    const isReviewed = reviewed.has(file.path)
    const isCollapsed = collapsed.has(file.path) || isReviewed
    const check = isReviewed ? `${REVIEWED_FG}✓${FG_DEFAULT} ` : ''
    const rename = file.previous_path ? `${DIM_FG} (was ${sanitize(file.previous_path)})${RESET}` : ''
    const stats = `${ADD_FG}+${file.additions ?? 0}${RESET} ${DEL_FG}-${file.deletions ?? 0}${RESET}`
    const fold = isCollapsed ? `${DIM_FG} [collapsed]${RESET}` : ''
    lines.push({ text: `${check}${BOLD}${glyph} ${sanitize(file.path)}${RESET}${rename}  ${stats}${fold}`, file: { path: file.path } })

    if (isCollapsed) { lines.push({ text: '' }); continue }
    if (file.is_binary) {
      lines.push({ text: `${DIM_FG}    (binary file)${RESET}` })
      lines.push({ text: '' })
      continue
    }

    const lang = languageForPath(file.path)
    const expanded = opts.expanded
    const pushRow = (row, hi) => {
      const side = row.kind === 'del' ? 'old' : 'new'
      const lineNo = side === 'old' ? row.oldNo : row.newNo
      const threads = (lineNo != null && byAnchor.get(anchorKey(file.path, side, lineNo))) || []
      const disp = renderRow(row, lang, innerCols, rowOpts)
      // The first display row carries the nav coordinates; wrapped
      // continuation rows are plain (cursor steps by logical line).
      disp.forEach((text, i) => {
        if (i === 0) lines.push({ text, nav: { path: file.path, side, oldNo: row.oldNo, newNo: row.newNo, kind: row.kind, threadIds: threads.map((t) => t.id), hunkIdx: hi } })
        else lines.push({ text })
      })
      for (const t of threads) for (const tl of renderThread(t, innerCols)) lines.push(tl)
    }
    parsePatch(file.patch || '').forEach((h, hi) => {
      const head = h.header ? ' ' + h.header : ''
      lines.push({ text: `${HUNK_FG}@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${head}${RESET}` })
      // Expanded-context lines fetched above this hunk (via `e`), shown dim.
      const exp = expanded && expanded.get(`${file.path}#${hi}`)
      if (exp) for (const el of exp.lines) pushRow({ kind: 'context', oldNo: el.oldNo, newNo: el.newNo, text: el.text }, hi)
      for (const row of h.rows) pushRow(row, hi)
    })
    lines.push({ text: '' })
  }
  return lines
}

function renderThread(thread, cols) {
  const fg = STATE_FG[thread.state] ?? 244
  const bar = `${ESC}[38;5;${fg}m${BAR}${FG_DEFAULT}`
  const label = STATE_LABEL[thread.state] || thread.state || ''
  const out = []
  out.push({ text: `   ${bar} ${ESC}[38;5;${fg}m${label}${FG_DEFAULT}${DIM_FG} · ${(thread.comments || []).length} comment${(thread.comments || []).length === 1 ? '' : 's'}${RESET}` })
  for (const cm of thread.comments || []) {
    out.push({ text: `   ${bar} ${AUTHOR_FG}@${sanitize(cm.user)}${FG_DEFAULT}${DIM_FG} · ${relTime(cm.posted_at)}${RESET}` })
    // Split on newlines FIRST, then sanitize each line: sanitize() strips
    // control bytes (incl. \n), so sanitizing before the split would collapse
    // a multi-line comment into one line.
    for (const raw of String(cm.body ?? '').split('\n')) {
      out.push({ text: `   ${bar}   ${clip(sanitize(raw), cols - 6)}` })
    }
  }
  return out
}

function clip(s, n) {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + String.fromCharCode(0x2026) : s
}

function chunkStr(s, n) {
  if (s.length <= n) return [s]
  const out = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out.length ? out : ['']
}

// Render one logical diff row to an array of display-row strings (1, or more
// when wrap is on). The prefix layout is uniform across kinds so the content
// column aligns: [gut-old][ ][gut-new][ ][marker][ ]. Continuation rows blank
// the gutter + marker. `showGutter:false` drops the line-number columns.
function renderRow(row, lang, cols, opts = {}) {
  const showGutter = opts.showGutter !== false
  const wrap = !!opts.wrap
  const prefixW = (showGutter ? GW + 1 + GW + 1 : 0) + 2 // gutters(+space) + marker + space
  const avail = Math.max(4, cols - prefixW)
  const raw = row.text ?? ''
  const chunks = wrap ? chunkStr(raw, avail) : [raw.slice(0, avail)]
  const isCtx = row.kind === 'context'
  const bg = isCtx ? '' : (row.kind === 'add' ? ADD_BG : DEL_BG)
  const markFg = row.kind === 'add' ? ADD_FG : row.kind === 'del' ? DEL_FG : ''
  const markGlyph = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const SP = ' '.repeat(GW)

  return chunks.map((text, i) => {
    const first = i === 0
    const colored = tokensToSgr(tokenize(text, lang))
    const pad = bg ? ' '.repeat(Math.max(0, avail - text.length)) : ''
    const gutCell = showGutter
      ? `${DIM_FG}${first ? gut(row.oldNo) : SP} ${first ? gut(row.newNo) : SP}${FG_DEFAULT} `
      : ''
    const markChar = first ? markGlyph : ' '
    const markStr = (first && markFg) ? `${markFg}${markChar}${FG_DEFAULT}` : markChar
    const body = `${gutCell}${markStr} ${colored}`
    return bg ? `${bg}${body}${pad}${RESET}` : `${body}${RESET}`
  })
}
