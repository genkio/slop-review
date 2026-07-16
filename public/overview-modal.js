import { api } from './api.js'
import { escapeHtml, relTime, toast } from './util.js'
import { makeModal } from './modals.js'

const POLL_MS = 2500

const TOOL_LABELS = {
  codex: 'Codex CLI',
  claude: 'Claude Code CLI',
}

/**
 * Show a confirmation / picker before kicking off overview generation.
 * Resolves to the chosen tool and optional presentation instructions, or null
 * if the user cancels. When only one CLI is available the modal degenerates
 * to a single-button confirm; when both are present the user picks one.
 */
export function confirmOverviewTool(status) {
  return new Promise((resolve) => {
    const tools = Array.isArray(status?.available_tools) ? status.available_tools : []
    if (!tools.length) {
      resolve(null)
      return
    }

    const versions = {
      codex: status?.codex_version || '',
      claude: status?.claude_version || '',
    }
    const additionalPrompt = escapeHtml(status?.additional_prompt || '')
    const promptField = `
      <label class="overview-extra-prompt">
        <span>Additional instructions <span class="overview-extra-optional">optional</span></span>
        <input type="text" data-overview-extra maxlength="2000" value="${additionalPrompt}" placeholder="e.g. Explain it in both English and Chinese">
      </label>`

    let body
    if (tools.length === 1) {
      const tool = tools[0]
      const version = versions[tool] ? ` (${escapeHtml(versions[tool])})` : ''
      body = `
        <h2>Generate overview</h2>
        <p class="modal-text">Use ${escapeHtml(TOOL_LABELS[tool])}${version} to generate the overview for this branch?</p>
        <input type="hidden" data-tool-choice value="${escapeHtml(tool)}">
        ${promptField}
        <div class="modal-actions is-reversed">
          <button type="button" class="primary" data-confirm>Generate</button>
          <button type="button" data-close>Cancel</button>
        </div>`
    } else {
      const options = tools.map((tool, i) => {
        const version = versions[tool] ? `<span class="overview-tool-version">${escapeHtml(versions[tool])}</span>` : ''
        return `
          <label class="overview-tool-option">
            <input type="radio" name="overview-tool" value="${escapeHtml(tool)}"${i === 0 ? ' checked' : ''}>
            <span class="overview-tool-name">${escapeHtml(TOOL_LABELS[tool] || tool)}</span>
            ${version}
          </label>`
      }).join('')
      body = `
        <h2>Generate overview</h2>
        <p class="modal-text">Choose which CLI should generate the overview.</p>
        <div class="overview-tool-picker" role="radiogroup" aria-label="Overview generator">${options}</div>
        ${promptField}
        <div class="modal-actions is-reversed">
          <button type="button" class="primary" data-confirm>Generate</button>
          <button type="button" data-close>Cancel</button>
        </div>`
    }

    let settled = false
    const backdrop = makeModal(body, {
      onClose: () => { if (!settled) { settled = true; resolve(null) } },
    })

    backdrop.querySelector('[data-confirm]')?.focus()
    backdrop.querySelector('[data-confirm]')?.addEventListener('click', () => {
      if (settled) return
      const radio = backdrop.querySelector('input[name="overview-tool"]:checked')
      const hidden = backdrop.querySelector('input[data-tool-choice]')
      const choice = radio?.value || hidden?.getAttribute('value') || tools[0]
      const extra = backdrop.querySelector('[data-overview-extra]')?.value.trim() || ''
      settled = true
      backdrop.remove()
      resolve({ tool: choice, additionalPrompt: extra })
    })
  })
}

/**
 * Open the generated branch overview inside a sandboxed frame in a modal.
 * The polling lifecycle (idle → generating → ready, plus stale + error paths)
 * lives entirely inside this function so the modal own-disposes its poll
 * timer when the user dismisses it.
 */
