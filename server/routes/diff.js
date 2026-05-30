import { loadState, findRepo } from '../state.js'
import {
  findSymbolDefinition,
  getBranchInfo,
  getCommits,
  getFileLines,
  getHeadPreview,
  getOriginUrl,
  isValidSha,
  isValidSymbol,
} from '../git.js'
import { parseRemoteUrl, getPullRequestUrl } from '../host.js'
import { readReviewed, writeReviewed, clearReviewed } from '../reviewed.js'
import { sanitizeBranchId } from '../reviews.js'
import { loadFullDiff, loadCommitDiff, loadLocalDiff } from '../../core/actions.js'

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

  // Host / PR metadata for the "GitHub" deep-link button. Returns enough
  // for the client to construct the `pull/N/files#diff-<hash>R<line>` URL:
  // forge identity (host/owner/repo) plus the PR url itself. All fields
  // are null when unavailable (no remote, unknown host, no PR yet, `gh`
  // not installed) — the client treats null as "hide the button", so a
  // single endpoint covers every degraded state without bespoke 4xx codes.
  app.get('/api/repos/:id/pr-info', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const info = await getBranchInfo(repo.path)
    const branch = info.current_branch
    const originUrl = await getOriginUrl(repo.path)
    const parsed = parseRemoteUrl(originUrl)
    if (!parsed || !parsed.host) {
      return c.json({ host: null, owner: null, repo: null, pr_url: null })
    }
    const pr_url = branch ? await getPullRequestUrl(repo.path, branch, parsed.host) : null
    return c.json({
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      pr_url,
    })
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
    try {
      return c.json(await loadCommitDiff(repo.path, c.req.param('sha')))
    } catch (e) {
      return c.json({ error: e.message || 'commit diff failed' }, e.status || 500)
    }
  })

  // Peek what a commit-view line looks like at HEAD. The client only
  // wires this on commit-view rows whose file has later changes — for
  // unchanged files the preview would equal what's already on screen,
  // and Full/Local already render HEAD content. The endpoint itself
  // accepts any (sha, path, line); the gating lives on the client so
  // we keep the URL surface small.
  app.get('/api/repos/:id/commits/:sha/head-preview', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const sha = c.req.param('sha')
    if (!isValidSha(sha)) return c.json({ error: 'invalid sha' }, 400)
    const path = c.req.query('path')
    const line = Number(c.req.query('line'))
    const context = Math.max(0, Math.min(50, Number(c.req.query('context')) || 10))
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!Number.isFinite(line) || line < 1) {
      return c.json({ error: 'line must be a positive integer' }, 400)
    }
    try {
      const out = await getHeadPreview(repo.path, sha, path, line, context)
      return c.json(out)
    } catch (e) {
      return c.json({ error: e.message || 'head preview failed' }, 500)
    }
  })

  // Fetch a line range from a file at a given ref, used by the diff
  // view's "expand context" buttons on hunk headers. `ref` may be a
  // sha/branch name OR the sentinel 'WORKTREE' (local diff's new side).
  // start/end are 1-indexed and inclusive; the server clamps end to the
  // file's actual length and reports `total_lines` so the client can
  // tell when there's nothing more to expand.
  app.get('/api/repos/:id/file-lines', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const ref   = c.req.query('ref')
    const path  = c.req.query('path')
    const start = Number(c.req.query('start'))
    const end   = Number(c.req.query('end'))
    if (!ref)  return c.json({ error: 'ref required' }, 400)
    if (!path) return c.json({ error: 'path required' }, 400)
    if (!Number.isFinite(start) || start < 1) {
      return c.json({ error: 'start must be a positive integer' }, 400)
    }
    if (!Number.isFinite(end) || end < start) {
      return c.json({ error: 'end must be >= start' }, 400)
    }
    // Cap the range size so a runaway request can't pull a 1M-line file
    // into memory. 2000 lines is well beyond any sensible expand chunk.
    if (end - start + 1 > 2000) {
      return c.json({ error: 'range too large (max 2000 lines)' }, 400)
    }
    if (ref !== 'WORKTREE' && !isValidSha(ref) && !/^[A-Za-z0-9_.\/-]+$/.test(ref)) {
      return c.json({ error: 'invalid ref' }, 400)
    }
    try {
      const out = await getFileLines(repo.path, ref, path, start, end)
      return c.json({ ref, path, ...out })
    } catch (e) {
      return c.json({ error: e.message || 'file-lines failed' }, 500)
    }
  })

  // Find a symbol's definition across the repo at HEAD, return a window of
  // surrounding lines. The client fires this once per symbol-panel session
  // (on dblclick) and renders the snippet as a collapsible header above
  // the in-diff matches. `name` is gated to bare identifiers — anything
  // shaped wrong gets a 400 rather than running grep.
  app.get('/api/repos/:id/symbol-def', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const name = c.req.query('name')
    if (!name) return c.json({ error: 'name required' }, 400)
    if (!isValidSymbol(name)) return c.json({ error: 'invalid symbol' }, 400)
    const beforeRaw = c.req.query('before')
    const afterRaw  = c.req.query('after')
    const before = beforeRaw != null ? Number(beforeRaw) : undefined
    const after  = afterRaw  != null ? Number(afterRaw)  : undefined
    try {
      const out = await findSymbolDefinition(repo.path, name, { before, after })
      return c.json(out)
    } catch (e) {
      return c.json({ error: e.message || 'symbol-def failed' }, 500)
    }
  })

  app.get('/api/repos/:id/diff', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    try {
      return c.json(await loadFullDiff(repo.path))
    } catch (e) {
      return c.json({ error: e.message || 'full diff failed' }, e.status || 500)
    }
  })

  app.get('/api/repos/:id/local-diff', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    try {
      return c.json(await loadLocalDiff(repo.path))
    } catch (e) {
      return c.json({ error: e.message || 'local diff failed' }, e.status || 500)
    }
  })

  app.get('/api/repos/:id/reviewed', async (c) => {
    const { repo, error } = await withRepo(c)
    if (error) return error
    const head_sha = c.req.query('head_sha') || null
    const branch = (await getBranchInfo(repo.path)).current_branch
    const branchId = sanitizeBranchId(branch || 'detached')
    const data = await readReviewed(repo.path, branchId)
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
      : [...new Set([...(await readReviewed(repo.path, branchId)).paths, ...incoming])]
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
