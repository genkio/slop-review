// Intra-line diff highlighting for paired (deleted, added) lines.
//
// Given two lines that the parser already paired as a single change,
// compute which TOKENS changed vs which carried over, so the renderer
// can paint just the changed bits brightly and leave the rest in the
// base wash. Inspired by `dandavison/delta`'s within-line highlights.
//
// Algorithm: token-level Longest Common Subsequence. Lines are split on
// word/punct/whitespace boundaries (so `foo.bar()` becomes 5 tokens),
// matched as tokens, then non-matching runs become highlighted segments.
// Token-level matches what reviewers expect; character-level Myers would
// be more precise but produces visually noisy highlights on code.

// Tokens: whitespace runs, identifiers, numbers, simple string literals
// (with backslash escapes), or any single non-word char. The string-literal
// branches keep `"foo"` as a single token so partial replacements inside
// strings don't produce confusing per-char highlights.
const TOKEN_RE = /\s+|[A-Za-z_$][A-Za-z0-9_$]*|0[xXbBoO][0-9A-Fa-f_]+|[0-9]+(?:\.[0-9]+)?|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|[^\s\w]/g

// Quadratic DP table cap. Beyond this we fall back to a single whole-line
// segment per side — long minified or generated lines aren't useful to
// highlight per-token anyway, and the LCS would dominate render cost.
const MAX_TOKENS = 400

// If the unchanged portion is too small relative to the longer side, the
// pair probably isn't really "the same line modified" — it's two separate
// changes that the unified-diff happened to pair by position. Showing a
// dense intra-diff in that case would be noise; fall back to whole-line
// wash so reviewers see "everything changed" rather than a confusing salt
// of red/green tokens across both sides.
const MIN_EQ_RATIO = 0.30

function tokenize(text) {
  if (!text) return []
  return text.match(TOKEN_RE) || []
}

/**
 * Compute the within-line diff between two strings.
 *
 * Returns `{ left: Segment[], right: Segment[] }` where each segment is
 * `{ kind: 'eq' | 'del' | 'add', text: string }`. The `left` array only
 * uses 'eq'/'del'; `right` only uses 'eq'/'add'. Concatenating the texts
 * on each side reproduces the original input.
 *
 * Returns `null` when the pair shouldn't be intra-highlighted (too long,
 * or not similar enough). Callers should fall back to whole-line wash.
 */
export function intraLineSegments(oldText, newText) {
  if (!oldText && !newText) return null
  const a = tokenize(oldText)
  const b = tokenize(newText)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null
  if (a.length === 0 || b.length === 0) return null

  // Standard LCS DP. Uint16Array keeps the table small for typical line
  // lengths; tokens-per-line tops out well below 65535 thanks to MAX_TOKENS.
  const n = a.length, m = b.length
  const dp = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    const dpi = dp[i], dpim1 = dp[i - 1]
    for (let j = 1; j <= m; j++) {
      dpi[j] = ai === b[j - 1]
        ? dpim1[j - 1] + 1
        : (dpim1[j] >= dpi[j - 1] ? dpim1[j] : dpi[j - 1])
    }
  }

  // Backtrack into per-side ops. Build right-to-left, reverse at the end.
  const left  = []
  const right = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      left.push({  kind: 'eq',  text: a[i - 1] })
      right.push({ kind: 'eq',  text: b[j - 1] })
      i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      left.push({  kind: 'del', text: a[i - 1] })
      i--
    } else {
      right.push({ kind: 'add', text: b[j - 1] })
      j--
    }
  }
  while (i > 0) { left.push({  kind: 'del', text: a[i - 1] }); i-- }
  while (j > 0) { right.push({ kind: 'add', text: b[j - 1] }); j-- }
  left.reverse()
  right.reverse()

  // Similarity gate: only emit intra-diff if a meaningful chunk carries over.
  const eqLen  = countEqChars(left)
  const maxLen = Math.max(oldText.length, newText.length)
  if (maxLen === 0 || eqLen / maxLen < MIN_EQ_RATIO) return null

  return { left: mergeAdjacent(left), right: mergeAdjacent(right) }
}

function countEqChars(segs) {
  let n = 0
  for (const s of segs) if (s.kind === 'eq') n += s.text.length
  return n
}

function mergeAdjacent(segs) {
  // The backtrack appends one token at a time; collapse runs of the same
  // kind so the renderer emits one wrapper span per change run instead of
  // one per token.
  const out = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.kind === s.kind) last.text += s.text
    else out.push({ kind: s.kind, text: s.text })
  }
  return out
}
