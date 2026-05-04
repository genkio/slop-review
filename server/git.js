import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

  try {
    await git(repoPath, ['diff', '--quiet', 'HEAD'])
  } catch (e) {
    // exit 1 => has changes; other codes => unrelated error
    if (e?.code === 1) out.has_local_changes = true
  }
  if (!out.has_local_changes) {
    try {
      const { stdout: untracked } = await git(repoPath, [
        'ls-files', '--others', '--exclude-standard', '-z',
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
 * Get the per-commit diff. Returns the same `files[]` shape as taiou's
 * diff endpoints so the frontend's diff modal can consume it uniformly.
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

  const files = await getDiffFiles(repoPath, [`${sha}^!`])
  return {
    sha: full_sha,
    short_sha,
    headline: headline || '',
    message: message || '',
    author: author || '',
    authored_at: authored_at || '',
    parents: (parents || '').trim().split(/\s+/).filter(Boolean),
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
 */
export async function getLocalDiff(repoPath) {
  const files = await getDiffFiles(repoPath, ['HEAD'])

  let untracked_files = []
  try {
    const { stdout } = await git(repoPath, [
      'ls-files', '--others', '--exclude-standard', '-z',
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
  // C copy, T type-change, U unmerged. Map to descriptive names matching
  // taiou's vocabulary so the frontend palette mapping carries over.
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
