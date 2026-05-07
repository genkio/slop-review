// Hash-route URL builders. Centralised so all link-construction sites use
// the same shape — drift here would silently break navigation.
//
// Lives in its own module (rather than router.js) to avoid a circular
// import: pages/* and diff.js both need ROUTES, and router.js imports
// pages/*. ES-module lazy bindings would handle the cycle correctly today,
// but a future refactor that touches ROUTES at top-level in router.js
// would tip into a TDZ crash. One tiny file removes that risk.

export const ROUTES = {
  threads:    () => '#/',
  diffFull:   () => '#/diff',
  diffLocal:  () => '#/diff/local',
  diffCommit: (sha) => `#/diff/${sha.slice(0, 12)}`,
}

// SHA shape — must not match the literal `local` (it doesn't, since
// `l`/`o` aren't hex). Kept here so the router's parseHash and any
// future caller share one definition.
export const SHA_RE = /^[0-9a-f]{7,40}$/
