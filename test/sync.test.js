import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { planSync, mapGithubThreadToSlop, newGithubComments, runSync } from '../server/sync.js'
import { readBranchThreads, writeThread, sanitizeBranchId } from '../server/reviews.js'

// Build a fake GitHub review-thread node in the same shape host.js returns
// (anchor fields on the thread, comments under comments.nodes). Defaults to a
// single-line, unresolved, RIGHT-side thread on README.md line 1.
function ghThread(id, opts = {}) {
  const {
    path = 'README.md',
    line = 1,
    startLine = null,
    isResolved = false,
    diffSide = 'RIGHT',
    subjectType = 'LINE',
    body = 'hi',
    login = 'octocat',
    createdAt = '2026-01-01T00:00:00Z',
    url = `https://github.com/acme/widgets/pull/7#discussion_r${id}`,
  } = opts
  return {
    id,
    isResolved,
    isOutdated: false,
    path,
    line,
    startLine,
    originalLine: line,
    originalStartLine: startLine,
    diffSide,
    subjectType,
    comments: { nodes: [{ databaseId: 1, author: login ? { login } : null, body, createdAt, url }] },
  }
}

// ---------------------------------------------------------------------------
// planSync: the pure create / update / delete / skip reconciliation.
// ---------------------------------------------------------------------------

test('planSync: a new GitHub thread with no local match is a create', () => {
  const { toUpsert, toDelete, skippedModified } = planSync([{ id: 'A' }], [])
  assert.equal(toUpsert.length, 1)
  assert.equal(toUpsert[0].existing, null)
  assert.equal(toDelete.length, 0)
  assert.equal(skippedModified, 0)
})

test('planSync: an existing unmodified synced thread still unresolved is an update', () => {
  const local = [{ id: 'thread_1', github_thread_id: 'A', locally_modified: false }]
  const { toUpsert, toDelete } = planSync([{ id: 'A' }], local)
  assert.equal(toUpsert.length, 1)
  assert.equal(toUpsert[0].existing, local[0])
  assert.equal(toDelete.length, 0)
})

test('planSync: a synced thread gone from the unresolved set is a delete', () => {
  const local = [{ id: 'thread_1', github_thread_id: 'A', locally_modified: false }]
  const { toUpsert, toDelete } = planSync([], local)   // A resolved or removed on GitHub
  assert.deepEqual(toDelete, ['thread_1'])
  assert.equal(toUpsert.length, 0)
})

test('planSync: locally_modified is skipped, never deleted (even when gone from GitHub)', () => {
  const local = [{ id: 'thread_1', github_thread_id: 'A', locally_modified: true }]
  const { toUpsert, toDelete, skippedModified } = planSync([], local)
  assert.equal(skippedModified, 1)
  assert.equal(toDelete.length, 0)
  assert.equal(toUpsert.length, 0)
})

test('planSync: locally_modified still on GitHub is a merge, not a skip or update', () => {
  const local = [{ id: 'thread_1', github_thread_id: 'A', locally_modified: true }]
  const { toUpsert, toMerge, skippedModified } = planSync([{ id: 'A' }], local)
  assert.equal(toMerge.length, 1)
  assert.equal(toMerge[0].existing, local[0])
  assert.equal(toUpsert.length, 0)
  assert.equal(skippedModified, 0)
})

test('planSync: a non-synced local thread (no github_thread_id) is invisible to sync', () => {
  const local = [{ id: 'thread_local' }]
  const { toUpsert, toDelete, skippedModified } = planSync([], local)
  assert.equal(toDelete.length, 0)
  assert.equal(toUpsert.length, 0)
  assert.equal(skippedModified, 0)
})

// ---------------------------------------------------------------------------
// mapGithubThreadToSlop: the GitHub -> slop anchor + comment mapping.
// ---------------------------------------------------------------------------

