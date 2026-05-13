import { api } from './api.js'
import { escapeHtml, toast } from './util.js'
import { openOverviewModal } from './overview-modal.js'

const POLL_MS = 2500

/**
 * Mounts the overview status/launcher into the diff page header. The
 * container is replaced wholesale on every status tick. When the server
 * reports a ready/stale/error cache or a generating run, the launcher
 * surfaces it; clicking opens the overview modal — there's no overview
 * page anymore.
 */
export function setupOverviewNav(container, repoId) {
  if (!container || !repoId) return () => {}

  let disposed = false
  let timer = null
  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    clearTimer()
    if (!disposed) timer = setTimeout(() => refresh(false), POLL_MS)
  }

  async function refresh() {
    if (disposed) return
    try {
      const status = await api(`/api/repos/${encodeURIComponent(repoId)}/overview`)
      if (disposed) return
      render(status)
      if (status.status === 'generating') schedule()
    } catch (e) {
      if (disposed) return
      container.innerHTML = `<button type="button" class="page-nav is-error" data-open-overview title="${escapeHtml(e.message)}">Overview failed</button>`
      wireOpen()
    }
  }

  function wireOpen() {
    container.querySelector('[data-open-overview]')?.addEventListener('click', () => openOverviewModal(repoId))
  }

  function render(status) {
    clearTimer()
    if (status.status === 'ready') {
      container.innerHTML = '<button type="button" class="page-nav" data-open-overview>Overview</button>'
      wireOpen()
      return
    }
    if (status.status === 'generating') {
      container.innerHTML = '<button type="button" class="btn overview-nav-generating" disabled>Generating overview…</button>'
      return
    }
    if (status.status === 'error' || status.error) {
      const title = status.error ? ` title="${escapeHtml(status.error)}"` : ''
      container.innerHTML = `<button type="button" class="page-nav is-error" data-open-overview${title}>Overview failed</button>`
      wireOpen()
      return
    }
    if (status.status === 'stale') {
      container.innerHTML = '<button type="button" class="page-nav is-stale" data-open-overview title="Overview is out of date for the current branch state">Overview staled</button>'
      wireOpen()
      return
    }
    if (status.can_generate && status.codex_available) {
      container.innerHTML = '<button type="button" class="btn overview-nav-generate" data-generate-overview>Generate overview</button>'
      container.querySelector('[data-generate-overview]')?.addEventListener('click', generate)
      return
    }
    container.innerHTML = ''
  }

  async function generate() {
    if (disposed) return
    container.innerHTML = '<button type="button" class="btn overview-nav-generating" disabled>Generating overview…</button>'
    try {
      const status = await api(`/api/repos/${encodeURIComponent(repoId)}/overview`, {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      })
      if (disposed) return
      render(status)
      if (status.status === 'generating') schedule()
    } catch (e) {
      if (disposed) return
      toast('Overview failed: ' + (e.message || 'unknown'))
      await refresh()
    }
  }

  refresh()

  return () => {
    disposed = true
    clearTimer()
  }
}
