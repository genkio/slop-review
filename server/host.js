import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

const GH_TIMEOUT = 5000

// Lazy `gh auth status` probe. Memoized for the life of the process — a
// fresh install / login in mid-session takes effect after restart. Boot
// stays fast and users without `gh` don't pay a probe cost unless they
// actually click a feature that wants it.
let ghAvailablePromise = null
export function isGhAvailable() {
  if (ghAvailablePromise) return ghAvailablePromise
  ghAvailablePromise = (async () => {
    try {
      await pExecFile('gh', ['auth', 'status'], { timeout: GH_TIMEOUT })
      return true
    } catch {
      return false
    }
  })()
  return ghAvailablePromise
}

/**
 * Parse the URL from `git remote get-url origin` into { host, owner, repo }.
 * Accepts both HTTPS (`https://github.com/owner/repo.git`) and SSH
 * (`git@github.com:owner/repo.git`) shapes. Returns null when the URL
 * doesn't look like a known forge — caller treats null as "no host", which
 * is what makes the GitHub button quietly hide for plain mirrors or local
 * test repos with no remote.
 */
export function parseRemoteUrl(url) {
  if (!url) return null
  const cleaned = url.trim()
  // https://github.com/owner/repo(.git)?  /  http://, git+https://, etc.
  let m = cleaned.match(/^(?:https?|git\+https?|ssh\+https?):\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)
  if (!m) {
    // git@github.com:owner/repo(.git)?
    m = cleaned.match(/^[^@\s]+@([^:]+):(.+?)(?:\.git)?\/?$/)
  }
  if (!m) return null
  const [, hostname, path] = m
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts.slice(1).join('/')  // group/subgroup/project on GitLab
  return { host: classifyHost(hostname), hostname, owner, repo }
}

function classifyHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github'
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab'
  if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org')) return 'bitbucket'
  return null
}

// Per-(repoPath, branch) cache for PR URL lookups. `gh pr view` is a
// network call (couple hundred ms typical, longer on cold connection) and
// the answer almost never changes for a branch — once a PR is opened the
// URL is permanent. Cache lives for the process lifetime; restart slop-
// review if you open a brand-new PR for an in-flight branch.
const prCache = new Map()

/**
 * Best-effort lookup of the PR/MR URL for the current branch on a known
 * host. Currently implements `gh` for GitHub only; GitLab/Bitbucket fall
 * through to null (button hides). Returns null on any failure — missing
 * `gh`, network error, branch with no PR. Callers treat null as "no link".
 */
export async function getPullRequestUrl(repoPath, branch, host) {
  if (!repoPath || !branch || host !== 'github') return null
  const key = `${repoPath}:${branch}`
  if (prCache.has(key)) return prCache.get(key)
  if (!(await isGhAvailable())) {
    prCache.set(key, null)
    return null
  }
  let url = null
  try {
    const { stdout } = await pExecFile(
      'gh', ['pr', 'view', '--json', 'url'],
      { cwd: repoPath, timeout: GH_TIMEOUT, encoding: 'utf8' }
    )
    const data = JSON.parse(stdout)
    url = data?.url || null
  } catch {
    url = null
  }
  prCache.set(key, url)
  return url
}
