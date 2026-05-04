import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { loadState } from './state.js'
import { registerRepoRoutes } from './routes/repos.js'
import { registerDiffRoutes } from './routes/diff.js'
import { registerThreadRoutes } from './routes/threads.js'
import { registerEventRoutes } from './routes/events.js'
import { shutdownAllWatchers } from './watcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const PUBLIC_DIR_REL = relative(process.cwd(), join(PROJECT_ROOT, 'public')) || '.'
const PORT = 4919

const app = new Hono()

app.get('/api/state', async (c) => {
  const state = await loadState()
  return c.json(state)
})

registerRepoRoutes(app)
registerDiffRoutes(app)
registerThreadRoutes(app)
registerEventRoutes(app)

app.use(
  '/*',
  serveStatic({
    root: PUBLIC_DIR_REL,
    rewriteRequestPath: (path) => (path === '/' ? '/index.html' : path),
  })
)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`slop-review running on http://0.0.0.0:${info.port}`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdownAllWatchers()
    process.exit(0)
  })
}
