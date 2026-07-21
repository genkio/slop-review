const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}
export function inlineCode(s) {
  let out = escapeHtml(s)
  out = out.replace(/```([\w-]*)\n?([\s\S]*?)\n?```/g, (_, lang, code) => {
    const lines = code.split('\n')
    const indents = lines
      .filter((l) => l.trim().length > 0)
      .map((l) => l.match(/^[ \t]*/)[0].length)
    const minIndent = indents.length ? Math.min(...indents) : 0
    const body = minIndent > 0 ? lines.map((l) => l.slice(minIndent)).join('\n') : code
    const attr = lang ? ` data-lang="${lang}"` : ''
    return `<pre class="code-block"${attr}><code>${body}</code></pre>`
  })
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  return out
}

export function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago'
  return d.toISOString().slice(0, 10)
}

/**
 * Stack-bottom toast host. Created lazily on first toast and reused for
 * all subsequent ones so multiple messages pile vertically instead of
 * overlapping. The host owns the screen positioning (bottom-center) and
 * the flex direction; each toast is a plain child that grows the stack
 * upward via `column-reverse` — older toasts don't shift when a new one
 * arrives, which matters now that they don't auto-dismiss.
 */
function ensureToastHost() {
  let host = document.getElementById('toast-host')
  if (host) return host
  host = document.createElement('div')
  host.id = 'toast-host'
  host.className = 'toast-host'
  document.body.appendChild(host)
  return host
}

/**
 * Show a toast. Default behavior is persistent — the user must click ×
 * to dismiss — because the messages we surface this way (gate warnings,
 * "X failed" errors, "anchor lost" hints) are exactly the ones a reviewer
 * is likely to skim past at first paint.
 *
 * For *obvious success acknowledgments* — "Comment added", "Copied",
 * "Thread resolved" — call `toast.ok(msg)` instead. Same visual, but it
 * auto-dismisses after 2.5s so the screen doesn't accumulate "yes, you
 * did the thing" confirmations the user already knows about.
 */
export function toast(msg, { autoDismiss = false } = {}) {
  const host = ensureToastHost()
  const t = document.createElement('div')
  t.className = 'toast'

  const text = document.createElement('span')
  text.className = 'toast-text'
  text.textContent = msg

  let timer = null
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast-close'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'
  close.addEventListener('click', () => {
    if (timer) clearTimeout(timer)
    t.remove()
  })

  t.append(text, close)
  host.appendChild(t)

  if (autoDismiss) {
    timer = setTimeout(() => t.remove(), 2500)
  }
}

toast.ok = (msg) => toast(msg, { autoDismiss: true })

/**
 * Copy text to the OS clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is only exposed on HTTPS or localhost — accessing
 * slop-review over a LAN/Tailscale URL (e.g. http://your-mac:9410) leaves
 * it undefined, which is why the modern path can throw "cannot read
 * property writeText of undefined" before it ever runs. The legacy
 * `document.execCommand` path is deprecated but works everywhere and
 * isn't gated on secure context, so it's the right fallback for this
 * app's deployment shape.
 *
 * Must be called inside a real user-gesture click handler (Safari + the
 * legacy path both require it). The synchronous fallback runs before
 * yielding to the microtask queue, so awaiting this helper inside an
 * `onclick` is fine.
 */
export async function copyToClipboard(text) {
  if (typeof text !== 'string') text = String(text ?? '')
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to execCommand. Some browsers expose
      // navigator.clipboard but reject in non-secure contexts; the
      // legacy path may still work when that happens.
    }
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // Position offscreen but still rendered, so focus + select works without
  // visibly scrolling the page. `opacity:0` keeps it invisible; `position:
  // fixed; top/left:0` keeps it inside the viewport so iOS Safari doesn't
  // refuse to select it.
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'
  document.body.appendChild(ta)
  const previous = document.activeElement
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    ta.remove()
    if (previous instanceof HTMLElement) previous.focus()
  }
  if (!ok) throw new Error('clipboard copy not permitted in this context')
}

/**
 * Display an absolute path with $HOME collapsed to `~`. The browser
 * doesn't know $HOME directly, so server surfaces `state.config.home`
 * and the call sites read it from there.
 */
export function homePath(absPath, home) {
  if (!absPath) return ''
  if (!home) return absPath
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  if (absPath === h) return '~'
  if (absPath.startsWith(h + '/')) return '~' + absPath.slice(h.length)
  return absPath
}

