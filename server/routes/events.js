import { stream } from 'hono/streaming'
import { loadState, findRepo } from '../state.js'
import { subscribe, unsubscribe } from '../watcher.js'

/**
 * SSE endpoint for fs.watch events on `.reviews/<repo_id>/`.
 *
 * The Hono streaming helper handles the keepalive loop and the connection
 * close hook for us. We hand the stream a `write` adapter to fit the
 * watcher's broadcast contract.
 */
export function registerEventRoutes(app) {
  app.get('/api/repos/:id/events', async (c) => {
    const state = await loadState()
    const repo = findRepo(state, c.req.param('id'))
    if (!repo) return c.json({ error: 'repo not found' }, 404)

    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('Connection', 'keep-alive')
    c.header('X-Accel-Buffering', 'no')

    return stream(c, async (s) => {
      const sub = {
        write: (line) => s.write(line),
      }
      const ok = subscribe(repo.id, repo.path, sub)
      if (!ok) {
        await s.write('event: error\ndata: {"error":"watcher init failed"}\n\n')
        return
      }
      // Send a hello event so the client confirms the stream is live.
      await s.write(`event: hello\ndata: {"repo_id":"${repo.id}"}\n\n`)

      let alive = true
      const keepalive = setInterval(() => {
        if (!alive) return
        try { s.write(': keepalive\n\n') } catch {}
      }, 25000)

      s.onAbort(() => {
        alive = false
        clearInterval(keepalive)
        unsubscribe(repo.id, sub)
      })

      // Hold the stream open until the client disconnects.
      // (Hono closes the body when the request aborts; this Promise just
      // keeps the handler scope alive so subscribe stays registered.)
      await new Promise(() => {})
    })
  })
}
