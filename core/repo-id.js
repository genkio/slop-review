// ----------------------------------------------------------------------
// Shared repo-id derivation. NODE-ONLY (imports node:crypto + node:path):
// the browser never derives a repo id (the server attaches it), so this
// module is imported by the Node server and the TUI, never fetched by the
// browser. Lifted out of server/state.js so the TUI derives the SAME id for
// a given absolute path (the id keys per-repo UI state in state.json).
// ----------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { basename } from 'node:path'

/**
 * Derive a stable, filesystem-friendly id for a repo from its absolute path:
 * `<sanitized-basename>_<sha1(absPath)[:8]>`. The basename gives a readable
 * prefix; the hash disambiguates same-named repos in different locations.
 */
export function deriveRepoId(absPath) {
  const base =
    basename(absPath).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 8)
  return `${base}_${hash}`
}
