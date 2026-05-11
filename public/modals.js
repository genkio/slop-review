import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, toast, copyToClipboard, formatLineRange } from './util.js'

export function makeModal(innerHtml) {
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
  backdrop.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true">' +
    '<button type="button" class="modal-close" data-close aria-label="Close">×</button>' +
    innerHtml + '</div>'
  document.body.appendChild(backdrop)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    if (backdrop.querySelector('textarea, input[type=text], input:not([type])')) return
    const all = document.querySelectorAll('.modal-backdrop')
    if (all[all.length - 1] === backdrop) close()
  }
  const close = () => {
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
  }
  document.addEventListener('keydown', onKey)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
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
export function openThreadModal(threadId, opts = {}) {
  const { repoId, getThread, jumpToDiff, onChanged } = opts
  if (!repoId || !getThread) {
    toast('Cannot open thread (missing context)')
    return
  }

  const renderModal = () => {
    const thread = getThread(threadId)
    if (!thread) {
      toast('Thread not found')
      return
    }

    const viewBadge = thread.view
      ? `<span class="card-local-pill view-${thread.view}">${escapeHtml(thread.view)}</span>`
      : ''
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

    const jumpBtn = jumpToDiff
      ? '<button type="button" data-jump>Jump to diff</button>'
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

    const filenameBtn = fileNameForCopy
      ? `<button type="button" class="thread-filename" data-copy-filename data-filename="${escapeHtml(fileNameForCopy)}" title="Click to copy — paste into a chat to reference this thread"><span class="thread-filename-text">${escapeHtml(fileNameForCopy)}</span></button>`
      : ''

    const backdrop = makeModal(`
      <h2>Thread ${viewBadge} ${filenameBtn}</h2>
      <div class="sub">${escapeHtml(subLabel)} ${thread.side ? `<span class="thread-side">(${escapeHtml(thread.side)})</span>` : ''}</div>
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
        ${jumpBtn}
        ${resolveBtn}
        <button type="button" class="danger" data-delete>Delete thread</button>
      </div>`)

    // Stamp last_read_at on open so the state pill flips from 🟢 → ◌
    // for the next refresh. Fire-and-forget; failure here would just leave
    // the pill green, which is harmless.
    api(`/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(threadId)}/read`, { method: 'POST' })
      .then((res) => { if (res?.threads) onChanged?.(res) })
      .catch(() => {})

    const ta = backdrop.querySelector('.thread-reply-input')
    const replyBtn = backdrop.querySelector('[data-reply]')
    ta.focus()

    replyBtn.addEventListener('click', async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      replyBtn.disabled = true
      replyBtn.textContent = 'Saving…'
      try {
        const res = await api(
          `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(threadId)}/comments`,
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
      backdrop.querySelector('[data-jump]').addEventListener('click', () => {
        backdrop.remove()
        jumpToDiff(thread)
      })
    }

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
          `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(threadId)}/${path}`,
          { method: 'POST' }
        )
        // Sync the local thread ref from the server response so any later
        // in-modal action (Reply, Delete) sees the post-toggle state.
        const updated = res?.threads?.find((t) => t.id === threadId)
        thread.resolved_at = updated?.resolved_at ?? (toResolved ? new Date().toISOString() : null)
        // Swap the footer button.
        const newBtnHtml = toResolved
          ? '<button type="button" class="thread-unresolve" data-unresolve>Reopen</button>'
          : '<button type="button" class="thread-resolve" data-resolve>✓ Resolve</button>'
        btn.outerHTML = newBtnHtml
        // Swap the "Resolved Xh ago" subtitle.
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

    backdrop.querySelector('[data-delete]').addEventListener('click', () => {
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
            `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(threadId)}`,
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

    // Per-comment delete delegation
    backdrop.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-comment]')
      if (!btn) return
      e.stopPropagation()
      const commentId = btn.dataset.commentId
      const t = getThread(threadId)
      const isLast = (t?.comments?.length || 0) <= 1
      confirmRemoveComment({
        isLast,
        onConfirm: async () => {
          btn.disabled = true
          try {
            const res = await api(
              `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`,
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

  renderModal()
}
