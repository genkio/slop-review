// ----------------------------------------------------------------------
// Shared, runtime-agnostic file-ordering + status presentation for the
// diff view. The priority *data* (ref counts, status/support ranks, the
// import graph) is computed server-side in server/diff-priorities.js; this
// module is the comparator + glyph tables that consume it, lifted out of
// public/diff.js so the browser file list and the TUI file list order and
// label files identically. Import-pure: NO DOM, NO `node:`.
// ----------------------------------------------------------------------

/**
 * Sort comparator for changed files, most-central-to-the-change-set first.
 * Order: reference count (how many other changed files import this) desc,
 * then status rank, then source-vs-support rank, then path. Files without a
 * priority entry sort last, alphabetically.
 */
export function compareForReview(a, b, priorities) {
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

// Single-letter status badge per file change kind (rendered in the file
// header). 'changed' folds onto 'M' (modified) like git's own shorthand.
export const STATUS_GLYPH = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' }

// Relationship chip glyphs + labels (filter mode, on non-anchor files).
// Arrow points FROM the dependent TO the dependency.
export const RELATIONSHIP_LABELS = {
  'imports':     { arrow: '→', text: 'imports',     verb: 'imports' },
  'imported-by': { arrow: '←', text: 'imported by', verb: 'imported by' },
  'circular':    { arrow: '↔', text: 'circular',    verb: 'circular import with' },
}