/**
 * Format a thread's anchor line range for display. Returns `42` for a
 * single-line thread (line_end null / equal to line) and `42–45` for a
 * multi-line one. Used by the thread modal's subtitle. Threads created
 * before the multi-line feature shipped carry no `line_end` at all —
 * `undefined` collapses to the single-line case, so legacy data renders
 * unchanged.
 */
export function formatLineRange(thread) {
  const start = thread?.line
  const end = thread?.line_end
  if (start == null) return ''
  if (end == null || end === start) return String(start)
  return `${start}–${end}`
}

/**
 * Build the clipboard payload for a comment pinned to the diff. Keep the
 * first line compatible with the diff page's existing `path:line` copy
 * format, then separate the original comment body with a blank line so the
 * result is ready to paste into an editor, issue, or agent chat.
 */
export function formatPinnedComment(thread, comment) {
  if (!thread?.file || thread.pr_level || thread.line == null || typeof comment?.body !== 'string') return ''
  const end = thread.line_end
  const range = end == null || end === thread.line
    ? String(thread.line)
    : `${thread.line}-${end}`
  const side = thread.side === 'old' ? ' (old)' : ''
  return `${thread.file}:${range}${side}\n\n${comment.body}`
}

/**
 * Sanitize a branch name into a filesystem-safe directory name. SPEC §5:
 * anything outside `[A-Za-z0-9_-]` collapses to `-`, leading/trailing `-`
 * stripped, capped at 80 chars. Must stay in lockstep with the server's
 * sanitization (server/reviews.js) so the `<repo>/.reviews/<branch_id>/`
 * paths the client constructs match what the server reads/writes.
 */
export function sanitizeBranchId(branch) {
  if (!branch) return ''
  let s = String(branch).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

/**
 * SHA-256 hex digest of a UTF-8 string. Used by the forge deep-link
 * builder — GitHub anchors files in PR diffs as `#diff-<sha256(path)>`,
 * so we replicate that hash on the client. SubtleCrypto is available on
 * any context the slop-review UI runs in (loopback localhost counts as
 * a secure context).
 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text ?? ''))
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Build the forge-specific deep link for a (file, lineStart, lineEnd, side)
 * pointer inside a PR/MR. Returns null when the host isn't supported yet
 * (GitLab/Bitbucket adapters can be added by extending the switch). Caller
 * decides whether to show the button based on null/non-null.
 *
 * GitHub format: `<prUrl>/files#diff-<sha256(path)>R3-R10` (R = right/new,
 * L = left/old). Multi-line ranges use the `R3-R5` syntax, which GitHub
 * highlights as a span. The `(file, side)` anchor invariant on slop-review
 * selections (no straddling the seam) maps 1:1 to GitHub's prefix.
 */
export async function buildForgeDeepLink({ host, prUrl, path, lineStart, lineEnd, side }) {
  if (!host || !prUrl || !path) return null
  switch (host) {
    case 'github': {
      const hash = await sha256Hex(path)
      const prefix = side === 'old' ? 'L' : 'R'
      const lineSpec = lineStart === lineEnd
        ? `${prefix}${lineStart}`
        : `${prefix}${lineStart}-${prefix}${lineEnd}`
      return `${prUrl}/files#diff-${hash}${lineSpec}`
    }
    // GitLab / Bitbucket: not yet implemented. Returning null hides the
    // button rather than producing a guess that 404s on the user.
    default:
      return null
  }
}

/**
 * Sync variant for callers that already have the SHA-256 of `path`
 * pre-computed (e.g. server-attached `thread.path_sha256`). Avoids the
 * SubtleCrypto round-trip, which matters because SubtleCrypto is gated
 * on a secure context. When slop-review is opened over a LAN IP from a
 * mobile device, `crypto.subtle` is undefined, so the async path fails
 * with "Cannot read properties of undefined (reading 'digest')". Same
 * URL shape as the async version, just skips the hash step.
 */
export function buildForgeDeepLinkFromSha({ host, prUrl, pathSha256, lineStart, lineEnd, side }) {
  if (!host || !prUrl || !pathSha256) return null
  switch (host) {
    case 'github': {
      const prefix = side === 'old' ? 'L' : 'R'
      const lineSpec = lineStart === lineEnd
        ? `${prefix}${lineStart}`
        : `${prefix}${lineStart}-${prefix}${lineEnd}`
      return `${prUrl}/files#diff-${pathSha256}${lineSpec}`
    }
    default:
      return null
  }
}
