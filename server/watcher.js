import { watch, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Per-repo fs.watch + SSE broadcast. Watch root is `<repo_path>/.reviews/`
 * — the repo's own review tree, not a centralized one.
 *
 * Subscriber bookkeeping is still keyed by `repoId` (a stable UI-side
 * identifier) since multiple browser tabs on the same repo should share
 * one watcher; the path is only needed once at watcher-creation time.
 *
 * Lifecycle:
 *   - Watcher created lazily on first subscriber (with the path the caller
 *     supplies).
 *   - Torn down when the last subscriber disconnects.
 *   - On macOS / Linux, `fs.watch` with `recursive: true` covers nested
 *     `<branch_id>/thread_<status>_<hex>.json` writes from a single root
 *     handle.
 *
 * No polling fallback — slop-review is a single-user local-machine app
 * where fs.watch's quirks don't matter in practice. If they bite, the
 * user can hit ↻ refresh.
 */

const watchers = new Map()  // repoId → { fsHandle, subscribers: Set<Sub>, root: string }

function ensureWatcher(repoId, repoPath) {
  let entry = watchers.get(repoId)
  if (entry) return entry

  const root = join(repoPath, '.reviews')
  // fs.watch on a missing dir throws; ensure it exists first so the
  // watcher is ready before the first thread is created.
  try { mkdirSync(root, { recursive: true }) } catch {}

  let fsHandle
  try {
    fsHandle = watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      // Filename is relative to root: `<branch_id>/thread_<status>_<hex>.json`
      // (sidecars like `_reviewed.json` / `_overview.json` are filtered out
      // by the regex below).
      const parts = String(filename).split(sep)
      if (parts.length < 2) return
      const branch_id = parts[0]
      const file = parts[parts.length - 1]
      // Strip the .tmp suffix from atomic writes — clients shouldn't see
      // intermediate file names.
      const base = file.endsWith('.tmp') ? file.slice(0, -4) : file
      // Extract the stable thread id (`thread_<hex>`) from the filename so
      // the SSE payload matches each thread's `id` field regardless of
      // which status segment the file currently carries.
      const m = base.match(/^thread_(?:open|resolved)_([0-9a-f]{8})\.json$/)
      if (!m) return  // unrecognized filename — skip
      const thread_id = `thread_${m[1]}`
      const change = eventType === 'rename' ? 'created_or_deleted' : 'modified'
      broadcast(repoId, { type: 'thread_changed', branch_id, thread_id, change })
    })
  } catch (e) {
    console.error(`[slop-review] fs.watch failed for ${root}:`, e.message)
    return null
  }

  entry = { fsHandle, subscribers: new Set(), root }
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

export function subscribe(repoId, repoPath, sub) {
  const entry = ensureWatcher(repoId, repoPath)
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
