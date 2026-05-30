// ----------------------------------------------------------------------
// Shared, runtime-agnostic syntax tokenizer.
//
// This is the single source of truth for per-line syntax highlighting,
// shared by the browser SPA (public/syntax.js wraps it in an HTML adapter)
// and the native TUI (which wraps it in an SGR/ANSI adapter). It emits a
// neutral TOKEN STREAM rather than markup, so neither front-end's rendering
// concern leaks into the tokenizer.
//
// Import-pure: NO `node:` specifiers, NO DOM globals. The tokens carry RAW
// (unescaped) text; escaping/coloring is each adapter's job.
//
// Token shapes:
//   { cls, text }            a classed run            -> <span class="hl-cls">esc(text)</span>
//   { cls, text, token }     classed + symbol anchor  -> <span class="hl-cls" data-token="esc(token)">...</span>
//   { text, token }          plain identifier anchor  -> <span data-token="esc(token)">esc(text)</span>
//   { text }                 plain run                -> esc(text)
//   { cls, children }        a span wrapping tokens   -> <span class="hl-cls">{children}</span>  (markdown headings only)
//
// Token classes: keyword | string | number | comment | literal | builtin | class
//
// Per-line scope: each line is tokenized independently, so multi-line
// constructs (block comments, multi-line template strings) lose context.
// That tradeoff is intentional: full-file highlighting would need
// server-fetched contents threaded through line-numbered output, far more
// complexity for the marginal correctness win.
// ----------------------------------------------------------------------

// ----- token constructors ----------------------------------------------
function tok(cls, text, token) {
  return token == null ? { cls, text } : { cls, text, token }
}
function txt(text) {
  return { text }
}
function identTok(word) {
  return { text: word, token: word }
}
function wrap(cls, children) {
  return { cls, children }
}

// Most common-language sets share the same `c-style` tokenizer with
// different keyword vocabularies and comment markers. The few outliers
// (yaml, json, markdown, ini) get their own narrow tokenizers.
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

// Per-language config: keywords, literals, builtins, comment.line,
// comment.block, regex (bool). The css entry has no keyword vocab; its
// tokens come from the c-style string/number/comment scan only.
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

/**
 * Map a file path to a language id, or null when unsupported. This is the
 * superset that the server's symbol lookup (server/git.js) and the SPA both
 * consume. Filename-pattern overrides (Dockerfile, Makefile, .env) win over
 * extension lookup.
 */
export function languageForPath(path) {
  if (!path) return null
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() || lower
  if (base === 'dockerfile')       return 'bash'
  if (base.startsWith('makefile')) return 'bash'
  if (base.startsWith('.env'))     return 'bash'
  const ext = base.includes('.') ? base.split('.').pop() : ''
  return EXT_TO_LANG[ext] || null
}

/**
 * Tokenize a single line of code in `lang` into a neutral token stream.
 * Returns [] for empty/null text and a single plain token for unknown /
 * unsupported / unconfigured languages, so adapters render the line cleanly
 * (just without color) in the fallback case.
 */
export function tokenize(text, lang) {
  if (text == null || text === '') return []
  if (!lang) return [txt(text)]
  if (lang === 'json')     return tokenizeJson(text)
  if (lang === 'yaml')     return tokenizeYaml(text)
  if (lang === 'markdown') return tokenizeMarkdown(text)
  if (lang === 'ini')      return tokenizeIni(text)
  const cfg = LANG_CONFIG[lang]
  if (!cfg) return [txt(text)]
  return tokenizeCStyle(text, cfg)
}

