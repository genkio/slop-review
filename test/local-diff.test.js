import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { getLocalDiff } from '../server/git.js'

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'slop-local-diff-'))
  const work = join(root, 'work')
  const g = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' })

  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
  g(work, ['config', 'user.email', 'test@example.com'])
  g(work, ['config', 'user.name', 'Test'])
  g(work, ['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(work, 'README.md'), 'baseline\n')
  g(work, ['add', 'README.md'])
  g(work, ['commit', '-m', 'initial'])

  return { root, work, g }
}

test('getLocalDiff excludes .reviews/ from untracked listing', async () => {
  // Regression for the "6 untracked files not shown" banner showing
  // slop-review's own thread JSONs. Those are metadata, not user code.
  const { root, work } = makeRepo()
  try {
    mkdirSync(join(work, '.reviews', 'main'), { recursive: true })
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_aaaaaaaa.json'), '{}')
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_bbbbbbbb.json'), '{}')

    const diff = await getLocalDiff(work)
    assert.deepEqual(diff.untracked_files, [], '.reviews/ JSONs must not surface as untracked')
    assert.equal(diff.files.length, 0, 'no tracked changes either')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLocalDiff still lists user-authored untracked files', async () => {
  // Sanity: exclusion is scoped to `.reviews/`, not a blanket filter.
  const { root, work } = makeRepo()
  try {
    mkdirSync(join(work, '.reviews', 'main'), { recursive: true })
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_aaaaaaaa.json'), '{}')
    writeFileSync(join(work, 'NOTES.md'), 'user notes\n')

    const diff = await getLocalDiff(work)
    assert.deepEqual(diff.untracked_files, ['NOTES.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getLocalDiff excludes tracked .reviews/ from the patch list too', async () => {
  // If the user commits .reviews/ (SPEC supports this for team-shared
  // thread history) AND has uncommitted edits to a thread JSON, the
  // Local view shouldn't surface that diff — it's slop-review metadata,
  // not code review material.
  const { root, work, g } = makeRepo()
  try {
    mkdirSync(join(work, '.reviews', 'main'), { recursive: true })
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_aaaaaaaa.json'), '{"v":1}')
    writeFileSync(join(work, 'src.js'), 'export const x = 1\n')
    g(work, ['add', '.reviews', 'src.js'])
    g(work, ['commit', '-m', 'second'])
    // Now mutate both: a tracked .reviews/ edit and a tracked src.js edit.
    writeFileSync(join(work, '.reviews', 'main', 'thread_open_aaaaaaaa.json'), '{"v":2}')
    writeFileSync(join(work, 'src.js'), 'export const x = 2\n')

    const diff = await getLocalDiff(work)
    const paths = diff.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['src.js'], 'only the user code file should be in the patch list')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
