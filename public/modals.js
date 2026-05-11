import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, toast, copyToClipboard } from './util.js'

export function makeModal(innerHtml, opts = {}) {
  const { onClose, noCloseButton = false } = opts
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  // Dynamic z-stack: layer above any modal already on screen so confirms
  // and aggregate-prompt modals don't render behind their launchers.
  const existing = [...document.querySelectorAll('.modal-backdrop')]
  if (existing.length) {
    const maxZ = Math.max(
      ...existing.map((b) => parseInt(getComputedStyle(b).zIndex, 10) || 0)
    )
    backdrop.style.zIndex = String(maxZ + 1)
  }
  // `noCloseButton`: opted into by the thread modal because it has its
  // own Close button in the footer, and the top-right corner is reused
  // for the click-to-copy filename affordance.
  const closeBtn = noCloseButton
    ? ''
    : '<button type="button" class="modal-close" data-close aria-label="Close">×</button>'
  backdrop.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true">' +
    closeBtn + innerHtml + '</div>'
  document.body.appendChild(backdrop)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    if (backdrop.querySelector('textarea, input[type=text], input:not([type])')) return
    const all = document.querySelectorAll('.modal-backdrop')
    if (all[all.length - 1] === backdrop) close()
  }
  // `closed` guards the fact that callers can also remove `backdrop`
  // directly (Delete-thread, navigate-to-diff) — without it, onClose
  // could fire twice when the explicit removal path is followed by an
  // Escape keypress on the now-detached node.
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    try { onClose?.() } catch {}
  }
  document.addEventListener('keydown', onKey)
  // One delegated click handler for both backdrop dismiss and any
  // `[data-close]` element. Delegation (not per-button binding) is what
  // lets a re-rendered modal's freshly-stamped close button still work —
  // openThreadModal's prev/next navigation replaces `.modal` innerHTML
  // in place, so the original × element gets thrown away.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { close(); return }
    if (e.target.closest('[data-close]')) close()
  })
  // Fires onClose even when the caller bypasses `close()` and removes
  // the backdrop node directly. One-shot via MutationObserver, since the
  // resolve/jump/delete paths in the thread modal use `backdrop.remove()`
  // for their own reasons and we still want the URL `?thread=` strip.
  if (onClose) {
    const obs = new MutationObserver(() => {
      if (!backdrop.isConnected) {
        obs.disconnect()
        close()
      }
    })
    obs.observe(document.body, { childList: true })
  }
  return backdrop
}

function commentHtml(c, removable = false) {
  const removeBtn = removable
    ? `<button type="button" class="msg-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Remove comment" title="Remove comment">×</button>`
    : ''
  return `
    <div class="msg" data-comment-id="${escapeHtml(c.id)}">
      <div class="msg-head"><span class="msg-who">${escapeHtml(c.user)}</span><span class="msg-when">${escapeHtml(relTime(c.posted_at || c.created_at))}</span>${removeBtn}</div>
      <div class="msg-body">${inlineCode(c.body)}</div>
    </div>`
}

export function confirmRemoveComment({ isLast, onConfirm }) {
  const detail = isLast
    ? 'This is the last comment in the thread, so the entire thread file will be removed too.'
    : 'Removes this comment from the thread.'
  const backdrop = makeModal(`
    <h2>Remove comment?</h2>
    <p class="modal-text">${escapeHtml(detail)} This can't be undone.</p>
    <div class="modal-actions">
      <button data-close>Cancel</button>
      <button class="primary" data-confirm>Remove</button>
    </div>`)
  backdrop.querySelector('[data-confirm]').onclick = () => {
    backdrop.remove()
    onConfirm()
  }
}

/**
 * Open the thread modal for one slop-review thread. The thread is fetched
 * from the freshest snapshot via the supplied `getThread` callback so a
 * thread that just got an LLM reply via SSE shows the latest content.
 *
 * `onChanged` fires after any mutation (reply / delete / comment delete)
 * so the host page can re-render its thread list / inline display.
 */
