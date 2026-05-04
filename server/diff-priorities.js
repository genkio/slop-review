import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

const pExecFile = promisify(execFile)

/**
 * Review-priority ordering for diff files. Ports the algorithm from
 * github.com/robzolkos/pi-slopchop PR #2 (commit 49a795a, "feat: improve
 * all-files navigator"): order changed files so reviewers land on the
 * structurally-central edits first instead of alphabetical.
 *
 * Sort key (descending priority):
 *   1. reference count — how many OTHER changed files import this one
 *      (centrality within the diff, not within the project)
 *   2. status rank   — modified/renamed (0) → added (1) → removed (2)
 *   3. support rank  — source files (0) before tests/docs/changesets (1)
 *   4. path          — alphabetical fallback
 *
 * Reference graph is built by extracting import specifiers from each
 * changed file's content via two regexes (static `from "X"` + dynamic
 * `import|require("X")`) and resolving relative specifiers against the
 * changed-file set. Aliases handle bare-extension imports (`./foo` →
 * `./foo.ts`) and index-file imports (`./bar` → `./bar/index.ts`).
 *
 * Local-only: contents come from `git show <sha>:<path>` for commit-
 * anchored views (full PR diff) or the worktree filesystem for the
 * local-diff view. No `gh api` calls — faster and more reliable than the
 * REST `/contents` endpoint for the volumes typical of a PR review.
 */

const STATUS_RANK = {
  modified: 0, renamed: 0, changed: 0, copied: 0,
  added:    1,
  removed:  2, deleted: 2,
}

// Slopchop's support-file regexes, with `.json` added: configs and fixtures
// shouldn't crowd source files. Renderable code-config (e.g. tsconfig) loses
// little from being de-prioritized — reviewers usually look at the .ts that
// reads it first.
const SUPPORT_PATTERNS = [
  /(^|\/)(\.changeset|docs?|tests?|__tests__|__mocks__|fixtures?)(\/|$)/,
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(md|mdx|txt|ya?ml|json|toml|lock)$/,
]

function statusRank(status) {
  return STATUS_RANK[status] ?? 3
}

function supportRank(path) {
  const lower = String(path || '').toLowerCase()
  for (const re of SUPPORT_PATTERNS) {
    if (re.test(lower)) return 1
  }
  return 0
}

function normalizeGitPath(p) {
  if (!p) return ''
  return posix.normalize(p).replace(/^\.\//, '')
}

// Two patterns cover JS/TS/CJS imports + dynamic imports.
//   - `import|export ... from "X"` (static + re-exports + type-only)
//   - `import|require("X")`        (dynamic ESM + CommonJS)
// We don't try to be a parser — false positives in strings are rare in
// import-shaped contexts, and a wrong edge in the graph just shifts a
// file's rank by one slot, not its bucket. Cheap & resilient beats clever.
function extractImportSpecifiers(content) {
  if (!content) return []
  const out = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      if (m[1]) out.push(m[1])
    }
  }
  return out
}

// Build alias → canonical-path lookup:
//   - the path itself
//   - the path with extension stripped (e.g. `foo/bar.ts` → `foo/bar`)
//   - if the file is an index-file, its directory (e.g. `foo/index.ts` → `foo`)
// This is the minimum needed to resolve common TS/JS import shapes against
// the changed-file set without doing real module resolution.
function buildAliasMap(paths) {
  const aliases = new Map()
  for (const p of paths) {
    const n = normalizeGitPath(p)
    if (!n || aliases.has(n)) {
      aliases.set(n, n) // canonical points to self
      continue
    }
    aliases.set(n, n)
    const ext = posix.extname(n)
    if (ext) {
      const noExt = n.slice(0, -ext.length)
      if (!aliases.has(noExt)) aliases.set(noExt, n)
    }
    const dir = posix.dirname(n)
    const base = posix.basename(n, ext)
    if (base === 'index' && dir !== '.' && !aliases.has(dir)) {
      aliases.set(dir, n)
    }
  }
  return aliases
}

function resolveRelativeImport(sourcePath, specifier, aliases) {
  if (!specifier.startsWith('.')) return null
  const joined = posix.join(posix.dirname(sourcePath), specifier)
  const resolved = normalizeGitPath(joined)
  return aliases.get(resolved) ?? null
}

/**
 * Build the reference graph among changed files. Returns:
 *   counts:   Map<path, number>           — incoming edges (centrality)
 *   outgoing: Map<path, string[] sorted>  — what this file imports
 *   incoming: Map<path, string[] sorted>  — what imports this file
 *
 * Only **relative** specifiers are considered. Non-relative imports
 * (`@scope/pkg`, `lodash`, alias paths) are ignored — they're either
 * external deps or mapped through tooling we'd need to read configs for.
 * Relative imports inside a PR's own changes are dense enough that
 * skipping the rest still produces meaningful centrality scores.
 */