test('mapGithubThreadToSlop: RIGHT single-line maps to new side', () => {
  const t = mapGithubThreadToSlop(ghThread('X', { diffSide: 'RIGHT', line: 42 }), { id: 'thread_dead', headSha: 'abc' })
  assert.equal(t.side, 'new')
  assert.equal(t.line, 42)
  assert.equal(t.line_end, null)
  assert.equal(t.view, 'full')
  assert.equal(t.sha, 'abc')
  assert.equal(t.github_thread_id, 'X')
  assert.equal(t.locally_modified, false)
  assert.equal(t.resolved_at, null)
  assert.equal(t.comments[0].id, 'thread_dead_1')
  assert.equal(t.comments[0].user, 'octocat')
  assert.equal(t.comments[0].posted_at, '2026-01-01T00:00:00Z')
})

test('mapGithubThreadToSlop: LEFT maps to old side', () => {
  const t = mapGithubThreadToSlop(ghThread('X', { diffSide: 'LEFT', line: 7 }), { id: 'thread_x', headSha: 'h' })
  assert.equal(t.side, 'old')
  assert.equal(t.line, 7)
})

test('mapGithubThreadToSlop: multi-line uses startLine as anchor and line as inclusive end', () => {
  const t = mapGithubThreadToSlop(ghThread('X', { startLine: 10, line: 14 }), { id: 'thread_x', headSha: 'h' })
  assert.equal(t.line, 10)
  assert.equal(t.line_end, 14)
})

test('mapGithubThreadToSlop: an outdated thread (line null) falls back to originalLine', () => {
  const gh = ghThread('X', { line: null })
  gh.originalLine = 99
  const t = mapGithubThreadToSlop(gh, { id: 'thread_x', headSha: 'h' })
  assert.equal(t.line, 99)
  assert.equal(t.line_end, null)
})

test('mapGithubThreadToSlop: a null author becomes the ghost sentinel', () => {
  const gh = ghThread('X', { login: null })
  const t = mapGithubThreadToSlop(gh, { id: 'thread_x', headSha: 'h' })
  assert.equal(t.comments[0].user, 'ghost')
})

test('mapGithubThreadToSlop: an existing thread preserves id and last_read_at', () => {
  const existing = { id: 'thread_keep', last_read_at: '2025-01-01T00:00:00Z', anchor_text: 'x' }
  const t = mapGithubThreadToSlop(ghThread('X'), { id: 'thread_keep', headSha: 'h', existing })
  assert.equal(t.id, 'thread_keep')
  assert.equal(t.last_read_at, '2025-01-01T00:00:00Z')
})

test('mapGithubThreadToSlop: a comment url becomes github_url; an absent url omits the field', () => {
  const withUrl = mapGithubThreadToSlop(ghThread('X'), { id: 'thread_x', headSha: 'h' })
  assert.equal(withUrl.comments[0].github_url, 'https://github.com/acme/widgets/pull/7#discussion_rX')
  const noUrl = mapGithubThreadToSlop(ghThread('Y', { url: null }), { id: 'thread_y', headSha: 'h' })
  assert.equal('github_url' in noUrl.comments[0], false)
})

// ---------------------------------------------------------------------------
// newGithubComments: the append-only merge for locally-modified threads.
// ---------------------------------------------------------------------------

// One raw GitHub comment node, shaped like host.js's comments.nodes entries.
function ghNode(body, url, opts = {}) {
  const { login = 'octocat', createdAt = '2026-01-01T00:00:00Z' } = opts
  return { author: login ? { login } : null, body, url, createdAt }
}

test('newGithubComments: returns only the GitHub comments not already mirrored locally', () => {
  const existing = {
    id: 'thread_x',
    comments: [
      { id: 'thread_x_1', user: 'octocat', body: 'a', github_url: 'u1' },
      { id: 'thread_x_2', user: 'reviewer', body: 'local note' }, // local-only, no url
    ],
  }
  const gh = { comments: { nodes: [ghNode('a', 'u1'), ghNode('c', 'u2')] } }
  const appended = newGithubComments(existing, gh)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].body, 'c')
  assert.equal(appended[0].github_url, 'u2')
})

