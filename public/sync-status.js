import { api } from './api.js'

// Diff-header badge for the background GitHub sync loop (server/sync-status.js).
// Mirrors overview-nav.js: poll /api/sync-status and rebuild the slot's contents
// each tick. Only a `--sync` session reports enabled:true; otherwise the slot
// stays empty (CSS hides it), so a normal launch shows nothing.
//
// Carbonyl: the badge is a single flat text node inside the (sticky) diff
// header, and carbonyl.css restores its color + weight. Both are needed for the
// glyphs to survive carbonyl's downsampling (docs/carbonyl-quirks.md #1, #5, #6).

const POLL_MS = 30000   // sync runs every 5 min; 30s keeps "ago" + new syncs fresh enough

export function setupSyncStatus(container, { getBaseline = () => null } = {}) {
  if (!container) return () => {}

  let disposed = false
  let timer = null
  let knownDisabled = false   // set once we confirm this isn't a --sync session

  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null }
  const schedule = () => {
    clearTimer()
    // Stop polling once we know sync is off (enabled never flips on mid-session
    // -- it's fixed at server boot). A transient fetch error leaves knownDisabled
    // false, so the badge keeps retrying and recovers.
    if (!disposed && !knownDisabled) timer = setTimeout(tick, POLL_MS)
  }

  function ago(iso) {
    const then = new Date(iso).getTime()
    if (!Number.isFinite(then)) return ''
    const secs = Math.max(0, (Date.now() - then) / 1000)
    if (secs < 45) return 'just now'
    const mins = Math.round(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  // "behind" = thread-store changes synced since the page captured its baseline
  // (loadThreads stashes /api/sync-status's `changes` then). Tells the user
  // whether a manual refresh is worth it, since the open page doesn't live-reload.
  function behindCount(status) {
    const baseline = getBaseline()
    if (typeof baseline !== 'number' || typeof status.changes !== 'number') return 0
    return Math.max(0, status.changes - baseline)
  }

  // Built with DOM methods (textContent / .title), not innerHTML: the badge
  // carries server-supplied strings (gh error text, timestamps) and a single
  // flat text node is also what carbonyl needs (no nested inline runs).
  function render(status) {
    container.replaceChildren()
    if (!status?.enabled) return
    const el = document.createElement('span')
    el.className = 'sync-status'
    let text
    if (status.state === 'error') {
      el.classList.add('is-error')
      text = 'Sync failed'
      if (status.error) el.title = status.error
    } else if (status.state === 'no-pr') {
      // Current tick found no PR; wins over a stale earlier timestamp.
      text = 'No PR to sync'
    } else if (status.last_synced_at) {
      text = `Synced ${ago(status.last_synced_at)}`
      el.title = `Last GitHub sync: ${new Date(status.last_synced_at).toLocaleString()}`
    } else {
      text = 'Sync on'
    }
    // Skip the nudge in the error state: "Sync failed" is the priority signal.
    const behind = status.state === 'error' ? 0 : behindCount(status)
    if (behind > 0) {
      el.classList.add('is-behind')
      text += ` · ${behind} behind`
      el.title = `${behind} thread change(s) synced since this page loaded. Reload to catch up.`
    }
    el.textContent = text
    container.appendChild(el)
  }

  async function tick() {
    if (disposed) return
    try {
      const status = await api('/api/sync-status')
      if (disposed) return
      if (!status.enabled) knownDisabled = true
      render(status)
    } catch {
      // Transient (server busy / momentary blip): leave the last badge in place
      // and retry next tick rather than flicker it away.
    }
    schedule()
  }

  tick()
  return () => { disposed = true; clearTimer() }
}
