import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { getCommitDiff } from '../server/git.js'

// Builds a working repo with two commits: a root commit adding `a.txt`,
// then a second commit adding `b.txt`. Returns SHAs of both so tests can
// fetch their diffs and assert per-commit semantics.
function makeTwoCommitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'slop-commit-diff-'))
  const work = join(root, 'work')

  const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' })

  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
  g(work, ['config', 'user.email', 'test@example.com'])
  g(work, ['config', 'user.name', 'Test'])
  g(work, ['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(work, 'a.txt'), 'first\n')
  g(work, ['add', 'a.txt'])
  g(work, ['commit', '-m', 'root commit'])
  const rootSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  writeFileSync(join(work, 'b.txt'), 'second\n')
  g(work, ['add', 'b.txt'])
  g(work, ['commit', '-m', 'second commit'])
  const headSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  return { root, work, rootSha, headSha }
}

test('root commit diff shows all files-added (not vs working tree)', async () => {
  // Regression for the `<sha>^!` degradation bug: for a root commit, that
  // shorthand silently falls back to `git diff <sha>` (vs working tree),
  // which produced wildly wrong diffs — e.g. the root-commit page showed
  // the *second* commit's changes when called from a 2-commit repo,
  // because the working tree matched HEAD2 not ROOT.
  const { root, work, rootSha } = makeTwoCommitRepo()
  try {
    const diff = await getCommitDiff(work, rootSha)
    assert.equal(diff.sha, rootSha)
    assert.equal(diff.parents.length, 0, 'root commit has no parents')
    // The root commit added `a.txt` (and nothing else). With the bug,
    // we'd see `b.txt` here because the working tree equals HEAD2.
    const paths = diff.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['a.txt'])
    assert.equal(diff.files[0].status, 'added')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-root commit diff is unchanged — just that commit\'s changes', async () => {
  const { root, work, headSha } = makeTwoCommitRepo()
  try {
    const diff = await getCommitDiff(work, headSha)
    assert.equal(diff.sha, headSha)
    assert.equal(diff.parents.length, 1)
    // Second commit added `b.txt` only.
    const paths = diff.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['b.txt'])
    assert.equal(diff.files[0].status, 'added')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('root commit diff is non-empty even when working tree equals HEAD (single-commit repo)', async () => {
  // The "hodor" symptom: a 1-commit repo where working tree == HEAD ==
  // root. With the bug, `git diff <root>` produces zero output (working
  // tree matches), so the per-commit page rendered nothing at all.
  const root = mkdtempSync(join(tmpdir(), 'slop-commit-diff-solo-'))
  const work = join(root, 'work')
  const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
    g(work, ['config', 'user.email', 'test@example.com'])
    g(work, ['config', 'user.name', 'Test'])
    g(work, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(work, 'README.md'), 'hello\n')
    g(work, ['add', 'README.md'])
    g(work, ['commit', '-m', 'initial'])
    const sha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    const diff = await getCommitDiff(work, sha)
    assert.equal(diff.parents.length, 0)
    assert.ok(diff.files.length > 0, 'root commit must show its added files')
    assert.deepEqual(diff.files.map((f) => f.path).sort(), ['README.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
