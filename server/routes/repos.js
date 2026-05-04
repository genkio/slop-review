import { resolve, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { loadState, saveState, findRepo } from '../state.js'
import { isGitRepo } from '../git.js'

function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

function deriveRepoId(absPath) {
  const base = basename(absPath).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 8)
  return `${base}_${hash}`
}

export function registerRepoRoutes(app) {
  app.post('/api/repos', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const raw = String(body?.path || '').trim()
    if (!raw) return c.json({ error: 'path is required' }, 400)
    const abs = resolve(expandHome(raw))
    if (!existsSync(abs)) return c.json({ error: `path does not exist: ${abs}` }, 400)
    if (!(await isGitRepo(abs))) return c.json({ error: `not a git repo: ${abs}` }, 400)

    const state = await loadState()
    const id = deriveRepoId(abs)
    if (state.repos.find((r) => r.id === id)) {
      return c.json({ error: 'repo already added' }, 409)
    }
    state.repos.push({
      id,
      path: abs,
      display_name: basename(abs),
      added_at: new Date().toISOString(),
    })
    await saveState(state)
    return c.json({ state, repo_id: id })
  })

  app.delete('/api/repos/:id', async (c) => {
    const id = c.req.param('id')
    const state = await loadState()
    const before = state.repos.length
    state.repos = state.repos.filter((r) => r.id !== id)
    if (state.repos.length === before) return c.json({ error: 'repo not found' }, 404)
    await saveState(state)
    return c.json({ state })
  })
}

// Re-exported for routes that need to look up a repo by id without re-loading.
export { findRepo }