// ----- C-family tokenizer -----------------------------------------------
// Walks the line character-by-character, emitting tokens. Conservative
// about edge cases (unterminated strings, escapes): emits plain text when
// uncertain rather than guessing.
function tokenizeCStyle(line, cfg) {
  const out = []
  const len = line.length
  let i = 0

  while (i < len) {
    const ch = line[i]

    // Single-line comment: rest of the line is a comment.
    if (cfg.line && line.startsWith(cfg.line, i)) {
      out.push(tok('comment', line.slice(i)))
      break
    }

    // Block comment opener (single-line slice; no multi-line state).
    if (cfg.block && line.startsWith(cfg.block[0], i)) {
      const closeIdx = line.indexOf(cfg.block[1], i + cfg.block[0].length)
      if (closeIdx >= 0) {
        const end = closeIdx + cfg.block[1].length
        out.push(tok('comment', line.slice(i, end)))
        i = end
        continue
      }
      out.push(tok('comment', line.slice(i)))
      break
    }

    // String literal (single, double, backtick).
    if (ch === '"' || ch === "'" || ch === '`') {
      const j = scanString(line, i, ch)
      out.push(tok('string', line.slice(i, j)))
      i = j
      continue
    }

    // Number literal: leading digit, or `.` followed by digit.
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(line[i + 1] || ''))) {
      let j = i
      if (ch === '0' && /[xXbBoO]/.test(line[i + 1] || '')) j += 2
      while (j < len && /[\d_a-fA-FxXoObB.eE+\-]/.test(line[j])) {
        if ((line[j] === '+' || line[j] === '-') && !/[eE]/.test(line[j - 1])) break
        j++
      }
      if (line[j] === 'n') j++
      out.push(tok('number', line.slice(i, j)))
      i = j
      continue
    }

    // Identifier / keyword.
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i
      while (j < len && /[a-zA-Z_$0-9]/.test(line[j])) j++
      const word = line.slice(i, j)
      let cls = null
      if      (cfg.keywords.has(word)) cls = 'keyword'
      else if (cfg.literals.has(word)) cls = 'literal'
      else if (cfg.builtins.has(word)) cls = 'builtin'
      else if (/^[A-Z][a-zA-Z0-9_$]*$/.test(word)) cls = 'class'
      // Anchor a data-token on identifier-bearing tokens so the symbol
      // panel can target the exact occurrence. Keywords are skipped (not
      // what users search for, and it holds markup growth down).
      if (cls && cls !== 'keyword') out.push(tok(cls, word, word))
      else if (cls)                 out.push(tok(cls, word))
      else                          out.push(identTok(word))
      i = j
      continue
    }

    // Plain punctuation / whitespace.
    out.push(txt(ch))
    i++
  }
  return out
}

function scanString(line, start, quote) {
  let j = start + 1
  while (j < line.length) {
    const c = line[j]
    if (c === '\\') { j += 2; continue }
    if (c === quote) { j++; return j }
    j++
  }
  return j  // unterminated: take to end of line
}

// ----- Narrow tokenizers -------------------------------------------------

function tokenizeJson(line) {
  const out = []
  const len = line.length
  let i = 0
  while (i < len) {
    const ch = line[i]
    if (ch === '"') {
      const j = scanString(line, i, '"')
      // Distinguish key from string value: if the next non-space is `:`,
      // it is an object key (rendered with the distinct `class` color).
      let k = j
      while (k < len && /\s/.test(line[k])) k++
      const isKey = line[k] === ':'
      out.push(tok(isKey ? 'class' : 'string', line.slice(i, j)))
      i = j
      continue
    }
    if (/\d/.test(ch) || ch === '-') {
      let j = i + (ch === '-' ? 1 : 0)
      while (j < len && /[\d.eE+\-]/.test(line[j])) j++
      out.push(tok('number', line.slice(i, j)))
      i = j
      continue
    }
    if (/[a-z]/.test(ch)) {
      let j = i
      while (j < len && /[a-z]/.test(line[j])) j++
      const word = line.slice(i, j)
      out.push(['true', 'false', 'null'].includes(word) ? tok('literal', word) : txt(word))
      i = j
      continue
    }
    out.push(txt(ch))
    i++
  }
  return out
}

