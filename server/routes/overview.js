import { loadState, findRepo } from '../state.js'
import { ensureOverviewGeneration, getOverviewStatus } from '../overview.js'

async function withRepo(c) {
  const state = await loadState()
  const repo = findRepo(state, c.req.param('id'))
  if (!repo) {
    return { error: c.json({ error: 'repo not found' }, 404) }
  }
  return { state, repo }
}

export function registerOverviewRoutes(app) {
  app.get('/api/repos/:id/overview', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    try {
      return c.json(await getOverviewStatus(repo.path))
    } catch (e) {
      return c.json({ error: e.message || 'overview status failed' }, 500)
    }
  })

  app.post('/api/repos/:id/overview', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    try {
      return c.json(await ensureOverviewGeneration(repo.path, { force: !!body?.force }))
    } catch (e) {
      return c.json({ error: e.message || 'overview generation failed' }, 500)
    }
  })
}
