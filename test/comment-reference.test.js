import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPinnedComment } from '../public/util.js'

test('formatPinnedComment copies a relative path range and comment body', () => {
  const thread = {
    file: 'packages/pafin.co/src/resources/user.ts',
    line: 315,
    line_end: 317,
    side: 'new',
  }
  const comment = { body: 'Is this edge case covered in this PR?' }

  assert.equal(
    formatPinnedComment(thread, comment),
    'packages/pafin.co/src/resources/user.ts:315-317\n\nIs this edge case covered in this PR?'
  )
})

test('formatPinnedComment marks old-side anchors and omits fake PR-level anchors', () => {
  assert.equal(
    formatPinnedComment({ file: 'src/user.ts', line: 8, side: 'old' }, { body: 'Why was this removed?' }),
    'src/user.ts:8 (old)\n\nWhy was this removed?'
  )
  assert.equal(
    formatPinnedComment({ file: 'README.md', line: 1, pr_level: true }, { body: 'Overall review' }),
    ''
  )
})
