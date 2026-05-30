import test from 'node:test'
import assert from 'node:assert/strict'
import { keymapItems } from '../core/keymap.js'

// Pins the which-key cascade lifted out of public/diff.js getKeymapItems:
// the priority order (confirm > editor > selection > base), the base item
// list, the conditional gates, and the labels. The browser builds ctx from
// the DOM and the TUI from its render model, but both flow through this.

test('confirm modal takes top priority', () => {
  assert.deepEqual(keymapItems({ confirmModalOpen: true, editorOpen: true, commentSelection: true }), [
    { keys: ['↵'], label: 'confirm' },
    { keys: ['Esc'], label: 'cancel' },
  ])
})

test('editor wins over selection; submitMod is honored', () => {
  assert.deepEqual(keymapItems({ editorOpen: true, commentSelection: true }), [
    { keys: ['Ctrl', '↵'], label: 'submit' },
    { keys: ['Esc'], label: 'cancel' },
  ])
  assert.deepEqual(keymapItems({ editorOpen: true, submitMod: '⌘' }), [
    { keys: ['⌘', '↵'], label: 'submit' },
    { keys: ['Esc'], label: 'cancel' },
  ])
})

test('comment selection mode', () => {
  assert.deepEqual(keymapItems({ commentSelection: true }), [
    { keys: ['c'], label: 'add comment' },
    { keys: ['Esc'], label: 'cancel' },
    { keys: ['j', 'k'], label: 'extend ↕' },
  ])
})

test('base view shows only the always-on verbs', () => {
  assert.deepEqual(keymapItems({}), [
    { keys: ['j', 'k'], label: 'move' },
    { keys: ['c'], label: 'comment' },
    { keys: ['v'], label: 'multi-line' },
    { keys: ['y'], label: 'copy' },
  ])
})

test('base view appends each conditional gate in order', () => {
  assert.deepEqual(keymapItems({
    viewSupportsReviewed: true,
    forgeAvailable: true,
    hasVisibleThread: true,
    cursorHasThread: true,
    cursorHasPeekTarget: true,
    hasExpandTarget: true,
  }), [
    { keys: ['j', 'k'], label: 'move' },
    { keys: ['c'], label: 'comment' },
    { keys: ['v'], label: 'multi-line' },
    { keys: ['y'], label: 'copy' },
    { keys: ['r'], label: 'toggle reviewed' },
    { keys: ['o'], label: 'open GitHub' },
    { keys: ['n'], label: 'next thread' },
    { keys: ['d'], label: 'delete thread' },
    { keys: ['p'], label: 'peek HEAD' },
    { keys: ['e'], label: 'expand' },
  ])
})
