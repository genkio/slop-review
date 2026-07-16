import { api } from './api.js'
import { escapeHtml, relTime, toast } from './util.js'
import { makeModal } from './modals.js'

const POLL_MS = 2500

const TOOL_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
}

/**
 * Show a multi-select picker before kicking off overview generation.
 * Resolves to the chosen tools and optional presentation instructions, or null
 * if the user cancels. Tools start unchecked so every run is an explicit
 * choice, especially when selecting an agent would replace its prior output.
 */
export function confirmOverviewTools(status) {
  return new Promise((resolve) => {
    const tools = Array.isArray(status?.available_tools) ? status.available_tools : []
    if (!tools.length) {
      resolve(null)
      return
    }

    const versions = {
      codex: status?.codex_version || '',
      claude: status?.claude_version || '',
      opencode: status?.opencode_version || '',
    }
    const additionalPrompt = escapeHtml(status?.additional_prompt || '')
    const promptField = `
      <label class="overview-extra-prompt">
        <span>Additional instructions <span class="overview-extra-optional">optional</span></span>
        <input type="text" data-overview-extra maxlength="2000" value="${additionalPrompt}" placeholder="e.g. Explain it in both English and Chinese">
      </label>`

    const options = tools.map((tool) => {
      const version = versions[tool] ? `<span class="overview-tool-version">${escapeHtml(versions[tool])}</span>` : ''
      const generation = status?.generations?.[tool]
      const result = generation?.status === 'error'
        ? '<span class="overview-tool-result is-error">failed</span>'
        : (generation?.has_content
            ? '<span class="overview-tool-result">succeeded</span>'
            : '')
      return `
        <label class="overview-tool-option">
          <input type="checkbox" name="overview-tool" value="${escapeHtml(tool)}">
          <span class="overview-tool-name">${escapeHtml(TOOL_LABELS[tool] || tool)}</span>
          ${result}
          ${version}
        </label>`
    }).join('')
    const body = `
      <h2>Generate overview</h2>
      <p class="modal-text">Choose one or more CLIs. Selected generators run at the same time. Selecting an agent with existing output replaces only that output.</p>
      <div class="overview-tool-picker" role="group" aria-label="Overview generators">${options}</div>
      ${promptField}
      <div class="modal-actions is-reversed">
        <button type="button" class="primary" data-confirm>Generate</button>
        <button type="button" data-close>Cancel</button>
      </div>`

    let settled = false
    const backdrop = makeModal(body, {
      onClose: () => { if (!settled) { settled = true; resolve(null) } },
    })

    const confirm = backdrop.querySelector('[data-confirm]')
    const updateConfirm = () => {
      if (confirm) confirm.disabled = !backdrop.querySelector('input[name="overview-tool"]:checked')
    }
    backdrop.querySelectorAll('input[name="overview-tool"]').forEach((input) => {
      input.addEventListener('change', updateConfirm)
    })
    updateConfirm()
    confirm?.focus()
    confirm?.addEventListener('click', () => {
      if (settled) return
      const selectedTools = [...backdrop.querySelectorAll('input[name="overview-tool"]:checked')]
        .map((input) => input.value)
      if (!selectedTools.length) return
      const extra = backdrop.querySelector('[data-overview-extra]')?.value.trim() || ''
      settled = true
      backdrop.remove()
      resolve({ tools: selectedTools, additionalPrompt: extra })
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
  let selectedTool = null
  const clearTimer = () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null }

  const backdrop = makeModal(`
    <div class="overview-modal" data-overview-modal>
      <div class="overview-modal-head">
        <div class="overview-modal-title">
          <h2>Overview</h2>
          <span class="overview-generated" data-overview-generated hidden></span>
        </div>
        <div class="overview-result-tabs" data-overview-tabs hidden></div>
      </div>
      <div class="overview-modal-body" data-overview-body role="tabpanel">
        <div class="branch-loading">Loading overview…</div>
      </div>
    </div>`, {
    onClose: () => { disposed = true; clearTimer() },
  })
  // Give the self-contained explainer enough room for its editorial layout.
  backdrop.querySelector('.modal')?.classList.add('modal-wide')

  const body = backdrop.querySelector('[data-overview-body]')
  const stampEl = backdrop.querySelector('[data-overview-generated]')
  const tabsEl = backdrop.querySelector('[data-overview-tabs]')

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
    updateResultTabs(status)
    updateGeneratedStamp(status)

    if (status.status === 'ready') {
      const tool = activeTool(status)
      body.innerHTML = `
        ${renderGenerationResult(repoId, status, tool)}
        <div class="overview-actions">
          <button type="button" data-regenerate-overview>Regenerate</button>
        </div>`
      body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
      return
    }

    if (status.status === 'generating') {
      const count = status.requested_tools?.length || 1
      const tool = activeTool(status)
      const contentTool = tool && status.generations?.[tool]?.has_content ? tool : null
      const currentContentTool = body.querySelector('[data-overview-live-tool]')
        ?.getAttribute('data-overview-live-tool') || null
      if (contentTool && currentContentTool === contentTool) return
      body.innerHTML = `
        <div class="overview-pending${contentTool ? ' has-content' : ''}">
          <span class="wt-spinner" aria-hidden="true"></span>
          <span>Generating ${count === 1 ? 'overview' : `${count} overviews`}…</span>
        </div>
        ${contentTool
          ? `<div data-overview-live-tool="${escapeHtml(contentTool)}">${renderGenerationResult(repoId, status, contentTool)}</div>`
          : ''}`
      return
    }

    if (status.status === 'error' || status.error) {
      const tool = activeTool(status)
      const generationError = tool ? status.generations?.[tool]?.error : null
      body.innerHTML = `
        <div class="overview-error">
          <div class="overview-error-title">${tool ? `${escapeHtml(toolLabel(tool))} generation failed.` : 'Overview generation failed.'}</div>
          <pre>${escapeHtml(generationError || status.error || 'Unknown error')}</pre>
          <button type="button" class="primary" data-regenerate-overview>Retry</button>
        </div>`
      body.querySelector('[data-regenerate-overview]')?.addEventListener('click', regenerate)
      return
    }

    if (status.status === 'stale') {
      const tool = activeTool(status)
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
      const article = tool
        ? `<div class="overview-content-stale" aria-label="Previous overview, out of date">${renderGenerationResult(repoId, status, tool)}</div>`
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

  function activeTool(status) {
    const tools = Array.isArray(status?.generated_tools)
      ? status.generated_tools.filter((tool) => status?.generations?.[tool])
      : []
    if (!tools.length) {
      selectedTool = null
      return null
    }
    const selectedHasContent = selectedTool && status.generations[selectedTool]?.has_content
    if (!tools.includes(selectedTool) || (status.status === 'generating' && !selectedHasContent)) {
      selectedTool = tools.find((tool) => status.generations[tool]?.has_content) || tools[0]
    }
    return selectedTool
  }

  function updateResultTabs(status) {
    if (!tabsEl) return
    const tools = ['generating', 'ready', 'error', 'stale'].includes(status?.status)
      ? (status.generated_tools || []).filter((tool) => status?.generations?.[tool])
      : []
    if (!tools.length) {
      tabsEl.hidden = true
      tabsEl.innerHTML = ''
      return
    }
    const active = activeTool(status)
    tabsEl.hidden = false
    tabsEl.setAttribute('role', 'tablist')
    tabsEl.setAttribute('aria-label', 'Generated overviews')
    tabsEl.innerHTML = tools.map((tool) => {
      const generationStatus = status.generations[tool]?.status
      const stateClass = generationStatus === 'ready'
        ? ' is-ready'
        : (generationStatus === 'error' ? ' is-error' : ' is-running')
      return `<button type="button" role="tab" data-result-tool="${escapeHtml(tool)}" aria-selected="${tool === active}" class="overview-result-tab${stateClass}">${escapeHtml(toolLabel(tool))}</button>`
    }).join('')
    tabsEl.querySelectorAll('[data-result-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedTool = button.getAttribute('data-result-tool')
        renderStatus(status)
      })
    })
    body.setAttribute('aria-label', active ? `${toolLabel(active)} overview` : 'Generated overview')
  }

  function updateGeneratedStamp(status) {
    if (!stampEl) return
    const tool = activeTool(status)
    const generationStatus = tool ? status?.generations?.[tool]?.status : null
    const completedAt = tool ? status?.generations?.[tool]?.completed_at : status?.completed_at
    if (completedAt) {
      stampEl.textContent = `${generationStatus === 'error' ? 'Failed' : 'Generated'} ${relTime(completedAt)}`
      stampEl.hidden = false
    } else {
      stampEl.textContent = ''
      stampEl.hidden = true
    }
  }

  async function regenerate() {
    const selection = await confirmOverviewTools(lastStatus)
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
          tools: selection.tools,
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
  return !!(status?.codex_available || status?.claude_available || status?.opencode_available)
}

function unavailableReason(status) {
  const parts = []
  if (status?.codex_error) parts.push(status.codex_error)
  if (status?.claude_error) parts.push(status.claude_error)
  if (status?.opencode_error) parts.push(status.opencode_error)
  return parts.join(' ') || 'No supported CLI (Codex, Claude Code, or OpenCode) is available on PATH.'
}

function toolLabel(tool) {
  return TOOL_LABELS[tool] || tool
}

function renderGenerationResult(repoId, status, tool) {
  const generation = status?.generations?.[tool]
  if (!tool || !generation) {
    return '<div class="overview-empty"><p>The generated overview is unavailable.</p></div>'
  }
  if (generation.status === 'error') {
    const previous = generation.has_content
      ? `<div class="overview-preserved-result">
          <p>The previous successful output was preserved.</p>
          ${renderOverviewFrame(repoId, status, tool)}
        </div>`
      : ''
    return `
      <div class="overview-error">
        <div class="overview-error-title">${escapeHtml(toolLabel(tool))} generation failed.</div>
        <pre>${escapeHtml(generation.error || 'Unknown error')}</pre>
      </div>
      ${previous}`
  }
  if (!generation.has_content) {
    return '<div class="overview-empty"><p>The generated overview is unavailable.</p></div>'
  }
  return renderOverviewFrame(repoId, status, tool)
}

function renderOverviewFrame(repoId, status, tool) {
  const params = new URLSearchParams({
    tool,
    cache: status.cache_key || '',
  })
  const src = `/api/repos/${encodeURIComponent(repoId)}/overview/content?${params}`
  return `<iframe class="overview-frame" src="${escapeHtml(src)}" sandbox="allow-scripts" title="${escapeHtml(toolLabel(tool))} branch overview"></iframe>`
}
