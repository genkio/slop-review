import test from 'node:test'
import assert from 'node:assert/strict'

// The shared definition, and the two re-export sites that used to carry
// their own hand-synced copies. Both public/util.js and server/reviews.js
// now `export { sanitizeBranchId } from '../core/ids.js'`. public/util.js
// is importable in Node because it touches DOM globals only inside function
// bodies, never at module top level.
import { sanitizeBranchId as fromCore } from '../core/ids.js'
import { sanitizeBranchId as fromClient } from '../public/util.js'
import { sanitizeBranchId as fromServer } from '../server/reviews.js'

test('sanitizeBranchId is one shared definition (no copies)', () => {
  // Structural guarantee: the client and server export the EXACT same
  // function object as the core. If anyone reintroduces a local copy, the
  // reference equality breaks and this test fails loudly.
  assert.equal(fromClient, fromCore, 'public/util.js must re-export core/ids.js')
  assert.equal(fromServer, fromCore, 'server/reviews.js must re-export core/ids.js')
})

test('sanitizeBranchId behavior is pinned', () => {
  // These were the invariants the two old copies kept in lockstep by
  // comment. They define the on-disk .reviews/<branch_id>/ directory name,
  // so a drift here would silently split a branch's threads across two dirs.
  const cases = [
    ['', ''],
    ['main', 'main'],
    ['feat/tui', 'feat-tui'],                       // slash collapses to -
    ['release/v1.2.3', 'release-v1-2-3'],           // runs of specials -> single -
    ['---foo---', 'foo'],                           // dashes are legal, but trimmed at the ends
    ['a//b', 'a-b'],                                // consecutive specials collapse
    ['feature/JIRA-123_x', 'feature-JIRA-123_x'],   // _ and - survive
    ['naïve', 'na-ve'],                             // non-ASCII becomes -
    ['  spaced  branch  ', 'spaced-branch'],        // whitespace -> -, ends trimmed
    ['a'.repeat(100), 'a'.repeat(80)],              // capped at 80
  ]
  for (const [input, expected] of cases) {
    assert.equal(fromCore(input), expected, `sanitizeBranchId(${JSON.stringify(input)})`)
  }
})

test('sanitizeBranchId tolerates nullish input', () => {
  assert.equal(fromCore(null), '')
  assert.equal(fromCore(undefined), '')
})
