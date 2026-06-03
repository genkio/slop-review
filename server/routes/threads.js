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

// Developer-authored comments (created via the slop-review web UI) are
// stamped with the role marker `"reviewer"` rather than a personal
// identifier. Matches the role-based `user` convention agents follow via
// the slop-review skill: every actor's `user` value names the role they're
// playing, never their identity. Side effects: slop-review no longer needs
// the `gh` CLI for identity resolution; rendered threads show `@reviewer`
// instead of `@<gh-login>`; state derivation in server/reviews.js compares
// against this same literal to decide "developer posted last → awaiting".
const DEVELOPER_USER = 'reviewer'

// Synced-thread guard. Threads pulled from GitHub via `slop --sync` carry a
// `github_thread_id`; the instant the developer mutates one locally (reply,
// edit, delete a comment, resolve/unresolve) we flip `locally_modified` so the
// next sync leaves it untouched instead of overwriting or deleting it. Marking
// a thread read (last_read_at) deliberately does NOT count: merely opening a
// thread shouldn't freeze it against future syncs.
function markSyncedThreadModified(thread) {
  if (thread?.github_thread_id) thread.locally_modified = true
}

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
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads', async (c) => {
    const { repo, branch, branchId, info, error } = await withRepoAndBranch(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const view = String(body?.view || '')
    const file = String(body?.file || '')
    const line = Number(body?.line || 0)
    // Optional range endpoint. When omitted or equal to `line`, the thread
    // is single-line (back-compat with pre-multi-line threads). When set,
    // anchors a multi-line comment spanning `line`..`line_end` inclusive
    // on the same (file, side). Capped at 500 lines server-side so a
    // typo-shift-click can't anchor to a million-line range.
    const lineEndRaw = body?.line_end
    const lineEnd = lineEndRaw == null || lineEndRaw === '' ? null : Number(lineEndRaw)
    const side = String(body?.side || 'new')
    const sha = String(body?.sha || info.head_sha || '')
    const text = String(body?.body || '').trim()
    // Optional snippet of the line being commented on. Captured at create
    // time so a future view that surfaces threads outside the original
    // anchor (e.g. anchor-lost in another commit's diff) can still show
    // the context the reviewer was looking at.
    const anchorText = body?.anchor_text != null ? String(body.anchor_text).slice(0, 500) : null
    if (!['commit', 'full', 'local'].includes(view)) return c.json({ error: 'invalid view' }, 400)
    if (!file) return c.json({ error: 'file required' }, 400)
    if (!Number.isFinite(line) || line < 1) return c.json({ error: 'invalid line' }, 400)
    if (lineEnd !== null && (!Number.isFinite(lineEnd) || lineEnd < line || lineEnd - line > 500)) {
      return c.json({ error: 'invalid line_end' }, 400)
    }
    if (!['old', 'new'].includes(side)) return c.json({ error: 'invalid side' }, 400)
    if (!text) return c.json({ error: 'body required' }, 400)

    const id = newThreadId()
    const now = new Date().toISOString()
    const user = DEVELOPER_USER
    const thread = {
      id,
      view,
      file,
      line,
      line_end: lineEnd && lineEnd > line ? lineEnd : null,
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
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, thread_id: id, branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads/:thread_id/comments', async (c) => {
    const { repo, branch, branchId, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const body = await c.req.json().catch(() => ({}))
    const text = String(body?.body || '').trim()
    if (!text) return c.json({ error: 'body required' }, 400)

    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    const now = new Date().toISOString()
    const user = DEVELOPER_USER
    const n = (thread.comments?.length || 0) + 1
    const comment = { id: `${tid}_${n}`, user, body: text, posted_at: now }
    thread.comments = [...(thread.comments || []), comment]
    thread.last_read_at = now    // user-authored reply implies they've seen prior context
    markSyncedThreadModified(thread)
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, comment, branch, branch_id: branchId, threads })
  })

  // Edit a comment's body in place. Author role (`user`), `posted_at`, and
  // the thread's `last_read_at` are deliberately preserved — the gesture is
  // "correct what was said," not "post a new message". State derivation
  // keys off `comments[last].user`, so mutating the body alone keeps pills
  // stable. Works for both reviewer- and reviewee-authored comments.
  app.patch('/api/repos/:id/threads/:thread_id/comments/:comment_id', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const cid = c.req.param('comment_id')
    const body = await c.req.json().catch(() => ({}))
    const text = String(body?.body || '').trim()
    if (!text) return c.json({ error: 'body required' }, 400)

    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    const idx = (thread.comments || []).findIndex((m) => m.id === cid)
    if (idx < 0) return c.json({ error: 'comment not found' }, 404)
    thread.comments[idx] = { ...thread.comments[idx], body: text }
    markSyncedThreadModified(thread)
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, comment: thread.comments[idx], branch, branch_id: branchId, threads })
  })

  app.delete('/api/repos/:id/threads/:thread_id/comments/:comment_id', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const cid = c.req.param('comment_id')
    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.comments = (thread.comments || []).filter((m) => m.id !== cid)
    if (thread.comments.length === 0) {
      await deleteThread(repo.path, branchId, tid)
      const threads = await listThreadsWithState(repo.path, branchId)
      return c.json({ ok: true, deleted: 'thread', branch, branch_id: branchId, threads })
    } else {
      markSyncedThreadModified(thread)
      await writeThread(repo.path, branchId, thread)
      const threads = await listThreadsWithState(repo.path, branchId)
      return c.json({ ok: true, deleted: 'comment', branch, branch_id: branchId, threads })
    }
  })

  app.delete('/api/repos/:id/threads/:thread_id', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    await deleteThread(repo.path, branchId, tid)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads/:thread_id/read', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.last_read_at = new Date().toISOString()
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })

  // Resolution toggle. `resolved_at` is a single nullable timestamp:
  // setting it (POST /resolve) marks the thread done; clearing it
  // (POST /unresolve) re-opens it. The state-derivation rule treats
  // `resolved_at != null` as the resolved pill, short-circuiting the
  // your_turn/awaiting/read derivation. Resolution is a pure human
  // bookkeeping flag — the bundled Claude Code skill (skills/slop-review/
  // SKILL.md) instructs agents to skip resolved threads when reviewing,
  // so they're not addressed unless the user explicitly reopens them.
  app.post('/api/repos/:id/threads/:thread_id/resolve', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.resolved_at = new Date().toISOString()
    markSyncedThreadModified(thread)
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })

  app.post('/api/repos/:id/threads/:thread_id/unresolve', async (c) => {
    const { repo, branchId, branch, error } = await withRepoAndBranch(c)
    if (error) return error
    const tid = c.req.param('thread_id')
    const thread = await readThread(repo.path, branchId, tid)
    if (!thread) return c.json({ error: 'thread not found' }, 404)
    thread.resolved_at = null
    markSyncedThreadModified(thread)
    await writeThread(repo.path, branchId, thread)
    const threads = await listThreadsWithState(repo.path, branchId)
    return c.json({ ok: true, branch, branch_id: branchId, threads })
  })
}
