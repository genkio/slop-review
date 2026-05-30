// ----------------------------------------------------------------------
// Shared, runtime-agnostic view index-space + visible-file computation.
//
// The diff view addresses its variants by integer index: 0..n-1 are the
// commits (oldest first), n is the Full diff, n+1 is the Local working-copy
// diff (only when hasLocal). These predicates encode that mapping, lifted
// out of public/diff.js so the TUI navigates the same index space. The
// predicates take the commit count (and hasLocal) explicitly; the browser
// and TUI each bind them to their own state. Import-pure: NO DOM, NO `node:`.
// ----------------------------------------------------------------------

export function isFullIndex(idx, commitCount) {
  return idx === commitCount
}
export function isCommitIndex(idx, commitCount) {
  return idx >= 0 && idx < commitCount
}
export function isLocalIndex(idx, commitCount, hasLocal) {
  return !!hasLocal && idx === commitCount + 1
}

/**
 * Compute which files are visible given the current view + filter. `state`
 * is expected to expose: `diff.files`, `diff.priorities`, `filter`, `index`,
 * `commits`. Behavior:
 *   - `?file=` single-file filter: just that file, in any view.
 *   - non-Full views: all files (filtering is a Full-diff concern).
 *   - Full view with a `related` filter: the anchor plus its in/out edges.
 *   - otherwise: all files (reviewed ones render collapsed, not removed).
 */
export function computeVisibleFiles(state) {
  const all = state.diff?.files || []
  const filter = state.filter
  if (filter?.kind === 'file' && filter.path) {
    return all.filter((f) => f.path === filter.path)
  }
  if (!isFullIndex(state.index, state.commits.length)) return all
  const priorities = state.diff?.priorities
  const filterAnchor = filter?.kind === 'related' ? filter.anchor : null
  if (filterAnchor && priorities) {
    const p = priorities[filterAnchor]
    const set = new Set([filterAnchor, ...(p?.incoming || []), ...(p?.outgoing || [])])
    return all.filter((f) => set.has(f.path))
  }
  return all
}
