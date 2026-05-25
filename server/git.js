import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, normalize, isAbsolute } from 'node:path'

const pExecFile = promisify(execFile)

const GIT_TIMEOUT = 15000
const GIT_MAXBUF = 32 * 1024 * 1024

async function git(repoPath, args, opts = {}) {
  return pExecFile('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT,
    maxBuffer: GIT_MAXBUF,
    encoding: 'utf8',
    ...opts,
  })
}

export async function isGitRepo(repoPath) {
  try {
    await git(repoPath, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/**
 * Read the URL of the `origin` remote, or null if not configured.
 * Used by the host module to derive forge identity (github / gitlab / …).
 */
export async function getOriginUrl(repoPath) {
  try {
    const { stdout } = await git(repoPath, ['remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Returns the canonical branch state for a repo. Single source of truth
 * for which view the UI should render — empty state, local-only, full,
 * or per-commit are all derivable from this object's fields.
 */
export async function getBranchInfo(repoPath) {
  const out = {
    current_branch:    null,
    head_sha:          null,
    base_branch:       null,
    base_sha:          null,
    merge_base_sha:    null,
    on_base:           false,
    detached:          false,
    has_local_changes: false,
    has_origin_head:   false,
    has_commits_ahead: false,
  }

  try {
    const { stdout: head } = await git(repoPath, ['rev-parse', 'HEAD'])
    out.head_sha = head.trim()
  } catch {
    return out  // not a git repo or empty
  }

  try {
    const { stdout: br } = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const name = br.trim()
    if (name === 'HEAD') {
      out.detached = true
    } else {
      out.current_branch = name
    }
  } catch {}

  try {
    const { stdout: oh } = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    const ref = oh.trim()
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/)
    if (m) {
      out.base_branch = m[1]
      out.has_origin_head = true
      try {
        const { stdout: bs } = await git(repoPath, ['rev-parse', `refs/remotes/origin/${m[1]}`])
        out.base_sha = bs.trim()
      } catch {}
    }
  } catch {}

  if (out.current_branch && out.base_branch && out.current_branch === out.base_branch) {
    out.on_base = true
  }

  if (out.head_sha && out.base_sha) {
    try {
      const { stdout: mb } = await git(repoPath, ['merge-base', out.head_sha, out.base_sha])
      out.merge_base_sha = mb.trim()
      out.has_commits_ahead = out.merge_base_sha !== out.head_sha
    } catch {}
  }

  // On-base review fallback: when sitting on main/master with nothing ahead
  // of origin, synthesize a merge-base = the empty-tree SHA so the user can
  // review the entire history reachable from HEAD. This keeps `/commits`
  // (the per-commit nav) and `/diff` (the cumulative Full diff) consistent
  // — both range over `<empty-tree>..HEAD`, so the per-commit list walks
  // every commit on main (capped at `getCommits`'s limit) and the Full
  // diff shows the corresponding cumulative content. We use the empty-tree
  // rather than `HEAD~1` so navigation reaches the *first* commit too,
  // which matters in fresh projects with only a handful of commits.
  //
  // Both `git diff` and `git log` accept the empty-tree SHA as a valid
  // range endpoint, so no special-casing is needed in getFullDiff /
  // getCommits. We derive the SHA with `hash-object` rather than hardcoding
  // `4b825dc6…` so SHA-256 repos work too (they use a different constant).
  if (out.on_base && !out.has_commits_ahead && out.head_sha) {
    try {
      const { stdout: empty } = await git(repoPath, ['hash-object', '-t', 'tree', '/dev/null'])
      out.merge_base_sha = empty.trim()
      out.has_commits_ahead = true
    } catch {}
  }

  // Exclude `.reviews/` from local-change detection. Those JSONs are
  // slop-review's own thread store — not user code work. Counting them
  // as local changes would flip the diff page's default landing to the
  // Local view as soon as the first thread is created, which then poisons
  // subsequent threads with `view: 'local'` and breaks jump-to-file on a
  // clean main. Mirrors the same exclusion already in server/overview.js.
  try {
    await git(repoPath, ['diff', '--quiet', 'HEAD', '--', '.', ':(exclude).reviews/**'])
  } catch (e) {
    // exit 1 => has changes; other codes => unrelated error
    if (e?.code === 1) out.has_local_changes = true
  }
  if (!out.has_local_changes) {
    try {
      const { stdout: untracked } = await git(repoPath, [
        'ls-files', '--others', '--exclude-standard', '-z',
        '--', '.', ':(exclude).reviews/**',
      ])
      if (untracked.length > 0) out.has_local_changes = true
    } catch {}
  }

  return out
}

/**
 * List commits between merge-base and HEAD, oldest-first. Returns enough
 * metadata for the commits list and per-commit diff fetcher to anchor by SHA.
 *
 * Per-commit numstat is a separate `git log --numstat` invocation so the
 * pretty format stays clean. We could cram it into one log with %H + a
 * delimiter, but the parsing complexity isn't worth saving one subprocess.
 */
export async function getCommits(repoPath, mergeBase, head, { limit = 100 } = {}) {
  if (!mergeBase || !head || mergeBase === head) return []

  const SEP = '\x1e'  // record separator
  const FIELD = '\x1f'  // unit separator
  const fmt = ['%H', '%h', '%s', '%an', '%aI'].join(FIELD) + SEP

  const { stdout } = await git(repoPath, [
    'log', '--reverse', `--pretty=format:${fmt}`,
    `${mergeBase}..${head}`, `-n`, String(limit),
  ])

  const commits = []
  for (const rec of stdout.split(SEP)) {
    const trimmed = rec.trim()
    if (!trimmed) continue
    const [sha, short_sha, headline, author, authored_at] = trimmed.split(FIELD)
    commits.push({
      sha,
      short_sha,
      headline: headline || '',
      author: author || '',
      authored_at: authored_at || '',
      additions: 0,
      deletions: 0,
      changed_files: 0,
    })
  }

  // Per-commit shortstat for additions/deletions/changed_files.
  // Could be expensive on large branches — bounded by `limit` above.
  await Promise.all(commits.map(async (c) => {
    try {
      const { stdout: ss } = await git(repoPath, [
        'show', '--shortstat', '--pretty=format:', c.sha,
      ])
      const text = ss.trim()
      const fm = text.match(/(\d+) files? changed/)
      const am = text.match(/(\d+) insertions?\(\+\)/)
      const dm = text.match(/(\d+) deletions?\(-\)/)
      if (fm) c.changed_files = Number(fm[1])
      if (am) c.additions = Number(am[1])
      if (dm) c.deletions = Number(dm[1])
    } catch {}
  }))

  return commits
}

const SHA_RE = /^[0-9a-f]{7,40}$/i

export function isValidSha(s) {
  return typeof s === 'string' && SHA_RE.test(s)
}

/**
 * Look up blob SHA at `ref` for each path. Paths absent from the tree
 * (e.g. deleted at `ref`, or a directory rather than a file) come back as
 * `null` so callers can distinguish "this file is gone here" from "this
 * file has blob X" — both stable states a reviewed-mark may want to pin.
 *
 * One subprocess regardless of path count. `-z` keeps NUL-separated output
 * so paths with newlines survive intact, and `--` is essential — without
 * it a path that happens to look like a ref ("HEAD", "master") collides
 * with revision parsing.
 */
export async function getBlobShasAt(repoPath, ref, paths) {
  const out = new Map()
  const list = (paths || []).filter(Boolean)
  if (!list.length) return out
  for (const p of list) out.set(p, null)
  try {
    const { stdout } = await git(repoPath, ['ls-tree', '-z', ref, '--', ...list])
    for (const rec of stdout.split('\0')) {
      if (!rec) continue
      const tabIdx = rec.indexOf('\t')
      if (tabIdx < 0) continue
      const meta = rec.slice(0, tabIdx).trim().split(/\s+/)
      // meta = [mode, type, object]. Filter to blobs — a directory entry
      // would also surface as a `tree` record we don't want to record.
      if (meta[1] !== 'blob') continue
      const p = rec.slice(tabIdx + 1)
      const sha = meta[2]
      if (p && sha) out.set(p, sha)
    }
  } catch {
    // ref unreadable (e.g. unborn HEAD) — leave entries as `null`.
  }
  return out
}

/**
 * Read a file's text at `ref` and return a 1-indexed line window of width
 * `2*context+1` centered on `line`. Empty/missing/binary content are
 * reported via flags rather than thrown — the head-preview UI surfaces
 * each as its own modal state, so a 500 here would just blank the modal.
 *
 * Binary detection mirrors what `git diff` itself does for "Binary files
 * differ" — a NUL byte in the first 8KB. Good enough for the preview
 * (which can't render binary anyway); not authoritative.
 */
export async function getFileWindowAt(repoPath, ref, path, line, context) {
  const window = Math.max(0, Number(context) | 0)
  const target = Math.max(1, Number(line) | 0)

  let raw
  try {
    const res = await git(repoPath, ['show', `${ref}:${path}`], { encoding: 'buffer' })
    raw = res.stdout
  } catch {
    return { missing: true, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
  }

  const probeLen = Math.min(raw.length, 8192)
  for (let i = 0; i < probeLen; i++) {
    if (raw[i] === 0) {
      return { missing: false, binary: true, start: 0, end: 0, lines: [], total_lines: 0 }
    }
  }

  const text = raw.toString('utf8')
  // `git show` always terminates the blob with the file's own bytes —
  // a trailing newline produces an empty final element on .split, which
  // we drop so total_lines reflects the file's actual line count.
  const allLines = text.split('\n')
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()

  const total = allLines.length
  if (total === 0) {
    return { missing: false, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
  }
  const clampedTarget = Math.min(target, total)
  const start = Math.max(1, clampedTarget - window)
  const end   = Math.min(total, clampedTarget + window)
  return {
    missing: false,
    binary: false,
    start,
    end,
    lines: allLines.slice(start - 1, end),
    total_lines: total,
  }
}

/**
 * Read a closed [start, end] (1-indexed, inclusive) line range from
 * `path` at `ref`. Powers the "expand context" buttons on hunk headers —
 * given a gap of unchanged lines between two hunks, the client asks for
 * the slice and splices it in as context rows.
 *
 * `ref` may be a git ref (sha, branch, 'HEAD') OR the sentinel
 * 'WORKTREE', which reads from disk instead of `git show`. The local
 * diff has no ref for its new side — the working tree IS the new side —
 * so WORKTREE is the only way to expand context there. Same binary +
 * missing-file flag shape as getFileWindowAt for caller symmetry.
 *
 * Path traversal is blocked when reading from WORKTREE: a relative
 * path is joined onto repoPath and the resolved path must stay under
 * repoPath. `git show` is naturally sandboxed to the repo's object store
 * so refs don't need the same guard.
 */
export async function getFileLines(repoPath, ref, path, start, end) {
  const s = Math.max(1, Number(start) | 0)
  const e = Math.max(s, Number(end) | 0)

  let raw
  if (ref === 'WORKTREE') {
    if (!path || isAbsolute(path)) {
      return { missing: true, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
    }
    const resolved = normalize(join(repoPath, path))
    const repoNorm = normalize(repoPath)
    if (!resolved.startsWith(repoNorm + '/') && resolved !== repoNorm) {
      return { missing: true, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
    }
    try {
      raw = await readFile(resolved)
    } catch {
      return { missing: true, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
    }
  } else {
    try {
      const res = await git(repoPath, ['show', `${ref}:${path}`], { encoding: 'buffer' })
      raw = res.stdout
    } catch {
      return { missing: true, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
    }
  }

  const probeLen = Math.min(raw.length, 8192)
  for (let i = 0; i < probeLen; i++) {
    if (raw[i] === 0) {
      return { missing: false, binary: true, start: 0, end: 0, lines: [], total_lines: 0 }
    }
  }

  const text = raw.toString('utf8')
  const allLines = text.split('\n')
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  const total = allLines.length
  if (total === 0) {
    return { missing: false, binary: false, start: 0, end: 0, lines: [], total_lines: 0 }
  }
  const cs = Math.min(s, total)
  const ce = Math.min(e, total)
  return {
    missing: false,
    binary: false,
    start: cs,
    end: ce,
    lines: allLines.slice(cs - 1, ce),
    total_lines: total,
  }
}

/**
 * Translate a 1-indexed new-side line number at `fromSha` into the
 * corresponding line at `toRef`, by walking `git diff fromSha..toRef`
 * hunks. With `--unified=0` each hunk is the minimal change region:
 *   @@ -A,B +C,D @@   ← B old lines starting at A map to D new at C
 *
 * Three outcomes:
 *   - mapped:           the line still exists verbatim; result = line + Σ(D-B)
 *                       over hunks strictly before this one
 *   - in-changed-hunk:  the line falls inside [A, A+B); content was modified
 *                       or removed, so we point at the hunk's newStart (C) as
 *                       the closest "this region now lives here" anchor
 *   - file-deleted:     the path is absent at `toRef`
 *
 * Pure-add hunks (B=0) are anchored on the OLD line *before* the addition,
 * so the "before this hunk" boundary is `line <= A`, not `line < A`. The
 * normal-hunk case uses `line < A` — same rule, expressed differently.
 *
 * Exported separately from getHeadPreview so tests can target the
 * pure-line-math layer without git fixtures for every edge case.
 */
export function mapLineThroughDiff(diffText, fromLine) {
  if (!diffText || !diffText.trim()) {
    return { line: fromLine, status: 'mapped' }
  }
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let m
  let offset = 0
  while ((m = hunkRe.exec(diffText))) {
    const A = +m[1]
    const B = m[2] != null ? +m[2] : 1
    const C = +m[3]
    const D = m[4] != null ? +m[4] : 1
    if (B === 0) {
      // Pure addition between old lines A and A+1. Line A itself is the
      // unaffected context line before the inserted block.
      if (fromLine <= A) return { line: fromLine + offset, status: 'mapped' }
    } else {
      if (fromLine < A)         return { line: fromLine + offset, status: 'mapped' }
      if (fromLine < A + B)     return { line: C, status: 'in-changed-hunk' }
    }
    offset += D - B
  }
  return { line: fromLine + offset, status: 'mapped' }
}

export async function mapLineToRef(repoPath, fromSha, toRef, path, fromLine) {
  const headBlobs = await getBlobShasAt(repoPath, toRef, [path])
  if (headBlobs.get(path) == null) {
    return { line: null, status: 'file-deleted' }
  }
  let diffText = ''
  try {
    const { stdout } = await git(repoPath, [
      'diff', '--unified=0', '--no-color', '--no-ext-diff',
      `${fromSha}..${toRef}`, '--', path,
    ])
    diffText = stdout
  } catch {
    // If diff itself fails (rare — usually a permissions or oversized
    // case), fall through to "mapped at identity" rather than 500ing.
    return { line: fromLine, status: 'mapped' }
  }
  return mapLineThroughDiff(diffText, fromLine)
}

/**
 * High-level: given a commit sha + a new-side line in that commit's view,
 * return a HEAD-side window of lines for the preview modal to render.
 * Composes mapLineToRef (which line in HEAD?) and getFileWindowAt (give
 * me ±context around that line). Status field is forwarded so the client
 * can show the right banner.
 */
export async function getHeadPreview(repoPath, commitSha, path, commitLine, context = 10) {
  if (!isValidSha(commitSha)) throw new Error('invalid sha')
  const { stdout: headRaw } = await git(repoPath, ['rev-parse', 'HEAD'])
  const head_sha = headRaw.trim()

  const map = await mapLineToRef(repoPath, commitSha, 'HEAD', path, commitLine)
  if (map.status === 'file-deleted') {
    return {
      path, head_sha, commit_line: commitLine, head_line: null,
      status: 'file-deleted',
      start: 0, end: 0, lines: [], total_lines: 0, binary: false,
    }
  }
  const win = await getFileWindowAt(repoPath, 'HEAD', path, map.line, context)
  if (win.binary) {
    return {
      path, head_sha, commit_line: commitLine, head_line: map.line,
      status: 'binary',
      start: 0, end: 0, lines: [], total_lines: 0, binary: true,
    }
  }
  if (win.missing) {
    // mapLineToRef said the file exists, getFileWindowAt says it doesn't —
    // a rare race (HEAD moved under us, or blob is unreadable). Surface
    // as file-deleted; less misleading than empty content.
    return {
      path, head_sha, commit_line: commitLine, head_line: map.line,
      status: 'file-deleted',
      start: 0, end: 0, lines: [], total_lines: 0, binary: false,
    }
  }
  return {
    path,
    head_sha,
    commit_line: commitLine,
    head_line: map.line,
    status: map.status,         // 'mapped' or 'in-changed-hunk'
    start: win.start,
    end: win.end,
    lines: win.lines,
    total_lines: win.total_lines,
    binary: false,
  }
}

// Symbol shape gate: bare identifiers only. Anything with punctuation,
// whitespace, or zero/over-length is rejected before it reaches `git grep`,
// which keeps the regex builders below safe to interpolate without escaping.
const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidSymbol(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && SYMBOL_RE.test(s)
}

// Server-side language detection — mirrors `languageForPath` in
// public/syntax.js. Kept in sync by hand (the server has no module
// access to the client bundle). If you add a language here, mirror it
// there too, and vice versa.
function langForPath(path) {
  if (!path) return null
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() || ''
  const ext = base.includes('.') ? base.split('.').pop() : ''
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': case 'd': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs':           return 'javascript'
    case 'py': case 'pyi': return 'python'
    case 'go':             return 'go'
    case 'rs':             return 'rust'
    case 'java': case 'kt': case 'scala': case 'cs': return 'java'
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': return 'c'
    case 'sh': case 'bash': case 'zsh': case 'ksh': return 'bash'
    default: return null
  }
}

// Per-language "this line shape introduces NAME" matchers. Each entry is
// `(name) => RegExp`; we pass the validated symbol through SYMBOL_RE so
// interpolating it raw into the regex is safe (no escaping needed).
//
// A null entry means "no def heuristic for this language" — the search
// still finds occurrences via `git grep -w`, but the no-def-shaped fallback
// (first occurrence anywhere) wins instead of a structural definition.
const DEF_PATTERNS = {
  // TS / JS: function / class / interface / type / enum / const|let|var
  // declarations at any indentation, with optional `export [default]`
  // and `async` prefixes. Covers ~all top-level declaration shapes; misses
  // method definitions inside classes (intentional — too easy to false-positive
  // on call sites that happen to start a line).
  typescript: (n) => new RegExp(
    `^[\\t ]*(?:export[\\t ]+(?:default[\\t ]+)?)?(?:async[\\t ]+)?` +
    `(?:function[\\t ]+${n}\\b` +
    `|class[\\t ]+${n}\\b` +
    `|interface[\\t ]+${n}\\b` +
    `|type[\\t ]+${n}\\b` +
    `|enum[\\t ]+${n}\\b` +
    `|(?:const|let|var)[\\t ]+${n}\\b)`,
  ),
  // TODO(human): add a Python definition matcher.
  //
  // Decide which line shapes count as "introducing NAME" — at minimum
  // `def NAME(...)` and `class NAME(...)`, but consider:
  //   - `async def NAME(...)`
  //   - `NAME = ...` at module level (broad; risks false positives on
  //     assignments inside functions)
  // Return a RegExp built around the validated NAME (no escaping needed).
  // Use POSIX-style anchoring (`^[\t ]*`) and a trailing `\b` after NAME
  // so `foo_bar` doesn't match when looking for `foo`. Mirror the TS
  // shape above as a starting point.
  python: null,

  go: (n) => new RegExp(
    `^(?:func[\\t ]+(?:\\([^)]*\\)[\\t ]+)?${n}\\b` +
    `|type[\\t ]+${n}\\b` +
    `|var[\\t ]+${n}\\b` +
    `|const[\\t ]+${n}\\b)`,
  ),
  rust: (n) => new RegExp(
    `^[\\t ]*(?:pub(?:\\([^)]*\\))?[\\t ]+)?(?:async[\\t ]+)?` +
    `(?:fn[\\t ]+${n}\\b` +
    `|struct[\\t ]+${n}\\b` +
    `|enum[\\t ]+${n}\\b` +
    `|trait[\\t ]+${n}\\b` +
    `|impl[\\t ]+${n}\\b` +
    `|mod[\\t ]+${n}\\b` +
    `|type[\\t ]+${n}\\b` +
    `|(?:const|static)[\\t ]+${n}\\b)`,
  ),
}
DEF_PATTERNS.javascript = DEF_PATTERNS.typescript

const REVIEW_PATHSPEC = ':(exclude).reviews/**'

/**
 * Find where `symbol` is *defined* across the repo at HEAD, then return
 * a window of source lines centred on (a few above, many below) the
 * winning def. Powers the symbol panel's header card — what the user
 * dblclicks may not have its definition in the diff text at all, so a
 * client-side regex over the current view misses it. We do the lookup
 * here once on panel open, cache the result on the session.
 *
 * Strategy: `git grep -nwF` for the exact word, walk results in path/line
 * order, score each line against the file's language def regex. First
 * def-shaped hit wins; fallback to first occurrence anywhere if no
 * language matched. The .reviews/ pathspec is excluded so review-thread
 * JSON doesn't crowd the results when reviewing slop-review itself.
 *
 * Output shape:
 *   { found: true, ref, path, line, lang, is_def, snippet: { start, end, lines, total_lines } }
 *   { found: false, reason: 'no-matches' | 'invalid-symbol' }
 */
export async function findSymbolDefinition(repoPath, symbol, opts = {}) {
  if (!isValidSymbol(symbol)) return { found: false, reason: 'invalid-symbol' }
  const before = Math.max(0, Math.min(20,  Number(opts.before) || 5))
  const after  = Math.max(0, Math.min(200, Number(opts.after)  || 40))

  let grepOut
  try {
    const res = await git(repoPath, [
      'grep', '-n', '-w', '-F', '--no-color', '-I',
      '-e', symbol, 'HEAD',
      '--', '.', REVIEW_PATHSPEC,
    ])
    grepOut = res.stdout
  } catch (e) {
    // `git grep` exits 1 when there are no matches — that's not an error.
    // Anything else (128 for repo errors, signals, etc.) bubbles up.
    if (e && (e.code === 1 || e.code === '1')) return { found: false, reason: 'no-matches' }
    throw e
  }

  // Format: `HEAD:path:lineno:content` — content may itself contain ':',
  // so we slice on the first three colons only.
  let firstAny = null
  let defHit   = null
  for (const raw of grepOut.split('\n')) {
    if (!raw) continue
    const c1 = raw.indexOf(':')
    if (c1 < 0) continue
    const c2 = raw.indexOf(':', c1 + 1)
    if (c2 < 0) continue
    const c3 = raw.indexOf(':', c2 + 1)
    if (c3 < 0) continue
    const path = raw.slice(c1 + 1, c2)
    const lineNo = Number(raw.slice(c2 + 1, c3))
    const content = raw.slice(c3 + 1)
    if (!Number.isFinite(lineNo) || lineNo < 1) continue
    const lang = langForPath(path)
    if (!firstAny) firstAny = { path, line: lineNo, lang }
    const builder = DEF_PATTERNS[lang]
    if (!builder) continue
    const re = builder(symbol)
    if (!re.test(content)) continue
    defHit = { path, line: lineNo, lang }
    break
  }

  const winner = defHit || firstAny
  if (!winner) return { found: false, reason: 'no-matches' }

  const start = Math.max(1, winner.line - before)
  const end   = winner.line + after
  const win = await getFileLines(repoPath, 'HEAD', winner.path, start, end)
  if (win.missing || win.binary) {
    return { found: false, reason: win.binary ? 'binary' : 'missing' }
  }

  return {
    found: true,
    ref: 'HEAD',
    path: winner.path,
    line: winner.line,
    lang: winner.lang,
    is_def: !!defHit,
    snippet: {
      start: win.start,
      end: win.end,
      lines: win.lines,
      total_lines: win.total_lines,
    },
  }
}

/**
 * Get the per-commit diff. Returns the same `files[]` shape as the
 * full/local diff endpoints so the frontend renderer can consume any
 * variant uniformly.
 *
 * Root-commit caveat: `<sha>^!` is the standard "this commit's changes"
 * shorthand and expands to `<sha>^..<sha>` for normal commits. For root
 * commits it silently degrades to single-arg-diff semantics (`<sha>` vs
 * working tree), which is incorrect — both `git rev-parse <root>^!` and
 * `git diff <root>^!` succeed with exit 0 but the diff is meaningless.
 * When the commit has no parents, we explicitly use `<empty-tree>..<sha>`
 * so the root commit renders as all-files-added.
 */
export async function getCommitDiff(repoPath, sha) {
  if (!isValidSha(sha)) throw new Error('invalid sha')

  // Resolve the meta first so we can return it alongside files.
  const SEP = '\x1f'
  const fmt = ['%H', '%h', '%s', '%B', '%an', '%aI', '%P'].join(SEP)
  const { stdout: metaRaw } = await git(repoPath, [
    'show', '--no-patch', `--pretty=format:${fmt}`, sha,
  ])
  const [full_sha, short_sha, headline, message, author, authored_at, parents] = metaRaw.split(SEP)
  const parentList = (parents || '').trim().split(/\s+/).filter(Boolean)

  let range
  if (parentList.length === 0) {
    const { stdout: empty } = await git(repoPath, ['hash-object', '-t', 'tree', '/dev/null'])
    range = `${empty.trim()}..${full_sha}`
  } else {
    range = `${full_sha}^!`
  }
  const files = await getDiffFiles(repoPath, [range])

  // Per-file `is_unchanged_since_commit` powers the commit-view reviewed
  // gate: a file may only be marked reviewed from a commit's view if its
  // blob at that commit equals its blob at HEAD (i.e. no later commit
  // touched it). Two batched ls-tree calls — one at the commit, one at
  // HEAD — let the client decide synchronously on click, with no extra
  // server round trip. For deleted files (absent at both refs) both
  // lookups return null, so the comparison correctly resolves to true.
  const paths = files.map((f) => f.path).filter(Boolean)
  const [commitBlobs, headBlobs] = await Promise.all([
    getBlobShasAt(repoPath, full_sha, paths),
    getBlobShasAt(repoPath, 'HEAD', paths),
  ])
  for (const f of files) {
    const cb = commitBlobs.get(f.path) ?? null
    const hb = headBlobs.get(f.path) ?? null
    f.is_unchanged_since_commit = cb === hb
  }

  return {
    sha: full_sha,
    short_sha,
    headline: headline || '',
    message: message || '',
    author: author || '',
    authored_at: authored_at || '',
    parents: parentList,
    files,
    truncated: false,
  }
}

export async function getFullDiff(repoPath, mergeBase, head) {
  const files = await getDiffFiles(repoPath, [`${mergeBase}..${head}`])
  return {
    sha: head,
    base_ref: mergeBase,
    head_ref: head,
    files,
    truncated: false,
  }
}

/**
 * Local diff = `git diff HEAD` (tracked changes) + `git ls-files --others`
 * for untracked. Untracked are NOT synthesized into add patches; they're
 * surfaced as a banner via `untracked_files`.
 *
 * `.reviews/` is excluded from both sides — slop-review's own thread store
 * isn't user-authored code, and surfacing thread JSONs in the Local view
 * is noise (the threads themselves are visible on the Threads page).
 */
export async function getLocalDiff(repoPath) {
  const files = await getDiffFiles(repoPath, ['HEAD', '--', '.', ':(exclude).reviews/**'])

  let untracked_files = []
  try {
    const { stdout } = await git(repoPath, [
      'ls-files', '--others', '--exclude-standard', '-z',
      '--', '.', ':(exclude).reviews/**',
    ])
    untracked_files = stdout.split('\0').filter(Boolean)
  } catch {}

  let head_sha = null
  let branch = null
  try {
    const { stdout: h } = await git(repoPath, ['rev-parse', 'HEAD'])
    head_sha = h.trim()
  } catch {}
  try {
    const { stdout: b } = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    branch = b.trim()
  } catch {}

  return {
    sha: head_sha,
    branch,
    files,
    untracked_files,
    truncated: false,
  }
}

/**
 * Shared file-list builder for all three diff modes. Combines:
 *   - `git diff --raw --numstat` (status + adds/dels per path)
 *   - `git diff --no-color --no-ext-diff` (the patches themselves)
 *
 * The `extraArgs` is whatever scopes the diff: `["abc..def"]`,
 * `["sha^!"]`, or `["HEAD"]` for staged+unstaged.
 */
async function getDiffFiles(repoPath, extraArgs) {
  // Use --raw -z for path-pair extraction (handles renames cleanly).
  // -M for rename detection.
  const { stdout: rawOut } = await git(repoPath, [
    'diff', '--raw', '-z', '-M', '--no-color', '--no-ext-diff', ...extraArgs,
  ])

  const filesByPath = new Map()
  // --raw -z format: each record is `:mode_old mode_new sha_old sha_new STATUS\0path\0[oldpath\0]`
  // We split on \0 sequentially.
  const tokens = rawOut.split('\0')
  let i = 0
  while (i < tokens.length) {
    const head = tokens[i++]
    if (!head) continue
    if (!head.startsWith(':')) continue
    const parts = head.trim().split(/\s+/)
    const status = (parts[parts.length - 1] || '').toUpperCase()
    let path, previous_path = null
    if (status.startsWith('R') || status.startsWith('C')) {
      previous_path = tokens[i++] || null
      path = tokens[i++] || null
    } else {
      path = tokens[i++] || null
    }
    if (!path) continue
    filesByPath.set(path, {
      path,
      previous_path,
      status: mapStatus(status),
      additions: 0,
      deletions: 0,
      is_binary: false,
      patch: '',
    })
  }

  // Numstat for additions/deletions
  const { stdout: numOut } = await git(repoPath, [
    'diff', '--numstat', '-z', '-M', '--no-color', '--no-ext-diff', ...extraArgs,
  ])
  // numstat -z: each record is `add\tdel\tpath\0`, with rename being
  // `add\tdel\t\0oldpath\0newpath\0`. We parse defensively.
  const numTokens = numOut.split('\0').filter(Boolean)
  for (let j = 0; j < numTokens.length;) {
    const tok = numTokens[j]
    const segs = tok.split('\t')
    if (segs.length < 3) { j++; continue }
    const add = segs[0]
    const del = segs[1]
    let p = segs.slice(2).join('\t')
    if (p === '' && j + 2 < numTokens.length) {
      // rename: oldpath, newpath in the next two tokens
      // skip oldpath, use newpath
      j += 2
      p = numTokens[j]
    }
    j++
    if (!p) continue
    const f = filesByPath.get(p)
    if (!f) continue
    if (add === '-' || del === '-') {
      f.is_binary = true
    } else {
      f.additions = Number(add) || 0
      f.deletions = Number(del) || 0
    }
  }

  // Patch text — one diff output per file. We get the whole thing in one
  // invocation and split by `diff --git` boundaries.
  const { stdout: patchOut } = await git(repoPath, [
    'diff', '-M', '--no-color', '--no-ext-diff', ...extraArgs,
  ])

  if (patchOut.length > 0) {
    const chunks = splitPatch(patchOut)
    for (const chunk of chunks) {
      const path = pathFromDiffHeader(chunk)
      if (!path) continue
      const f = filesByPath.get(path)
      if (!f) continue
      f.patch = chunk
    }
  }

  return [...filesByPath.values()]
}

function splitPatch(text) {
  // Each file's diff begins with `diff --git a/... b/...`. Split there.
  const re = /(^|\n)diff --git /g
  const idxs = []
  let m
  while ((m = re.exec(text)) !== null) {
    // start position of `diff --git ...` (skip the leading \n if any)
    idxs.push(m.index === 0 ? 0 : m.index + 1)
  }
  if (idxs.length === 0) return []
  const out = []
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i]
    const end = i + 1 < idxs.length ? idxs[i + 1] : text.length
    out.push(text.slice(start, end))
  }
  return out
}

function pathFromDiffHeader(chunk) {
  // First line: `diff --git a/<old> b/<new>`. Use the b/ side.
  // Falls back to +++ b/<path> if needed (handles whitespace edge cases).
  const firstLine = chunk.split('\n', 1)[0] || ''
  const m1 = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/)
  if (m1) return m1[2]
  const m2 = chunk.match(/^\+\+\+ b\/(.+)$/m)
  if (m2) return m2[1]
  // /dev/null on +++ side means deletion; use --- a/<path>
  const m3 = chunk.match(/^--- a\/(.+)$/m)
  if (m3) return m3[1]
  return null
}

function mapStatus(s) {
  // git --raw status letters: A added, M modified, D deleted, R rename,
  // C copy, T type-change, U unmerged. Map to the descriptive names the
  // frontend palette + status-glyph table expect.
  const head = s[0] || ''
  switch (head) {
    case 'A': return 'added'
    case 'D': return 'removed'
    case 'M': return 'modified'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'changed'
    case 'U': return 'modified'
    default:  return 'modified'
  }
}
