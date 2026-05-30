// ----------------------------------------------------------------------
// Shared, runtime-agnostic display formatters. Pure string helpers used by
// both the browser SPA and the TUI. Import-pure: NO DOM, NO `node:`.
// ----------------------------------------------------------------------

/**
 * Relative time label for an ISO timestamp: 'just now', 'Nm ago', 'Nh ago',
 * 'Nd ago', then the ISO date once older than a week.
 */
export function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago'
  return d.toISOString().slice(0, 10)
}

// The multi-line separator is U+2013 (en-dash), built via fromCharCode so the
// literal glyph never appears in source (matches the original diff modal).
const LINE_RANGE_SEP = String.fromCharCode(0x2013)

/**
 * Format a thread's anchor line range: `42` for a single-line thread, or
 * `42<sep>45` for a multi-line one. Threads created before the multi-line
 * feature carry no `line_end`, which collapses to the single-line case so
 * legacy data renders unchanged.
 */
export function formatLineRange(thread) {
  const start = thread?.line
  const end = thread?.line_end
  if (start == null) return ''
  if (end == null || end === start) return String(start)
  return `${start}${LINE_RANGE_SEP}${end}`
}
