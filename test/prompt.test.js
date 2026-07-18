import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeKeys } from '../bin/prompt.js'

test('tokenizeKeys splits coalesced keypresses in one chunk', () => {
  // The bug this guards: down-arrow + space arriving as a single stdin read
  // must yield two keys, not one unmatched blob.
  assert.deepEqual(tokenizeKeys('\x1b[B '), ['\x1b[B', ' '])
})

test('tokenizeKeys keeps each escape sequence as one token', () => {
  assert.deepEqual(tokenizeKeys('\x1b[A\x1b[Bk'), ['\x1b[A', '\x1b[B', 'k'])
  assert.deepEqual(tokenizeKeys('\x1bOA'), ['\x1bOA'])   // SS3 arrows
})

test('tokenizeKeys treats a modified/unknown sequence as a single ignorable token', () => {
  // Consumed through the final letter so its digits/semicolons never leak out
  // as stray keys (a bare digit could otherwise toggle or move).
  assert.deepEqual(tokenizeKeys('\x1b[1;5A'), ['\x1b[1;5A'])
})

test('tokenizeKeys emits plain characters individually', () => {
  assert.deepEqual(tokenizeKeys('abc'), ['a', 'b', 'c'])
  assert.deepEqual(tokenizeKeys(' \r'), [' ', '\r'])
  assert.deepEqual(tokenizeKeys(''), [])
})
