import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { getBranchInfo } from '../server/git.js'

// Tiny harness: builds a working repo with a bare `origin` remote and
// `origin/HEAD` symbolic-ref set, so getBranchInfo sees the same shape it
// would in a real clone. Returns the working repo path; caller is
// responsible for cleanup of the parent `root`.
function makeRepoWithOrigin() {
  const root   = mkdtempSync(join(tmpdir(), 'slop-branch-info-'))
  const origin = join(root, 'origin.git')
  const work   = join(root, 'work')

  const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' })

  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' })
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'pipe' })
  g(work, ['config', 'user.email', 'test@example.com'])
  g(work, ['config', 'user.name', 'Test'])
  g(work, ['config', 'commit.gpgsign', 'false'])
  g(work, ['remote', 'add', 'origin', origin])

  // Initial commit so HEAD exists.
  writeFileSync(join(work, 'README.md'), 'one\n')
  g(work, ['add', 'README.md'])
  g(work, ['commit', '-m', 'initial'])
  g(work, ['push', '-u', 'origin', 'main'])
  g(work, ['remote', 'set-head', 'origin', '-a'])

  return { root, work, g }
}

test('on main, fully synced, root commit → empty-tree fallback', async () => {
  const { root, work } = makeRepoWithOrigin()
  try {
    const info = await getBranchInfo(work)
    assert.equal(info.current_branch, 'main')
    assert.equal(info.base_branch, 'main')
    assert.equal(info.on_base, true)
    assert.equal(info.has_origin_head, true)
    // Single root commit: HEAD~1 doesn't exist, so the fallback falls
    // through to the empty-tree SHA. has_commits_ahead is forced true so
    // the diff page renders the initial commit as "all files added".
    assert.equal(info.has_commits_ahead, true)
    assert.equal(info.has_local_changes, false)
    const emptyTreeSha = execFileSync('git', ['-C', work, 'hash-object', '-t', 'tree', '/dev/null'], { encoding: 'utf8' }).trim()
    assert.equal(info.merge_base_sha, emptyTreeSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('on main, fully synced, has parent → empty-tree fallback covers full history', async () => {
  const { root, work, g } = makeRepoWithOrigin()
  try {
    // Add a second commit so HEAD~1 exists, then push so origin tracks it.
    writeFileSync(join(work, 'two.txt'), 'two\n')
    g(work, ['add', 'two.txt'])
    g(work, ['commit', '-m', 'second'])
    g(work, ['push', 'origin', 'main'])

    const info = await getBranchInfo(work)
    assert.equal(info.on_base, true)
    assert.equal(info.has_local_changes, false)
    assert.equal(info.has_commits_ahead, true)
    // Fallback uses the empty-tree SHA (not HEAD~1) so the per-commit nav
    // and Full diff both span the entire history of main — the user can
    // reach commit #1 as well as commit #2.
    const emptyTreeSha = execFileSync('git', ['-C', work, 'hash-object', '-t', 'tree', '/dev/null'], { encoding: 'utf8' }).trim()
    assert.equal(info.merge_base_sha, emptyTreeSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('on main, fully synced, has parent → /commits-equivalent walk lists all commits', async () => {
  const { root, work, g } = makeRepoWithOrigin()
  try {
    writeFileSync(join(work, 'two.txt'), 'two\n')
    g(work, ['add', 'two.txt'])
    g(work, ['commit', '-m', 'second'])
    g(work, ['push', 'origin', 'main'])

    const info = await getBranchInfo(work)
    const { getCommits } = await import('../server/git.js')
    const commits = await getCommits(work, info.merge_base_sha, info.head_sha)
    // Both commits should be present, oldest-first.
    assert.equal(commits.length, 2)
    assert.equal(commits[0].headline, 'initial')
    assert.equal(commits[1].headline, 'second')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('on main with unpushed commits → existing behavior, fallback no-op', async () => {
  const { root, work, g } = makeRepoWithOrigin()
  try {
    // Second commit, but DO NOT push — origin/main stays at the initial commit.
    writeFileSync(join(work, 'two.txt'), 'two\n')
    g(work, ['add', 'two.txt'])
    g(work, ['commit', '-m', 'second (unpushed)'])

    const info = await getBranchInfo(work)
    assert.equal(info.on_base, true)
    assert.equal(info.has_commits_ahead, true)
    // merge_base is origin/main (the first commit). The fallback should
    // NOT have run — it only triggers when has_commits_ahead is false.
    const originSha = execFileSync('git', ['-C', work, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim()
    assert.equal(info.merge_base_sha, originSha)
    assert.equal(info.base_sha, originSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('untracked .reviews/ files alone do NOT flip has_local_changes', async () => {
  // Regression for the "jump to file lands on empty #/diff/local" bug:
  // slop-review's own thread JSONs (under .reviews/) shouldn't count as
  // user code work. If they did, the on-base + has-local rule would flip
  // the diff page's default landing to Local as soon as the first thread
  // is created, poisoning later threads with `view: 'local'`.
  const { root, work } = makeRepoWithOrigin()
  try {
    mkdirSync(join(work, '.reviews', 'main'), { recursive: true })
    writeFileSync(
      join(work, '.reviews', 'main', 'thread_open_a1b2c3d4.json'),
      JSON.stringify({ id: 'thread_a1b2c3d4', file: 'README.md' }),
    )

    const info = await getBranchInfo(work)
    assert.equal(info.has_local_changes, false, '.reviews/ should be excluded from has_local_changes')
    // Falls through to the on-base empty-tree fallback exactly as if the
    // working tree were untouched — has_commits_ahead becomes true via the
    // hash-object fallback so the diff page can render the initial commit.
    assert.equal(info.has_commits_ahead, true)
    const emptyTreeSha = execFileSync('git', ['-C', work, 'hash-object', '-t', 'tree', '/dev/null'], { encoding: 'utf8' }).trim()
    assert.equal(info.merge_base_sha, emptyTreeSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('untracked .reviews/ + real code change → has_local_changes stays true', async () => {
  // The exclusion is for `.reviews/` specifically, not a blanket pass-
  // through. Real working-tree changes must still flip the flag.
  const { root, work } = makeRepoWithOrigin()
  try {
    mkdirSync(join(work, '.reviews', 'main'), { recursive: true })
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_a1b2c3d4.json'), '{}')
    writeFileSync(join(work, 'README.md'), 'edited content\n')

    const info = await getBranchInfo(work)
    assert.equal(info.has_local_changes, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('feature branch with commits ahead → on_base=false, fallback not triggered', async () => {
  const { root, work, g } = makeRepoWithOrigin()
  try {
    g(work, ['checkout', '-b', 'feat/example'])
    writeFileSync(join(work, 'feat.txt'), 'feat\n')
    g(work, ['add', 'feat.txt'])
    g(work, ['commit', '-m', 'feature commit'])

    const info = await getBranchInfo(work)
    assert.equal(info.current_branch, 'feat/example')
    assert.equal(info.base_branch, 'main')
    assert.equal(info.on_base, false)
    assert.equal(info.has_commits_ahead, true)
    // merge_base is origin/main (the initial commit on main).
    const originSha = execFileSync('git', ['-C', work, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim()
    assert.equal(info.merge_base_sha, originSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
