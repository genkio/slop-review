import { escapeHtml } from './util.js'

/**
 * Minimal per-line syntax highlighter for the diff modal. Supports the
 * languages that show up in the user's PR review work — TS/JS family,
 * JSON, YAML, Python, Go, Bash, Markdown, CSS. No third-party deps.
 *
 * Per-line scope: each line is tokenized independently, so multi-line
 * constructs (block comments, multi-line template strings) lose context
 * — a line in the middle of `/* ... *‍/` will be parsed as code. That
 * tradeoff is intentional: full-file highlighting would need server-side
 * fetched contents threaded through line-numbered output, far more
 * complexity for the marginal correctness win.
 *
 * Token classes (rendered as `<span class="hl-<name>">`):
 *   keyword | string | number | comment | literal | builtin | class | regex
 * CSS theme in app.css maps these to taiou's lane palette.
 */

// Most common-language sets the same `c-style` tokenizer with different
// keyword vocabularies and comment markers. The few outliers (yaml, json,
// markdown) get their own narrow tokenizers.
const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'extends', 'implements',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'return', 'break', 'continue', 'throw', 'try', 'catch', 'finally',
  'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'async', 'await', 'yield', 'static', 'get', 'set',
  'import', 'export', 'from', 'as',
  'public', 'private', 'protected', 'readonly', 'abstract', 'override',
  'interface', 'type', 'enum', 'namespace', 'module', 'declare',
  'is', 'keyof', 'infer', 'satisfies',
])
const TS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this', 'super', 'NaN', 'Infinity'])
const TS_BUILTINS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp', 'Error',
  'console', 'Math', 'JSON', 'window', 'document', 'process', 'global',
  'never', 'unknown', 'any', 'string', 'number', 'boolean', 'object', 'symbol', 'bigint',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except',
  'finally', 'with', 'as', 'import', 'from', 'return', 'yield', 'raise',
  'pass', 'break', 'continue', 'lambda', 'global', 'nonlocal', 'async',
  'await', 'and', 'or', 'not', 'in', 'is', 'del', 'assert',
])
const PY_LITERALS = new Set(['True', 'False', 'None', 'self', 'cls'])
const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'list', 'dict', 'set', 'tuple', 'str', 'int',
  'float', 'bool', 'bytes', 'type', 'isinstance', 'issubclass', 'open',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'any', 'all',
])

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
])
const GO_LITERALS = new Set(['true', 'false', 'nil', 'iota'])
const GO_BUILTINS = new Set([
  'append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
  'make', 'new', 'panic', 'print', 'println', 'real', 'recover',
  'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16',
  'uint32', 'uint64', 'byte', 'rune', 'float32', 'float64', 'bool', 'error',
])

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while',
  'do', 'done', 'in', 'function', 'return', 'exit', 'break', 'continue',
  'local', 'export', 'readonly', 'declare', 'unset',
])
const SH_BUILTINS = new Set([
  'echo', 'printf', 'cd', 'pwd', 'pushd', 'popd', 'set', 'shift', 'test',
  'true', 'false', 'source', 'eval', 'exec', 'trap', 'kill', 'wait',
])

const EXT_TO_LANG = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  d:  'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
  json: 'json',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'css', less: 'css',
  toml: 'ini', ini: 'ini',
  // c-family (close enough to TS without type keywords leaking incorrectly)
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', hxx: 'c',
  java: 'java', kt: 'java', scala: 'java', cs: 'java',
  rs: 'rust',
}

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
  'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
  'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
  'Self', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while',
])
const RUST_LITERALS = new Set(['true', 'false', 'None', 'Some', 'Ok', 'Err'])

const JAVA_KEYWORDS = new Set([
  'abstract', 'class', 'interface', 'enum', 'extends', 'implements', 'package',
  'import', 'public', 'private', 'protected', 'static', 'final', 'abstract',
  'synchronized', 'volatile', 'transient', 'native', 'strictfp',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'throws',
  'new', 'this', 'super', 'instanceof',
])

