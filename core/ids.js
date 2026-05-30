// ----------------------------------------------------------------------
// Shared, runtime-agnostic identity helpers.
//
// This module is the single source of truth for id/path sanitization that
// MUST agree between the browser SPA, the Node server, and the native TUI.
// It is fetched by the browser (served under /core/, see server/index.js)
// AND imported by Node, so it must stay import-pure: NO `node:` specifiers,
// no DOM globals. Anything needing node:crypto or the DOM belongs elsewhere.
// ----------------------------------------------------------------------

/**
 * Sanitize a branch name into a filesystem-safe directory name. SPEC §5:
 * anything outside `[A-Za-z0-9_-]` collapses to `-`, leading/trailing `-`
 * stripped, capped at 80 chars.
 *
 * Previously hand-duplicated in public/util.js and server/reviews.js with
 * a "must stay in lockstep" comment on each copy; both now re-export this
 * one definition, so the `<repo>/.reviews/<branch_id>/` paths the client
 * constructs are byte-identical to what the server reads/writes by
 * construction rather than by discipline.
 */
export function sanitizeBranchId(branch) {
  if (!branch) return ''
  let s = String(branch)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > 80) s = s.slice(0, 80)
  return s
}
