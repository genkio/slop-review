import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  mapLineThroughDiff,
  getHeadPreview,
} from '../server/git.js'

// ---- mapLineThroughDiff (pure) ----------------------------------------
//
// These cover the boundary math that the head-preview feature relies on.
// Hunk headers use `--unified=0` semantics (minimal change region, no
// surrounding context lines in the header counts).

test('mapLineThroughDiff: empty diff → identity', () => {
  assert.deepEqual(mapLineThroughDiff('', 10), { line: 10, status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff('   \n', 10), { line: 10, status: 'mapped' })
})

test('mapLineThroughDiff: pure deletion shifts lines below up', () => {
  // Delete 2 lines starting at old line 5. HEAD line 4 is where the
  // deletion landed (last surviving line before).
  const diff = '@@ -5,2 +4,0 @@\n-removed1\n-removed2\n'
  // Before the deletion → unchanged.
  assert.deepEqual(mapLineThroughDiff(diff, 4), { line: 4, status: 'mapped' })
  // Inside the deleted block → in-changed-hunk, anchored at HEAD's newStart.
  assert.deepEqual(mapLineThroughDiff(diff, 5), { line: 4, status: 'in-changed-hunk' })
  assert.deepEqual(mapLineThroughDiff(diff, 6), { line: 4, status: 'in-changed-hunk' })
  // After the deletion → shifted up by 2.
  assert.deepEqual(mapLineThroughDiff(diff, 7), { line: 5, status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 100), { line: 98, status: 'mapped' })
})

test('mapLineThroughDiff: pure addition shifts lines below down', () => {
  // 2 lines added between old lines 2 and 3 → new lines 3 and 4.
  // Header: `@@ -2,0 +3,2 @@` — A=2 is the LAST OLD LINE before the insert.
  const diff = '@@ -2,0 +3,2 @@\n+added1\n+added2\n'
  assert.deepEqual(mapLineThroughDiff(diff, 1), { line: 1, status: 'mapped' })
  // Line 2 is the context line BEFORE the addition — not affected by it.
  assert.deepEqual(mapLineThroughDiff(diff, 2), { line: 2, status: 'mapped' })
  // Line 3 in old is now line 5 in HEAD (pushed down by 2 added lines).
  assert.deepEqual(mapLineThroughDiff(diff, 3), { line: 5, status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 4), { line: 6, status: 'mapped' })
})

test('mapLineThroughDiff: modification → in-changed-hunk for affected range', () => {
  // Replace 2 old lines (10–11) with 3 new lines (10–12).
  const diff = '@@ -10,2 +10,3 @@\n-old1\n-old2\n+new1\n+new2\n+new3\n'
  assert.deepEqual(mapLineThroughDiff(diff, 9),  { line: 9,  status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 10), { line: 10, status: 'in-changed-hunk' })
  assert.deepEqual(mapLineThroughDiff(diff, 11), { line: 10, status: 'in-changed-hunk' })
  // After the hunk: shift +1 (3 new − 2 old).
  assert.deepEqual(mapLineThroughDiff(diff, 12), { line: 13, status: 'mapped' })
})

test('mapLineThroughDiff: multiple hunks compose offsets', () => {
  // Hunk 1: delete 1 line at old:5 → new ends at line 4.
  // Hunk 2: add 2 lines after old:20 → +2 offset thereafter.
  const diff =
    '@@ -5,1 +4,0 @@\n-x\n' +
    '@@ -20,0 +21,2 @@\n+y1\n+y2\n'
  assert.deepEqual(mapLineThroughDiff(diff, 4),  { line: 4,  status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 5),  { line: 4,  status: 'in-changed-hunk' })
  // Between hunks: -1 offset from hunk 1, hunk 2 not yet applied.
  assert.deepEqual(mapLineThroughDiff(diff, 10), { line: 9,  status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 20), { line: 19, status: 'mapped' })
  // After hunk 2: -1 + 2 = +1 net offset.
  assert.deepEqual(mapLineThroughDiff(diff, 21), { line: 22, status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 50), { line: 51, status: 'mapped' })
})

test('mapLineThroughDiff: omitted count defaults to 1', () => {
  // `@@ -5 +5 @@` (no comma counts) means 1 line on each side. Git's
  // diff format omits the count when it's exactly 1.
  const diff = '@@ -5 +5 @@\n-old\n+new\n'
  assert.deepEqual(mapLineThroughDiff(diff, 4), { line: 4, status: 'mapped' })
  assert.deepEqual(mapLineThroughDiff(diff, 5), { line: 5, status: 'in-changed-hunk' })
  assert.deepEqual(mapLineThroughDiff(diff, 6), { line: 6, status: 'mapped' })
})

// ---- getHeadPreview (integration with real git) -----------------------

function makeRepoWithLaterChanges() {
  const root = mkdtempSync(join(tmpdir(), 'slop-head-preview-'))
  const work = join(root, 'work')
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' })

  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'user.name', 'Test'])
  g(['config', 'commit.gpgsign', 'false'])

  // C1: foo.txt with 10 lines.
  const c1Content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  writeFileSync(join(work, 'foo.txt'), c1Content)
  g(['add', 'foo.txt'])
  g(['commit', '-m', 'C1: add foo.txt'])
  const c1 = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  // C2 (HEAD): insert 2 lines between line 3 and 4 of foo.txt.
  const c2Content = [
    'line 1', 'line 2', 'line 3',
    'inserted A', 'inserted B',
    'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10',
  ].join('\n') + '\n'
  writeFileSync(join(work, 'foo.txt'), c2Content)
  g(['add', 'foo.txt'])
  g(['commit', '-m', 'C2: insert two lines'])
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  return { root, work, c1, head }
}

