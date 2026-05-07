import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { loadState } from './state.js'
import { registerDiffRoutes } from './routes/diff.js'
import { registerThreadRoutes } from './routes/threads.js'
import { registerEventRoutes } from './routes/events.js'
import { shutdownAllWatchers } from './watcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const PUBLIC_DIR_REL = relative(process.cwd(), join(PROJECT_ROOT, 'public')) || '.'

const DEFAULT_PORT = 4919

/**
 * Build and start the slop-review server. Returned promise resolves once
 * the listener is actually accepting connections — this is what the bin
 * shim awaits before opening the user's browser.
 *
 * Exported as a function so the same module is reusable from:
 *   - `npm start` (runs this file as the entry; the run-as-main check at
 *     the bottom kicks off `start()` with env-derived defaults)
 *   - `bin/slop-review.js` (imports and awaits `start({ port })` directly)
 */
export async function start({ port = DEFAULT_PORT, hostname = '0.0.0.0' } = {}) {
  // Hard requirement: the active repo is derived from this env var. The
  // bin shim sets it from cwd; running `node server/index.js` directly
  // (without the env) is unsupported now that bookmark-CRUD is gone.
  if (!process.env.SLOP_REVIEW_REPO) {
    console.error('slop-review: SLOP_REVIEW_REPO is not set.')
    console.error('Run via `npx slop-review` (or `slop-review` after `npm link`) inside a git repo,')
    console.error('or set SLOP_REVIEW_REPO=$PWD before invoking the server directly.')
    process.exit(1)
  }

  const app = new Hono()

  app.get('/api/state', async (c) => {
    const state = await loadState()
    return c.json(state)
  })

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

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`slop-review running on http://${hostname}:${info.port}`)
      resolve({ server, info })
    })

    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        shutdownAllWatchers()
        process.exit(0)
      })
    }
  })
}

// Run-as-main: if this file was invoked directly (via `node server/index.js`
// or `npm start`), kick off the server. When imported by the bin shim, this
// branch is skipped and the bin awaits `start()` itself.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = Number(process.env.SLOP_REVIEW_PORT || process.env.PORT) || DEFAULT_PORT
  start({ port })
}
