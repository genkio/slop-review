// ----------------------------------------------------------------------
// Transport-agnostic action facade. NODE-ONLY: it orchestrates the DOM-free
// server modules (git, diff-priorities, ...) into the operations the app
// performs, independent of HTTP. The HTTP routes wrap these and the native
// TUI calls them in-process, so validation + assembly live in one place and
// on-disk/data invariants stay identical across both front-ends.
//
// (Transitional note: this imports ../server/*.js. Those modules are the
// node-side core; a later cleanup may relocate them under core/. The naming
// here follows the design's `core/actions` facade.)
// ----------------------------------------------------------------------
import {
  getBranchInfo,
  getCommitDiff,
  getFullDiff,
  getLocalDiff,
  getOriginUrl,
  getFileLines,
  getHeadPreview,
  findSymbolDefinition,
  isValidSha,
  isValidSymbol,
} from '../server/git.js'
import { parseRemoteUrl, getPullRequestUrl } from '../server/host.js'
import { forgeDeepLink } from './forge.js'
import { createHash } from 'node:crypto'
import {
  computePrioritiesAtSha,
  computePrioritiesForWorktree,
} from '../server/diff-priorities.js'
import {
  newThreadId,
  readThread,
  writeThread,
  deleteThread,
  listThreadsWithState,
} from '../server/reviews.js'
import { readReviewed, writeReviewed, clearReviewed } from '../server/reviewed.js'
import { getOverviewStatus, ensureOverviewGeneration, shutdownAllOverviewJobs } from '../server/overview.js'
import { sanitizeBranchId } from './ids.js'

// Re-exported so the TUI can wire the overview-job teardown into its own
// exit path (a 10-minute codex/claude child must not orphan onto the TTY).
export { shutdownAllOverviewJobs }

/**
 * Error carrying an HTTP-style status so the route layer can map it to a
 * response code, while the TUI can catch the same shape in-process and
 * render an error panel. `status` defaults to 500.
 */
export class ActionError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'ActionError'
    this.status = status
  }
}

// The Full-diff 409 message contains an em-dash (U+2014). It is reproduced
// byte-for-byte via fromCharCode so the literal glyph never appears in source
// (and so the SPA's error text is unchanged).
const FULL_DIFF_NO_BASE =
  'no merge base / head sha ' + String.fromCharCode(0x2014) + ' branch state unsuitable for full diff'

/**
 * Load the cumulative Full diff (merge-base..HEAD) with importance
 * priorities attached. Throws ActionError(409) when the branch has no merge
 * base / head sha (degenerate branch state).
 */
export async function loadFullDiff(repoPath) {
  const info = await getBranchInfo(repoPath)
  if (!info.merge_base_sha || !info.head_sha) throw new ActionError(FULL_DIFF_NO_BASE, 409)
  const diff = await getFullDiff(repoPath, info.merge_base_sha, info.head_sha)
  diff.priorities = await computePrioritiesAtSha(repoPath, diff.sha, diff.files)
  return diff
}

/**
 * Load a single commit's diff with priorities computed from each file's
 * content AT that commit. Throws ActionError(400) on a malformed sha.
 */
export async function loadCommitDiff(repoPath, sha) {
  if (!isValidSha(sha)) throw new ActionError('invalid sha', 400)
  const diff = await getCommitDiff(repoPath, sha)
  diff.priorities = await computePrioritiesAtSha(repoPath, diff.sha, diff.files)
  return diff
}

/** Load the local working-copy diff with worktree-content priorities. */
export async function loadLocalDiff(repoPath) {
  const diff = await getLocalDiff(repoPath)
  diff.priorities = await computePrioritiesForWorktree(repoPath, diff.files)
  return diff
}

// ----------------------------------------------------------------------
// Review-thread actions. These mirror the validation + assembly the HTTP
// thread routes perform, over the same server/reviews.js storage, so a
// thread written from the TUI is byte-compatible with one written from the
// browser or the bundled skill. Each mutator returns the fresh
// state-enriched thread list (matching the routes' response shape).
// ----------------------------------------------------------------------

// Role marker stamped on developer-authored comments (TUI + web alike), kept
// in lockstep with DEVELOPER_USER in server/routes/threads.js + reviews.js.
const DEVELOPER_USER = 'reviewer'