const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int',
  'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static',
  'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  // C++/Java overlap
  'class', 'public', 'private', 'protected', 'virtual', 'template', 'namespace',
  'using', 'try', 'catch', 'throw', 'new', 'delete', 'this', 'nullptr', 'bool',
])

// Per-language config table — keys: keywords, literals, builtins, comment.line, comment.block, regex (bool)
const LANG_CONFIG = {
  typescript: { keywords: TS_KEYWORDS, literals: TS_LITERALS, builtins: TS_BUILTINS, line: '//', block: ['/*', '*/'], regex: true },
  javascript: { keywords: TS_KEYWORDS, literals: TS_LITERALS, builtins: TS_BUILTINS, line: '//', block: ['/*', '*/'], regex: true },
  python:     { keywords: PY_KEYWORDS, literals: PY_LITERALS, builtins: PY_BUILTINS, line: '#',  block: null,         regex: false },
  go:         { keywords: GO_KEYWORDS, literals: GO_LITERALS, builtins: GO_BUILTINS, line: '//', block: ['/*', '*/'], regex: false },
  bash:       { keywords: SH_KEYWORDS, literals: new Set(),   builtins: SH_BUILTINS, line: '#',  block: null,         regex: false },
  rust:       { keywords: RUST_KEYWORDS, literals: RUST_LITERALS, builtins: new Set(), line: '//', block: ['/*', '*/'], regex: false },
  java:       { keywords: JAVA_KEYWORDS, literals: new Set(['true', 'false', 'null']), builtins: new Set(), line: '//', block: ['/*', '*/'], regex: false },
  c:          { keywords: C_KEYWORDS, literals: new Set(['true', 'false', 'NULL', 'nullptr']), builtins: new Set(), line: '//', block: ['/*', '*/'], regex: false },
  css:        { keywords: new Set(), literals: new Set(), builtins: new Set(), line: null, block: ['/*', '*/'], regex: false, css: true },
}

export function languageForPath(path) {
  if (!path) return null
  const lower = path.toLowerCase()
  // Filename-pattern overrides (e.g. Dockerfile, Makefile) before extension lookup
  const base = lower.split('/').pop() || lower
  if (base === 'dockerfile')               return 'bash'
  if (base.startsWith('makefile'))         return 'bash'
  if (base.startsWith('.env'))             return 'bash'
  const ext = base.includes('.') ? base.split('.').pop() : ''
  return EXT_TO_LANG[ext] || null
}

/**
 * Tokenize a single line of code in `lang`. Returns escaped-and-spanned
 * HTML safe to drop directly into innerHTML. Falls back to plain
 * escape-html when language is unknown / unsupported / unconfigured —
 * the diff still renders cleanly, just without color.
 */
export function highlightLine(text, lang) {
  if (text == null || text === '') return ''
  if (!lang) return escapeHtml(text)
  if (lang === 'json')     return highlightJson(text)
  if (lang === 'yaml')     return highlightYaml(text)
  if (lang === 'markdown') return highlightMarkdown(text)
  if (lang === 'ini')      return highlightIni(text)
  const cfg = LANG_CONFIG[lang]
  if (!cfg) return escapeHtml(text)
  return cStyleTokenize(text, cfg)
}