// SessionStorage key for the "recently viewed thread" breadcrumb the
// threads page paints as a thick left ribbon. Set whenever a modal opens
// or prev/next steps to a new thread; read on every threads-page render.
const LAST_OPENED_KEY = 'slop-review:last-opened-thread'

export function openThreadModal(threadId, opts = {}) {
  const { repoId, getThread, jumpToDiff, onChanged, onClose, threadOrder } = opts
  if (!repoId || !getThread) {
    toast('Cannot open thread (missing context)')
    return
  }

  // `currentId` is mutable so prev/next can swap the displayed thread
  // without remounting the modal. Doing this in place (instead of
  // close+reopen) is load-bearing for the URL `?thread=` contract: a
  // teardown would fire `onClose` and replaceState the param away,
  // breaking the relationship between modal and URL.
  let currentId = threadId
  let backdrop = null
  // Textarea auto-focus runs only on the very first mount. Re-running it
  // on prev/next would yank the modal scroll position downward as the
  // browser tries to bring the textarea into view — exactly the wrong
  // gesture for "I'm browsing through threads."
  let isInitialMount = true

  const buildInnerHtml = (thread) => {
    const subLabel = thread.file ? `${thread.file}:${thread.line}` : 'Thread'

    // Filename for copy-to-clipboard. Server always sends `file_name`; we
    // construct the same `thread_<status>_<hex>.json` formula client-side
    // as a defensive fallback so the affordance still works if the field
    // is missing for any reason.
    const fileNameForCopy = thread.file_name || (() => {
      const status = thread.resolved_at ? 'resolved' : 'open'
      const hex = (thread.id || '').replace(/^thread_/, '')
      return hex ? `thread_${status}_${hex}.json` : ''
    })()

    const msgs = (thread.comments || []).map((c) => commentHtml(c, true)).join('')

    // "Jump to file" lives in the modal head — closer to the file:line
    // subtitle it acts on. The old footer "Jump to diff" button is gone;
    // its data-jump hook moves with it so the existing click wiring works.
    const jumpLink = jumpToDiff
      ? '<button type="button" class="thread-jump-link" data-jump title="Open this file in the diff view">Jump to file</button>'
      : ''

    // Resolution toggle. Label + class flip based on the current state so
    // a single click does whatever is locally meaningful: "✓ Resolve" on
    // an open thread, "Reopen" on a resolved one. Resolved threads also
    // surface a small subtitle so the user remembers when they closed it.
    const isResolved = !!thread.resolved_at
    const resolveBtn = isResolved
      ? '<button type="button" class="thread-unresolve" data-unresolve>Reopen</button>'
      : '<button type="button" class="thread-resolve" data-resolve>✓ Resolve</button>'
    const resolvedSub = isResolved
      ? `<div class="thread-resolved-note">Resolved ${escapeHtml(relTime(thread.resolved_at))}</div>`
      : ''

    // The filename copy-to-clipboard button sits at the top-right of the
    // modal head — taking over the spot the `×` close button used to
    // occupy (the thread modal opts out via noCloseButton: true).
    const filenameBtn = fileNameForCopy
      ? `<button type="button" class="thread-filename" data-copy-filename data-filename="${escapeHtml(fileNameForCopy)}" title="Click to copy — paste into a chat to reference this thread"><span class="thread-filename-text">${escapeHtml(fileNameForCopy)}</span></button>`
      : ''

    // Prev/next thread navigation. Disabled at the ends rather than
    // wrapping — wrap-around at boundaries is more disorienting than
    // helpful for an irregular browsing workflow.
    const navHtml = renderThreadNav(thread.id, threadOrder)

    return `
      <div class="thread-modal-head">
        ${navHtml}
        <div class="thread-modal-head-spacer"></div>
        ${filenameBtn}
      </div>
      <div class="sub">${escapeHtml(subLabel)} ${jumpLink}</div>
      ${resolvedSub}
      <div class="thread-list" data-thread-list>${msgs}</div>
      <div class="thread-reply">
        <textarea class="thread-reply-input" rows="3" placeholder="Add a follow-up comment…"></textarea>
        <div class="thread-reply-actions">
          <button type="button" data-reply>Reply</button>
        </div>
      </div>
      <div class="modal-actions">
        <button data-close>Close</button>
        ${resolveBtn}
        <button type="button" class="danger" data-delete>Delete thread</button>
      </div>`
  }

  const mountOrUpdate = () => {
    const thread = getThread(currentId)
    if (!thread) {
      toast('Thread not found')
      return
    }

    // Stash the breadcrumb every time the modal lands on a thread —
    // initial open, prev/next nav, or even a re-render after resolution
    // toggle. Reads of this key happen on the threads page render path.
    try { sessionStorage.setItem(LAST_OPENED_KEY, currentId) } catch {}

    // Keep `?thread=` in the URL synced with the modal's current thread.
    // Two reasons: (a) refresh restores the thread you were actually
    // looking at, not the one you initially opened; (b) browser back from
    // the diff page returns you here with the right thread reopened.
    // replaceState (not push) avoids stacking a history entry per
    // prev/next click — the modal is one logical view with mutable
    // contents, not N separate pages. Doesn't fire hashchange, so the
    // router doesn't re-enter and try to re-mount this page.
    syncThreadInUrl(currentId)

    const html = buildInnerHtml(thread)
    if (!backdrop) {
      backdrop = makeModal(html, { onClose, noCloseButton: true })
    } else {
      // Replace `.modal`'s innerHTML in place. The backdrop's MutationObserver
      // only fires when the backdrop itself leaves the DOM, so swapping
      // children does NOT trigger onClose — exactly what we want for
      // prev/next: same modal session, different thread. No close button
      // prepended either — the thread modal opts out (noCloseButton: true).
      const modalEl = backdrop.querySelector('.modal')
      modalEl.innerHTML = html
    }

    // Stamp last_read_at on open / on navigation. Fire-and-forget;
    // failure leaves the pill green which is harmless.
    api(`/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/read`, { method: 'POST' })
      .then((res) => { if (res?.threads) onChanged?.(res) })
      .catch(() => {})

    wireHandlers(thread)
    isInitialMount = false
  }

  const wireHandlers = (thread) => {
    const ta = backdrop.querySelector('.thread-reply-input')
    const replyBtn = backdrop.querySelector('[data-reply]')
    // Only auto-focus on the very first mount. Re-focusing on prev/next
    // would scroll the modal to the textarea position — the user is
    // navigating threads, not composing replies.
    if (isInitialMount) ta?.focus()

    replyBtn?.addEventListener('click', async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      replyBtn.disabled = true
      replyBtn.textContent = 'Saving…'
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/comments`,
          { method: 'POST', body: JSON.stringify({ body }) }
        )
        const list = backdrop.querySelector('[data-thread-list]')
        if (list && res.comment) list.insertAdjacentHTML('beforeend', commentHtml(res.comment, true))
        ta.value = ''
        ta.focus()
        toast('Reply added')
        onChanged?.(res)
      } catch (e) {
        toast('Reply failed: ' + (e.message || 'unknown'))
      } finally {
        replyBtn.disabled = false
        replyBtn.textContent = 'Reply'
      }
    })

    if (jumpToDiff) {
      backdrop.querySelector('[data-jump]')?.addEventListener('click', () => {
        backdrop.remove()
        jumpToDiff(thread)
      })
    }

    // Prev/next thread navigation. Same closure as the rest of the modal,
    // so opts (jumpToDiff, onChanged, threadOrder, onClose) flow into the
    // re-rendered modal unchanged.
    backdrop.querySelector('[data-thread-prev]')?.addEventListener('click', () => {
      const adj = adjacentThreadId(currentId, threadOrder, -1)
      if (adj) { currentId = adj; mountOrUpdate() }
    })
    backdrop.querySelector('[data-thread-next]')?.addEventListener('click', () => {
      const adj = adjacentThreadId(currentId, threadOrder, +1)
      if (adj) { currentId = adj; mountOrUpdate() }
    })

    // Click-to-copy on the filename affordance. Lets the developer grab
    // the `thread_<status>_<hex>.json` filename and paste it into an agent
    // chat (the slop-review skill's "reply to a specific thread" workflow
    // needs the filename to locate the JSON without a directory scan).
    // The transient `is-copied` class flips the leading icon glyph from
    // `⧉` to `✓` for 1.2s as visual confirmation alongside the toast.
    backdrop.querySelector('[data-copy-filename]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget
      const name = btn.dataset.filename
      if (!name) return
      try {
        await copyToClipboard(name)
        toast('Filename copied')
        btn.classList.add('is-copied')
        setTimeout(() => btn.classList.remove('is-copied'), 1200)
      } catch (err) {
        toast('Copy failed: ' + (err.message || 'unknown'))
      }
    })

    // Resolution toggle. Patches the footer button, the resolved subtitle,
    // and the local `thread` ref in place rather than re-rendering the
    // whole modal — preserves any in-flight reply text and avoids a flash.
    const wireResolutionToggle = () => {
      const onResolve   = () => performResolution(true)
      const onUnresolve = () => performResolution(false)
      backdrop.querySelector('[data-resolve]')?.addEventListener('click', onResolve)
      backdrop.querySelector('[data-unresolve]')?.addEventListener('click', onUnresolve)
    }
    const performResolution = async (toResolved) => {
      const path = toResolved ? 'resolve' : 'unresolve'
      const btn = backdrop.querySelector(toResolved ? '[data-resolve]' : '[data-unresolve]')
      if (!btn) return
      btn.disabled = true
      const originalLabel = btn.textContent
      btn.textContent = 'Saving…'
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/${path}`,
          { method: 'POST' }
        )
        const updated = res?.threads?.find((t) => t.id === currentId)
        thread.resolved_at = updated?.resolved_at ?? (toResolved ? new Date().toISOString() : null)
        const newBtnHtml = toResolved
          ? '<button type="button" class="thread-unresolve" data-unresolve>Reopen</button>'
          : '<button type="button" class="thread-resolve" data-resolve>✓ Resolve</button>'
        btn.outerHTML = newBtnHtml
        const existingNote = backdrop.querySelector('.thread-resolved-note')
        if (toResolved) {
          const noteHtml = `<div class="thread-resolved-note">Resolved ${escapeHtml(relTime(thread.resolved_at))}</div>`
          if (existingNote) existingNote.outerHTML = noteHtml
          else backdrop.querySelector('.sub')?.insertAdjacentHTML('afterend', noteHtml)
        } else {
          existingNote?.remove()
        }
        wireResolutionToggle()
        onChanged?.(res)
        toast(toResolved ? 'Thread resolved' : 'Thread reopened')
      } catch (e) {
        btn.disabled = false
        btn.textContent = originalLabel
        toast(`${toResolved ? 'Resolve' : 'Reopen'} failed: ` + (e.message || 'unknown'))
      }
    }
    wireResolutionToggle()

    backdrop.querySelector('[data-delete]')?.addEventListener('click', () => {
      const confirmBackdrop = makeModal(`
        <h2>Delete this thread?</h2>
        <p class="modal-text">Removes the thread, its comments, and the on-disk JSON file. This can't be undone.</p>
        <div class="modal-actions">
          <button data-close>Cancel</button>
          <button class="primary" data-confirm>Delete</button>
        </div>`)
      confirmBackdrop.querySelector('[data-confirm]').onclick = async () => {
        try {
          const res = await api(
            `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}`,
            { method: 'DELETE' }
          )
          confirmBackdrop.remove()
          backdrop.remove()
          onChanged?.(res)
          toast('Thread deleted')
        } catch (e) {
          toast('Delete failed: ' + (e.message || 'unknown'))
        }
      }
    })
  }

  // Per-comment delete delegation. Attached ONCE to the backdrop because
  // it survives in-place re-renders (the listener is on the backdrop
  // element, not on the inner comment markup). Uses `currentId` (the
  // mutable closure variable) so prev/next-navigated threads delete from
  // the right thread.
  backdrop = null  // ensure first mountOrUpdate creates the backdrop
  mountOrUpdate()
  backdrop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-comment]')
    if (!btn) return
    e.stopPropagation()
    const commentId = btn.dataset.commentId
    const t = getThread(currentId)
    const isLast = (t?.comments?.length || 0) <= 1
    confirmRemoveComment({
      isLast,
      onConfirm: async () => {
        btn.disabled = true
        try {
          const res = await api(
            `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/comments/${encodeURIComponent(commentId)}`,
            { method: 'DELETE' }
          )
          if (res.deleted === 'thread') {
            backdrop.remove()
            toast('Thread removed')
          } else {
            backdrop.querySelector(`.msg[data-comment-id="${commentId}"]`)?.remove()
            toast('Comment removed')
          }
          onChanged?.(res)
        } catch (err) {
          btn.disabled = false
          toast('Remove failed: ' + (err.message || 'unknown'))
        }
      },
    })
  })
}