test('newGithubComments: new ids continue past the current max suffix so they never collide', () => {
  const existing = {
    id: 'thread_x',
    comments: [
      { id: 'thread_x_1', user: 'octocat', body: 'a', github_url: 'u1' },
      { id: 'thread_x_2', user: 'reviewer', body: 'local note' },
    ],
  }
  const gh = { comments: { nodes: [ghNode('c', 'u2'), ghNode('d', 'u3')] } }
  const appended = newGithubComments(existing, gh)
  assert.deepEqual(appended.map((c) => c.id), ['thread_x_3', 'thread_x_4'])
})

test('newGithubComments: an already-mirrored comment edited on GitHub is NOT re-appended', () => {
  const existing = { id: 'thread_x', comments: [{ id: 'thread_x_1', body: 'a', github_url: 'u1' }] }
  const gh = { comments: { nodes: [ghNode('a (edited on github)', 'u1')] } }
  assert.deepEqual(newGithubComments(existing, gh), [])
})

// ---------------------------------------------------------------------------
// runSync: end-to-end against a temp repo, with gh responses injected.
// ---------------------------------------------------------------------------

// A git repo whose origin URL parses as GitHub (the URL need not be reachable;
// getOriginUrl just reads the configured value). No push / bare remote needed.
function makeGithubRepo() {
  const root = mkdtempSync(join(tmpdir(), 'slop-sync-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' })
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'pipe' })
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'user.name', 'Test'])
  g(['config', 'commit.gpgsign', 'false'])
  g(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  writeFileSync(join(work, 'README.md'), 'one\ntwo\nthree\n')
  g(['add', 'README.md'])
  g(['commit', '-m', 'initial'])
  return { root, work }
}

