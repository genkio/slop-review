import test from 'node:test'
import assert from 'node:assert/strict'
import { compareForReview, STATUS_GLYPH, RELATIONSHIP_LABELS } from '../core/diff-order.js'

const sortPaths = (files, priorities) =>
  [...files].sort((a, b) => compareForReview(a, b, priorities)).map((f) => f.path)

test('orders by ref_count desc, then status, then support, then path', () => {
  const files = [
    { path: 'z.js' }, { path: 'a.js' }, { path: 'hub.js' }, { path: 'leaf.js' },
  ]
  const priorities = {
    'hub.js':  { ref_count: 5, status_rank: 0, support_rank: 0 },
    'leaf.js': { ref_count: 1, status_rank: 0, support_rank: 0 },
    'a.js':    { ref_count: 1, status_rank: 0, support_rank: 0 },
    'z.js':    { ref_count: 1, status_rank: 0, support_rank: 0 },
  }
  // hub first (highest ref_count); the three ref_count:1 files tie down to
  // path order: a, leaf, z.
  assert.deepEqual(sortPaths(files, priorities), ['hub.js', 'a.js', 'leaf.js', 'z.js'])
})

test('status_rank then support_rank break ref_count ties', () => {
  const files = [{ path: 'b.js' }, { path: 'a.js' }]
  const priorities = {
    'a.js': { ref_count: 2, status_rank: 2, support_rank: 0 },
    'b.js': { ref_count: 2, status_rank: 1, support_rank: 0 },
  }
  assert.deepEqual(sortPaths(files, priorities), ['b.js', 'a.js']) // lower status_rank wins
})

test('files without a priority entry sort last; both-missing is alphabetical', () => {
  const files = [{ path: 'no-prio.js' }, { path: 'prio.js' }]
  const priorities = { 'prio.js': { ref_count: 1, status_rank: 0, support_rank: 0 } }
  assert.deepEqual(sortPaths(files, priorities), ['prio.js', 'no-prio.js'])
  assert.deepEqual(sortPaths([{ path: 'b' }, { path: 'a' }], {}), ['a', 'b'])
  assert.deepEqual(sortPaths([{ path: 'b' }, { path: 'a' }], undefined), ['a', 'b'])
})

test('status glyphs and relationship labels are pinned', () => {
  assert.deepEqual(STATUS_GLYPH, { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' })
  assert.equal(RELATIONSHIP_LABELS['imports'].arrow, '→')
  assert.equal(RELATIONSHIP_LABELS['imported-by'].arrow, '←')
  assert.equal(RELATIONSHIP_LABELS['circular'].verb, 'circular import with')
})
