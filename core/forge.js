// ----------------------------------------------------------------------
// Shared, runtime-agnostic forge deep-link URL builder.
//
// This is the URL *shape* only: given a precomputed path hash, build the
// GitHub PR-file anchor. Each runtime supplies the SHA-256 its own way: the
// browser via crypto.subtle (public/util.js sha256Hex), the server/TUI via
// node:crypto. Returns null for unsupported hosts so callers hide the link
// rather than emit a guess that 404s. Import-pure: NO DOM, NO `node:`.
//
// GitHub format: `<prUrl>/files#diff-<sha256(path)>R3-R10` (R = right/new,
// L = left/old). Single line uses `R3`; a range uses `R3-R5`.
// ----------------------------------------------------------------------

export function forgeDeepLink({ host, prUrl, pathSha256, lineStart, lineEnd, side }) {
  if (!host || !prUrl || !pathSha256) return null
  switch (host) {
    case 'github': {
      const prefix = side === 'old' ? 'L' : 'R'
      const lineSpec = lineStart === lineEnd
        ? `${prefix}${lineStart}`
        : `${prefix}${lineStart}-${prefix}${lineEnd}`
      return `${prUrl}/files#diff-${pathSha256}${lineSpec}`
    }
    // GitLab / Bitbucket: not yet implemented. Returning null hides the
    // link rather than producing a guess that 404s on the user.
    default:
      return null
  }
}
