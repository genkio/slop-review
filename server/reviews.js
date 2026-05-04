import { readFile, writeFile, rename, chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { currentGhLogin } from './identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REVIEWS_DIR = join(__dirname, '..', '.reviews')

export function newThreadId() {
  const r = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `thread_${r}`
}

/**
 * Sanitize a branch name for use as a directory. Same rules as taiou's
 * tmux session naming: anything outside [A-Za-z0-9_-] collapses to `-`,
 * leading/trailing dashes trimmed, capped at 80 chars. Two different
 * branches will not collide unless their pre-sanitization names already
 * differed only in characters that all become `-` AND are >80 chars.
 */
export function sanitizeBranchId(branch) {
  if (!branch) return ''
  let s = String(branch)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

export function branchDir(repoId, branchId) {
  return join(REVIEWS_DIR, repoId, branchId)
}

function fileFor(repoId, branchId, threadId) {
  return join(branchDir(repoId, branchId), `${threadId}.json`)
}

async function safeReaddir(d) {
  try { return await readdir(d) } catch { return [] }
}

/**
 * Read every thread file under `.reviews/<repoId>/<branchId>/`. Skips
 * leading-underscore files (`_reviewed.json`) and silently drops anything
 * that fails JSON.parse — one corrupt file should never break the UI.
 */
export async function readBranchThreads(repoId, branchId) {
  if (!repoId || !branchId) return []
  const dir = branchDir(repoId, branchId)
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
 * Atomic-write-then-rename a thread file. Mirrors taiou's pattern.
 * Caller must supply repoId + branchId + a complete thread object.
 */
export async function writeThread(repoId, branchId, thread) {
  if (!repoId || !branchId || !thread?.id) {
    throw new Error('writeThread: missing repo/branch/id')
  }
  const target = fileFor(repoId, branchId, thread.id)
  await mkdir(dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(thread, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
}

export async function readThread(repoId, branchId, threadId) {
  const target = fileFor(repoId, branchId, threadId)
  if (!existsSync(target)) return null
  try {
    const raw = await readFile(target, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function deleteThread(repoId, branchId, threadId) {
  try {
    await unlink(fileFor(repoId, branchId, threadId))
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

export async function listThreadsWithState(repoId, branchId) {
  const [threads, gh] = await Promise.all([
    readBranchThreads(repoId, branchId),
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
 * any path that escapes REVIEWS_DIR — used for the agent-handoff prompt's
 * absolute-path rendering.
 */
export function absoluteThreadPath(repoId, branchId, threadId) {
  const target = resolve(fileFor(repoId, branchId, threadId))
  if (!target.startsWith(resolve(REVIEWS_DIR) + '/')) {
    throw new Error('path traversal blocked')
  }
  return target
}
