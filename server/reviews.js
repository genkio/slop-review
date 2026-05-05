import { readFile, writeFile, rename, chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { currentGhLogin } from './identity.js'

/**
 * `.reviews/` lives **inside each repo** (`<repo_path>/.reviews/<branch_id>/<thread_id>.json`).
 * Previously these files lived under the slop-review install dir keyed by
 * `<repo_id>`; that made the package non-portable (every install had its
 * own state) and decoupled review history from the repo it described.
 *
 * The on-disk layout is now:
 *   <repo>/.reviews/<branch_id>/<thread_id>.json
 *   <repo>/.reviews/<branch_id>/_reviewed.json
 *
 * Callers pass `repoPath` (an absolute filesystem path) — the helpers no
 * longer accept `repoId`, since the id is just a UI-side identifier and
 * has no role in path resolution.
 */

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

function fileFor(repoPath, branchId, threadId) {
  return join(branchDir(repoPath, branchId), `${threadId}.json`)
}

async function safeReaddir(d) {
  try { return await readdir(d) } catch { return [] }
}

/**
 * Read every thread file under `<repo>/.reviews/<branchId>/`. Skips
 * leading-underscore files (`_reviewed.json`) and silently drops anything
 * that fails JSON.parse — one corrupt file should never break the UI.
 */
export async function readBranchThreads(repoPath, branchId) {
  if (!repoPath || !branchId) return []
  const dir = branchDir(repoPath, branchId)
  if (!existsSync(dir)) return []
  const files = await safeReaddir(dir)
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
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
 * Atomic-write-then-rename a thread file. Caller supplies a complete
 * thread object.
 */
export async function writeThread(repoPath, branchId, thread) {
  if (!repoPath || !branchId || !thread?.id) {
    throw new Error('writeThread: missing repo/branch/id')
  }
  const target = fileFor(repoPath, branchId, thread.id)
  await mkdir(dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(thread, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
}

export async function readThread(repoPath, branchId, threadId) {
  const target = fileFor(repoPath, branchId, threadId)
  if (!existsSync(target)) return null
  try {
    const raw = await readFile(target, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function deleteThread(repoPath, branchId, threadId) {
  try {
    await unlink(fileFor(repoPath, branchId, threadId))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

/**
 * Derive the human-facing state of a thread: `your_turn` / `awaiting` /
 * `read`. The single rule is "is the last comment from the human?" plus
 * an unread check on top.
 */
export function deriveState(thread, ghLogin) {
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
  }))
}

/**
 * Resolve a path inside the .reviews tree to its absolute form. Refuses
 * any path that escapes the repo's `.reviews/` root.
 */
export function absoluteThreadPath(repoPath, branchId, threadId) {
  const root = resolve(reviewsRoot(repoPath))
  const target = resolve(fileFor(repoPath, branchId, threadId))
  if (!target.startsWith(root + '/')) {
    throw new Error('path traversal blocked')
  }
  return target
}
