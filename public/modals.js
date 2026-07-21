import { api } from './api.js'
import { escapeHtml, inlineCode, relTime, toast, copyToClipboard, formatLineRange, formatPinnedComment, buildForgeDeepLinkFromSha } from './util.js'
import { languageForPath, highlightLine } from './syntax.js'

export function makeModal(innerHtml, opts = {}) {
  const { onClose, noCloseButton = false, noBackdropClose = false } = opts
  const backdrop = document.createElement('div')
  backdrop.className = 'modal-backdrop'
  // Dynamic z-stack: layer above any modal already on screen so confirms
  // (Delete thread, Delete comment, Clear reviewed marks) don't render
  // behind the thread or overview modal that launched them.
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

function commentHtml(c, interactive = false, hasCodeAnchor = false) {
  // Edit + remove sit together at the right edge of the meta row. The first
  // one carries `margin-left: auto` (in CSS) so both get pushed right while
  // staying flush to each other. Body is rendered as raw text via
  // inlineCode; the edit handler reads the unrendered string from the
  // thread state, never from this HTML.
  const actions = interactive
    ? `<button type="button" class="msg-edit" data-edit-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Edit comment" title="Edit comment">✎</button>` +
      `<button type="button" class="msg-remove" data-remove-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Remove comment" title="Remove comment">×</button>`
    : ''
  // Synced GitHub comments carry a permalink; turn the timestamp into a link
  // back to the comment on GitHub. Local comments render a plain timestamp.
  const when = escapeHtml(relTime(c.posted_at || c.created_at))
  const whenHtml = c.github_url
    ? `<a class="msg-when" href="${escapeHtml(c.github_url)}" target="_blank" rel="noopener noreferrer" title="Open this comment on GitHub">${when}</a>`
    : `<span class="msg-when">${when}</span>`
  const copyAction = interactive && hasCodeAnchor
    ? `<button type="button" class="msg-copy-reference" data-copy-comment data-comment-id="${escapeHtml(c.id)}" aria-label="Copy pinned path and comment" title="Copy the pinned path and this comment">Copy</button>`
    : ''
  return `
    <div class="msg" data-comment-id="${escapeHtml(c.id)}">
      <div class="msg-head"><span class="msg-who">${escapeHtml(c.user)}</span>${whenHtml}${actions}</div>
      <div class="msg-content"><div class="msg-body" data-body>${inlineCode(c.body)}</div>${copyAction}</div>
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
 * Peek what a commit-view line looks like at HEAD. Only meaningful in
 * commit view on files with later changes (`is_unchanged_since_commit ===
 * false`) — the trigger sites enforce that gate. Renders a ±N line window
 * around the *HEAD-mapped* line position, not the raw commit-line number,
 * so a line that was pushed down by later inserts still shows up centered
 * in the window. The mapping is done server-side via mapLineThroughDiff.
 *
 * Status banners cover the three non-happy paths:
 *   - in-changed-hunk: line was modified between then and now → orange band
 *   - file-deleted:    file no longer exists at HEAD          → red band
 *   - binary:          file became binary at HEAD             → grey band
 * The happy path ('mapped') gets no banner — the lines + the line numbers
 * are self-explanatory.
 */
export function openHeadPreviewModal({ repoId, commitSha, path, line }) {
  const fileLabel = path.split('/').pop() || path
  const loadingHtml =
    '<header class="modal-header head-preview-header">' +
      `<h2>Peek HEAD <code class="modal-path">${escapeHtml(fileLabel)}</code></h2>` +
      `<span class="head-preview-subtle">commit line ${line}</span>` +
    '</header>' +
    '<div class="head-preview-body"><p class="modal-text">Loading…</p></div>'

  const backdrop = makeModal(loadingHtml)
  const modal = backdrop.querySelector('.modal')

  api(`/api/repos/${repoId}/commits/${commitSha}/head-preview?path=${encodeURIComponent(path)}&line=${line}&context=10`)
    .then((data) => {
      // Backdrop may have been dismissed mid-fetch — bail rather than
      // re-rendering a detached node.
      if (!backdrop.isConnected) return
      modal.innerHTML = renderHeadPreviewBody(data, { path, line })
    })
    .catch((e) => {
      if (!backdrop.isConnected) return
      modal.innerHTML =
        '<header class="modal-header head-preview-header">' +
          `<h2>Peek HEAD <code class="modal-path">${escapeHtml(fileLabel)}</code></h2>` +
        '</header>' +
        `<div class="head-preview-body"><p class="modal-text modal-error">Failed to load: ${escapeHtml(e.message || 'unknown error')}</p></div>` +
        '<div class="modal-actions is-reversed"><button data-close>Close</button></div>'
    })

  return backdrop
}

function renderHeadPreviewBody(data, { path, line }) {
  const fileLabel = path.split('/').pop() || path
  const headShortSha = (data.head_sha || '').slice(0, 7)
  const header =
    '<header class="modal-header head-preview-header">' +
      `<h2>Peek HEAD <code class="modal-path">${escapeHtml(fileLabel)}</code></h2>` +
      `<span class="head-preview-subtle">commit line ${line}` +
        (data.head_line && data.head_line !== line ? ` → HEAD line ${data.head_line}` : '') +
        (headShortSha ? ` · HEAD ${escapeHtml(headShortSha)}` : '') +
      '</span>' +
    '</header>'

  if (data.status === 'file-deleted') {
    return header +
      '<div class="head-preview-body">' +
        '<p class="head-preview-banner is-deleted">This file no longer exists at HEAD — a later commit removed it.</p>' +
      '</div>' +
      '<div class="modal-actions is-reversed"><button data-close>Close</button></div>'
  }
  if (data.binary) {
    return header +
      '<div class="head-preview-body">' +
        '<p class="head-preview-banner is-binary">This file is binary at HEAD — no text preview available.</p>' +
      '</div>' +
      '<div class="modal-actions is-reversed"><button data-close>Close</button></div>'
  }
  if (!data.lines || data.lines.length === 0) {
    return header +
      '<div class="head-preview-body">' +
        '<p class="head-preview-banner is-empty">File at HEAD is empty.</p>' +
      '</div>' +
      '<div class="modal-actions is-reversed"><button data-close>Close</button></div>'
  }

  // In-changed-hunk: the commit's exact line was rewritten between then
  // and HEAD, so we anchored the window on the hunk's newStart rather
  // than a 1:1 line correspondence. Banner makes that explicit so the
  // user doesn't read the highlighted line as "this is your line".
  const banner = data.status === 'in-changed-hunk'
    ? '<p class="head-preview-banner is-changed">Line was modified between this commit and HEAD. Showing the region in HEAD where the change landed.</p>'
    : ''

  const lang = languageForPath(path)
  const lineRows = data.lines.map((text, i) => {
    const ln = data.start + i
    const isAnchor = ln === data.head_line
    return (
      `<tr class="head-preview-row${isAnchor ? ' is-anchor' : ''}">` +
        `<td class="head-preview-ln">${ln}</td>` +
        `<td class="head-preview-code">${highlightLine(text, lang) || '&nbsp;'}</td>` +
      '</tr>'
    )
  }).join('')

  const rangeLabel = data.start === data.end
    ? `Line ${data.start} of ${data.total_lines}`
    : `Lines ${data.start}–${data.end} of ${data.total_lines}`

  return header +
    '<div class="head-preview-body">' +
      banner +
      `<div class="head-preview-range">${rangeLabel}</div>` +
      `<table class="head-preview-table">${lineRows}</table>` +
    '</div>' +
    '<div class="modal-actions is-reversed"><button data-close>Close</button></div>'
}

/**
 * Open the thread modal for one slop-review thread. The thread is fetched
 * from the freshest snapshot via the supplied `getThread` callback so a
 * thread that just got an LLM reply (visible after the host calls
 * `loadThreads`) shows the latest content on the next mount/update.
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
  const { repoId, getThread, onChanged, onRead, onClose, onNavigate, threadOrder, prInfo } = opts
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
  // The modal mutates individual comments in place while the host refreshes
  // its thread snapshot asynchronously. Keep the bodies shown in this modal
  // immediately copyable after a reply or edit, without waiting for that
  // background refresh to finish.
  const visibleCommentBodies = new Map()

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
    // Submit-chord hint shown on the Reply button. Carbonyl's chromium fork
    // strips Cmd/Ctrl, so terminal users submit with the `;;` shim (see
    // public/carbonyl-key-shim.js); browser users get the platform chord.
    const isCarbonyl = document.documentElement.classList.contains('is-carbonyl')
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
    const submitHint = isCarbonyl ? ';;' : (isMac ? '⌘↵' : 'Ctrl+↵')

    // PR-level review summaries have only a dummy file:1 anchor (see
    // server/sync.js), so labelling them with that line would mislead. Show
    // their nature instead.
    const subLabel = thread.pr_level
      ? 'PR-level review'
      : (thread.file ? `${thread.file}:${formatLineRange(thread)}` : 'Thread')
    // Mark old-side anchors so the user knows the comment is on a deleted
    // line — same affordance as the inline-thread badge and editor anchor.
    // New-side is the default; labelling it would be visual noise.
    const sideTagHtml = thread.side === 'old' ? ' <span class="thread-modal-side">(old)</span>' : ''

    // Filename for copy-to-clipboard. Server always sends `file_name`; we
    // construct the same `thread_<status>_<hex>.json` formula client-side
    // as a defensive fallback so the affordance still works if the field
    // is missing for any reason.
    const fileNameForCopy = thread.file_name || (() => {
      const status = thread.resolved_at ? 'resolved' : 'open'
      const hex = (thread.id || '').replace(/^thread_/, '')
      return hex ? `thread_${status}_${hex}.json` : ''
    })()

    for (const comment of thread.comments || []) visibleCommentBodies.set(comment.id, comment.body)
    const hasCodeAnchor = !!thread.file && !thread.pr_level && thread.line != null
    const msgs = (thread.comments || []).map((c) => commentHtml(c, true, hasCodeAnchor)).join('')

    // Resolution toggle. Label + class flip based on the current state so
    // a single click does whatever is locally meaningful: "✓ Resolve" on
    // an open thread, "Reopen" on a resolved one. Resolved threads also
    // surface a small subtitle so the user remembers when they closed it.
    const isResolved = !!thread.resolved_at
    const resolveBtn = isResolved
      ? '<button type="button" class="thread-unresolve" data-unresolve data-keyhint="r">Reopen</button>'
      : '<button type="button" class="thread-resolve" data-resolve data-keyhint="r">✓ Resolve</button>'
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
      ? `<button type="button" class="thread-filename" data-copy-filename data-filename="${escapeHtml(fileNameForCopy)}" title="Copy ${escapeHtml(fileNameForCopy)} (press y): paste into a chat to reference this thread"><span class="thread-filename-text">${escapeHtml(hexId)}</span></button>`
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
    //
    // The file:line label upgrades to a forge deep-link when prInfo
    // resolved a GitHub PR for the branch (same destination as the CTA
    // "GitHub" button). URL is synthesized synchronously from the
    // server-attached `thread.path_sha256`, so the rendered `<a>` has a
    // real href: hover preview, middle-click, copy-link-address all work
    // as a regular external link.
    const forgeUrl = buildForgeDeepLinkFromSha({
      host: prInfo?.host,
      prUrl: prInfo?.pr_url,
      pathSha256: thread.path_sha256,
      lineStart: thread.line,
      lineEnd: thread.line_end || thread.line,
      side: thread.side || 'new',
    })
    // No forge deep-link for a PR-level summary: its file:1 is a dummy anchor,
    // so a "jump to line 1 of the first file" link would point nowhere useful.
    // The summary's own permalink rides on the comment timestamp instead.
    const subLabelEl = (forgeUrl && !thread.pr_level)
      ? `<a href="${escapeHtml(forgeUrl)}" class="thread-modal-sub-label" target="_blank" rel="noopener noreferrer">${escapeHtml(subLabel)}${sideTagHtml}</a>`
      : `<span class="thread-modal-sub-label">${escapeHtml(subLabel)}${sideTagHtml}</span>`
    // "GitHub" badge for threads pulled in by `slop --sync` (those carry a
    // github_thread_id). Once the developer edits a synced thread locally,
    // `locally_modified` flips and sync stops touching it, so the badge goes
    // muted + "(edited)" to signal it has diverged from GitHub.
    // PR-level summaries also carry a github_thread_id (the review node id) but
    // get their own "PR" badge below, so exclude them from the GitHub badge.
    const githubBadge = (thread.github_thread_id && !thread.pr_level)
      ? `<span class="thread-github-badge${thread.locally_modified ? ' is-modified' : ''}" title="${thread.locally_modified
          ? 'Synced from GitHub, then edited locally; future syncs skip it'
          : 'Synced from a GitHub PR review thread'}">GitHub${thread.locally_modified ? ' (edited)' : ''}</span>`
      : ''
    // "PR" badge for a synced PR-level review summary (a review's top-level
    // body, which has no line anchor and is pinned to a dummy file:1).
    const prLevelBadge = thread.pr_level
      ? `<span class="thread-pr-badge${thread.locally_modified ? ' is-modified' : ''}" title="${thread.locally_modified
          ? 'A PR-level review summary, edited locally; future syncs leave it alone'
          : 'A PR-level review summary (no line anchor); shown in the thread list, not pinned to the diff'}">PR${thread.locally_modified ? ' (edited)' : ''}</span>`
      : ''

    const subHtml = `<div class="sub">
      ${subLabelEl}
      ${githubBadge}
      ${prLevelBadge}
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
          <button type="button" class="thread-modal-nav-link" data-thread-prev data-keyhint="h" ${navIdx <= 0 ? 'disabled' : ''}>‹ Prev</button>
          <button type="button" class="thread-modal-nav-link" data-thread-next data-keyhint="l" ${navIdx >= threadOrder.length - 1 ? 'disabled' : ''}>Next ›</button>
        </div>`
      : ''

    return `
      ${subHtml}
      ${resolvedSub}
      <div class="thread-list" data-thread-list>${msgs}</div>
      <div class="thread-reply">
        <textarea class="thread-reply-input" rows="3" placeholder="Add a follow-up comment… [i]"></textarea>
      </div>
      ${navHtml}
      <div class="modal-actions is-reversed">
        ${resolveBtn}
        <button type="button" class="danger" data-delete data-keyhint="d">Delete</button>
        <button type="button" data-reply data-keyhint="${escapeHtml(submitHint)}">Reply</button>
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
      // The thread modal's keyboard map: arrows (or h/l, vim-style) step
      // prev/next thread, j/k scroll the modal body (J/K jump further), i
      // focuses the reply box, r resolves, d deletes, y copies the thread id,
      // q closes, Esc drops focus, and Cmd/Ctrl+Enter (or carbonyl's `;;`)
      // submits a reply.
      // Document-scoped so it fires regardless of which element inside the
      // modal has focus (otherwise a focused button would swallow the event
      // before a backdrop-scoped listener saw it). The verb keys bail while a
      // text field is focused, so native typing/cursor movement still wins;
      // the reply textarea is not auto-focused on mount, so the verbs and
      // arrows are live the moment the modal opens.
      const onModalKey = (e) => {
        // What's focused, and is it a text field inside THIS modal? The
        // single-letter verbs stay dormant while the user is typing (so the
        // letters land in the textarea); only the submit chord and Esc act
        // mid-compose.
        const ae = document.activeElement
        const inTextField = !!ae && backdrop.contains(ae) && (
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable ||
          (ae.tagName === 'INPUT' && (() => {
            const t = (ae.type || 'text').toLowerCase()
            return ['text','search','email','url','tel','password','number','date','time','month','week','datetime-local'].includes(t)
          })())
        )
        const backdrops = document.querySelectorAll('.modal-backdrop')
        const isTop = backdrops[backdrops.length - 1] === backdrop

        // Submit reply: Cmd/Ctrl+Enter from inside the reply textarea. The
        // carbonyl `;;` shim synthesizes this exact ctrl+Enter keydown (see
        // public/carbonyl-key-shim.js), so this one branch serves both the
        // browser and the terminal. Scoped to the reply textarea so it never
        // hijacks the chord while a comment edit-box (its own Save) is focused.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey) {
          if (!isTop) return
          const replyTa = backdrop.querySelector('.thread-reply-input')
          if (replyTa && ae === replyTa) {
            e.preventDefault()
            e.stopImmediatePropagation()
            backdrop.querySelector('[data-reply]')?.click()
          }
          return
        }

        // Esc: when a text field is focused, drop focus (the "done writing"
        // gesture) so the verb keys light up again. Otherwise a no-op here:
        // `q` is the close key, and makeModal's own Esc handler already bails
        // while the reply textarea exists, so plain Esc leaves the modal open.
        if (e.key === 'Escape') {
          if (inTextField) {
            e.preventDefault()
            e.stopImmediatePropagation()
            ae.blur()
          }
          return
        }

        // Single-letter verbs: i = focus reply, r = resolve/reopen,
        // d = delete, y = copy thread id, q = close. Swallowed whenever the
        // modal is on screen (capture-phase + stopImmediatePropagation) so
        // they never leak to the diff page's onKey underneath, which binds
        // bare r / d / y to its own actions (y there copies a diff line ref,
        // which would silently clobber the clipboard behind the modal); acted
        // on only when this modal is topmost and not typing. Chord modifiers
        // pass through untouched so browser shortcuts (Cmd+R reload, Ctrl+D
        // bookmark) still work.
        if (!e.metaKey && !e.ctrlKey && !e.altKey &&
            (e.key === 'i' || e.key === 'r' || e.key === 'd' || e.key === 'y' || e.key === 'q')) {
          if (inTextField) return
          e.preventDefault()
          e.stopImmediatePropagation()
          if (!isTop) return
          if (e.key === 'i') {
            const replyTa = backdrop.querySelector('.thread-reply-input')
            if (replyTa) {
              replyTa.focus()
              const end = replyTa.value.length
              replyTa.setSelectionRange(end, end)
            }
          } else if (e.key === 'r') {
            backdrop.querySelector('[data-resolve], [data-unresolve]')?.click()
          } else if (e.key === 'd') {
            backdrop.querySelector('[data-delete]')?.click()
          } else if (e.key === 'y') {
            // Reuse the filename pill's own click handler: copy + toast + the
            // transient is-copied glyph swap. No-op if the pill is absent
            // (thread with no resolvable filename).
            backdrop.querySelector('[data-copy-filename]')?.click()
          } else if (e.key === 'q') {
            backdrop.remove()   // -> MutationObserver -> wrappedOnClose tears down
          }
          return
        }

        // ----- j / k: scroll the modal body (J / K jump further) -----
        // `.modal` is the scroll container (max-height: 90vh, overflow-y:
        // auto in app.css), so the whole thread scrolls as one. Without
        // this branch bare j/k/J/K fall past us (capture phase) to the diff
        // page's onKey underneath, which moves its line cursor and scrolls
        // the diff behind the modal: the background lurches while the modal
        // sits still. Claim them for the modal exactly like the arrows:
        // swallow whenever the modal is topmost and the user isn't typing,
        // so nothing leaks to the page below. J/K are caught here too
        // because diff.js binds them to a 5-line jump; leaving them out
        // would let Shift+j/k still scroll the background.
        if ((e.key === 'j' || e.key === 'k' || e.key === 'J' || e.key === 'K') &&
            !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (inTextField) return
          e.preventDefault()
          e.stopImmediatePropagation()
          if (!isTop) return
          const scroller = backdrop.querySelector('.modal')
          if (scroller) scroller.scrollBy({ top: modalScrollStep(e.key, scroller), behavior: 'auto' })
          return
        }

        // ----- Arrow / h / l nav: step prev / next thread -----
        // h/l mirror ArrowLeft/ArrowRight (vim-style). The letter keys are
        // chord-guarded (bail when Cmd/Ctrl/Alt is held) so browser shortcuts
        // such as Cmd+L / Ctrl+L (focus address bar) still work, matching how
        // the i/r/d/y/q verbs above let chords through. The arrows keep their
        // existing modifier behaviour. Shift+h/l never reach here (they arrive
        // as 'H'/'L'), so the Shift bail below stays arrow-only in practice.
        const navPrev = e.key === 'ArrowLeft'  || (e.key === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey)
        const navNext = e.key === 'ArrowRight' || (e.key === 'l' && !e.metaKey && !e.ctrlKey && !e.altKey)
        if (!navPrev && !navNext) return
        // Shift+arrow is reserved for diff-page commit navigation (see
        // diff.js onKey). Bail BEFORE swallowing the event so the
        // bubble-phase onKey listener gets a clean shot. This also
        // makes Shift+arrow work for native text-selection extension
        // inside the reply textarea — Shift bypasses our claim entirely.
        if (e.shiftKey) return
        // Text-input cursor movement wins: bail before swallowing so the
        // reply textarea (or a comment edit-box) keeps native arrow behaviour.
        if (inTextField) return
        // Thread modal is on screen: these nav keys belong to the modal
        // stack, NOT the diff page underneath. Swallow the event so
        // anything else listening for them can't react.
        //
        // For h/l this swallow is load-bearing: diff.js's onKey binds bare
        // h/l to prev/next *diff* navigation (goto), so if the event leaked
        // through it would step the diff behind the modal. Capture-phase
        // registration + stopImmediatePropagation here are what reserve
        // h/l for thread nav while the modal is up.
        //
        // For the arrows it's belt-and-braces: diff.js requires Shift+arrow
        // for commit nav (we bailed above when shiftKey is true), so plain
        // arrows wouldn't trigger goto even if they reached it. Stopping
        // them too keeps the modal's claim on bare arrows unambiguous for
        // any future listener. Stop unconditionally: even with no neighbour
        // to navigate to (threadOrder.length < 2), these keys are the
        // modal's.
        e.preventDefault()
        e.stopImmediatePropagation()
        // Only NAVIGATE when this modal is topmost: a confirm modal layered
        // on top (Delete this thread?) owns the keyboard, so we swallow the
        // key here but don't step threads beneath it.
        if (!isTop) return
        if (!Array.isArray(threadOrder) || threadOrder.length < 2) return
        const dir = navPrev ? -1 : +1
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
        document.removeEventListener('keydown', onModalKey, true)
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
      // `onKey` listener (registered in `renderDiffView`) was attached
      // earlier on `document` in the default bubble phase. Same-element
      // bubble listeners fire in registration order, so without
      // `capture: true` the diff page's onKey would run FIRST and call
      // `goto()` before this handler could stop it. Registering for the
      // capture phase guarantees we run first regardless of registration
      // order, which lets the `stopImmediatePropagation` above actually
      // pre-empt onKey.
      document.addEventListener('keydown', onModalKey, true)
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
        const hasCodeAnchor = !!thread.file && !thread.pr_level && thread.line != null
        if (res.comment) visibleCommentBodies.set(res.comment.id, res.comment.body)
        if (list && res.comment) list.insertAdjacentHTML('beforeend', commentHtml(res.comment, true, hasCodeAnchor))
        ta.value = ''
        ta.focus()
        toast.ok('Reply added')
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
        toast.ok('Filename copied')
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
        toast.ok(toResolved ? 'Thread resolved' : 'Thread reopened')
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
        btn.outerHTML = '<button type="button" class="thread-resolve" data-resolve data-keyhint="r">✓ Resolve</button>'
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
      // Auto-focus the confirm button so the keyboard delete flow completes:
      // `d` opens this confirm, Enter (on the focused button) deletes, Esc
      // cancels (makeModal's own keydown handler closes it; no textarea here).
      confirmBackdrop.querySelector('[data-confirm]')?.focus()
      confirmBackdrop.querySelector('[data-confirm]').onclick = async () => {
        try {
          const res = await api(
            `/api/repos/${encodeURIComponent(repoId)}/threads/${encodeURIComponent(currentId)}`,
            { method: 'DELETE' }
          )
          confirmBackdrop.remove()
          onChanged?.(res)
          toast.ok('Thread deleted')
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
    const copyBtn = e.target.closest('[data-copy-comment]')
    if (copyBtn) {
      e.stopPropagation()
      const thread = getThread(currentId)
      const comment = (thread?.comments || []).find((item) => item.id === copyBtn.dataset.commentId)
      const body = visibleCommentBodies.get(copyBtn.dataset.commentId) ?? comment?.body
      const text = formatPinnedComment(thread, { body })
      if (!text) return
      copyToClipboard(text)
        .then(() => {
          toast.ok('Path and comment copied')
          copyBtn.classList.add('is-copied')
          copyBtn.textContent = '✓ Copied'
          setTimeout(() => {
            copyBtn.classList.remove('is-copied')
            copyBtn.textContent = 'Copy'
          }, 1200)
        })
        .catch((err) => toast('Copy failed: ' + (err.message || 'unknown')))
      return
    }
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
            toast.ok('Thread removed')
          } else {
            backdrop.querySelector(`.msg[data-comment-id="${commentId}"]`)?.remove()
            toast.ok('Comment removed')
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
        visibleCommentBodies.set(commentId, res?.comment?.body ?? text)
        toast.ok('Comment updated')
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
 * other query params (e.g. `?file=…` from the single-file thread-context
 * view). Uses replaceState — silent URL update, no hashchange event, no
 * router re-entry. Closing the modal strips this param via the diff
 * page's `stripThreadQuery()` (see public/diff.js).
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

/**
 * Pixel delta for one j/k/J/K keypress scrolling the thread modal body.
 * `el` is the `.modal` scroll container. Positive scrolls down (j / J),
 * negative up (k / K); J/K are the larger "jump" variant, mirroring the
 * diff page's 1-line (j) vs 5-line (J) cursor moves. Magnitude is a
 * fraction of the visible height so it scales with modal size, with px
 * floors so a short modal still moves a perceptible amount under
 * carbonyl's half-block downsample (quirk #1).
 */
function modalScrollStep(key, el) {
  const h = el.clientHeight || 0
  const big = key === 'J' || key === 'K'
  const magnitude = big ? Math.max(200, h * 0.85) : Math.max(48, h * 0.15)
  return key === 'j' || key === 'J' ? magnitude : -magnitude
}