function tokenizeYaml(line) {
  const idx = line.search(/\S/)
  const indent = idx >= 0 ? line.slice(0, idx) : line
  const rest   = idx >= 0 ? line.slice(idx)    : ''
  // Comment
  if (rest.startsWith('#')) return [txt(indent), tok('comment', rest)]
  // Key (top-level identifier followed by `:`)
  const keyMatch = rest.match(/^([\w.-]+)(\s*:)(.*)$/)
  if (keyMatch) {
    const valuePart = keyMatch[3]
    const trimmedVal = valuePart.replace(/^\s*/, '')
    const valueTokens = []
    if (trimmedVal) {
      const leadSpace = valuePart.length - trimmedVal.length
      const inlineComment = trimmedVal.match(/^(.*?)(\s+#.*)$/)
      if (inlineComment) {
        valueTokens.push(txt(' '.repeat(leadSpace)), ...tokenizeYamlScalar(inlineComment[1]), tok('comment', inlineComment[2]))
      } else {
        valueTokens.push(txt(' '.repeat(leadSpace)), ...tokenizeYamlScalar(trimmedVal))
      }
    }
    return [txt(indent), tok('class', keyMatch[1]), txt(keyMatch[2]), ...valueTokens]
  }
  // List item: dash prefix
  if (rest.startsWith('- ')) return [txt(indent), tok('keyword', '-'), txt(' '), ...tokenizeYamlScalar(rest.slice(2))]
  return [txt(line)]
}

function tokenizeYamlScalar(s) {
  if (!s) return []
  if (/^["']/.test(s)) {
    const j = scanString(s, 0, s[0])
    return [tok('string', s.slice(0, j)), txt(s.slice(j))]
  }
  if (/^(true|false|null|yes|no|on|off|~)\b/i.test(s)) {
    const m = s.match(/^(\S+)/)
    return [tok('literal', m[1]), txt(s.slice(m[1].length))]
  }
  if (/^-?\d/.test(s)) {
    const m = s.match(/^-?[\d.eE+\-]+/)
    return [tok('number', m[0]), txt(s.slice(m[0].length))]
  }
  return [txt(s)]
}

function tokenizeMarkdown(line) {
  // Heading: wrap the whole line in keyword color, then process inline code
  // inside it (nested span; the HTML adapter reproduces the nesting and the
  // SGR adapter flattens it).
  const heading = line.match(/^(\s*#{1,6}\s+)(.*)$/)
  if (heading) return [txt(heading[1]), wrap('keyword', tokenizeMdInline(heading[2]))]
  // Code fence (whole line comment-toned)
  if (/^\s*```/.test(line)) return [tok('comment', line)]
  // List bullet: color the bullet glyph as keyword, recurse for inline.
  const bullet = line.match(/^(\s*)([-*+]\s+|\d+\.\s+)(.*)$/)
  if (bullet) return [txt(bullet[1]), tok('keyword', bullet[2]), ...tokenizeMdInline(bullet[3])]
  return tokenizeMdInline(line)
}

function tokenizeMdInline(s) {
  // Split on inline-code segments. Code segments get the builtin color;
  // plain segments stay plain. Empty segments produce empty plain tokens
  // (which render to nothing), matching the original join behavior.
  return s.split(/(`[^`]+`)/).map((seg) => (
    seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2
      ? tok('builtin', seg)
      : txt(seg)
  ))
}

function tokenizeIni(line) {
  if (/^\s*[#;]/.test(line)) return [tok('comment', line)]
  const m = line.match(/^(\s*)(\[[^\]]+\])(.*)$/)
  if (m) return [txt(m[1]), tok('class', m[2]), txt(m[3])]
  const kv = line.match(/^(\s*)([\w.-]+)(\s*=\s*)(.*)$/)
  if (kv) return [txt(kv[1]), tok('class', kv[2]), txt(kv[3]), tok('string', kv[4])]
  return [txt(line)]
}
