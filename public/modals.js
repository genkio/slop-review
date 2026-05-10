import { api } from './api.js'
import { store } from './store.js'
import { escapeHtml, inlineCode, relTime, toast, copyToClipboard } from './util.js'

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
    const subLabel = thread.file ? `${thread.file}:${thread.line}` : 'Thread'

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

    const backdrop = makeModal(`
      <h2>Thread ${viewBadge}</h2>
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

// ----------------------------------------------------------------------
// Aggregate prompt modal — copies the LLM-handoff prompt to clipboard.
// Mirrors taiou's wirePromptBlocks pattern but trimmed: no PR description
// (we don't have one), branch context replaces it.
// ----------------------------------------------------------------------

function blocksHTML(blocks) {
  return blocks
    .map((b) => {
      const value = b.content || ''
      const placeholder = b.placeholder ?? ''
      const isEmpty = !value
      const display = isEmpty ? placeholder : value
      return `
    <div class="preview-block" data-block-id="${b.id}" data-placeholder="${escapeHtml(placeholder)}">
      <div class="preview-block-header">
        <span class="preview-block-label">${b.label}</span>
        <button type="button" class="preview-block-remove" aria-label="Remove ${b.label} block" title="Remove block">×</button>
      </div>
      <button type="button" class="preview-block-content${isEmpty ? ' is-empty' : ''}" data-content="${escapeHtml(value)}" aria-label="Edit ${b.label}" title="Click to edit">${escapeHtml(display)}</button>
    </div>`
    })
    .join('')
}

function openSectionEditor({ initialValue = '', label = 'Edit', onSave } = {}) {
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop section-editor-backdrop'
  // Layer above any existing modal so editing from inside the aggregate
  // prompt modal works.
  const existing = [...document.querySelectorAll('.modal-backdrop')]
  if (existing.length) {
    const maxZ = Math.max(...existing.map((b) => parseInt(getComputedStyle(b).zIndex, 10) || 0))
    backdrop.style.zIndex = String(maxZ + 1)
  }
  backdrop.innerHTML =
    '<div class="modal section-editor-modal" role="dialog" aria-modal="true">' +
      '<header class="section-editor-head">' +
        `<span class="section-editor-label">${escapeHtml(label)}</span>` +
        '<button type="button" class="section-editor-done primary" data-done>Done</button>' +
      '</header>' +
      '<textarea class="section-editor-content" spellcheck="false"></textarea>' +
    '</div>'
  document.body.appendChild(backdrop)

  const ta = backdrop.querySelector('.section-editor-content')
  ta.value = initialValue ?? ''

  const close = () => {
    onSave?.(ta.value)
    backdrop.remove()
  }

  backdrop.querySelector('[data-done]').addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  requestAnimationFrame(() => ta.focus())
}

function confirmRemoveBlock(blockEl, onRemoved) {
  const label = blockEl.querySelector('.preview-block-label').textContent
  const confirmBackdrop = makeModal(`
    <h2>Remove block?</h2>
    <div class="sub">${escapeHtml(label)}</div>
    <p class="modal-text">Removes the block from the current prompt. Cancel &amp; reopen the modal to restore it.</p>
    <div class="modal-actions">
      <button data-close>Cancel</button>
      <button class="primary" data-confirm>Remove</button>
    </div>`)
  confirmBackdrop.querySelector('[data-confirm]').onclick = () => {
    blockEl.remove()
    confirmBackdrop.remove()
    onRemoved?.()
  }
}

function wirePromptBlocks(backdrop) {
  const collectPrompt = () => {
    const parts = []
    for (const block of backdrop.querySelectorAll('.preview-block')) {
      const display = block.querySelector('.preview-block-content')
      const content = (display?.dataset.content || '').trim()
      if (!content) continue
      const tag = block.dataset.blockId
      parts.push(tag ? `<${tag}>\n${content}\n</${tag}>` : content)
    }
    return parts.join('\n\n')
  }

  const countEl = backdrop.querySelector('#prompt-count')
  const updateCount = () => {
    if (!countEl) return
    const text = collectPrompt()
    if (!text) { countEl.textContent = ''; return }
    const tokens = Math.ceil(text.length / 4)
    countEl.textContent = `~${tokens.toLocaleString()} tokens`
  }
  updateCount()

  backdrop.querySelectorAll('.preview-block-content').forEach((display) => {
    display.addEventListener('click', () => {
      const block = display.closest('.preview-block')
      const label = block?.querySelector('.preview-block-label')?.textContent || 'Edit'
      const placeholder = block?.dataset.placeholder || ''
      openSectionEditor({
        initialValue: display.dataset.content || '',
        label,
        onSave: (newValue) => {
          display.dataset.content = newValue
          display.textContent = newValue || placeholder
          display.classList.toggle('is-empty', !newValue)
          updateCount()
        },
      })
    })
  })

  backdrop.querySelectorAll('.preview-block-remove').forEach((btn) => {
    btn.onclick = () => confirmRemoveBlock(btn.closest('.preview-block'), updateCount)
  })

  return { collectPrompt, updateCount }
}

function aggregateBlocks({ repo, branch, branchInfo, threads }) {
  const repoPath = repo?.path || '{REPO_PATH}'
  const tmpl = store.state?.prompt_templates?.copy_local || ''
  const howTo = tmpl.replaceAll('{REPO_PATH}', repoPath)

  const blocks = [{ id: 'how-to', label: 'How to', content: howTo }]

  // Branch context: lets the agent know what range of code to consider.
  const ctxLines = []
  if (branch) ctxLines.push(`Branch: ${branch}`)
  if (branchInfo?.base_branch) ctxLines.push(`Base: ${branchInfo.base_branch}`)
  if (branchInfo?.head_sha) ctxLines.push(`HEAD: ${branchInfo.head_sha.slice(0, 12)}`)
  if (branchInfo?.merge_base_sha) ctxLines.push(`Merge-base: ${branchInfo.merge_base_sha.slice(0, 12)}`)
  blocks.push({ id: 'branch-context', label: 'Branch context', content: ctxLines.join('\n') })

  // Threads: every UNRESOLVED thread for the current branch, sorted by
  // file then line. Resolved threads are pure human bookkeeping — they're
  // omitted from the prompt entirely so the agent stays focused on what
  // still needs work and isn't biased by closed conversations.
  const sorted = [...(threads || [])]
    .filter((t) => !t.resolved_at)
    .sort((a, b) => {
      const f = (a.file || '').localeCompare(b.file || '')
      if (f !== 0) return f
      return (a.line || 0) - (b.line || 0)
    })
  // The agent reaches each thread JSON via its absolute `File:` path so it
  // doesn't matter what cwd it's invoked from. The server emits `file_name`
  // on every thread (it's the on-disk name carrying the status segment), so
  // we just splice it in here.
  const branchId = (typeof window !== 'undefined' && window.__slopBranchId) || branch || 'main'
  const threadText = sorted.length === 0
    ? '(no threads on this branch yet)'
    : sorted
        .map((t) => {
          const filePath = `${repoPath}/.reviews/${branchId}/${t.file_name}`
          const header = `Source: ${t.file}:${t.line}\nFile: ${filePath}\nView: ${t.view || 'full'}`
          const body = (t.comments || [])
            .map((c) => '[' + c.user + ']\n' + c.body)
            .join('\n\n')
          return body ? `${header}\n\n${body}` : header
        })
        .join('\n\n')

  blocks.push({ id: 'threads', label: 'Threads', content: threadText })
  blocks.push({
    id: 'adhoc-instructions', label: 'Adhoc instructions', content: '',
    placeholder: 'Additional guidance for the agent…',
  })
  return blocks
}

export function openCopyAggregateModal({ repo, branch, branchId, branchInfo, threads }) {
  // Stash branchId on window so aggregateBlocks can read it without
  // threading it through every call. Cheap and avoids a wider refactor of
  // the helper signature; cleared via the modal's close path.
  window.__slopBranchId = branchId
  // Count only the threads the agent will actually see — resolved threads
  // are filtered out by aggregateBlocks, so the subtitle should match
  // what the user is about to copy (no surprise mismatch).
  const unresolved = (threads || []).filter((t) => !t.resolved_at)
  const count = unresolved.length
  const total = (threads || []).length
  const resolvedHint = total > count ? ` (${total - count} resolved hidden)` : ''
  const subText = `${branch || 'no branch'} · ${count} thread${count === 1 ? '' : 's'}${resolvedHint}`
  const backdrop = makeModal(`
    <h2>Aggregate review comments</h2>
    <div class="sub">${escapeHtml(subText)}</div>

    <label class="block">
      Prompt
      <span class="prompt-count" id="prompt-count"></span>
      <button type="button" class="prompt-copy" data-copy-prompt aria-label="Copy prompt to clipboard" title="Copy prompt to clipboard">copy</button>
    </label>
    <div class="preview-blocks">${blocksHTML(aggregateBlocks({ repo, branch, branchInfo, threads }))}</div>

    <div class="modal-actions">
      <button data-close>Close</button>
    </div>`)
  backdrop.classList.add('copy-prompt-backdrop')

  const { collectPrompt } = wirePromptBlocks(backdrop)

  backdrop.querySelector('[data-copy-prompt]').onclick = async () => {
    const prompt = collectPrompt()
    if (!prompt) return toast('Nothing to copy')
    try {
      await copyToClipboard(prompt)
      toast('Prompt copied')
    } catch (e) {
      toast('Copy failed: ' + (e.message || 'unknown'))
    }
  }
}
