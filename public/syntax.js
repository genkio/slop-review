import { escapeHtml } from './util.js'
import { tokenize, languageForPath } from '../core/syntax.js'

// The tokenizer and language detection now live in the shared core
// (core/syntax.js), consumed identically by the Node server's symbol lookup
// and the native TUI. This module is the browser's HTML *adapter* over that
// neutral token stream: it turns tokens into the exact `<span class="hl-..">`
// markup the diff modal's CSS targets. The TUI ships its own SGR adapter.
//
// languageForPath is re-exported so existing importers (diff.js, modals.js)
// keep importing it from here unchanged.
export { languageForPath }

/**
 * Render a token stream (from core's `tokenize`) to escaped, spanned HTML
 * safe to drop directly into innerHTML. Mirrors the original per-token
 * markup exactly:
 *   { cls, children }     -> <span class="hl-cls">{children}</span>  (nesting)
 *   { cls, text, token }  -> <span class="hl-cls" data-token="esc(token)">esc(text)</span>
 *   { cls, text }         -> <span class="hl-cls">esc(text)</span>
 *   { text, token }       -> <span data-token="esc(token)">esc(text)</span>
 *   { text }              -> esc(text)
 */
export function tokensToHtml(tokens) {
  let out = ''
  for (const tk of tokens) {
    if (tk.children) {
      out += `<span class="hl-${tk.cls}">${tokensToHtml(tk.children)}</span>`
    } else if (tk.cls) {
      const tokAttr = tk.token != null ? ` data-token="${escapeHtml(tk.token)}"` : ''
      out += `<span class="hl-${tk.cls}"${tokAttr}>${escapeHtml(tk.text)}</span>`
    } else if (tk.token != null) {
      out += `<span data-token="${escapeHtml(tk.token)}">${escapeHtml(tk.text)}</span>`
    } else {
      out += escapeHtml(tk.text)
    }
  }
  return out
}

/**
 * Tokenize a single line of code in `lang` and render it to highlighted
 * HTML. Falls back to plain escaped text for unknown / unsupported
 * languages (handled inside `tokenize`, which returns a single plain token).
 */
export function highlightLine(text, lang) {
  return tokensToHtml(tokenize(text, lang))
}
