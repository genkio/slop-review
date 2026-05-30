// ----------------------------------------------------------------------
// TUI syntax adapter: renders a core/syntax.js token stream to ANSI SGR.
// This is the terminal counterpart of public/syntax.js tokensToHtml: same
// token stream, different output. It emits ONLY foreground color (38;5;N)
// and a foreground-reset (39), never a full reset (0) or a background, so it
// composes inside a row that already painted an add/del background wash.
// ----------------------------------------------------------------------

// 256-color foreground per token class (chosen to read on both dark add/del
// washes and the default background).
const FG = {
  keyword: 170, // magenta
  string: 114,  // green
  number: 75,   // blue
  comment: 245, // grey
  literal: 173, // orange
  builtin: 75,  // blue
  class: 179,   // yellow
}

const ESC = '\x1b'

export function tokensToSgr(tokens) {
  let out = ''
  for (const tk of tokens) {
    if (tk.children) {
      // Markdown-heading nesting collapses in the terminal: render the inner
      // tokens with their own colors (the outer keyword tint is dropped).
      out += tokensToSgr(tk.children)
      continue
    }
    const code = tk.cls ? FG[tk.cls] : undefined
    if (code != null) out += `${ESC}[38;5;${code}m${tk.text}${ESC}[39m`
    else out += tk.text
  }
  return out
}