export function buildReferenceGraph(files, contentsByPath) {
  const paths    = files.map((f) => normalizeGitPath(f.path)).filter(Boolean)
  const pathSet  = new Set(paths)
  const aliases  = buildAliasMap(paths)
  const counts   = new Map(paths.map((p) => [p, 0]))
  const outgoing = new Map(paths.map((p) => [p, new Set()]))
  const incoming = new Map(paths.map((p) => [p, new Set()]))

  for (const file of files) {
    const sourcePath = normalizeGitPath(file.path)
    if (!pathSet.has(sourcePath)) continue
    const content = contentsByPath.get(file.path) ?? contentsByPath.get(sourcePath)
    if (!content) continue
    const seen = new Set()
    for (const spec of extractImportSpecifiers(content)) {
      const resolved = resolveRelativeImport(sourcePath, spec, aliases)
      if (!resolved || resolved === sourcePath) continue
      if (!pathSet.has(resolved) || seen.has(resolved)) continue
      seen.add(resolved)
      counts.set(resolved, (counts.get(resolved) ?? 0) + 1)
      outgoing.get(sourcePath)?.add(resolved)
      incoming.get(resolved)?.add(sourcePath)
    }
  }

  const toSortedArrays = (m) => new Map(
    [...m.entries()].map(([k, set]) => [k, [...set].sort((a, b) => a.localeCompare(b))])
  )
  return { counts, outgoing: toSortedArrays(outgoing), incoming: toSortedArrays(incoming) }
}

/**
 * Combine reference graph + status/support ranks into a per-path map the
 * client can sort against. Output shape:
 *   { [path]: { ref_count, outgoing[], incoming[], status_rank, support_rank } }
 * Path keys are the original `file.path` strings so the client can index
 * them directly without re-normalizing.
 */
export function buildPriorities(files, contentsByPath) {
  const graph = buildReferenceGraph(files, contentsByPath)
  const out = {}
  for (const f of files) {
    const norm = normalizeGitPath(f.path)
    out[f.path] = {
      ref_count:    graph.counts.get(norm) ?? 0,
      outgoing:     graph.outgoing.get(norm) || [],
      incoming:     graph.incoming.get(norm) || [],
      status_rank:  statusRank(f.status),
      support_rank: supportRank(f.path),
    }
  }
  return out
}

/**
 * Read each path's content at `sha` from a local git repo. Returns
 * Map<path, string|null> — null indicates a read failure (missing in
 * this rev, oversized, binary, or the SHA isn't fetched locally yet).
 *
 * Bounded parallelism: spawning N git subprocesses at once would thrash
 * the kernel's process table on large PRs. 8 in flight is enough to
 * saturate disk on any modern machine without flooding it.
 *
 * Fail-soft per-file: a missing read leaves the entry as null and the
 * graph treats that file as "imports nothing we know about" — its
 * centrality score is whatever other files' imports add to it. The sort
 * still works, the file just lands lower than it might otherwise.
 */
export async function readPathsAtSha(repoRoot, sha, paths, { concurrency = 8 } = {}) {
  const out = new Map(paths.map((p) => [p, null]))
  if (!repoRoot || !sha || !paths.length) return out

  let cursor = 0
  const worker = async () => {
    while (cursor < paths.length) {
      const idx = cursor++
      const p = paths[idx]
      try {
        const { stdout } = await pExecFile(
          'git',
          ['-C', repoRoot, 'show', `${sha}:${p}`],
          { timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }
        )
        out.set(p, stdout)
      } catch {
        // Silent — null is the documented failure signal.
      }
    }
  }
  const lanes = Math.min(concurrency, paths.length)
  await Promise.all(Array.from({ length: lanes }, worker))
  return out
}

/**
 * Read each path's content from a worktree's filesystem. Used by the
 * local-diff path — those changes haven't been committed so there's no
 * SHA to anchor to; the working tree IS the source.
 */
export async function readPathsFromWorktree(worktreePath, paths, { concurrency = 16 } = {}) {
  const out = new Map(paths.map((p) => [p, null]))
  if (!worktreePath || !paths.length) return out

  let cursor = 0
  const worker = async () => {
    while (cursor < paths.length) {
      const idx = cursor++
      const p = paths[idx]
      try {
        out.set(p, await readFile(join(worktreePath, p), 'utf8'))
      } catch {
        // Silent — same fail-soft contract as readPathsAtSha.
      }
    }
  }
  const lanes = Math.min(concurrency, paths.length)
  await Promise.all(Array.from({ length: lanes }, worker))
  return out
}

// Pre-filter: skip files we wouldn't extract imports from anyway. Saves
// one read per binary/removed/oversized file.
function readableFiles(files) {
  return files.filter((f) => f && f.path && !f.is_binary && f.status !== 'removed')
}

/**
 * Compute priorities for a commit-anchored view (full PR diff or per-commit
 * diff). `repoRoot` can be the gtreea worktree or the configured root —
 * git's object store is shared, so either works as long as `sha` is fetched.
 *
 * Returns null on hard failure (no repoRoot, no sha, or readPathsAtSha
 * threw). Callers treat null as "ship the diff without sort metadata" —
 * the modal falls back to GitHub's order, which is what users see today.
 */
export async function computePrioritiesAtSha(repoRoot, sha, files) {
  if (!repoRoot || !sha || !files?.length) return null
  try {
    const candidates = readableFiles(files).map((f) => f.path)
    const contents   = await readPathsAtSha(repoRoot, sha, candidates)
    return buildPriorities(files, contents)
  } catch {
    return null
  }
}

/**
 * Compute priorities for the local-diff view (worktree ← HEAD). Reads the
 * working-tree files directly — no SHA, no `git show`, no fetch needed.
 * Untracked files aren't surfaced in `files[]` (they get a banner instead),
 * so we don't read them; the graph captures only tracked changes.
 */
export async function computePrioritiesForWorktree(worktreePath, files) {
  if (!worktreePath || !files?.length) return null
  try {
    const candidates = readableFiles(files).map((f) => f.path)
    const contents   = await readPathsFromWorktree(worktreePath, candidates)
    return buildPriorities(files, contents)
  } catch {
    return null
  }
}
