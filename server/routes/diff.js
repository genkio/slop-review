import { loadState, findRepo } from '../state.js'
import {
  getBranchInfo,
  getCommits,
  getCommitDiff,
  getFullDiff,
  getLocalDiff,
  isValidSha,
} from '../git.js'
import {
  computePrioritiesAtSha,
  computePrioritiesForWorktree,
} from '../diff-priorities.js'
import { readReviewed, writeReviewed, clearReviewed } from '../reviewed.js'
import { sanitizeBranchId } from '../reviews.js'

async function withRepo(c) {
  const state = await loadState()
  const repo = findRepo(state, c.req.param('id'))
  if (!repo) {
    return { error: c.json({ error: 'repo not found' }, 404) }
  }
  return { state, repo }
}

export function registerDiffRoutes(app) {
  app.get('/api/repos/:id/branch', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const info = await getBranchInfo(repo.path)
    return c.json(info)
  })

  app.get('/api/repos/:id/commits', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const info = await getBranchInfo(repo.path)
    if (!info.merge_base_sha || !info.head_sha) {
      return c.json({ commits: [] })
    }
    const commits = await getCommits(repo.path, info.merge_base_sha, info.head_sha)
    return c.json({ commits })
  })

  app.get('/api/repos/:id/commits/:sha/diff', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const sha = c.req.param('sha')
    if (!isValidSha(sha)) return c.json({ error: 'invalid sha' }, 400)
    try {
      const diff = await getCommitDiff(repo.path, sha)
      return c.json(diff)
    } catch (e) {
      return c.json({ error: e.message || 'commit diff failed' }, 500)
    }
  })

  app.get('/api/repos/:id/diff', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const info = await getBranchInfo(repo.path)
    if (!info.merge_base_sha || !info.head_sha) {
      return c.json({ error: 'no merge base / head sha — branch state unsuitable for full diff' }, 409)
    }
    try {
      const diff = await getFullDiff(repo.path, info.merge_base_sha, info.head_sha)
      diff.priorities = await computePrioritiesAtSha(repo.path, diff.sha, diff.files)
      return c.json(diff)
    } catch (e) {
      return c.json({ error: e.message || 'full diff failed' }, 500)
    }
  })

  app.get('/api/repos/:id/local-diff', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    try {
      const diff = await getLocalDiff(repo.path)
      diff.priorities = await computePrioritiesForWorktree(repo.path, diff.files)
      return c.json(diff)
    } catch (e) {
      return c.json({ error: e.message || 'local diff failed' }, 500)
    }
  })

  app.get('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const head_sha = c.req.query('head_sha') || null
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    const data = await readReviewed(repo.path, branchId, head_sha)
    return c.json({ head_sha: head_sha || data.head_sha, paths: data.paths })
  })

  app.put('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const head_sha = String(body?.head_sha || '')
    const incoming = Array.isArray(body?.paths) ? body.paths : []
    // mode='add' (default): merge incoming into existing — used by the
    // bulk "Mark visible reviewed" action where the user has selected a
    // subset and means "add THESE to whatever's already marked".
    // mode='replace': overwrite existing with incoming — used by the
    // per-file toggle where the client computes the new full set itself.
    const mode = body?.mode === 'replace' ? 'replace' : 'add'
    if (!head_sha) return c.json({ error: 'head_sha required' }, 400)
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    const final = mode === 'replace'
      ? incoming
      : [...new Set([...(await readReviewed(repo.path, branchId, head_sha)).paths, ...incoming])]
    const out = await writeReviewed(repo.path, branchId, head_sha, final)
    return c.json({ ok: true, head_sha: out.head_sha, paths: out.paths })
  })

  app.delete('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    await clearReviewed(repo.path, branchId)
    return c.json({ ok: true })
  })
}
