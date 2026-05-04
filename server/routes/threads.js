import { loadState, findRepo } from '../state.js'
import {
  newThreadId,
  sanitizeBranchId,
  readThread,
  writeThread,
  deleteThread,
  listThreadsWithState,
} from '../reviews.js'
import { getBranchInfo } from '../git.js'
import { currentGhLogin } from '../identity.js'

async function withRepoAndBranch(c) {
  const state = await loadState()
  const repo = findRepo(state, c.req.param('id'))
  if (!repo) return { error: c.json({ error: 'repo not found' }, 404) }
  const info = await getBranchInfo(repo.path)
  const branch = info.current_branch
  if (!branch) return { error: c.json({ error: 'no current branch (detached HEAD?)' }, 409) }
  const branchId = sanitizeBranchId(branch)
  return { state, repo, branch, branchId, info }
}

export function registerThreadRoutes(app) {
  app.get('/api/repos/:id/threads', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const threads = await listThreadsWithState(repo.id, branchId)
    return c.json({ branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads', async (c) => {
    const { repo, branch, branchId, info, error } = await withRepoAndBranch(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const view = String(body?.view || '')
    const file = String(body?.file || '')
    const line = Number(body?.line || 0)
    const side = String(body?.side || 'new')
    const sha = String(body?.sha || info.head_sha || '')
    const text = String(body?.body || '').trim()
    // Optional snippet of the line being commented on. Captured at create
    // time so the threads page can show context even after the line drifts.
    const anchorText = body?.anchor_text != null ? String(body.anchor_text).slice(0, 500) : null
    if (!['commit', 'full', 'local'].includes(view)) return c.json({ error: 'invalid view' }, 400)
    if (!file) return c.json({ error: 'file required' }, 400)
    if (!Number.isFinite(line) || line < 1) return c.json({ error: 'invalid line' }, 400)
    if (!['old', 'new'].includes(side)) return c.json({ error: 'invalid side' }, 400)
    if (!text) return c.json({ error: 'body required' }, 400)

    const id = newThreadId()
    const now = new Date().toISOString()
    const user = await currentGhLogin()
    const thread = {
      id,
      view,
      file,
      line,
      side,
      sha: sha || null,
      anchor_text: anchorText,
      created_at: now,
      last_read_at: now,
      comments: [
        {
          id: `${id}_1`,
          user,
          body: text,
          posted_at: now,
        },
      ],
    }
    await writeThread(repo.id, branchId, thread)
    const threads = await listThreadsWithState(repo.id, branchId)
    return c.json({ ok: true, thread_id: id, branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads/:thread_id/comments', async (c) => {
    const { repo, branch, branchId, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const body = await c.req.json().catch(() => ({}))
    const text = String(body?.body || '').trim()
    if (!text) return c.json({ error: 'body required' }, 400)

    const thread = await readThread(repo.id, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    const now = new Date().toISOString()
    const user = await currentGhLogin()
    const n = (thread.comments?.length || 0) + 1
    const comment = { id: `${tid}_${n}`, user, body: text, posted_at: now }
    thread.comments = [...(thread.comments || []), comment]
    thread.last_read_at = now    // user-authored reply implies they've seen prior context
    await writeThread(repo.id, branchId, thread)
    const threads = await listThreadsWithState(repo.id, branchId)
    return c.json({ ok: true, comment, branch, branch_id: branchId, threads })
  })

  app.delete('/api/repos/:id/threads/:thread_id/comments/:comment_id', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const cid = c.req.param('comment_id')
    const thread = await readThread(repo.id, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.comments = (thread.comments || []).filter((m) => m.id !== cid)
    if (thread.comments.length === 0) {
      await deleteThread(repo.id, branchId, tid)
      const threads = await listThreadsWithState(repo.id, branchId)
      return c.json({ ok: true, deleted: 'thread', branch, branch_id: branchId, threads })
    } else {
      await writeThread(repo.id, branchId, thread)
      const threads = await listThreadsWithState(repo.id, branchId)
      return c.json({ ok: true, deleted: 'comment', branch, branch_id: branchId, threads })
    }
  })

  app.delete('/api/repos/:id/threads/:thread_id', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    await deleteThread(repo.id, branchId, tid)
    const threads = await listThreadsWithState(repo.id, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads/:thread_id/read', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const thread = await readThread(repo.id, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.last_read_at = new Date().toISOString()
    await writeThread(repo.id, branchId, thread)
    const threads = await listThreadsWithState(repo.id, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })
}