test('getHeadPreview: line below an insertion is shifted down at HEAD', async () => {
  const { root, work, c1 } = makeRepoWithLaterChanges()
  try {
    // At C1, line 5 is "line 5". At HEAD, those 2 inserted lines pushed
    // "line 5" down to position 7.
    const out = await getHeadPreview(work, c1, 'foo.txt', 5, 2)
    assert.equal(out.status, 'mapped')
    assert.equal(out.commit_line, 5)
    assert.equal(out.head_line, 7)
    // Window is ±2 around HEAD line 7 → lines 5..9.
    assert.equal(out.start, 5)
    assert.equal(out.end, 9)
    assert.deepEqual(out.lines, ['inserted B', 'line 4', 'line 5', 'line 6', 'line 7'])
    assert.equal(out.binary, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getHeadPreview: line above the insertion is unchanged', async () => {
  const { root, work, c1 } = makeRepoWithLaterChanges()
  try {
    const out = await getHeadPreview(work, c1, 'foo.txt', 2, 1)
    assert.equal(out.status, 'mapped')
    assert.equal(out.commit_line, 2)
    assert.equal(out.head_line, 2)
    assert.deepEqual(out.lines, ['line 1', 'line 2', 'line 3'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getHeadPreview: file deleted at HEAD reports file-deleted', async () => {
  // Three commits: C1 adds gone.txt, C2 modifies it, C3 deletes it.
  // From C1's view, asking for HEAD preview should report file-deleted.
  const root = mkdtempSync(join(tmpdir(), 'slop-head-preview-del-'))
  const work = join(root, 'work')
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' })
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
    g(['config', 'user.email', 'test@example.com'])
    g(['config', 'user.name', 'Test'])
    g(['config', 'commit.gpgsign', 'false'])

    writeFileSync(join(work, 'gone.txt'), 'a\nb\nc\n')
    g(['add', 'gone.txt'])
    g(['commit', '-m', 'C1'])
    const c1 = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    writeFileSync(join(work, 'gone.txt'), 'a\nb prime\nc\n')
    g(['add', 'gone.txt'])
    g(['commit', '-m', 'C2'])

    execFileSync('git', ['-C', work, 'rm', '-q', 'gone.txt'])
    g(['commit', '-m', 'C3: delete'])

    const out = await getHeadPreview(work, c1, 'gone.txt', 2, 5)
    assert.equal(out.status, 'file-deleted')
    assert.equal(out.head_line, null)
    assert.deepEqual(out.lines, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('getHeadPreview: line inside a modified region reports in-changed-hunk', async () => {
  // C1 adds 5 lines. C2 modifies line 3. From C1's view, asking for the
  // preview at line 3 should report in-changed-hunk (the line was rewritten
  // between C1 and HEAD) and anchor the window on HEAD's newStart.
  const root = mkdtempSync(join(tmpdir(), 'slop-head-preview-mod-'))
  const work = join(root, 'work')
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' })
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
    g(['config', 'user.email', 'test@example.com'])
    g(['config', 'user.name', 'Test'])
    g(['config', 'commit.gpgsign', 'false'])

    writeFileSync(join(work, 'm.txt'), 'a\nb\nc\nd\ne\n')
    g(['add', 'm.txt'])
    g(['commit', '-m', 'C1'])
    const c1 = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    writeFileSync(join(work, 'm.txt'), 'a\nb\nC-rewritten\nd\ne\n')
    g(['add', 'm.txt'])
    g(['commit', '-m', 'C2: rewrite line 3'])

    const out = await getHeadPreview(work, c1, 'm.txt', 3, 1)
    assert.equal(out.status, 'in-changed-hunk')
    assert.equal(out.head_line, 3)
    assert.deepEqual(out.lines, ['b', 'C-rewritten', 'd'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
