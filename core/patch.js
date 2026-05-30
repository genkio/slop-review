// ----------------------------------------------------------------------
// Shared, runtime-agnostic unified-diff patch parser.
//
// Lifted verbatim from public/diff.js so the browser SPA and the native TUI
// build their diff render models from the same parser. Import-pure (only the
// sibling intra-line-diff module); the rendering of these rows into HTML
// (browser) or cells (TUI) stays in each front-end. No DOM, no `node:`.
// ----------------------------------------------------------------------
import { intraLineSegments } from './intra-line-diff.js'

/**
 * Parse a unified-diff patch into an array of hunks, each with a `rows`
 * list of `{ kind, oldNo, newNo, text }` ('del' | 'add' | 'context'), and
 * intra-line segment stamps annotated onto change rows.
 *
 * Resilient to: missing hunk-line counts, blank context lines without the
 * leading space, `\ No newline at end of file` markers, and patches with
 * preamble before the first `@@`.
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

/**
 * Collapse a hunk's flat row list into paired rows for split (side-by-side)
 * rendering: runs of (del, add) become `change`/`del`/`add` pairs, context
 * rows become a `context` pair pointing at the same row on both sides.
 */
export function pairRows(rows) {
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
