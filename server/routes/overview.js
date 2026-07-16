import { loadState, findRepo } from '../state.js'
import {
  ensureOverviewGeneration,
  getOverviewStatus,
  readOverviewDocument,
} from '../overview.js'

const MAX_ADDITIONAL_PROMPT_LENGTH = 2000

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

  app.get('/api/repos/:id/overview/content', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    try {
      const content = await readOverviewDocument(repo.path)
      if (!content) return c.json({ error: 'overview not found' }, 404)
      c.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
      c.header('Cache-Control', 'no-store')
      c.header('X-Content-Type-Options', 'nosniff')
      c.rawRes.statusCode = 200
      c.rawRes.setHeader('content-type', 'text/html; charset=utf-8')
      c.rawRes.end(content)
      return c
    } catch (e) {
      return c.json({ error: e.message || 'overview content failed' }, 500)
    }
  })

  app.post('/api/repos/:id/overview', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    if (body?.additional_prompt != null && typeof body.additional_prompt !== 'string') {
      return c.json({ error: 'additional_prompt must be a string' }, 400)
    }
    const additionalPrompt = (body?.additional_prompt || '').trim()
    if (additionalPrompt.length > MAX_ADDITIONAL_PROMPT_LENGTH) {
      return c.json({ error: `additional_prompt must be ${MAX_ADDITIONAL_PROMPT_LENGTH} characters or fewer` }, 400)
    }
    try {
      return c.json(await ensureOverviewGeneration(repo.path, {
        force: !!body?.force,
        tool: typeof body?.tool === 'string' ? body.tool : null,
        additionalPrompt,
      }))
    } catch (e) {
      return c.json({ error: e.message || 'overview generation failed' }, 500)
    }
  })
}
