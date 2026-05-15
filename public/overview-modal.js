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
 * Resolves to the chosen tool id ('codex' | 'claude') or null if the user
 * cancels. When only one CLI is available the modal degenerates to a
 * single-button confirm; when both are present the user picks one.
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

    let body
    if (tools.length === 1) {
      const tool = tools[0]
      const version = versions[tool] ? ` (${escapeHtml(versions[tool])})` : ''
      body = `
        <h2>Generate overview</h2>
        <p class="modal-text">Use ${escapeHtml(TOOL_LABELS[tool])}${version} to generate the overview for this branch?</p>
        <input type="hidden" data-tool-choice value="${escapeHtml(tool)}">
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
      settled = true
      backdrop.remove()
      resolve(choice)
    })
  })
}

/**
 * Open the generated branch overview inside a modal. Reuses makeModal's
 * backdrop + Esc handling and the existing section-aware markdown render.
 * The polling lifecycle (idle → generating → ready, plus stale + error
 * paths) lives entirely inside this function so the modal own-disposes
 * its poll timer when the user dismisses it.
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
  // Widen the modal so the Mental Model two-column grid + What-Changed
  // card grid have breathing room — the default 600px max-width crams
  // every section into a single column.
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
      const rendered = renderOverview(status.content || '')
      body.innerHTML = `
        <article class="overview-content">${rendered}</article>
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
      const article = status.content
        ? `<article class="overview-content overview-content-stale" aria-label="Previous overview, out of date">${renderOverview(status.content)}</article>`
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
    const tool = await confirmOverviewTool(lastStatus)
    if (!tool || disposed) return
    body.innerHTML = `
      <div class="overview-pending">
        <span class="wt-spinner" aria-hidden="true"></span>
        <span>Generating overview…</span>
      </div>`
    try {
      const status = await api(`/api/repos/${encodeURIComponent(repoId)}/overview`, {
        method: 'POST',
        body: JSON.stringify({ force: true, tool }),
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

function renderOverview(markdown) {
  const { sketch, markdown: withoutSketch } = extractSketch(markdown)
  const sections = parseSections(withoutSketch)
  const whatChanged = sections.get('What Changed') || ''
  const mentalModel = sections.get('Mental Model') || ''
  const beforeAfter = sections.get('Before vs After Behavior') || sections.get('Contract Changes') || ''

  return `
    ${renderSection('01', 'What Changed', renderFactList(whatChanged))}
    ${renderSection('02', 'Mental Model', `
      <div class="overview-mental-grid">
        <div class="overview-mental-copy">${renderMentalProse(mentalModel)}</div>
        ${renderSketch(sketch)}
      </div>`)}
    ${renderSection('03', 'Before vs After', renderCompareList(beforeAfter))}
  `
}

function renderSection(eyebrow, title, body) {
  return `
    <section class="overview-section">
      <header class="overview-section-head">
        <span class="overview-section-eyebrow">${escapeHtml(eyebrow)}</span>
        <h2>${escapeHtml(title)}</h2>
      </header>
      ${body}
    </section>`
}

function extractBullets(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n')
  const bullets = []
  let cur = null
  const flush = () => { if (cur != null) { bullets.push(cur.trim()); cur = null } }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/)
    if (m) { flush(); cur = m[1] }
    else if (cur != null && line.trim()) cur += ' ' + line.trim()
    else if (!line.trim()) flush()
  }
  flush()
  return bullets.filter(Boolean)
}

function renderFactList(markdown) {
  const bullets = extractBullets(markdown)
  if (!bullets.length) {
    const fallback = renderMarkdown(markdown)
    return fallback || '<p class="overview-muted">No summary provided.</p>'
  }
  const items = bullets.map((body, i) => `
    <li class="overview-fact">
      <span class="overview-fact-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="overview-fact-body">${inlineMarkdown(body)}</div>
    </li>`).join('')
  return `<ol class="overview-facts">${items}</ol>`
}

function renderCompareList(markdown) {
  const bullets = extractBullets(markdown)
  if (!bullets.length) {
    const fallback = renderMarkdown(markdown)
    return fallback || '<p class="overview-muted">No summary provided.</p>'
  }
  const splitRe = /\s\/\s+after\s*:\s*/i
  const beforeRe = /^before\s*:\s*/i
  const rows = bullets.map((bullet) => {
    const split = bullet.split(splitRe)
    if (split.length === 2 && beforeRe.test(split[0])) {
      return {
        kind: 'compare',
        before: split[0].replace(beforeRe, '').trim(),
        after: split[1].trim(),
      }
    }
    return { kind: 'note', body: bullet }
  })
  const html = rows.map((r) => {
    if (r.kind === 'compare') return `
      <div class="overview-compare-row">
        <div class="overview-compare-side overview-compare-before">
          <div class="overview-compare-tag">Before</div>
          <div class="overview-compare-body">${inlineMarkdown(r.before)}</div>
        </div>
        <div class="overview-compare-arrow" aria-hidden="true">→</div>
        <div class="overview-compare-side overview-compare-after">
          <div class="overview-compare-tag">After</div>
          <div class="overview-compare-body">${inlineMarkdown(r.after)}</div>
        </div>
      </div>`
    return `<div class="overview-compare-note">${inlineMarkdown(r.body)}</div>`
  }).join('')
  return `<div class="overview-compare">${html}</div>`
}

function renderMentalProse(markdown) {
  const html = renderMarkdown(markdown)
  if (!html) return '<p class="overview-muted">No summary provided.</p>'
  return html.replace(/^<p>/, '<p class="overview-lead">')
}

function extractSketch(markdown) {
  let sketch = null
  const text = String(markdown || '')
  const fenceRe = /```json\s*([\s\S]*?)```/i
  const match = text.match(fenceRe)
  if (match) {
    try { sketch = normalizeSketch(JSON.parse(match[1])) } catch {}
  }
  return { sketch, markdown: text.replace(fenceRe, '').replace(/^##\s+Sketch\s*$/im, '').trim() }
}

function normalizeSketch(input) {
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : []
  const nodes = rawNodes
    .map((n) => ({
      id: String(n?.id || '').trim(),
      label: String(n?.label || '').trim(),
      detail: String(n?.detail || '').trim(),
    }))
    .filter((n) => /^[a-z0-9_-]{1,40}$/.test(n.id) && n.label)
    .slice(0, 6)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(input?.edges) ? input.edges : [])
    .map((e) => Array.isArray(e) ? [String(e[0] || ''), String(e[1] || '')] : null)
    .filter((e) => e && ids.has(e[0]) && ids.has(e[1]) && e[0] !== e[1])
    .slice(0, 7)
  return nodes.length ? { nodes, edges } : null
}

function parseSections(markdown) {
  const sections = new Map()
  let current = null
  const buf = []
  const flush = () => {
    if (!current) return
    sections.set(current, buf.join('\n').trim())
    buf.length = 0
  }
  for (const line of String(markdown || '').replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      flush()
      current = heading[1].trim()
      continue
    }
    if (/^#\s+/.test(line)) continue
    if (current) buf.push(line)
  }
  flush()
  return sections
}

function renderSketch(sketch) {
  if (!sketch?.nodes?.length) return '<div class="overview-sketch overview-sketch-empty">No sketch generated.</div>'
  const incoming = new Map()
  const outgoing = new Map()
  for (const node of sketch.nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const [from, to] of sketch.edges || []) {
    outgoing.get(from)?.push(to)
    incoming.get(to)?.push(from)
  }
  return `
    <div class="overview-sketch" aria-label="Change sketch">
      ${sketch.nodes.map((node) => renderSketchNode(node, incoming.get(node.id) || [], outgoing.get(node.id) || [], sketch.nodes)).join('')}
    </div>`
}

function renderSketchNode(node, incoming, outgoing, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inLabel = incoming.map((id) => byId.get(id)?.label).filter(Boolean).join(', ')
  const outLabel = outgoing.map((id) => byId.get(id)?.label).filter(Boolean).join(', ')
  return `
    <div class="overview-sketch-node">
      <div class="overview-sketch-card">
        <div class="overview-sketch-label">${escapeHtml(node.label)}</div>
        ${node.detail ? `<div class="overview-sketch-detail">${escapeHtml(node.detail)}</div>` : ''}
      </div>
      ${outgoing.length ? `<div class="overview-sketch-arrow" title="Feeds into ${escapeHtml(outLabel)}">↓</div>` : ''}
      ${incoming.length ? `<div class="overview-sketch-in" title="From ${escapeHtml(inLabel)}"></div>` : ''}
    </div>`
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let list = null
  let para = []

  const closePara = () => {
    if (!para.length) return
    out.push(`<p>${inlineMarkdown(para.join(' '))}</p>`)
    para = []
  }
  const closeList = () => {
    if (!list) return
    out.push(`</${list}>`)
    list = null
  }
  const openList = (kind) => {
    closePara()
    if (list === kind) return
    closeList()
    list = kind
    out.push(`<${kind}>`)
  }

  for (const line of lines) {
    if (!line.trim()) {
      closePara()
      closeList()
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/)
    if (h) {
      closePara()
      closeList()
      const level = h[1].length === 1 ? 2 : h[1].length
      out.push(`<h${level}>${inlineMarkdown(h[2].trim())}</h${level}>`)
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (bullet) {
      openList('ul')
      out.push(`<li>${inlineMarkdown(bullet[1].trim())}</li>`)
      continue
    }
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/)
    if (numbered) {
      openList('ol')
      out.push(`<li>${inlineMarkdown(numbered[1].trim())}</li>`)
      continue
    }
    para.push(line.trim())
  }
  closePara()
  closeList()
  return out.join('')
}

function inlineMarkdown(s) {
  let out = escapeHtml(s)
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return out
}