async function resolveBranch(repoPath) {
  const info = await getBranchInfo(repoPath)
  if (!info.current_branch) throw new ActionError('no current branch (detached HEAD?)', 409)
  return { info, branchId: sanitizeBranchId(info.current_branch) }
}

/** List all threads for the current branch, each enriched with `state`. */
export async function listThreads(repoPath) {
  const { branchId } = await resolveBranch(repoPath)
  return listThreadsWithState(repoPath, branchId)
}

/** Create a new single- or multi-line thread anchored at (file, line, side). */
export async function createThread(repoPath, { view, file, line, lineEnd = null, side = 'new', sha = null, body, anchorText = null }) {
  const { info, branchId } = await resolveBranch(repoPath)
  if (!['commit', 'full', 'local'].includes(view)) throw new ActionError('invalid view', 400)
  if (!file) throw new ActionError('file required', 400)
  if (!Number.isFinite(line) || line < 1) throw new ActionError('invalid line', 400)
  if (lineEnd !== null && (!Number.isFinite(lineEnd) || lineEnd < line || lineEnd - line > 500)) {
    throw new ActionError('invalid line_end', 400)
  }
  if (!['old', 'new'].includes(side)) throw new ActionError('invalid side', 400)
  const text = String(body || '').trim()
  if (!text) throw new ActionError('body required', 400)

  const id = newThreadId()
  const now = new Date().toISOString()
  const thread = {
    id, view, file, line,
    line_end: lineEnd && lineEnd > line ? lineEnd : null,
    side,
    sha: sha || info.head_sha || null,
    anchor_text: anchorText != null ? String(anchorText).slice(0, 500) : null,
    created_at: now,
    last_read_at: now,
    comments: [{ id: `${id}_1`, user: DEVELOPER_USER, body: text, posted_at: now }],
  }
  await writeThread(repoPath, branchId, thread)
  return listThreadsWithState(repoPath, branchId)
}

/** Append a reply comment to an existing thread. */
export async function replyThread(repoPath, threadId, body) {
  const { branchId } = await resolveBranch(repoPath)
  const text = String(body || '').trim()
  if (!text) throw new ActionError('body required', 400)
  const thread = await readThread(repoPath, branchId, threadId)
  if (!thread) throw new ActionError('thread not found', 404)
  const now = new Date().toISOString()
  const n = (thread.comments?.length || 0) + 1
  thread.comments = [...(thread.comments || []), { id: `${threadId}_${n}`, user: DEVELOPER_USER, body: text, posted_at: now }]
  thread.last_read_at = now
  await writeThread(repoPath, branchId, thread)
  return listThreadsWithState(repoPath, branchId)
}

/** Toggle a thread's resolution (resolved=true marks done, false reopens). */
export async function setThreadResolved(repoPath, threadId, resolved) {
  const { branchId } = await resolveBranch(repoPath)
  const thread = await readThread(repoPath, branchId, threadId)
  if (!thread) throw new ActionError('thread not found', 404)
  thread.resolved_at = resolved ? new Date().toISOString() : null
  await writeThread(repoPath, branchId, thread)
  return listThreadsWithState(repoPath, branchId)
}

/** Delete an entire thread. */
export async function removeThread(repoPath, threadId) {
  const { branchId } = await resolveBranch(repoPath)
  await deleteThread(repoPath, branchId, threadId)
  return listThreadsWithState(repoPath, branchId)
}

// ----------------------------------------------------------------------
// Reviewed-file marks. Reuses server/reviewed.js verbatim (per-file blob-SHA
// pinning, head_sha keying), so a mark set from the TUI survives + invalidates
// exactly as it does from the browser. Marks are only meaningful in Full /
// commit views (Local has no stable blob to pin against), gated by the caller.
// ----------------------------------------------------------------------

/** Read the validated reviewed set for the current branch: { head_sha, paths }. */
export async function getReviewed(repoPath) {
  const { branchId } = await resolveBranch(repoPath)
  return readReviewed(repoPath, branchId)
}

/**
 * Persist reviewed marks. mode='replace' overwrites with `paths` (the caller
 * computed the full set, e.g. a per-file toggle); mode='add' merges. Pins
 * against the current head_sha.
 */
