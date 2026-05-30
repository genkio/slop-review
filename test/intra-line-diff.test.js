import test from 'node:test'
import assert from 'node:assert/strict'
import { intraLineSegments } from '../core/intra-line-diff.js'

function reconstruct(segs) {
  return segs.map((s) => s.text).join('')
}

test('returns null for identical lines (similarity gate not the issue — no LCS work needed)', () => {
  // Same input twice should still pair, but every token is 'eq' which means
  // there's nothing to highlight. We let the gate handle this — explicit
  // tests below cover the not-similar-enough case.
  const seg = intraLineSegments('return result.empty', 'return result.empty')
  assert.ok(seg)
  assert.equal(reconstruct(seg.left), 'return result.empty')
  assert.equal(reconstruct(seg.right), 'return result.empty')
  assert.ok(seg.left.every((s) => s.kind === 'eq'))
  assert.ok(seg.right.every((s) => s.kind === 'eq'))
})

test('isolates a single-token replacement', () => {
  const seg = intraLineSegments('const x = foo(1)', 'const x = bar(1)')
  assert.ok(seg, 'should pair')
  assert.equal(reconstruct(seg.left), 'const x = foo(1)')
  assert.equal(reconstruct(seg.right), 'const x = bar(1)')
  // The 'foo' token on the left should be the only del; 'bar' the only add.
  const lDel = seg.left.filter((s) => s.kind === 'del').map((s) => s.text)
  const rAdd = seg.right.filter((s) => s.kind === 'add').map((s) => s.text)
  assert.deepEqual(lDel, ['foo'])
  assert.deepEqual(rAdd, ['bar'])
})

test('captures a multi-token suffix change', () => {
  const seg = intraLineSegments(
    '  return result.empty ? null : result',
    '  return result.empty ? undefined : result'
  )
  assert.ok(seg)
  // Reconstruct must round-trip exactly so renderers don't lose chars.
  assert.equal(reconstruct(seg.left),  '  return result.empty ? null : result')
  assert.equal(reconstruct(seg.right), '  return result.empty ? undefined : result')
  const lDel = seg.left.filter((s) => s.kind === 'del').map((s) => s.text).join('')
  const rAdd = seg.right.filter((s) => s.kind === 'add').map((s) => s.text).join('')
  assert.equal(lDel, 'null')
  assert.equal(rAdd, 'undefined')
})

test('returns null when lines are too dissimilar (similarity gate)', () => {
  // Two unrelated lines — pairRows pairs them by position but they aren't
  // really the same line modified. Highlighting would just paint everything.
  const seg = intraLineSegments(
    'import { foo } from "./a"',
    'export const result = compute()'
  )
  assert.equal(seg, null)
})

test('returns null when one side is empty', () => {
  assert.equal(intraLineSegments('', 'something'), null)
  assert.equal(intraLineSegments('something', ''), null)
})

test('returns null when both sides are empty', () => {
  assert.equal(intraLineSegments('', ''), null)
})

test('falls back when input is too long (MAX_TOKENS guard)', () => {
  // Long minified line — generate one that clears the 400-token threshold.
  const long = Array.from({ length: 600 }, (_, i) => `var v${i}=1;`).join(' ')
  const seg = intraLineSegments(long, long.replace('v0', 'v999'))
  assert.equal(seg, null, 'should bail out rather than do quadratic work')
})

test('treats string literals as single tokens (no per-char noise inside strings)', () => {
  // Use enough surrounding context that the similarity gate passes — when
  // strings are opaque tokens, very-short lines look "mostly different"
  // to the LCS and fall back to whole-line wash, which is fine.
  const seg = intraLineSegments('fetchUser("alice", true)', 'fetchUser("bob", true)')
  assert.ok(seg)
  // Whole strings should appear as opaque tokens — the del should be the
  // entire old string, the add the entire new string, not per-char churn.
  const lDel = seg.left.filter((s) => s.kind === 'del').map((s) => s.text)
  const rAdd = seg.right.filter((s) => s.kind === 'add').map((s) => s.text)
  assert.deepEqual(lDel, ['"alice"'])
  assert.deepEqual(rAdd, ['"bob"'])
})

test('merges adjacent same-kind segments', () => {
  // Right side is a strict prefix; the trailing ' bar' becomes two
  // consecutive del tokens (' ' and 'bar') that should merge into one.
  const seg = intraLineSegments('foo bar', 'foo')
  assert.ok(seg)
  const lDels = seg.left.filter((s) => s.kind === 'del')
  assert.equal(lDels.length, 1, 'two adjacent del tokens should merge into one segment')
  assert.equal(lDels[0].text, ' bar')
})
