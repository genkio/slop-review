import test from 'node:test'
import assert from 'node:assert/strict'
import { relTime, formatLineRange } from '../core/format.js'
import { forgeDeepLink } from '../core/forge.js'
import { isFullIndex, isCommitIndex, isLocalIndex, computeVisibleFiles } from '../core/view.js'
import { deriveRepoId } from '../core/repo-id.js'

const EN_DASH = String.fromCharCode(0x2013)

test('formatLineRange: single, multi (en-dash), legacy, nullish', () => {
  assert.equal(formatLineRange({ line: 42 }), '42')
  assert.equal(formatLineRange({ line: 42, line_end: 42 }), '42')
  assert.equal(formatLineRange({ line: 42, line_end: 45 }), `42${EN_DASH}45`)
  assert.equal(formatLineRange({}), '')
  assert.equal(formatLineRange(null), '')
})

test('relTime: empty and far-past branches are deterministic', () => {
  assert.equal(relTime(''), '')
  assert.equal(relTime(null), '')
  assert.equal(relTime('2000-01-01T00:00:00Z'), '2000-01-01')
})

test('forgeDeepLink: github single / range / old-side / unsupported', () => {
  assert.equal(
    forgeDeepLink({ host: 'github', prUrl: 'https://x/pr/1', pathSha256: 'abc', lineStart: 3, lineEnd: 3, side: 'new' }),
    'https://x/pr/1/files#diff-abcR3',
  )
  assert.equal(
    forgeDeepLink({ host: 'github', prUrl: 'https://x/pr/1', pathSha256: 'abc', lineStart: 3, lineEnd: 5, side: 'new' }),
    'https://x/pr/1/files#diff-abcR3-R5',
  )
  assert.equal(
    forgeDeepLink({ host: 'github', prUrl: 'https://x/pr/1', pathSha256: 'abc', lineStart: 3, lineEnd: 3, side: 'old' }),
    'https://x/pr/1/files#diff-abcL3',
  )
  assert.equal(forgeDeepLink({ host: 'gitlab', prUrl: 'u', pathSha256: 'h', lineStart: 1, lineEnd: 1 }), null)
  assert.equal(forgeDeepLink({ host: 'github', prUrl: '', pathSha256: 'h', lineStart: 1, lineEnd: 1 }), null)
})

test('view index-space predicates (commits=3, hasLocal)', () => {
  // indices 0,1,2 = commits; 3 = Full; 4 = Local (only when hasLocal)
  assert.equal(isCommitIndex(0, 3), true)
  assert.equal(isCommitIndex(2, 3), true)
  assert.equal(isCommitIndex(3, 3), false)
  assert.equal(isFullIndex(3, 3), true)
  assert.equal(isFullIndex(4, 3), false)
  assert.equal(isLocalIndex(4, 3, true), true)
  assert.equal(isLocalIndex(4, 3, false), false)
})

test('computeVisibleFiles: file filter, non-full passthrough, related filter', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]
  const base = { diff: { files }, commits: [1, 2], hasLocal: false }
  // single-file filter wins in any view
  assert.deepEqual(
    computeVisibleFiles({ ...base, index: 0, filter: { kind: 'file', path: 'b' } }).map((f) => f.path),
    ['b'],
  )
  // non-Full view (index 0 = a commit): all files
  assert.deepEqual(computeVisibleFiles({ ...base, index: 0, filter: null }).map((f) => f.path), ['a', 'b', 'c'])
  // Full view (index === commits.length === 2) with a related filter: anchor + edges
  const withPrio = {
    diff: { files, priorities: { b: { incoming: ['a'], outgoing: ['c'] } } },
    commits: [1, 2], hasLocal: false, index: 2, filter: { kind: 'related', anchor: 'b' },
  }
  assert.deepEqual(computeVisibleFiles(withPrio).map((f) => f.path).sort(), ['a', 'b', 'c'])
})

test('deriveRepoId: stable, basename-prefixed, sanitized', () => {
  const id = deriveRepoId('/Users/x/My Repo!')
  assert.match(id, /^My-Repo_[0-9a-f]{8}$/)
  assert.equal(deriveRepoId('/Users/x/My Repo!'), id) // stable
  assert.notEqual(deriveRepoId('/other/My Repo!'), id) // path-sensitive
})
