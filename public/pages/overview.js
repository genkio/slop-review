import { api } from '../api.js'
import { store } from '../store.js'
import { escapeHtml, relTime, toast } from '../util.js'
import { ROUTES } from '../routes.js'
import { subscribeRepoEvents } from '../sse.js'

const POLL_MS = 2500
let pollTimer = null
let threadsUnsub = null

export async function renderOverviewPage(isCurrent = () => true) {
  disposeOverviewView()

  const repo = store.state.repos[0]
  if (!repo) { location.hash = ROUTES.threads(); return }
  if (!isCurrent()) return

  const main = document.getElementById('main')
  main.innerHTML = `
    <div class="overview-page">
      <div class="page-head">
        <div class="overview-page-title">
          <h1>Overview</h1>
          <span class="overview-generated" id="overview-generated" hidden></span>
        </div>
        <div class="actions">
          <a class="btn" href="${ROUTES.diffFull()}">Diff</a>
          <a class="btn" data-threads-link href="${ROUTES.threads()}" hidden>Threads</a>
        </div>
      </div>
      <div id="overview-body" class="overview-body">
        <div class="branch-loading">Loading overview…</div>
      </div>
    </div>`

  refreshThreadsLink(repo, isCurrent)
  threadsUnsub = subscribeRepoEvents(repo.id, () => refreshThreadsLink(repo, isCurrent))

  await refresh(repo, isCurrent)
}

export function disposeOverviewView() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (threadsUnsub) { try { threadsUnsub() } catch {} }
  threadsUnsub = null
}

async function refreshThreadsLink(repo, isCurrent) {
  try {
    const r = await api(`/api/repos/${encodeURIComponent(repo.id)}/threads`)
    if (!isCurrent()) return
    const link = document.querySelector('[data-threads-link]')
    if (link) link.hidden = !(r?.threads?.length)
  } catch {}
}

async function refresh(repo, isCurrent) {
  disposeOverviewView()
  if (!isCurrent()) return
  const body = document.getElementById('overview-body')
  if (!body) return
  try {
    const status = await api(`/api/repos/${encodeURIComponent(repo.id)}/overview`)
    if (!isCurrent()) return
    renderStatus(body, repo, status, isCurrent)
    if (status.status === 'generating') {
      pollTimer = setTimeout(() => refresh(repo, isCurrent), POLL_MS)
    }
  } catch (e) {
    if (!isCurrent()) return
    body.innerHTML = `<div class="branch-error">Failed to load overview: ${escapeHtml(e.message)}</div>`
  }
}

function renderStatus(body, repo, status, isCurrent) {
  updateGeneratedStamp(status)

  if (status.status === 'ready') {
    const rendered = renderOverview(status.content || '')
    body.innerHTML = `
      <article class="overview-content">${rendered}</article>
      <div class="overview-actions">
        <button type="button" data-regenerate-overview>Regenerate</button>
      </div>`
    body.querySelector('[data-regenerate-overview]')?.addEventListener('click', () => regenerate(body, repo, isCurrent))
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
    body.querySelector('[data-regenerate-overview]')?.addEventListener('click', () => regenerate(body, repo, isCurrent))
    return
  }

  if (status.status === 'stale') {
    const canRegen = status.can_generate && status.codex_available
    const headFrag = status.head_sha
      ? `Current HEAD <code>${escapeHtml(status.head_sha.slice(0, 12))}</code> no longer matches the snapshot this overview was generated for.`
      : 'New commits or local changes have been made since this overview was generated.'
    const codexNote = !canRegen && status.codex_error
      ? `<div class="overview-stale-note">${escapeHtml(status.codex_error)}</div>`
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
    body.querySelector('[data-regenerate-overview]')?.addEventListener('click', () => regenerate(body, repo, isCurrent))
    return
  }

  const label = status.can_generate && !status.codex_available && status.codex_error
    ? status.codex_error
    : (status.reason || 'No overview has been generated yet.')
  const action = status.can_generate && status.codex_available
    ? '<button type="button" class="primary" data-regenerate-overview>Generate overview</button>'
    : ''
  body.innerHTML = `
    <div class="overview-empty">
      <p>${escapeHtml(label)}</p>
      ${action}
    </div>`
  body.querySelector('[data-regenerate-overview]')?.addEventListener('click', () => regenerate(body, repo, isCurrent))
}

function updateGeneratedStamp(status) {
  const el = document.getElementById('overview-generated')
  if (!el) return
  if (status?.completed_at) {
    el.textContent = `Generated ${relTime(status.completed_at)}`
    el.hidden = false
  } else {
    el.textContent = ''
    el.hidden = true
  }
}

async function regenerate(body, repo, isCurrent) {
  body.innerHTML = `
    <div class="overview-pending">
      <span class="wt-spinner" aria-hidden="true"></span>
      <span>Generating overview…</span>
    </div>`
  try {
    const status = await api(`/api/repos/${encodeURIComponent(repo.id)}/overview`, {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })
    if (!isCurrent()) return
    renderStatus(body, repo, status, isCurrent)
    if (status.status === 'generating') {
      pollTimer = setTimeout(() => refresh(repo, isCurrent), POLL_MS)
    }
  } catch (e) {
    toast('Overview failed: ' + (e.message || 'unknown'))
    await refresh(repo, isCurrent)
  }
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
