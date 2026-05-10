import { readFile, writeFile, rename, chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { currentGhLogin } from './identity.js'

/**
 * `.reviews/` lives **inside each repo** (`<repo_path>/.reviews/<branch_id>/<filename>`).
 *
 * Filename pattern: `thread_<status>_<8hex>.json` where `status` ∈ `{open, resolved}`.
 * The status is encoded into the filename (rather than only into the JSON's
 * `resolved_at` field) so `ls` and the agent can read the resolution status
 * without parsing every file:
 *
 *   .reviews/main/thread_open_1d7c31d8.json       ← unresolved
 *   .reviews/main/thread_resolved_a1b2c3d4.json   ← resolved
 *
 * The thread's `id` field stays stable as `thread_<8hex>` across resolve /
 * unresolve transitions — only the filename changes. Comment ids
 * (`<thread_id>_<N>`) are anchored to the stable `id`, so toggling resolve
 * never re-stamps comment ids or invalidates the modal's open-by-id refs.
 */

const THREAD_FILE_RE = /^thread_(open|resolved)_([0-9a-f]{8})\.json$/

export function reviewsRoot(repoPath) {
  return join(repoPath, '.reviews')
}

export function newThreadId() {
  const r = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `thread_${r}`
}

/**
 * Sanitize a branch name for use as a directory. Same rules as taiou's
 * tmux session naming: anything outside [A-Za-z0-9_-] collapses to `-`,
 * leading/trailing dashes trimmed, capped at 80 chars.
 */
export function sanitizeBranchId(branch) {
  if (!branch) return ''
  let s = String(branch)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

export function branchDir(repoPath, branchId) {
  return join(reviewsRoot(repoPath), branchId)
}

/**
 * Compose the on-disk filename for a thread based on its current state.
 * The status segment mirrors `resolved_at`: non-null → `resolved`, else `open`.
 */
export function fileNameFor(thread) {
  if (!thread?.id?.startsWith('thread_')) {
    throw new Error('fileNameFor: invalid thread.id (expected thread_<hex>)')
  }
  const hex = thread.id.slice('thread_'.length)
  const status = thread.resolved_at ? 'resolved' : 'open'
  return `thread_${status}_${hex}.json`
}

async function safeReaddir(d) {
  try { return await readdir(d) } catch { return [] }
}

/**
 * Locate the on-disk filename for a given thread id. Each thread can be in
 * exactly one of two states (open or resolved), so there are at most two
 * possible filenames for a given id — we just probe both with existsSync
 * rather than reading the whole directory listing.
 */
export function findThreadFile(repoPath, branchId, threadId) {
  if (!threadId?.startsWith('thread_')) return null
  const hex = threadId.slice('thread_'.length)
  const dir = branchDir(repoPath, branchId)
  for (const status of ['open', 'resolved']) {
    const name = `thread_${status}_${hex}.json`
    if (existsSync(join(dir, name))) return name
  }
  return null
}

/**
 * Read every thread file under `<repo>/.reviews/<branchId>/`. Skips
 * anything whose name doesn't match `thread_<status>_<8hex>.json` —
 * leading-underscore sidecars (`_reviewed.json`, `_overview.json`) and any
 * other stray files are filtered out by the regex check. JSON.parse
 * failures are silently skipped so one corrupt file doesn't break the UI.
 */
export async function readBranchThreads(repoPath, branchId) {
  if (!repoPath || !branchId) return []
  const dir = branchDir(repoPath, branchId)
  if (!existsSync(dir)) return []
  const files = await safeReaddir(dir)
  const out = []
  for (const f of files) {
    if (!THREAD_FILE_RE.test(f)) continue
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      const data = JSON.parse(raw)
      if (data?.id) out.push(data)
    } catch {
      // skip corrupt/unreadable
    }
  }
  return out
}

/**
 * Atomic-write-then-rename. Caller supplies a complete thread object; the
 * filename is derived from `thread.resolved_at`. If a file exists for this
 * thread under the *other* status name (i.e. the resolve toggle just
 * flipped), the old file is unlinked after the new one lands so the
 * directory holds at most one file per thread id.
 */
export async function writeThread(repoPath, branchId, thread) {
  if (!repoPath || !branchId || !thread?.id) {
    throw new Error('writeThread: missing repo/branch/id')
  }
  const dir = branchDir(repoPath, branchId)
  await mkdir(dir, { recursive: true })
  const targetName = fileNameFor(thread)
  const target = join(dir, targetName)
  // Note any pre-existing file for this id BEFORE we write — we'll prune it
  // below if its name doesn't match the new target.
  const existingName = findThreadFile(repoPath, branchId, thread.id)
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(thread, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
  if (existingName && existingName !== targetName) {
    try { await unlink(join(dir, existingName)) } catch {}
  }
}

export async function readThread(repoPath, branchId, threadId) {
  const name = findThreadFile(repoPath, branchId, threadId)
  if (!name) return null
  try {
    const raw = await readFile(join(branchDir(repoPath, branchId), name), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function deleteThread(repoPath, branchId, threadId) {
  const name = findThreadFile(repoPath, branchId, threadId)
  if (!name) return
  try {
    await unlink(join(branchDir(repoPath, branchId), name))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

/**
 * Derive the human-facing state of a thread: `resolved` / `your_turn` /
 * `awaiting` / `read`. `resolved_at` short-circuits everything — once a
 * thread is marked resolved, comment activity stops driving the pill
 * until the human explicitly unresolves it. Otherwise the single rule is
 * "is the last comment from the human?" plus an unread check on top.
 */
export function deriveState(thread, ghLogin) {
  if (thread.resolved_at) return 'resolved'
  const last = thread.comments?.[thread.comments.length - 1]
  if (!last) return 'awaiting'
  if (last.user === ghLogin) return 'awaiting'
  const lastAt = Date.parse(last.posted_at || '') || 0
  const readAt = Date.parse(thread.last_read_at || '') || 0
  return lastAt > readAt ? 'your_turn' : 'read'
}

export async function listThreadsWithState(repoPath, branchId) {
  const [threads, gh] = await Promise.all([
    readBranchThreads(repoPath, branchId),
    currentGhLogin(),
  ])
  return threads.map((t) => ({
    ...t,
    state: deriveState(t, gh),
    last_comment_at: t.comments?.[t.comments.length - 1]?.posted_at || t.created_at || null,
    file_name: fileNameFor(t),
  }))
}