/** Read the "last viewed" thread id stashed by openThreadModal. */
export function getLastOpenedThreadId() {
  try { return sessionStorage.getItem(LAST_OPENED_KEY) || null }
  catch { return null }
}

/**
 * Rewrite `?thread=…` in the current hash to the given id, preserving any
 * other query params (e.g. `?file=…` on the diff page, though the thread
 * modal only ever opens on `#/` today). Uses replaceState — silent URL
 * update, no hashchange event, no router re-entry. Closing the modal
 * still strips this param via threads.js's `stripThreadQuery()`.
 */
function syncThreadInUrl(threadId) {
  const hash = location.hash || '#/'
  const qIdx = hash.indexOf('?')
  const pathPart  = qIdx < 0 ? hash : hash.slice(0, qIdx)
  const queryPart = qIdx < 0 ? '' : hash.slice(qIdx + 1)
  const kept = queryPart.split('&').filter((p) => p && !p.startsWith('thread=')).join('&')
  const newQuery = kept ? `${kept}&thread=${encodeURIComponent(threadId)}` : `thread=${encodeURIComponent(threadId)}`
  const next = `${pathPart}?${newQuery}`
  if (next === hash) return    // no-op if URL already says what we want
  history.replaceState(null, '', next)
}

function adjacentThreadId(currentId, order, step) {
  if (!Array.isArray(order) || order.length === 0) return null
  const idx = order.indexOf(currentId)
  if (idx < 0) return null
  const next = idx + step
  return next >= 0 && next < order.length ? order[next] : null
}

function renderThreadNav(currentId, order) {
  if (!Array.isArray(order) || order.length <= 1) return ''
  const idx = order.indexOf(currentId)
  if (idx < 0) return ''
  const prevDisabled = idx === 0
  const nextDisabled = idx === order.length - 1
  const position = `${idx + 1} of ${order.length}`
  return '<div class="thread-modal-nav" role="group" aria-label="Thread navigation">' +
    `<button type="button" class="thread-nav-btn" data-thread-prev aria-label="Previous thread" title="Previous thread"${prevDisabled ? ' disabled' : ''}>‹</button>` +
    `<span class="thread-nav-position">${position}</span>` +
    `<button type="button" class="thread-nav-btn" data-thread-next aria-label="Next thread" title="Next thread"${nextDisabled ? ' disabled' : ''}>›</button>` +
  '</div>'
}
