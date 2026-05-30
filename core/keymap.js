// ----------------------------------------------------------------------
// Shared, runtime-agnostic which-key keymap cascade.
//
// This is the SINGLE SOURCE of the diff view's contextual hint bar: the
// priority order, the gating rules, the keys, and the labels. It was lifted
// out of public/diff.js's getKeymapItems, which read all of its context
// straight from the DOM. The cascade logic is the same; what changed is that
// the DOM coupling now lives in the caller: each front-end computes a flat
// `ctx` object and passes it in. The browser builds ctx from the DOM; the
// TUI builds the same ctx from its render model. Both render the returned
// `{ keys, label }[]` their own way (HTML <kbd> vs SGR chips), and both the
// key dispatcher and the footer read from this one list, so the bar can
// never advertise a key the handler won't honor.
//
// Import-pure: NO DOM, NO `node:`.
//
// ctx fields (all optional; falsy = gate closed):
//   confirmModalOpen      a destructive-confirm dialog is on top
//   editorOpen            the comment editor/composer has focus
//   commentSelection      a visual-line comment selection is active
//   viewSupportsReviewed  current view is Full or a commit (not Local)
//   forgeAvailable        a GitHub PR URL is resolved for deep-linking
//   hasVisibleThread      at least one thread row is rendered (not collapsed)
//   cursorHasThread       the cursor row has a thread to delete
//   cursorHasPeekTarget   the cursor row can peek HEAD (commit view gate)
//   hasExpandTarget       an expand-context affordance is reachable
//   submitMod             the submit modifier label ('Ctrl' or the mac glyph)
// ----------------------------------------------------------------------

export function keymapItems(ctx = {}) {
  const {
    confirmModalOpen,
    editorOpen,
    commentSelection,
    viewSupportsReviewed,
    forgeAvailable,
    hasVisibleThread,
    cursorHasThread,
    cursorHasPeekTarget,
    hasExpandTarget,
    submitMod = 'Ctrl',
  } = ctx

  // Confirmation modal: highest priority, it steals attention from
  // everything underneath.
  if (confirmModalOpen) {
    return [
      { keys: ['↵'],   label: 'confirm' },
      { keys: ['Esc'], label: 'cancel' },
    ]
  }
  // Editor open: cursor nav is suppressed while typing, so only
  // submit/cancel are actionable. Checked before the selection branch
  // because the selection is still set while the editor is open.
  if (editorOpen) {
    return [
      { keys: [submitMod, '↵'], label: 'submit' },
      { keys: ['Esc'],          label: 'cancel' },
    ]
  }
  // Visual-line selection mode. `c` and Enter both commit; surface `c`
  // (vim-canonical). Enter stays wired but un-advertised. y/o stay live
  // but are advertised at top-level only.
  if (commentSelection) {
    return [
      { keys: ['c'],     label: 'add comment' },
      { keys: ['Esc'],   label: 'cancel' },
      { keys: ['j', 'k'], label: 'extend ↕' },
    ]
  }
  // Base diff-view bindings. Old-side variants (C/V/Y/O) and J/K's 5-line
  // jump stay live but unadvertised to keep the bar uncluttered.
  const items = [
    { keys: ['j', 'k'], label: 'move' },
    { keys: ['c'],      label: 'comment' },
    { keys: ['v'],      label: 'multi-line' },
    { keys: ['y'],      label: 'copy' },
  ]
  // `r` is file-level reviewed toggle; Local view has no stable blob to
  // pin against, so it (and its hint) are scoped to Full/Commit.
  if (viewSupportsReviewed) items.push({ keys: ['r'], label: 'toggle reviewed' })
  // Forge: only when a GitHub PR URL has resolved.
  if (forgeAvailable) items.push({ keys: ['o'], label: 'open GitHub' })
  // `n`: only when a thread row is currently visible.
  if (hasVisibleThread) items.push({ keys: ['n'], label: 'next thread' })
  // Cursor-dependent: `d` only when there's a thread under the cursor.
  if (cursorHasThread) items.push({ keys: ['d'], label: 'delete thread' })
  // `p` peek-HEAD: only when the cursor row is a valid peek target.
  if (cursorHasPeekTarget) items.push({ keys: ['p'], label: 'peek HEAD' })
  // `e`: only when an expand-context affordance is reachable.
  if (hasExpandTarget) items.push({ keys: ['e'], label: 'expand' })
  return items
}
