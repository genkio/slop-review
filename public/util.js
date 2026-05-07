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

export function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2500)
}

/**
 * Copy text to the OS clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is only exposed on HTTPS or localhost — accessing
 * taiou over Tailscale (e.g. http://your-mac:4917) leaves it undefined,
 * which is why the modern path can throw "cannot read property writeText
 * of undefined" before it ever runs. The legacy `document.execCommand`
 * path is deprecated but works everywhere and isn't gated on secure
 * context, so it's the right fallback for this app's deployment shape.
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