// ----- C-family tokenizer -----------------------------------------------
// Walks the line character-by-character, emitting tokens. Conservative
// about edge cases (unterminated strings, escapes) — outputs plain text
// when uncertain rather than risking malformed HTML.
function cStyleTokenize(line, cfg) {
  const out = []
  const len = line.length
  let i = 0

  while (i < len) {
    const ch = line[i]

    // Single-line comment — if we see the line marker, the rest of the
    // line is a comment. Greedy take-to-end-of-line.
    if (cfg.line && line.startsWith(cfg.line, i)) {
      out.push(span('comment', line.slice(i)))
      break
    }

    // Block comment opener (single-line slice; we don't track multi-line state)
    if (cfg.block && line.startsWith(cfg.block[0], i)) {
      const closeIdx = line.indexOf(cfg.block[1], i + cfg.block[0].length)
      if (closeIdx >= 0) {
        const end = closeIdx + cfg.block[1].length
        out.push(span('comment', line.slice(i, end)))
        i = end
        continue
      }
      // No closer on this line — treat the rest as a comment
      out.push(span('comment', line.slice(i)))
      break
    }

    // String literal (single, double, backtick)
    if (ch === '"' || ch === "'" || ch === '`') {
      const j = scanString(line, i, ch)
      out.push(span('string', line.slice(i, j)))
      i = j
      continue
    }

    // Number literal — leading digit, or `.` followed by digit
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(line[i + 1] || ''))) {
      let j = i
      // Hex / binary / octal prefix
      if (ch === '0' && /[xXbBoO]/.test(line[i + 1] || '')) j += 2
      while (j < len && /[\d_a-fA-FxXoObB.eE+\-]/.test(line[j])) {
        // Stop on +/- unless preceded by exponent letter (1e+5)
        if ((line[j] === '+' || line[j] === '-') && !/[eE]/.test(line[j - 1])) break
        j++
      }
      // Optional bigint suffix
      if (line[j] === 'n') j++
      out.push(span('number', line.slice(i, j)))
      i = j
      continue
    }

    // Identifier / keyword
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i
      while (j < len && /[a-zA-Z_$0-9]/.test(line[j])) j++
      const word = line.slice(i, j)
      let cls = null
      if      (cfg.keywords.has(word)) cls = 'keyword'
      else if (cfg.literals.has(word)) cls = 'literal'
      else if (cfg.builtins.has(word)) cls = 'builtin'
      else if (/^[A-Z][a-zA-Z0-9_$]*$/.test(word)) cls = 'class'
      // Stamp data-token on identifier-bearing tokens so the symbol panel's
      // dynamic <style> can target the exact occurrence via attribute
      // selector. Keywords are skipped — they're not what users dblclick
      // to search, and keeping them out of the data-token set holds the
      // markup-size growth down on keyword-heavy lines.
      if (cls && cls !== 'keyword') out.push(span(cls, word, word))
      else if (cls)                 out.push(span(cls, word))
      else                          out.push(`<span data-token="${escapeHtml(word)}">${escapeHtml(word)}</span>`)
      i = j
      continue
    }

    // Plain punctuation / whitespace — pass through escaped
    out.push(escapeHtml(ch))
    i++
  }
  return out.join('')
}

function scanString(line, start, quote) {
  let j = start + 1
  while (j < line.length) {
    const c = line[j]
    if (c === '\\') { j += 2; continue }
    if (c === quote) { j++; return j }
    j++
  }
  return j  // unterminated — take to end of line
}

// ----- Narrow tokenizers -------------------------------------------------

function highlightJson(line) {
  // Two cases: line is `"key": value` or just a value/comma. We split
  // around the first `:` after a quoted key candidate.
  const out = []
  const len = line.length
  let i = 0
  while (i < len) {
    const ch = line[i]
    if (ch === '"') {
      const j = scanString(line, i, '"')
      // Distinguish key from string value: if next non-space is `:`, this
      // is an object key — render with the slightly distinct `class` color.
      let k = j
      while (k < len && /\s/.test(line[k])) k++
      const isKey = line[k] === ':'
      out.push(span(isKey ? 'class' : 'string', line.slice(i, j)))
      i = j
      continue
    }
    if (/\d/.test(ch) || ch === '-') {
      let j = i + (ch === '-' ? 1 : 0)
      while (j < len && /[\d.eE+\-]/.test(line[j])) j++
      out.push(span('number', line.slice(i, j)))
      i = j
      continue
    }
    if (/[a-z]/.test(ch)) {
      let j = i
      while (j < len && /[a-z]/.test(line[j])) j++
      const word = line.slice(i, j)
      out.push(['true', 'false', 'null'].includes(word) ? span('literal', word) : escapeHtml(word))
      i = j
      continue
    }
    out.push(escapeHtml(ch))
    i++
  }
  return out.join('')
}

