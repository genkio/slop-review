import { getBranchInfo, getOriginUrl, getFileLines } from './git.js'
import { parseRemoteUrl, isGhAvailable, getPrNumber, fetchReviewThreads } from './host.js'
import {
  sanitizeBranchId,
  readBranchThreads,
  writeThread,
  deleteThread,
  newThreadId,
} from './reviews.js'

// ----------------------------------------------------------------------
// `slop --sync`: one-directional mirror of a GitHub PR's unresolved review
// threads into the local `.reviews/` store. GitHub is the source of truth;
// we never write back. Threads pulled from GitHub carry two extra fields
// beyond the base shape (see server/reviews.js / the slop-review skill):
//
//   github_thread_id  the GraphQL node id of the source PullRequestReview-
//                     Thread. Stable across syncs and independent of slop's
//                     own random `thread_<hex>` id, so it's the key we match
//                     on to decide create / update / delete each re-sync.
//                     Its presence is also what marks a thread as "synced".
//   locally_modified  false when sync writes the thread; the web-UI thread
//                     routes flip it true the moment the developer edits,
//                     replies to, deletes a comment from, or (un)resolves a
//                     synced thread. Sync then leaves that thread untouched
//                     forever (no overwrite, no delete): local edits win.
// ----------------------------------------------------------------------

/**
 * Pure reconciliation. Given the unresolved, line-anchored GitHub threads and
 * the current local thread objects, decide what to do. No I/O, no clock, no
 * randomness, so it's exhaustively unit-testable.
 *
 *   toUpsert: [{ gh, existing }]  existing=null -> create; else -> refresh
 *   toDelete: [threadId]          synced locally but resolved/gone on GitHub
 *   skippedModified: number       synced locally but locally_modified -> leave
 *
 * Threads with no `github_thread_id` (developer-authored, never synced) are
 * invisible to sync: they're neither upserted nor deleted.
 */
export function planSync(unresolvedGh, localThreads) {
  const ghIds = new Set(unresolvedGh.map((t) => t.id))
  const localByGh = new Map()
  for (const t of localThreads) {
    if (t.github_thread_id) localByGh.set(t.github_thread_id, t)
  }

  const toDelete = []
  let skippedModified = 0
  for (const t of localByGh.values()) {
    if (t.locally_modified) { skippedModified++; continue }
    if (!ghIds.has(t.github_thread_id)) toDelete.push(t.id)
  }

  const toUpsert = []
  for (const gh of unresolvedGh) {
    const existing = localByGh.get(gh.id) || null
    if (existing?.locally_modified) continue   // protected; counted above
    toUpsert.push({ gh, existing })
  }

  return { toUpsert, toDelete, skippedModified }
}

// First of the candidate line numbers that is a usable 1-indexed line, else
// null. Lets the anchor mapping prefer a thread's current line over its
// original-commit fallback while skipping nulls/zeros/non-integers.
function pickLine(...candidates) {
  for (const n of candidates) {
    if (Number.isInteger(n) && n >= 1) return n
  }
  return null
}

/**
 * Map one GitHub review thread onto a slop thread object. Pure: the caller
 * supplies the slop `id` (stable across re-syncs for an existing thread, fresh
 * for a new one) and the resolved HEAD sha, so there's no clock/randomness
 * here. `anchor_text` is filled in by the caller afterwards (reading it needs
 * disk access). GitHub review threads always anchor on the PR "Files" tab,
 * which is slop's full diff, hence `view: 'full'`.
 */
export function mapGithubThreadToSlop(gh, { id, headSha, existing = null }) {
  // Resolve the anchor (side, line, lineEnd) from the GitHub thread fields.
  //   diffSide 'LEFT'  = pre-image  -> slop side 'old'
  //   diffSide 'RIGHT' = post-image -> slop side 'new'  (the util.js:217 map, reversed)
  const side = gh.diffSide === 'LEFT' ? 'old' : 'new'
  // Prefer the line on the CURRENT diff. An "outdated" thread has gh.line ===
  // null because GitHub could no longer re-anchor it, so originalLine (the line
  // at the comment's original commit) is the only number left to fall back to.
  const endLine = pickLine(gh.line, gh.originalLine)
  const startLine = pickLine(gh.startLine, gh.originalStartLine)
  // Multi-line threads carry a start < end; slop anchors at the start with an
  // inclusive line_end. Single-line threads have no start, so line_end is null.
  let line = endLine ?? 1
  let lineEnd = null
  if (startLine != null && endLine != null && startLine < endLine) {
    line = startLine
    lineEnd = endLine
  }

  const comments = (gh.comments?.nodes || []).map((cmt, i) => {
    const comment = {
      id: `${id}_${i + 1}`,
      // "use whatever GitHub has": the author's login, verbatim. Deleted/ghost
      // accounts come back null from the API; fall back to 'ghost' (the same
      // sentinel GitHub itself renders) so the UI never prints "@null".
      user: cmt.author?.login || 'ghost',
      body: cmt.body || '',
      posted_at: cmt.createdAt || null,
    }
    // Permalink to the comment on GitHub (the "Copy link" URL:
    // .../pull/N#discussion_r<id>). The UI turns the synced comment's
    // timestamp into a deep link back to it. Omitted if GitHub gives none.
    if (cmt.url) comment.github_url = cmt.url
    return comment
  })
  const createdAt = comments[0]?.posted_at || existing?.created_at || null

  return {
    id,
    view: 'full',
    file: gh.path,
    line,
    line_end: lineEnd,
    side,
    sha: headSha || null,
    anchor_text: existing?.anchor_text ?? null,   // caller refreshes this
    created_at: createdAt,
    // Preserve the developer's read cursor across re-syncs; a brand-new thread
    // starts "read up to creation" so a later GitHub reply surfaces as unread.
    last_read_at: existing?.last_read_at || createdAt,
    resolved_at: null,
    github_thread_id: gh.id,
    locally_modified: false,
    comments,
  }
}

