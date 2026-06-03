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

const GH_GRAPHQL_TIMEOUT = 20000
const GH_MAXBUF = 32 * 1024 * 1024

/**
 * The PR number for the current branch, or null when there's no open PR
 * (or `gh` is unavailable). `gh pr view` with no positional arg resolves the
 * PR associated with the checked-out branch, the same resolution
 * getPullRequestUrl relies on, just asking for the number instead of the url.
 */
export async function getPrNumber(repoPath) {
  if (!repoPath) return null
  try {
    const { stdout } = await pExecFile(
      'gh', ['pr', 'view', '--json', 'number'],
      { cwd: repoPath, timeout: GH_TIMEOUT, encoding: 'utf8' }
    )
    const data = JSON.parse(stdout)
    return Number.isInteger(data?.number) ? data.number : null
  } catch {
    return null
  }
}

// Resolution status for a review thread (isResolved) is exposed ONLY by the
// GraphQL API; the REST pulls/comments endpoint can't tell a resolved thread
// from an open one. So sync fetches PullRequestReviewThread nodes directly.
// Anchor fields (path/line/diffSide/etc.) live on the thread itself in the
// current schema, which is why we don't need to dig into each comment to find
// where the thread is pinned.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          subjectType
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`

/**
 * Fetch every PullRequestReviewThread on a PR via the GraphQL API, paginating
 * the thread connection. Returns the raw node objects; the sync layer
 * (server/sync.js) filters to unresolved + maps them onto slop threads.
 *
 * Comments are capped at the first 100 per thread: a single review thread
 * effectively never exceeds that, and going deeper would mean a second
 * paginated connection per thread for a case that doesn't occur in practice.
 *
 * Throws on a hard gh failure (bad auth, network, GraphQL error) so the caller
 * surfaces it rather than silently syncing zero threads. `-f` passes the query
 * plus string vars raw; `-F number=N` coerces to the GraphQL Int.
 */
export async function fetchReviewThreads(repoPath, owner, repo, number) {
  const out = []
  let cursor = null
  // Runaway backstop: 100 pages x 100 threads = 10k, far beyond any real PR.
  for (let page = 0; page < 100; page++) {
    const args = [
      'api', 'graphql',
      '-f', `query=${REVIEW_THREADS_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `repo=${repo}`,
      '-F', `number=${number}`,
    ]
    if (cursor) args.push('-f', `cursor=${cursor}`)
    const { stdout } = await pExecFile('gh', args, {
      cwd: repoPath,
      timeout: GH_GRAPHQL_TIMEOUT,
      maxBuffer: GH_MAXBUF,
      encoding: 'utf8',
    })
    const data = JSON.parse(stdout)
    const conn = data?.data?.repository?.pullRequest?.reviewThreads
    if (!conn) break
    for (const node of conn.nodes || []) if (node) out.push(node)
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break
    cursor = conn.pageInfo.endCursor
  }
  return out
}
