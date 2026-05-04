import { watch, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { REVIEWS_DIR } from './reviews.js'

/**
 * Per-repo fs.watch + SSE broadcast. One watcher per `.reviews/<repo_id>/`
 * tree (recursive); subscribers register through the SSE endpoint and
 * receive `{ type, thread_id, change, branch_id }` events as JSON.
 *
 * Lifecycle:
 *   - Watcher created lazily on first subscriber.
 *   - Torn down when the last subscriber disconnects.
 *   - On macOS / Linux, fs.watch with `recursive: true` covers nested
 *     `<branch_id>/<thread_id>.json` writes from a single root handle.
 *
 * No polling fallback — slop-review is a single-user local-machine app
 * where fs.watch's quirks don't matter in practice. If they bite, the
 * user can always hit ↻ refresh.
 */

const watchers = new Map()  // repoId → { fsHandle, subscribers: Set<Sub> }

function ensureWatcher(repoId) {
  let entry = watchers.get(repoId)
  if (entry) return entry

  const root = join(REVIEWS_DIR, repoId)
  // fs.watch on a missing dir throws; ensure it exists first so the
  // watcher is ready before the first thread is created.
  try { mkdirSync(root, { recursive: true }) } catch {}

  let fsHandle
  try {
    fsHandle = watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      // Filename is relative to root: `<branch_id>/<thread_id>.json` (or
      // `<branch_id>/_reviewed.json`, which we suppress).
      const parts = String(filename).split(sep)
      if (parts.length < 2) return
      const branch_id = parts[0]
      const file = parts[parts.length - 1]
      if (!file.endsWith('.json')) return
      if (file.startsWith('_')) return
      // Strip the .tmp suffix from atomic writes — clients shouldn't see
      // intermediate file names.
      const base = file.endsWith('.tmp') ? file.slice(0, -4) : file
      const thread_id = base.replace(/\.json$/, '')
      const change = eventType === 'rename' ? 'created_or_deleted' : 'modified'
      broadcast(repoId, { type: 'thread_changed', branch_id, thread_id, change })
    })
  } catch (e) {
    console.error(`[slop-review] fs.watch failed for ${root}:`, e.message)
    return null
  }

  entry = { fsHandle, subscribers: new Set() }
  watchers.set(repoId, entry)
  return entry
}

function broadcast(repoId, payload) {
  const entry = watchers.get(repoId)
  if (!entry) return
  const line = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const sub of entry.subscribers) {
    try { sub.write(line) } catch {}
  }
}

export function subscribe(repoId, sub) {
  const entry = ensureWatcher(repoId)
  if (!entry) return false
  entry.subscribers.add(sub)
  return true
}

export function unsubscribe(repoId, sub) {
  const entry = watchers.get(repoId)
  if (!entry) return
  entry.subscribers.delete(sub)
  if (entry.subscribers.size === 0) {
    try { entry.fsHandle.close() } catch {}
    watchers.delete(repoId)
  }
}

export function shutdownAllWatchers() {
  for (const entry of watchers.values()) {
    try { entry.fsHandle.close() } catch {}
  }
  watchers.clear()
}