export function openOverviewModal(repoId) {
  if (!repoId) return

  let pollTimer = null
  let disposed = false
  let lastStatus = null
  const clearTimer = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null }

  const backdrop = makeModal(`
    <div class="overview-modal" data-overview-modal>
      <div class="overview-modal-head">
        <h2>Overview</h2>
        <span class="overview-generated" data-overview-generated hidden></span>
      </div>
      <div class="overview-modal-body" data-overview-body>
        <div class="branch-loading">Loading overview…</div>
      </div>
    </div>`, {
    onClose: () => { disposed = true; clearTimer() },
  })
  // Give the self-contained explainer enough room for its editorial layout.
  backdrop.querySelector('.modal')?.classList.add('modal-wide')

  const body = backdrop.querySelector('[data-overview-body]')
  const stampEl = backdrop.querySelector('[data-overview-generated]')

  async function refresh() {
    clearTimer()
    if (disposed) return
    try {
      const status = await api(`/api/repos/${encodeURIComponent(repoId)}/overview`)
      if (disposed) return
      lastStatus = status
      renderStatus(status)
      if (status.status === 'generating') pollTimer = setTimeout(refresh, POLL_MS)
    } catch (e) {
      if (disposed) return
      body.innerHTML = `<div class="branch-error">Failed to load overview: ${escapeHtml(e.message)}</div>`
    }
  }

  function renderStatus(status) {
    updateGeneratedStamp(status)

    if (status.status === 'ready') {
      body.innerHTML = `
        ${renderOverviewFrame(repoId, status)}
        <div class="overview-actions">
          <button type="button" data-regenerate-overview>Regenerate</button>
        </div>`
      body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
      return
    }

    if (status.status === 'generating') {
      body.innerHTML = `
        <div class="overview-pending">
          <span class="wt-spinner" aria-hidden="true"></span>
          <span>Generating overview…</span>
        </div>`
      return
    }

    if (status.status === 'error' || status.error) {
      body.innerHTML = `
        <div class="overview-error">
          <div class="overview-error-title">Overview generation failed.</div>
          <pre>${escapeHtml(status.error || 'Unknown error')}</pre>
          <button type="button" class="primary" data-regenerate-overview>Retry</button>
        </div>`
      body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
      return
    }

    if (status.status === 'stale') {
      const canRegen = status.can_generate && hasAnyTool(status)
      const headFrag = status.head_sha
        ? `Current HEAD <code>${escapeHtml(status.head_sha.slice(0, 12))}</code> no longer matches the snapshot this overview was generated for.`
        : 'New commits or local changes have been made since this overview was generated.'
      const codexNote = !canRegen
        ? `<div class="overview-stale-note">${escapeHtml(unavailableReason(status))}</div>`
        : ''
      const action = canRegen
        ? '<button type="button" class="primary" data-regenerate-overview>Regenerate overview</button>'
        : ''
      const article = status.has_content
        ? `<div class="overview-content-stale" aria-label="Previous overview, out of date">${renderOverviewFrame(repoId, status)}</div>`
        : ''
      body.innerHTML = `
        <div class="overview-stale" role="status">
          <div class="overview-stale-head">
            <span class="overview-stale-badge">Out of date</span>
            <span class="overview-stale-title">This overview no longer reflects the current branch state.</span>
          </div>
          <div class="overview-stale-sub">${headFrag}</div>
          ${codexNote}
          ${action}
        </div>
        ${article}`
      body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
      return
    }

    const label = status.can_generate && !hasAnyTool(status)
      ? unavailableReason(status)
      : (status.reason || 'No overview has been generated yet.')
    const action = status.can_generate && hasAnyTool(status)
      ? '<button type="button" class="primary" data-regenerate-overview>Generate overview</button>'
      : ''
    body.innerHTML = `
      <div class="overview-empty">
        <p>${escapeHtml(label)}</p>
        ${action}
      </div>`
    body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
  }

  function updateGeneratedStamp(status) {
    if (!stampEl) return
    if (status?.completed_at) {
      stampEl.textContent = `Generated ${relTime(status.completed_at)}`
      stampEl.hidden = false
    } else {
      stampEl.textContent = ''
      stampEl.hidden = true
    }
  }

  async function regenerate() {
    const selection = await confirmOverviewTool(lastStatus)
    if (!selection || disposed) return
    body.innerHTML = `
      <div class="overview-pending">
        <span class="wt-spinner" aria-hidden="true"></span>
        <span>Generating overview…</span>
      </div>`
    try {
      const status = await api(`/api/repos/${encodeURIComponent(repoId)}/overview`, {
        method: 'POST',
        body: JSON.stringify({
          force: true,
          tool: selection.tool,
          additional_prompt: selection.additionalPrompt,
        }),
      })
      if (disposed) return
      lastStatus = status
      renderStatus(status)
      if (status.status === 'generating') pollTimer = setTimeout(refresh, POLL_MS)
    } catch (e) {
      toast('Overview failed: ' + (e.message || 'unknown'))
      await refresh()
    }
  }

  refresh()
}

function hasAnyTool(status) {
  if (Array.isArray(status?.available_tools)) return status.available_tools.length > 0
  return !!(status?.codex_available || status?.claude_available)
}

function unavailableReason(status) {
  const parts = []
  if (status?.codex_error) parts.push(status.codex_error)
  if (status?.claude_error) parts.push(status.claude_error)
  return parts.join(' ') || 'No supported CLI (Codex or Claude Code) is available on PATH.'
}

function renderOverviewFrame(repoId, status) {
  if (!status?.has_content) {
    return '<div class="overview-empty"><p>The generated overview is unavailable.</p></div>'
  }
  const src = `/api/repos/${encodeURIComponent(repoId)}/overview/content?cache=${encodeURIComponent(status.cache_key || '')}`
  return `<iframe class="overview-frame" src="${escapeHtml(src)}" sandbox="allow-scripts" title="Generated branch overview"></iframe>`
}
