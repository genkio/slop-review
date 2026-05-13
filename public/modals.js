import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, toast, copyToClipboard, formatLineRange } from './util.js'

export function makeModal(innerHtml, opts = {}) {
  const { onClose, noCloseButton = false, noBackdropClose = false } = opts
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
    // `noBackdropClose` callers (the thread modal) have their own Close
    // button in the footer and treat backdrop clicks as accidental — a
    // misfire that throws away an in-flight reply textarea would be more
    // disruptive than the convenience of click-outside-to-dismiss. Esc
    // still works (handled by the keydown listener above).
    if (e.target === backdrop) {
      if (!noBackdropClose) close()
      return
    }
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

function commentHtml(c, interactive = false) {
  // Edit + remove sit together at the right edge of the meta row. The first
  // one carries `margin-left: auto` (in CSS) so both get pushed right while
  // staying flush to each other. Body is rendered as raw text via
  // inlineCode; the edit handler reads the unrendered string from the
  // thread state, never from this HTML.
  const actions = interactive
    ? `<button type="button" class="msg-edit" data-edit-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Edit comment" title="Edit comment">✎</button>` +
      `<button type="button" class="msg-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Remove comment" title="Remove comment">×</button>`
    : ''
  return `
    <div class="msg" data-comment-id="${escapeHtml(c.id)}">
      <div class="msg-head"><span class="msg-who">${escapeHtml(c.user)}</span><span class="msg-when">${escapeHtml(relTime(c.posted_at || c.created_at))}</span>${actions}</div>
      <div class="msg-body" data-body>${inlineCode(c.body)}</div>
    </div>`
}

export function confirmRemoveComment({ isLast, onConfirm }) {
  const detail = isLast
    ? 'This is the last comment in the thread, so the entire thread file will be deleted too.'
    : 'Deletes this comment from the thread.'
  const backdrop = makeModal(`
    <h2>Delete this comment?</h2>
    <p class="modal-text">${escapeHtml(detail)} This can't be undone.</p>
    <div class="modal-actions is-reversed">
      <button class="danger" data-confirm>Delete</button>
      <button data-close>Cancel</button>
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
 * `onChanged` fires after a real mutation (reply / resolve / delete-thread
 * / delete-comment / edit-comment) so the host page can re-render its
 * thread list / inline display.
 *
 * `onRead` fires after the /read stamp returns. It's intentionally a
 * separate hook from `onChanged` because /read isn't a real mutation —
 * its only visible effect is the single thread's state-pill flipping
 * from "your_turn" to "read". Hosts that route /read through `onChanged`
 * pay for a full diff re-render every time the modal opens or the user
 * hits prev/next, which can drift the diff-body scroll position (the
 * `preserveScrollTo` ResizeObserver dance vs. `overflow-anchor: none`
 * is imperfect on body-wide innerHTML swaps). Hosts can either omit
 * `onRead` (default behavior: skip refresh entirely — the pill update
 * lags one user action) or supply a lightweight refresh that doesn't
 * wipe innerHTML.
 *
 * `onNavigate(newId)` fires after a prev/next step so the host page can
 * re-aim its scroll (the diff page jumps to the new anchor).
 */
export function openThreadModal(threadId, opts = {}) {
  const { repoId, getThread, onChanged, onRead, onClose, onNavigate, threadOrder } = opts
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

  /**
   * Shared "I'm done with this thread, move me along" advance step used
   * by Delete and Resolve. Prefers the next thread in `threadOrder`,
   * falling back to the previous one when current sits at the end.
   * Splices the current id out of `threadOrder` so position labels
   * ("N of M") stay truthful and so the user doesn't cycle back through
   * a thread they've explicitly signed off on. When no neighbour remains,
   * the modal closes — i.e. the user finished the last thread, so the
   * "advance" gesture naturally becomes "I'm done with the whole batch."
   */
  const advanceAfterDone = () => {
    let nextId = null
    if (Array.isArray(threadOrder) && threadOrder.length > 1) {
      nextId = adjacentThreadId(currentId, threadOrder, +1)
            ?? adjacentThreadId(currentId, threadOrder, -1)
      const idx = threadOrder.indexOf(currentId)
      if (idx >= 0) threadOrder.splice(idx, 1)
    }
    if (nextId) {
      currentId = nextId
      mountOrUpdate()
      onNavigate?.(nextId)
    } else {
      backdrop?.remove()
    }
  }

  const buildInnerHtml = (thread) => {
    const subLabel = thread.file ? `${thread.file}:${formatLineRange(thread)}` : 'Thread'

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

    // Filename copy-to-clipboard. Displayed as the bare 8-hex thread id
    // (e.g. `b0d370da` from `thread_open_b0d370da.json`) so it reads as a
    // quiet right-aligned identifier on the same row as the file:line
    // subtitle, not a noisy `thread_open_*.json` filename. The full
    // filename still rides in `data-filename` because that's what the
    // agent-chat paste workflow expects — paste either the hex or the
    // full filename and the slop-review skill resolves to the same JSON.
    const hexId = (thread.id || '').replace(/^thread_/, '')
    const filenameBtn = fileNameForCopy && hexId
      ? `<button type="button" class="thread-filename" data-copy-filename data-filename="${escapeHtml(fileNameForCopy)}" title="Click to copy ${escapeHtml(fileNameForCopy)} — paste into a chat to reference this thread"><span class="thread-filename-text">${escapeHtml(hexId)}</span></button>`
      : ''

    // navAvailable + navIdx feed two pieces of nav UI rendered later in
    // this function: the "N of M" position label on the .sub row, and
    // the Prev / Next text-link row above the modal-actions footer. The
    // text-link row replaces the older side-chevron buttons that lived
    // outside `.modal`; consolidating both nav surfaces inline simplifies
    // the mount/unmount story (no more once-and-done attach for the
    // chevrons), at the cost of pushing the prev/next visual one row
    // further from the modal edge — fine for this content-dense modal.
    const navAvailable = Array.isArray(threadOrder) && threadOrder.length > 1
    const navIdx = navAvailable ? threadOrder.indexOf(thread.id) : -1
    const navPosition = navAvailable && navIdx >= 0
      ? `${navIdx + 1} of ${threadOrder.length}`
      : ''
    const positionHtml = navPosition
      ? `<span class="thread-modal-position">${escapeHtml(navPosition)}</span>`
      : ''

    // Sub row: file:line on the left, then a right-cluster with the
    // thread-hex filename pill and (when nav is available) the "N of M"
    // position indicator. The filename uses `margin-left: auto` in CSS
    // to consume slack and push itself + the position label to the right
    // edge. One row instead of three (was: head + filename + sub) so the
    // meta block doesn't waste vertical space.
    const subHtml = `<div class="sub">
      <span class="thread-modal-sub-label">${escapeHtml(subLabel)}</span>
      ${filenameBtn}
      ${positionHtml}
    </div>`

    // Prev / Next text-link nav row. Rendered as buttons (semantically
    // actionable, keyboard-friendly) styled to read as plain text. Lives
    // *inside* the modal's innerHTML, so it gets re-rendered on every
    // mountOrUpdate — listeners are re-attached in wireHandlers (no
    // once-and-done dance like the old side chevrons needed). Hidden
    // entirely when there's only one thread on the branch.
    const navHtml = navAvailable
      ? `<div class="thread-modal-nav">
          <button type="button" class="thread-modal-nav-link" data-thread-prev ${navIdx <= 0 ? 'disabled' : ''}>Prev</button>
          <button type="button" class="thread-modal-nav-link" data-thread-next ${navIdx >= threadOrder.length - 1 ? 'disabled' : ''}>Next</button>
        </div>`
      : ''

    return `
      ${subHtml}
      ${resolvedSub}
      <div class="thread-list" data-thread-list>${msgs}</div>
      <div class="thread-reply">
        <textarea class="thread-reply-input" rows="3" placeholder="Add a follow-up comment…"></textarea>
      </div>
      ${navHtml}
      <div class="modal-actions is-reversed">
        ${resolveBtn}
        <button type="button" class="danger" data-delete>Delete</button>
        <button type="button" data-reply>Reply</button>
      </div>`
  }

  const mountOrUpdate = () => {
    const thread = getThread(currentId)
    if (!thread) {
      toast('Thread not found')
      return
    }

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
      // ArrowLeft / ArrowRight → step prev / next thread. Document-scoped
      // so it fires regardless of which element inside the modal has
      // focus (otherwise a focused button would swallow the keyboard
      // event before it ever reached a backdrop-scoped listener).
      // Active-element gate is narrower than the Esc dispatcher in
      // makeModal: we bail only when the cursor is in an actual text
      // input (textarea / contentEditable / text-like <input>), so that
      // native cursor movement inside those still wins. The reply
      // textarea is not auto-focused on mount, so arrow nav works
      // immediately after the modal opens.
      const onArrowNav = (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        // Shift+arrow is reserved for diff-page commit navigation (see
        // diff.js onKey). Bail BEFORE swallowing the event so the
        // bubble-phase onKey listener gets a clean shot. This also
        // makes Shift+arrow work for native text-selection extension
        // inside the reply textarea — Shift bypasses our claim entirely.
        if (e.shiftKey) return
        // Text-input cursor movement wins: bail BEFORE swallowing the
        // event so the textarea / contentEditable / text-like <input>
        // gets its native behaviour. Same compromise as before — typing
        // a reply inside the modal still works.
        const ae = document.activeElement
        if (ae) {
          if (ae.tagName === 'TEXTAREA' || ae.isContentEditable) return
          if (ae.tagName === 'INPUT') {
            const t = (ae.type || 'text').toLowerCase()
            const textLike = ['text','search','email','url','tel','password','number','date','time','month','week','datetime-local']
            if (textLike.includes(t)) return
          }
        }
        // Thread modal is on screen — arrow keys belong to the modal
        // stack, NOT the diff page underneath. Swallow the event so
        // anything else listening for bare arrows can't react.
        //
        // The primary line of defence is actually the keybinding
        // contract: diff.js's onKey requires Shift+arrow for commit
        // nav (we bailed above when shiftKey is true), so plain arrows
        // won't trigger `goto` even if the event reached it. Capture-
        // phase registration + `stopImmediatePropagation` here are
        // defence-in-depth — they ensure that if a future listener
        // anywhere starts handling bare arrows, the thread modal's
        // claim stays unambiguous. Stop unconditionally — even when
        // there's no neighbour to navigate to (threadOrder.length < 2),
        // bare arrows belong to the modal.
        e.preventDefault()
        e.stopImmediatePropagation()
        // Only NAVIGATE when this modal is the topmost — a confirm
        // modal layered on top (Delete this thread? Delete this
        // comment?) interactively owns the keyboard, so we swallow the
        // key here but don't step threads beneath it.
        const all = document.querySelectorAll('.modal-backdrop')
        if (all[all.length - 1] !== backdrop) return
        if (!Array.isArray(threadOrder) || threadOrder.length < 2) return
        const dir = e.key === 'ArrowLeft' ? -1 : +1
        const adj = adjacentThreadId(currentId, threadOrder, dir)
        if (!adj) return
        currentId = adj
        mountOrUpdate()
        onNavigate?.(adj)
      }
      // Wrap the host's onClose so the keydown listener is torn down when
      // the modal closes — every call to openThreadModal adds one, so
      // without cleanup we'd leak a handler per session that fires
      // against a detached `backdrop` closure.
      const wrappedOnClose = () => {
        document.removeEventListener('keydown', onArrowNav, true)
        onClose?.()
      }
      // No `noBackdropClose` flag: clicking outside the modal closes it
      // (user requested). Trade-off: a misclick on the backdrop will
      // discard any in-flight reply text in the textarea. Esc with the
      // textarea focused is still blocked by makeModal's keydown listener
      // (Esc-while-typing is a different muscle memory), so the user
      // retains one safe dismissal path that won't surprise them.
      backdrop = makeModal(html, { onClose: wrappedOnClose, noCloseButton: true })
      // Capture-phase registration is load-bearing: the diff page's
      // onKey listener (at diff.js:500-501) was registered earlier
      // during the diff page mount, also on `document`, in the default
      // bubble phase. Same-element bubble listeners fire in
      // registration order, so without `capture: true` the diff page's
      // onKey would run FIRST and call `goto()` before this handler
      // could stop it. Registering for capture phase guarantees we run
      // first regardless of registration order, which lets the
      // stopImmediatePropagation above actually pre-empt onKey.
      document.addEventListener('keydown', onArrowNav, true)
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
    // failure leaves the pill green which is harmless. The response
    // is routed through `onRead` (NOT `onChanged`) — see the docstring
    // above. The default `onRead` is undefined, so by default we skip
    // any host-side refresh and let the pill update lag one user
    // action. Hosts that want immediate-but-cheap refresh can opt in
    // by supplying onRead.
    api(`/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/read`, { method: 'POST' })
      .then((res) => { if (res?.threads) onRead?.(res) })
      .catch(() => {})

    wireHandlers(thread)
  }

  const wireHandlers = (thread) => {
    const ta = backdrop.querySelector('.thread-reply-input')
    const replyBtn = backdrop.querySelector('[data-reply]')
    // No auto-focus on mount: the focused textarea would swallow
    // ArrowLeft / ArrowRight (cursor movement inside text wins over the
    // global keydown handler that drives prev/next thread navigation).
    // The user can click the textarea when ready to compose a reply.

    replyBtn?.addEventListener('click', async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      // Reply is a plain text button now (lives in the footer's modal-
      // actions row alongside Resolve and Delete), so the conventional
      // textContent swap to "Saving…" + disabled state gives the user
      // unambiguous in-flight feedback.
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

    // Prev / Next nav. Re-wired on every mountOrUpdate because the modal
    // innerHTML is swapped on navigation, so the button nodes are fresh
    // (the listeners on the previous mount were tied to nodes that got
    // garbage-collected with the old innerHTML — no duplicate-handler
    // pileup risk). Disabled state is baked into the rendered HTML via
    // the `disabled` attribute, so we don't need a separate sync pass.
    backdrop.querySelector('[data-thread-prev]')?.addEventListener('click', () => {
      const adj = adjacentThreadId(currentId, threadOrder, -1)
      if (adj) { currentId = adj; mountOrUpdate(); onNavigate?.(adj) }
    })
    backdrop.querySelector('[data-thread-next]')?.addEventListener('click', () => {
      const adj = adjacentThreadId(currentId, threadOrder, +1)
      if (adj) { currentId = adj; mountOrUpdate(); onNavigate?.(adj) }
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
        onChanged?.(res)
        toast(toResolved ? 'Thread resolved' : 'Thread reopened')
        if (toResolved) {
          // User signalled "I'm done with this one" — auto-advance to the
          // next thread (or close if no neighbour). Skip the in-place
          // button + sub-note swap below: the modal re-mounts on next
          // thread via advanceAfterDone, so any in-place edits here would
          // be thrown away by the innerHTML swap.
          advanceAfterDone()
          return
        }
        // Reopen: the user wants to keep working on this thread, so stay
        // put and flip the button back to "✓ Resolve" in place. Drop the
        // "Resolved Xh ago" sub-note since the thread is open again.
        const updated = res?.threads?.find((t) => t.id === currentId)
        thread.resolved_at = updated?.resolved_at ?? null
        btn.outerHTML = '<button type="button" class="thread-resolve" data-resolve>✓ Resolve</button>'
        backdrop.querySelector('.thread-resolved-note')?.remove()
        wireResolutionToggle()
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
        <p class="modal-text">Deletes the thread, its comments, and the on-disk JSON file. This can't be undone.</p>
        <div class="modal-actions is-reversed">
          <button class="danger" data-confirm>Delete</button>
          <button data-close>Cancel</button>
        </div>`)
      confirmBackdrop.querySelector('[data-confirm]').onclick = async () => {
        try {
          const res = await api(
            `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}`,
            { method: 'DELETE' }
          )
          confirmBackdrop.remove()
          onChanged?.(res)
          toast('Thread deleted')
          // Auto-advance to the next thread instead of closing the modal.
          // `advanceAfterDone` closes the modal if no neighbour remains.
          advanceAfterDone()
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
    const editBtn = e.target.closest('[data-edit-comment]')
    if (editBtn) {
      e.stopPropagation()
      beginEditComment(editBtn.dataset.commentId)
      return
    }
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

  // In-place edit of a comment body. Replaces `.msg-body` with a textarea +
  // Save / Cancel buttons. Save → PATCH → swap the new body back in. Cancel
  // restores the original markup. `last_read_at` is intentionally not
  // bumped (the server preserves it too) — editing is a correction, not a
  // new event in the thread.
  function beginEditComment(commentId) {
    const msgEl = backdrop.querySelector(`.msg[data-comment-id="${commentId}"]`)
    const bodyEl = msgEl?.querySelector('[data-body]')
    if (!msgEl || !bodyEl) return
    if (msgEl.querySelector('[data-edit-form]')) return    // already editing
    const t = getThread(currentId)
    const comment = (t?.comments || []).find((m) => m.id === commentId)
    if (!comment) return

    const originalHtml = bodyEl.outerHTML
    const form = document.createElement('div')
    form.className = 'msg-body msg-edit-form'
    form.dataset.body = ''
    form.dataset.editForm = ''
    form.innerHTML =
      '<textarea class="msg-edit-input" rows="3"></textarea>' +
      '<div class="msg-edit-actions">' +
        '<button type="button" data-edit-cancel>Cancel</button>' +
        '<button type="button" class="primary" data-edit-save>Save</button>' +
      '</div>'
    bodyEl.replaceWith(form)
    const ta = form.querySelector('textarea')
    ta.value = comment.body || ''
    ta.focus()
    // Place cursor at end rather than selecting all — matches common
    // "edit my own message" behavior in chat UIs.
    ta.setSelectionRange(ta.value.length, ta.value.length)

    const cancel = () => {
      const restored = document.createElement('template')
      restored.innerHTML = originalHtml.trim()
      form.replaceWith(restored.content.firstChild)
    }
    form.querySelector('[data-edit-cancel]').addEventListener('click', cancel)
    form.querySelector('[data-edit-save]').addEventListener('click', async () => {
      const text = ta.value.trim()
      if (!text) { ta.focus(); return }
      if (text === (comment.body || '').trim()) { cancel(); return }
      const saveBtn = form.querySelector('[data-edit-save]')
      const cancelBtn = form.querySelector('[data-edit-cancel]')
      saveBtn.disabled = true; cancelBtn.disabled = true
      saveBtn.textContent = 'Saving…'
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}/comments/${encodeURIComponent(commentId)}`,
          { method: 'PATCH', body: JSON.stringify({ body: text }) }
        )
        const newBody = document.createElement('div')
        newBody.className = 'msg-body'
        newBody.dataset.body = ''
        newBody.innerHTML = inlineCode(res?.comment?.body ?? text)
        form.replaceWith(newBody)
        toast('Comment updated')
        onChanged?.(res)
      } catch (err) {
        saveBtn.disabled = false; cancelBtn.disabled = false
        saveBtn.textContent = 'Save'
        toast('Edit failed: ' + (err.message || 'unknown'))
      }
    })
  }
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