// Best-effort snapshot of the anchored line's text, read from the repo at the
// relevant ref: HEAD for a new-side anchor, the merge-base (pre-image) for an
// old-side one. Mirrors what the reviewer flow captures in `anchor_text`.
// Returns null on any failure (file gone, binary, ref missing) so a bad read
// never blocks the sync.
async function readAnchorText(repoPath, { side, line, file, headSha, baseSha }) {
  if (!file || !line) return null
  const ref = side === 'old' ? baseSha : headSha
  if (!ref) return null
  try {
    const res = await getFileLines(repoPath, ref, file, line, line)
    if (!res || res.missing || res.binary) return null
    return res.lines?.[0] ?? null
  } catch {
    return null
  }
}

// A review thread we can't pin to a line: GitHub's file-level comments
// (subjectType === 'FILE') and anything missing a path. slop threads require a
// concrete (file, line), so these are reported as skipped rather than guessed
// onto line 1.
function isAnchorable(gh) {
  return gh.subjectType !== 'FILE' && !!gh.path
}

/**
 * Run a full sync for the repo at `repoPath`. Returns a result object the CLI
 * turns into an exit code + summary. Expected soft-stops (detached HEAD, no
 * GitHub remote, no `gh`, no PR) come back as `{ status, message }` rather than
 * throwing; only unexpected failures (a crashing gh call) propagate.
 *
 * `deps` lets tests inject fake GitHub responses; everything defaults to the
 * real gh-CLI / git helpers.
 */
export async function runSync(repoPath, { log = () => {}, deps = {} } = {}) {
  const _getPrNumber = deps.getPrNumber || getPrNumber
  const _fetchReviewThreads = deps.fetchReviewThreads || fetchReviewThreads
  const _isGhAvailable = deps.isGhAvailable || isGhAvailable

  const info = await getBranchInfo(repoPath)
  const branch = info.current_branch
  if (!branch) {
    return { status: 'detached', message: 'cannot sync from a detached HEAD; check out a branch first.' }
  }

  const parsed = parseRemoteUrl(await getOriginUrl(repoPath))
  if (!parsed || parsed.host !== 'github') {
    return {
      status: 'not-github',
      message: `--sync supports GitHub remotes only (origin host: ${parsed?.host || 'none'}).`,
    }
  }
  if (!(await _isGhAvailable())) {
    return {
      status: 'no-gh',
      message: 'the `gh` CLI is required for --sync. Install it and run `gh auth login`.',
    }
  }

  const number = await _getPrNumber(repoPath)
  if (!number) {
    return {
      status: 'no-pr',
      message: `no open pull request found for branch "${branch}"; nothing to sync.`,
    }
  }

  log(`Syncing review threads from ${parsed.owner}/${parsed.repo} PR #${number} ...`)
  const rawThreads = await _fetchReviewThreads(repoPath, parsed.owner, parsed.repo, number)

  const unresolved = rawThreads.filter((t) => t && t.isResolved === false)
  const anchorable = unresolved.filter(isAnchorable)
  const unsupported = unresolved.length - anchorable.length

  const branchId = sanitizeBranchId(branch)
  const localThreads = await readBranchThreads(repoPath, branchId)
  const { toUpsert, toDelete, skippedModified } = planSync(anchorable, localThreads)

  const stats = {
    branch,
    pr_number: number,
    owner: parsed.owner,
    repo: parsed.repo,
    github_unresolved: unresolved.length,
    github_unsupported: unsupported,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped_modified: skippedModified,
  }

  for (const { gh, existing } of toUpsert) {
    const id = existing?.id || newThreadId()
    const thread = mapGithubThreadToSlop(gh, { id, headSha: info.head_sha, existing })
    thread.anchor_text = await readAnchorText(repoPath, {
      side: thread.side,
      line: thread.line,
      file: thread.file,
      headSha: info.head_sha,
      baseSha: info.merge_base_sha,
    })
    // Always overwrite a non-locally-modified thread (planSync already
    // excluded the locally_modified ones). We deliberately don't skip
    // "unchanged" threads: a new GitHub reply, a relocated anchor, or a
    // newly-added field (like github_url) must always land, so re-running
    // sync reliably converges the local copy onto GitHub.
    await writeThread(repoPath, branchId, thread)
    if (existing) stats.updated++
    else stats.created++
  }

  for (const threadId of toDelete) {
    await deleteThread(repoPath, branchId, threadId)
    stats.deleted++
  }

  return { status: 'ok', stats }
}

/** Render the stats object as a short human-facing summary for the CLI. */
export function formatSyncStats(stats) {
  const lines = [
    `Synced PR #${stats.pr_number} (${stats.owner}/${stats.repo}) on branch "${stats.branch}":`,
    `  ${stats.created} created, ${stats.updated} updated`,
    `  ${stats.deleted} deleted (resolved on GitHub), ${stats.skipped_modified} skipped (edited locally)`,
  ]
  if (stats.github_unsupported > 0) {
    lines.push(`  ${stats.github_unsupported} file-level thread(s) skipped (no line anchor)`)
  }
  lines.push(`  ${stats.github_unresolved} unresolved thread(s) on GitHub total`)
  return lines.join('\n')
}
