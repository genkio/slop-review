import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
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

const pExecFile = promisify(execFile)

const DEFAULT_EDITOR_LAUNCH = "open -na Ghostty.app --args --command='nvim +%L %F'"

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

  app.post('/api/repos/:id/edit', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const file = String(body?.file || '')
    const line = Number(body?.line || 1)
    if (!file) return c.json({ error: 'file is required' }, 400)
    if (!Number.isFinite(line) || line < 1) return c.json({ error: 'invalid line' }, 400)

    // Path-traversal guard: resolve `<repo>/<file>` and verify the result
    // stays inside the repo path.
    const target = resolve(repo.path, file)
    const repoAbs = resolve(repo.path) + '/'
    if (!target.startsWith(repoAbs)) {
      return c.json({ error: 'path traversal blocked' }, 400)
    }

    const tpl = repo?.config?.editor_launch || DEFAULT_EDITOR_LAUNCH
    const cmd = tpl
      .replaceAll('%L', shellEscape(String(line)))
      .replaceAll('%F', shellEscape(target))
      .replaceAll('%S', shellEscape(sanitizeBranchId(repo.display_name || '')))
      .replaceAll('%W', shellEscape(repo.path))

    try {
      await pExecFile('sh', ['-c', cmd], { timeout: 5000 })
      return c.json({ ok: true, target, line, command: cmd })
    } catch (e) {
      return c.json({ error: e.message || 'editor launch failed', command: cmd }, 500)
    }
  })

  app.get('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const head_sha = c.req.query('head_sha') || null
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    const data = await readReviewed(repo.id, branchId, head_sha)
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
      : [...new Set([...(await readReviewed(repo.id, branchId, head_sha)).paths, ...incoming])]
    const out = await writeReviewed(repo.id, branchId, head_sha, final)
    return c.json({ ok: true, head_sha: out.head_sha, paths: out.paths })
  })

  app.delete('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    await clearReviewed(repo.id, branchId)
    return c.json({ ok: true })
  })
}

// Minimal POSIX-ish shell escape for the editor template substitution.
// Wraps in single quotes and escapes embedded single quotes the standard
// way: `' \\' '`. Not bulletproof against every shell quirk but adequate
// for the file-path / line-number domain.
function shellEscape(s) {
  if (s == null) return "''"
  const str = String(s)
  if (str === '') return "''"
  if (/^[A-Za-z0-9_./@%+:-]+$/.test(str)) return str
  return "'" + str.replaceAll("'", "'\\''") + "'"
}