test('runSync: creates, then refreshes/deletes, then protects locally-modified threads', async () => {
  const { root, work } = makeGithubRepo()
  const branchId = sanitizeBranchId('main')
  const deps = {
    isGhAvailable: async () => true,
    getPrNumber: async () => 7,
    fetchReviewThreads: async () => [ghThread('GH_A'), ghThread('GH_B', { line: 2 })],
  }
  try {
    // First sync: both threads land as fresh local files.
    let res = await runSync(work, { deps })
    assert.equal(res.status, 'ok')
    assert.equal(res.stats.created, 2)
    let threads = await readBranchThreads(work, branchId)
    assert.equal(threads.length, 2)
    assert.ok(threads.every((t) => t.github_thread_id && t.locally_modified === false && t.view === 'full'))
    // anchor_text was read off HEAD: line 1 -> "one".
    const a = threads.find((t) => t.github_thread_id === 'GH_A')
    assert.equal(a.anchor_text, 'one')
    // the comment permalink rode through to disk.
    assert.match(a.comments[0].github_url, /pull\/7#discussion_r/)

    // Second sync: GH_B resolved (drops out of the unresolved set) -> deleted;
    // GH_A unchanged on GitHub -> no rewrite.
    deps.fetchReviewThreads = async () => [ghThread('GH_A')]
    res = await runSync(work, { deps })
    assert.equal(res.stats.deleted, 1)
    assert.equal(res.stats.updated, 1)
    assert.equal(res.stats.created, 0)
    threads = await readBranchThreads(work, branchId)
    assert.equal(threads.length, 1)
    assert.equal(threads[0].github_thread_id, 'GH_A')

    // Developer edits GH_A locally (flag flips). A third sync that carries a
    // changed GitHub body must SKIP it: the local file keeps its old body.
    const local = threads[0]
    local.locally_modified = true
    await writeThread(work, branchId, local)
    deps.fetchReviewThreads = async () => [ghThread('GH_A', { body: 'CHANGED ON GITHUB' })]
    res = await runSync(work, { deps })
    assert.equal(res.stats.skipped_modified, 1)
    assert.equal(res.stats.updated, 0)
    const final = await readBranchThreads(work, branchId)
    assert.equal(final.length, 1)
    assert.equal(final[0].comments[0].body, 'hi')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSync: a locally-modified thread keeps its local reply and appends new GitHub comments', async () => {
  const { root, work } = makeGithubRepo()
  const branchId = sanitizeBranchId('main')
  const c1 = { databaseId: 1, author: { login: 'octocat' }, body: 'first', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/acme/widgets/pull/7#discussion_r1' }
  const ghWith = (...nodes) => [{ ...ghThread('GH_A'), comments: { nodes } }]
  const deps = {
    isGhAvailable: async () => true,
    getPrNumber: async () => 7,
    fetchReviewThreads: async () => ghWith(c1),
  }
  try {
    // First sync lands the thread with its single GitHub comment.
    await runSync(work, { deps })
    let threads = await readBranchThreads(work, branchId)
    const t = threads[0]
    // Developer replies in the UI: flips locally_modified, adds a non-GitHub comment.
    t.locally_modified = true
    t.comments.push({ id: `${t.id}_2`, user: 'reviewer', body: 'my note', posted_at: '2026-01-01T01:00:00Z' })
    await writeThread(work, branchId, t)

    // GitHub then gains a brand-new reply (fresh url) AND edits the first comment.
    const c1edited = { ...c1, body: 'first (edited on github)' }
    const c2 = { databaseId: 2, author: { login: 'octocat' }, body: 'second', createdAt: '2026-01-01T02:00:00Z', url: 'https://github.com/acme/widgets/pull/7#discussion_r2' }
    deps.fetchReviewThreads = async () => ghWith(c1edited, c2)
    const res = await runSync(work, { deps })

    assert.equal(res.stats.merged, 1)
    assert.equal(res.stats.merged_comments, 1)
    assert.equal(res.stats.skipped_modified, 0)
    assert.equal(res.stats.updated, 0)
    assert.equal(res.stats.deleted, 0)

    threads = await readBranchThreads(work, branchId)
    const after = threads[0]
    assert.equal(after.comments.length, 3)
    // First synced comment NOT clobbered by the GitHub edit: local edits win.
    assert.equal(after.comments[0].body, 'first')
    // Local reply preserved verbatim, in place.
    assert.equal(after.comments[1].user, 'reviewer')
    assert.equal(after.comments[1].body, 'my note')
    // New GitHub comment appended last, with a fresh id that doesn't collide.
    assert.equal(after.comments[2].body, 'second')
    assert.equal(after.comments[2].github_url, c2.url)
    const ids = after.comments.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length)
    // Still flagged locally-modified; never deleted or overwritten.
    assert.equal(after.locally_modified, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSync: a non-GitHub origin is a no-op soft-stop', async () => {
  const { root, work } = makeGithubRepo()
  execFileSync('git', ['-C', work, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/widgets.git'], { stdio: 'pipe' })
  try {
    const res = await runSync(work, { deps: { isGhAvailable: async () => true, getPrNumber: async () => 1, fetchReviewThreads: async () => [] } })
    assert.equal(res.status, 'not-github')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSync: no open PR is a benign soft-stop', async () => {
  const { root, work } = makeGithubRepo()
  try {
    const res = await runSync(work, { deps: { isGhAvailable: async () => true, getPrNumber: async () => null, fetchReviewThreads: async () => [] } })
    assert.equal(res.status, 'no-pr')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSync: missing gh is a soft-stop', async () => {
  const { root, work } = makeGithubRepo()
  try {
    const res = await runSync(work, { deps: { isGhAvailable: async () => false, getPrNumber: async () => 1, fetchReviewThreads: async () => [] } })
    assert.equal(res.status, 'no-gh')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSync: file-level (no line anchor) threads are reported as skipped', async () => {
  const { root, work } = makeGithubRepo()
  try {
    const deps = {
      isGhAvailable: async () => true,
      getPrNumber: async () => 7,
      fetchReviewThreads: async () => [ghThread('GH_FILE', { subjectType: 'FILE', line: null })],
    }
    const res = await runSync(work, { deps })
    assert.equal(res.status, 'ok')
    assert.equal(res.stats.created, 0)
    assert.equal(res.stats.github_unsupported, 1)
    assert.equal(res.stats.github_unresolved, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