export async function setReviewed(repoPath, paths, { mode = 'replace' } = {}) {
  const { info, branchId } = await resolveBranch(repoPath)
  if (!info.head_sha) throw new ActionError('head_sha required', 409)
  const final = mode === 'add'
    ? [...new Set([...(await readReviewed(repoPath, branchId)).paths, ...paths])]
    : paths
  return writeReviewed(repoPath, branchId, info.head_sha, final)
}

/** Clear all reviewed marks for the current branch. */
export async function clearReviewedMarks(repoPath) {
  const { branchId } = await resolveBranch(repoPath)
  await clearReviewed(repoPath, branchId)
  return { head_sha: null, paths: [] }
}

// ----------------------------------------------------------------------
// Forge deep-links + symbol lookup. prInfo mirrors the /pr-info route; the
// URL shape comes from the shared core/forge.js; the path hash is computed
// with node:crypto (the browser uses crypto.subtle for the same value).
// ----------------------------------------------------------------------

/** Forge identity + PR url for the current branch (nulls when unavailable). */
export async function prInfo(repoPath) {
  const info = await getBranchInfo(repoPath)
  const parsed = parseRemoteUrl(await getOriginUrl(repoPath))
  if (!parsed || !parsed.host) return { host: null, owner: null, repo: null, pr_url: null }
  const pr_url = info.current_branch ? await getPullRequestUrl(repoPath, info.current_branch, parsed.host) : null
  return { host: parsed.host, owner: parsed.owner, repo: parsed.repo, pr_url }
}

/** Build the forge deep-link for a (path,line,side), or null if no PR/forge. */
export async function forgeUrlForLine(repoPath, { path, line, side }) {
  const pi = await prInfo(repoPath)
  if (!pi.host || !pi.pr_url) return null
  const pathSha256 = createHash('sha256').update(String(path)).digest('hex')
  return forgeDeepLink({ host: pi.host, prUrl: pi.pr_url, pathSha256, lineStart: line, lineEnd: line, side })
}

/** Find a symbol's definition across the repo at HEAD (validated identifier). */
export async function findSymbol(repoPath, name, opts = {}) {
  if (!isValidSymbol(name)) throw new ActionError('invalid symbol', 400)
  return findSymbolDefinition(repoPath, name, opts)
}

// ----------------------------------------------------------------------
// Expand-context: fetch a line range from a file at a ref (sha/branch, or
// the 'WORKTREE' sentinel for the local diff's new side). Mirrors the
// /file-lines route validation. Returns { ref, path, lines, start, end,
// total_lines, missing, binary }.
// ----------------------------------------------------------------------
export async function getLines(repoPath, ref, path, start, end) {
  if (!ref) throw new ActionError('ref required', 400)
  if (!path) throw new ActionError('path required', 400)
  if (!Number.isFinite(start) || start < 1) throw new ActionError('start must be a positive integer', 400)
  if (!Number.isFinite(end) || end < start) throw new ActionError('end must be >= start', 400)
  if (end - start + 1 > 2000) throw new ActionError('range too large (max 2000 lines)', 400)
  if (ref !== 'WORKTREE' && !isValidSha(ref) && !/^[A-Za-z0-9_.\/-]+$/.test(ref)) {
    throw new ActionError('invalid ref', 400)
  }
  const out = await getFileLines(repoPath, ref, path, start, end)
  return { ref, path, ...out }
}

// ----------------------------------------------------------------------
// Branch overview (codex/claude generation). The engine runs the CLI as an
// async job; the front-end polls. These wrap it 1:1 for the TUI.
// ----------------------------------------------------------------------

/** Current overview status: { status, content, error, available_tools, ... }. */
export async function overviewStatus(repoPath) {
  return getOverviewStatus(repoPath)
}

/** Trigger (or force-regenerate) overview generation; returns the status. */
export async function generateOverview(repoPath, opts = {}) {
  return ensureOverviewGeneration(repoPath, opts)
}

/** Peek what a commit-view line looks like at HEAD (commit views only). */
export async function headPreview(repoPath, sha, path, line, context = 10) {
  if (!isValidSha(sha)) throw new ActionError('invalid sha', 400)
  if (!path) throw new ActionError('path required', 400)
  if (!Number.isFinite(line) || line < 1) throw new ActionError('line must be a positive integer', 400)
  return getHeadPreview(repoPath, sha, path, line, Math.max(0, Math.min(50, context)))
}
