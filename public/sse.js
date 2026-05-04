/**
 * Per-repo EventSource subscription. The diff modal and the threads page
 * both use this to live-refresh when `.reviews/<repo>/<branch>/*.json`
 * changes (typically via the LLM appending a reply).
 *
 * Reuses one EventSource per repoId across subscribers so we don't open
 * N parallel SSE connections — each tab needs only one. The handler list
 * is keyed by callback function so unsubscribe is symmetrical.
 *
 * EventSource itself handles reconnection on disconnect with an
 * exponential backoff baked into the spec, so we don't roll our own.
 */

const sources = new Map()  // repoId → { es, handlers: Set<(payload) => void> }

export function subscribeRepoEvents(repoId, handler) {
  let entry = sources.get(repoId)
  if (!entry) {
    const url = `/api/repos/${encodeURIComponent(repoId)}/events`
    const es = new EventSource(url)
    entry = { es, handlers: new Set() }
    sources.set(repoId, entry)

    const onMessage = (e) => {
      let payload
      try { payload = JSON.parse(e.data) } catch { return }
      for (const h of entry.handlers) {
        try { h(payload) } catch (err) { console.error('SSE handler threw:', err) }
      }
    }
    es.addEventListener('thread_changed', onMessage)
    es.addEventListener('hello', () => {})
    es.addEventListener('error', () => {
      // EventSource auto-reconnects; surface to console for visibility but
      // don't tear down — a transient disconnect shouldn't break the loop.
      // If the connection truly dies (server gone), the user sees stale
      // data until they refresh.
    })
  }

  entry.handlers.add(handler)
  return () => unsubscribeRepoEvents(repoId, handler)
}

export function unsubscribeRepoEvents(repoId, handler) {
  const entry = sources.get(repoId)
  if (!entry) return
  entry.handlers.delete(handler)
  if (entry.handlers.size === 0) {
    try { entry.es.close() } catch {}
    sources.delete(repoId)
  }
}
