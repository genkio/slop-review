import { getBranchInfo, getOriginUrl, getFileLines } from './git.js'
import { parseRemoteUrl, isGhAvailable, getPrNumber, fetchReviewThreads, fetchReviewSummaries } from './host.js'
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
//                     synced thread. Sync then never overwrites, re-orders, or
//                     deletes such a thread: local edits win. It does still
//                     APPEND comments newly posted on GitHub (matched by
//                     github_url, so nothing already mirrored is duplicated),
//                     letting an edited thread keep catching its later replies.
// ----------------------------------------------------------------------

/**
 * Pure reconciliation. Given the unresolved, line-anchored GitHub threads and
 * the current local thread objects, decide what to do. No I/O, no clock, no
 * randomness, so it's exhaustively unit-testable.
 *
 *   toUpsert: [{ gh, existing }]  existing=null -> create; else -> full refresh
 *                                 (locally_modified threads are NOT in here)
 *   toMerge:  [{ gh, existing }]  locally_modified AND still live on GitHub:
 *                                 append-only -> pull NEW GitHub comments in,
 *                                 preserving every existing comment + local edit
 *   toDelete: [threadId]          unmodified locally but resolved/gone on GitHub
 *   skippedModified: number       locally_modified AND gone from GitHub: nothing
 *                                 to merge, never deleted -> left as-is
 *
 * Threads with no `github_thread_id` (developer-authored, never synced) are
 * invisible to sync: neither upserted, merged, nor deleted.
 */
