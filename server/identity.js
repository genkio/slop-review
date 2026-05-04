import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

let cached = null
let pending = null

/**
 * Resolve the gh-authenticated user's login. Memoized for the lifetime of
 * the process so we don't shell out per-thread when deriving state.
 *
 * Falls back to `'me'` if `gh` is unreachable — same convention taiou uses.
 * That keeps state-derivation working when offline; the tradeoff is that
 * if the user's git config name happens to be `'me'` they'd be ambiguous
 * with the LLM (extremely unlikely).
 */
export async function currentGhLogin() {
  if (cached) return cached
  if (pending) return pending
  pending = (async () => {
    try {
      const { stdout } = await pExecFile(
        'gh',
        ['api', 'user', '--jq', '.login'],
        { timeout: 5000, encoding: 'utf8' }
      )
      const login = stdout.trim()
      cached = login || 'me'
    } catch {
      cached = 'me'
    } finally {
      pending = null
    }
    return cached
  })()
  return pending
}
