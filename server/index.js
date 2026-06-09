import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { createApp, serve, serveStatic } from './http.js'
import { loadState, saveState, findRepo } from './state.js'
import { registerDiffRoutes } from './routes/diff.js'
import { registerThreadRoutes } from './routes/threads.js'
import { registerOverviewRoutes } from './routes/overview.js'
import { shutdownAllOverviewJobs } from './overview.js'
import { startSyncLoop } from './sync.js'
import { markSyncEnabled, recordSyncResult, recordSyncError, getSyncStatus } from './sync-status.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const PUBLIC_DIR_REL = relative(process.cwd(), join(PROJECT_ROOT, 'public')) || '.'

const DEFAULT_PORT = 9410

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
export async function start({ port = DEFAULT_PORT, hostname = '0.0.0.0', startSync = false, syncSeed = null } = {}) {
  // Hard requirement: the active repo is derived from this env var. The
  // bin shim sets it from cwd; running `node server/index.js` directly
  // (without the env) is unsupported now that bookmark-CRUD is gone.
  if (!process.env.SLOP_REVIEW_REPO) {
    console.error('slop-review: SLOP_REVIEW_REPO is not set.')
    console.error('Run via `npx slop-review` (or `slop-review` after `npm link`) inside a git repo,')
    console.error('or set SLOP_REVIEW_REPO=$PWD before invoking the server directly.')
    process.exit(1)
  }

  const app = createApp()

  app.get('/api/state', async (c) => {
    const state = await loadState()
    return c.json(state)
  })

  // Per-repo UI-state bucket — a partial-update sink for transient
  // bookkeeping the frontend wants to survive across restarts (port
  // changes). Today's only user is the thread-cursor resume bookmark
  // for the counts-strip total, but the endpoint is intentionally
  // generic: every field in the request body merges into
  // `state.config.repo_ui_state[repoId]`, with `null` values deleting
  // that field. New UI state additions (default view mode, filter
  // prefs, etc.) ride the same wire format — no new endpoint per field.
  // localStorage was the obvious first choice client-side but is
  // origin-scoped: slop-review picks a free port each launch, so each
  // session gets a fresh storage namespace and the cursor would vanish.
  // state.json lives under ~/.config/slop-review and is port-independent.
  app.patch('/api/repos/:id/ui-state', async (c) => {
    const state = await loadState()
    const repo = findRepo(state, c.req.param('id'))
    if (!repo) return c.json({ error: 'repo not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400)
    }
    state.config = state.config || {}
    state.config.repo_ui_state = state.config.repo_ui_state || {}
    const bucket = state.config.repo_ui_state[repo.id] || {}
    for (const [k, v] of Object.entries(body)) {
      if (v === null || v === undefined) delete bucket[k]
      else bucket[k] = v
    }
    state.config.repo_ui_state[repo.id] = bucket
    await saveState(state)
    return c.json({ ok: true, ui_state: bucket })
  })

  // Background-sync health for the diff-header badge (public/sync-status.js).
  // Process-global: one slop process serves one repo. `enabled` is false on a
  // normal launch, which keeps the badge hidden.
  app.get('/api/sync-status', (c) => c.json(getSyncStatus()))

  registerDiffRoutes(app)
  registerThreadRoutes(app)
  registerOverviewRoutes(app)

  app.use(
    '/*',
    serveStatic({
      root: PUBLIC_DIR_REL,
      rewriteRequestPath: (path) => (path === '/' ? '/index.html' : path),
    })
  )

  return new Promise((resolve) => {
    const server = serve({ app, port, hostname }, (info) => {
      console.log(`slop-review running on http://${hostname}:${info.port}`)
      resolve({ server, info })
    })

    // For a `--sync` session, mirror GitHub on a fixed interval. The loop lives
    // here (not the bin shim) so its status feeds /api/sync-status from the same
    // process. syncSeed is the launch sync's result, so the badge reads "Synced
    // just now" immediately instead of waiting a full interval for the first tick.
    let stopSync = null
    if (startSync) {
      markSyncEnabled()
      if (syncSeed) recordSyncResult(syncSeed)
      stopSync = startSyncLoop(process.env.SLOP_REVIEW_REPO, {
        onResult: recordSyncResult,
        onError: recordSyncError,
      })
    }

    // Single shutdown point. Stopping the loop is belt-and-suspenders -- the
    // timer dies with the process anyway -- but it makes intent explicit:
    // quitting slop-review halts the GitHub pull. Covers terminal Ctrl-C and,
    // under carbonyl, the SIGINT delivered to the shared process group.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        if (stopSync) stopSync()
        shutdownAllOverviewJobs()
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