export function planSync(unresolvedGh, localThreads) {
  const ghById = new Map(unresolvedGh.map((t) => [t.id, t]))
  const localByGh = new Map()
  for (const t of localThreads) {
    if (t.github_thread_id) localByGh.set(t.github_thread_id, t)
  }

  const toDelete = []
  const toMerge = []
  let skippedModified = 0
  for (const t of localByGh.values()) {
    const gh = ghById.get(t.github_thread_id) || null
    if (t.locally_modified) {
      // Local edits win: never overwrite or delete. But a still-live thread
      // can still gain NEW GitHub replies -> merge them in (append-only).
      if (gh) toMerge.push({ gh, existing: t })
      else skippedModified++   // gone from GitHub: nothing to merge, won't delete
      continue
    }
    if (!gh) toDelete.push(t.id)
  }

  const toUpsert = []
  for (const gh of unresolvedGh) {
    const existing = localByGh.get(gh.id) || null
    if (existing?.locally_modified) continue   // handled by toMerge above
    toUpsert.push({ gh, existing })
  }

  return { toUpsert, toMerge, toDelete, skippedModified }
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

/**
 * The GitHub comments on `gh` that aren't yet mirrored in the locally-modified
 * thread `existing`. Pure and append-only: every comment already in `existing`
 * (synced OR developer-authored) is left untouched; this only builds the NEW
 * comment objects to push onto the end, in GitHub's own chronological order.
 *
 * Ids continue the thread's `<id>_<N>` sequence from its current max rather
 * than from the GitHub list position: a developer reply already claimed a
 * number (e.g. `_3`), so a fresh GitHub reply mapped positionally would collide
 * with it and clobber the local comment. Max-plus-one sidesteps that.
 *
 * Appending (vs. re-sorting the whole thread by timestamp) keeps the
 * developer's own comments where they put them and leaves the newest GitHub
 * reply last, so deriveState surfaces the thread as `your_turn`.
 */
export function newGithubComments(existing, gh) {
  const existingComments = existing.comments || []
  const seenUrls = new Set()
  for (const c of existingComments) {
    if (c.github_url) seenUrls.add(c.github_url)
  }
  let maxN = 0
  for (const c of existingComments) {
    const n = parseInt(String(c.id).split('_').pop(), 10)
    if (Number.isInteger(n) && n > maxN) maxN = n
  }

  const appended = []
  for (const cmt of gh.comments?.nodes || []) {
    // Already mirrored, or unkeyable -> skip. github_url is the only stable
    // per-comment identity slop persists; a url-less node (rare: the GraphQL
    // field is nullable) can't be deduped, so appending it would re-duplicate
    // it on every future sync.
    if (!cmt.url || seenUrls.has(cmt.url)) continue

    maxN += 1
    const comment = {
      id: `${existing.id}_${maxN}`,
      user: cmt.author?.login || 'ghost',
      body: cmt.body || '',
      posted_at: cmt.createdAt || null,
    }
    if (cmt.url) comment.github_url = cmt.url
    appended.push(comment)
  }
  return appended
}

/**
 * Synthesize PR review *summary bodies* into GitHub-thread-shaped objects so
 * they ride the same reconcile/create/merge/delete pipeline as real review
 * threads. A review body has no line anchor, so the synthetic thread carries no
 * file/line (`path: null`): the UI renders it "anchor lost" (not pinned to a
 * diff row) but still counts it and walks it in the thread nav, where a fileless
 * thread sorts first. An `_prLevel` marker the upsert step turns into
 * `pr_level: true` drives the "PR" badge. Reviews with an empty body (a bare
 * review wrapping inline replies) are dropped. The review's GraphQL node id
 * becomes the synthetic thread id, so re-syncs match and update instead of
 * duplicating. Pure: no I/O.
 */
export function reviewSummaryThreads(reviews) {
  const out = []
  for (const r of reviews || []) {
    if (!r || !(r.body || '').trim()) continue
    out.push({
      id: r.id,
      _prLevel: true,
      path: null,
      line: null,
      comments: { nodes: [{ author: r.author || null, body: r.body, createdAt: r.submittedAt || null, url: r.url || null }] },
    })
  }
  return out
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
  const _fetchReviewSummaries = deps.fetchReviewSummaries || fetchReviewSummaries
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

  // PR-level review summaries (no line anchor) ride the same pipeline as real
  // threads, carrying no file so the UI renders them "anchor lost". Additive and
  // best-effort: a failure here must never sink the inline-thread sync, so we
  // swallow it and carry on.
  let reviewSummaries = []
  try {
    const { reviews, truncated } = await _fetchReviewSummaries(repoPath, parsed.owner, parsed.repo, number)
    reviewSummaries = reviewSummaryThreads(reviews)
    if (truncated) log('  note: PR has >100 reviews; only the first 100 summary bodies were considered.')
  } catch (e) {
    log(`  note: could not fetch PR review summaries (${e.message}); synced inline threads only.`)
  }

  const branchId = sanitizeBranchId(branch)
  const localThreads = await readBranchThreads(repoPath, branchId)
  const { toUpsert, toMerge, toDelete, skippedModified } = planSync([...anchorable, ...reviewSummaries], localThreads)

  const stats = {
    branch,
    pr_number: number,
    owner: parsed.owner,
    repo: parsed.repo,
    github_unresolved: unresolved.length,
    github_unsupported: unsupported,
    created: 0,
    updated: 0,
    merged: 0,
    merged_comments: 0,
    pr_summaries: 0,
    deleted: 0,
    skipped_modified: skippedModified,
  }

  for (const { gh, existing } of toUpsert) {
    const id = existing?.id || newThreadId()
    const thread = mapGithubThreadToSlop(gh, { id, headSha: info.head_sha, existing })
    if (gh._prLevel) {
      thread.pr_level = true
      // A review body isn't anchored to a line the reviewer read code at, so a
      // brand-new summary must NOT start "read up to creation" like a real
      // thread would. Backdate last_read_at to the epoch so it surfaces as
      // unread (your_turn) until the developer opens it. A truthy epoch (vs
      // null) survives mapGithubThreadToSlop's `existing.last_read_at || ...`
      // coalesce on later syncs, so it stays unread across re-syncs.
      if (!existing) thread.last_read_at = '1970-01-01T00:00:00.000Z'
    }
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
    if (gh._prLevel) stats.pr_summaries++
    else if (existing) stats.updated++
    else stats.created++
  }

  // Locally-modified threads: append-only merge. We never rewrite or re-order
  // what the developer already has, only push GitHub comments they haven't seen
  // yet onto the end. A merge that finds nothing new counts as a skip (edited
  // locally, no fresh GitHub replies this round).
  for (const { gh, existing } of toMerge) {
    const appended = newGithubComments(existing, gh)
    if (appended.length === 0) { stats.skipped_modified++; continue }
    const thread = { ...existing, comments: [...(existing.comments || []), ...appended] }
    await writeThread(repoPath, branchId, thread)
    stats.merged++
    stats.merged_comments += appended.length
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
    `  ${stats.created} created, ${stats.updated} updated, ${stats.merged} merged`,
    `  ${stats.deleted} deleted (resolved on GitHub), ${stats.skipped_modified} skipped (edited locally)`,
  ]
  if (stats.merged_comments > 0) {
    lines.push(`  ${stats.merged_comments} new GitHub comment(s) appended to edited thread(s)`)
  }
  if (stats.pr_summaries > 0) {
    lines.push(`  ${stats.pr_summaries} PR-level review summary thread(s) (no line anchor)`)
  }
  if (stats.github_unsupported > 0) {
    lines.push(`  ${stats.github_unsupported} file-level thread(s) skipped (no line anchor)`)
  }
  lines.push(`  ${stats.github_unresolved} unresolved thread(s) on GitHub total`)
  return lines.join('\n')
}