function highlightYaml(line) {
  // YAML lines can be: comment, key: value, list item, plain
  const idx = line.search(/\S/)
  const indent = idx >= 0 ? line.slice(0, idx) : line
  const rest   = idx >= 0 ? line.slice(idx)    : ''
  // Comment
  if (rest.startsWith('#')) return escapeHtml(indent) + span('comment', rest)
  // Key (top-level identifier followed by `:`)
  const keyMatch = rest.match(/^([\w.-]+)(\s*:)(.*)$/)
  if (keyMatch) {
    const valuePart = keyMatch[3]
    const trimmedVal = valuePart.replace(/^\s*/, '')
    let valueHtml = ''
    if (trimmedVal) {
      const leadSpace = valuePart.length - trimmedVal.length
      const inlineComment = trimmedVal.match(/^(.*?)(\s+#.*)$/)
      if (inlineComment) {
        valueHtml = ' '.repeat(leadSpace) + highlightYamlScalar(inlineComment[1]) + span('comment', inlineComment[2])
      } else {
        valueHtml = ' '.repeat(leadSpace) + highlightYamlScalar(trimmedVal)
      }
    }
    return escapeHtml(indent) + span('class', keyMatch[1]) + escapeHtml(keyMatch[2]) + valueHtml
  }
  // List item — dash prefix
  if (rest.startsWith('- ')) return escapeHtml(indent) + span('keyword', '-') + ' ' + highlightYamlScalar(rest.slice(2))
  return escapeHtml(line)
}

function highlightYamlScalar(s) {
  if (!s) return ''
  if (/^["']/.test(s)) {
    const j = scanString(s, 0, s[0])
    return span('string', s.slice(0, j)) + escapeHtml(s.slice(j))
  }
  if (/^(true|false|null|yes|no|on|off|~)\b/i.test(s)) {
    const m = s.match(/^(\S+)/)
    return span('literal', m[1]) + escapeHtml(s.slice(m[1].length))
  }
  if (/^-?\d/.test(s)) {
    const m = s.match(/^-?[\d.eE+\-]+/)
    return span('number', m[0]) + escapeHtml(s.slice(m[0].length))
  }
  return escapeHtml(s)
}

function highlightMarkdown(line) {
  // Heading — wrap the whole line in keyword color, then process inline
  // code inside it (nested spans; CSS specificity hands inline code its
  // own builtin color while letting the rest stay heading-tinted).
  const heading = line.match(/^(\s*#{1,6}\s+)(.*)$/)
  if (heading) return escapeHtml(heading[1]) + `<span class="hl-keyword">${highlightMdInline(heading[2])}</span>`
  // Code fence (whole line is comment-toned)
  if (/^\s*```/.test(line)) return span('comment', line)
  // List bullet — color the bullet glyph as keyword, recurse for inline.
  const bullet = line.match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/)
  if (bullet) return escapeHtml(bullet[1]) + span('keyword', bullet[2]) + highlightMdInline(bullet[3])
  return highlightMdInline(line)
}

function highlightMdInline(s) {
  // Split on inline-code segments. The capture group keeps the
  // backtick-wrapped pieces in the resulting array so we can identify
  // them by the leading backtick. Plain segments get escaped; code
  // segments get the builtin token color (which `span()` already escapes).
  return s.split(/(`[^`]+`)/).map((seg) => (
    seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2
      ? span('builtin', seg)
      : escapeHtml(seg)
  )).join('')
}

function highlightIni(line) {
  if (/^\s*[#;]/.test(line)) return span('comment', line)
  const m = line.match(/^(\s*)(\[[^\]]+\])(.*)$/)
  if (m) return escapeHtml(m[1]) + span('class', m[2]) + escapeHtml(m[3])
  const kv = line.match(/^(\s*)([\w.-]+)(\s*=\s*)(.*)$/)
  if (kv) return escapeHtml(kv[1]) + span('class', kv[2]) + escapeHtml(kv[3]) + span('string', kv[4])
  return escapeHtml(line)
}

function span(cls, text, token) {
  const tokAttr = token ? ` data-token="${escapeHtml(token)}"` : ''
  return `<span class="hl-${cls}"${tokAttr}>${escapeHtml(text)}</span>`
}
