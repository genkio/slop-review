// In-memory, process-global health of the background GitHub sync loop, surfaced
// to the UI via GET /api/sync-status so the diff header can show a "Synced 2m
// ago" badge. One slop process serves one repo, so a single module-level record
// is enough; nothing is persisted (a fresh launch starts clean, and the loop
// re-seeds it on its first run).

let status = {
  enabled: false,        // true only for a --sync session; gates the badge
  last_synced_at: null,  // ISO of the last OK sync; null until the first lands
  state: null,           // 'ok' | 'no-pr' | 'error' | null
  error: null,           // message when state === 'error'
  changes: 0,            // cumulative threads changed by syncs; the badge diffs it
                         // against the value captured at page load to show "N behind"
}

export function getSyncStatus() {
  return status
}

// A --sync session is live. Set once at server start; without it the badge
// stays hidden, so a normal launch shows no sync indicator.
export function markSyncEnabled() {
  status = { ...status, enabled: true }
}

// Fold a completed runSync result in. 'ok' stamps last_synced_at (the badge's
// "ago" anchor); a soft-stop (no-pr etc.) records the state but keeps the prior
// last_synced_at so the badge doesn't regress to "never synced".
export function recordSyncResult(result) {
  if (!result) return
  if (result.status === 'ok') {
    const s = result.stats || {}
    const delta = (s.created || 0) + (s.updated || 0) + (s.merged || 0) + (s.deleted || 0)
    status = {
      ...status,
      state: 'ok',
      error: null,
      last_synced_at: new Date().toISOString(),
      changes: status.changes + delta,
    }
  } else {
    status = { ...status, state: result.status, error: result.message || null }
  }
}

// An unexpected throw (crashing gh, etc.): flagged red, kept distinct from a
// soft-stop's expected "nothing to sync".
export function recordSyncError(err) {
  status = { ...status, state: 'error', error: err?.message || String(err) }
}
