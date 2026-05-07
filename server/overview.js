import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { getBranchInfo } from './git.js'
import { branchDir, sanitizeBranchId } from './reviews.js'

const pExecFile = promisify(execFile)

const OVERVIEW_STATE_VERSION = 1
const OVERVIEW_PROMPT_VERSION = 3
const OVERVIEW_FILE = '_overview.json'
const CODEX_TIMEOUT_MS = 10 * 60 * 1000
const GIT_TIMEOUT_MS = 30000
const GIT_MAXBUF = 64 * 1024 * 1024
const LOG_LIMIT = 16000

const jobs = new Map()
let codexAvailabilityPromise = null

function sha1(value) {
  return createHash('sha1').update(value).digest('hex')
}

async function git(repoPath, args, opts = {}) {
  return pExecFile('git', ['-C', repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAXBUF,
    encoding: 'utf8',
    ...opts,
  })
}

function overviewPath(repoPath, branchId) {
  return join(branchDir(repoPath, branchId), OVERVIEW_FILE)
}

function jobKey(repoPath, branchId) {
  return `${repoPath}\0${branchId}`
}

function clientMeta(context) {
  const info = context.branchInfo
  return {
    cache_key: context.cacheKey,
    prompt_version: OVERVIEW_PROMPT_VERSION,
    branch_id: context.branchId,
    branch: info.current_branch,
    base_branch: info.base_branch,
    base_sha: info.base_sha,
    merge_base_sha: info.merge_base_sha,
    head_sha: info.head_sha,
    has_local_changes: !!info.has_local_changes,
    has_commits_ahead: !!info.has_commits_ahead,
  }
}

function generationReadiness(info) {
  if (!info?.head_sha) {
    return { can_generate: false, reason: 'No HEAD commit found in this repository.' }
  }
  if (info.detached) {
    return { can_generate: false, reason: 'Detached HEAD. Checkout a branch and refresh.' }
  }
  if (!info.has_commits_ahead && !info.has_local_changes) {
    const base = info.base_branch ? ` of ${info.base_branch}` : ''
    return { can_generate: false, reason: `No feature-branch commits or local changes ahead${base}.` }
  }
  if (!info.merge_base_sha && !info.has_local_changes) {
    return {
      can_generate: false,
      reason: "Can't detect a merge-base. Set origin/HEAD or make local changes, then refresh.",
    }
  }
  return { can_generate: true, reason: null }
}

async function codexAvailability() {
  if (!codexAvailabilityPromise) {
    codexAvailabilityPromise = pExecFile('codex', ['--version'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    })
      .then(({ stdout, stderr }) => ({
        available: true,
        version: (stdout || stderr || '').trim().split('\n')[0] || null,
        error: null,
      }))
      .catch((e) => ({
        available: false,
        version: null,
        error: e?.code === 'ENOENT'
          ? 'Codex CLI is not available on PATH.'
          : (e?.message || 'Codex CLI availability check failed.'),
      }))
  }
  return codexAvailabilityPromise
}

async function localChangeFingerprint(repoPath) {
  let trackedDiffHash = null
  let trackedDiffError = null
  try {
    const { stdout } = await git(repoPath, [
      'diff', 'HEAD', '--no-color', '--no-ext-diff',
      '--', '.', ':(exclude).reviews/**',
    ])
    trackedDiffHash = sha1(stdout)
  } catch (e) {
    trackedDiffError = e?.message || 'git diff failed'
  }

  let untracked = []
  try {
    const { stdout } = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z'])
    const names = stdout.split('\0').filter((name) => (
      name && name !== '.reviews' && !name.startsWith('.reviews/')
    ))
    untracked = await Promise.all(names.map(async (path) => {
      try {
        const s = await stat(join(repoPath, path))
        return { path, size: s.size, mtime_ms: Math.trunc(s.mtimeMs) }
      } catch {
        return { path, missing: true }
      }
    }))
    untracked.sort((a, b) => a.path.localeCompare(b.path))
  } catch {}

  return {
    tracked_diff_hash: trackedDiffHash,
    tracked_diff_error: trackedDiffError,
    untracked,
  }
}

export async function getOverviewContext(repoPath) {
  const branchInfo = await getBranchInfo(repoPath)
  const branchId = sanitizeBranchId(branchInfo.current_branch || 'detached')
  const local = branchInfo.has_local_changes ? await localChangeFingerprint(repoPath) : null
  const cacheKey = sha1(JSON.stringify({
    prompt_version: OVERVIEW_PROMPT_VERSION,
    branch: branchInfo.current_branch || null,
    base_sha: branchInfo.base_sha || null,
    merge_base_sha: branchInfo.merge_base_sha || null,
    head_sha: branchInfo.head_sha || null,
    has_commits_ahead: !!branchInfo.has_commits_ahead,
    has_local_changes: !!branchInfo.has_local_changes,
    local,
  }))

  return { branchInfo, branchId, cacheKey, local }
}

async function readOverviewState(repoPath, branchId) {
  const target = overviewPath(repoPath, branchId)
  if (!existsSync(target)) return null
  try {
    const data = JSON.parse(await readFile(target, 'utf8'))
    if (data?.version !== OVERVIEW_STATE_VERSION) return null
    return data
  } catch {
    return null
  }
}

async function writeOverviewState(repoPath, branchId, data) {
  const target = overviewPath(repoPath, branchId)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(data, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
}

function stateForClient(context, data, statusOverride = null, codex = null) {
  const readiness = generationReadiness(context.branchInfo)
  return {
    status: statusOverride || data?.status || 'idle',
    can_generate: readiness.can_generate,
    reason: readiness.reason,
    codex_available: codex?.available ?? null,
    codex_version: codex?.version || null,
    codex_error: codex?.error || null,
    ...clientMeta(context),
    started_at: data?.started_at || null,
    completed_at: data?.completed_at || null,
    content: data?.content || '',
    error: data?.error || null,
  }
}

export async function getOverviewStatus(repoPath) {
  const context = await getOverviewContext(repoPath)
  const codex = await codexAvailability()
  const key = jobKey(repoPath, context.branchId)
  const job = jobs.get(key)
  if (job && job.cacheKey === context.cacheKey) {
    return stateForClient(context, job, 'generating', codex)
  }

  const cached = await readOverviewState(repoPath, context.branchId)
  if (cached?.cache_key === context.cacheKey && (cached.status === 'ready' || cached.status === 'error')) {
    return stateForClient(context, cached, null, codex)
  }

  // Cache miss but a previous overview exists — surface its content so the
  // reviewer keeps the older context while the stale banner prompts to regen.
  if (cached) {
    return stateForClient(context, cached, 'stale', codex)
  }

  const readiness = generationReadiness(context.branchInfo)
  return {
    status: 'idle',
    can_generate: readiness.can_generate,
    reason: readiness.reason,
    codex_available: codex.available,
    codex_version: codex.version,
    codex_error: codex.error,
    ...clientMeta(context),
    started_at: null,
    completed_at: null,
    content: '',
    error: null,
  }
}

export async function ensureOverviewGeneration(repoPath, { force = false } = {}) {
  const context = await getOverviewContext(repoPath)
  const codex = await codexAvailability()
  const readiness = generationReadiness(context.branchInfo)
  if (!readiness.can_generate) {
    return stateForClient(context, { status: 'idle' }, null, codex)
  }
  if (!codex.available) {
    return stateForClient(context, { status: 'idle' }, null, codex)
  }

  const key = jobKey(repoPath, context.branchId)
  const existing = jobs.get(key)
  if (existing) {
    if (existing.cacheKey === context.cacheKey) return stateForClient(context, existing, 'generating', codex)
    try { existing.child?.kill('SIGTERM') } catch {}
    jobs.delete(key)
  }

  if (!force) {
    const cached = await readOverviewState(repoPath, context.branchId)
    if (cached?.cache_key === context.cacheKey && cached.status === 'ready') {
      return stateForClient(context, cached, null, codex)
    }
  }

  const job = startOverviewGeneration(repoPath, context)
  return stateForClient(context, job, 'generating', codex)
}

function startOverviewGeneration(repoPath, context) {
  const key = jobKey(repoPath, context.branchId)
  const startedAt = new Date().toISOString()
  const job = {
    status: 'generating',
    cacheKey: context.cacheKey,
    started_at: startedAt,
    completed_at: null,
    content: '',
    error: null,
    child: null,
  }
  jobs.set(key, job)

  job.promise = (async () => {
    try {
      const content = await runCodexOverview(repoPath, buildOverviewPrompt(repoPath, context), job)
      const data = {
        version: OVERVIEW_STATE_VERSION,
        status: 'ready',
        cache_key: context.cacheKey,
        prompt_version: OVERVIEW_PROMPT_VERSION,
        branch_id: context.branchId,
        branch: context.branchInfo.current_branch,
        base_branch: context.branchInfo.base_branch,
        base_sha: context.branchInfo.base_sha,
        merge_base_sha: context.branchInfo.merge_base_sha,
        head_sha: context.branchInfo.head_sha,
        has_local_changes: !!context.branchInfo.has_local_changes,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        content,
        error: null,
      }
      await writeOverviewState(repoPath, context.branchId, data)
      return data
    } catch (e) {
      const data = {
        version: OVERVIEW_STATE_VERSION,
        status: 'error',
        cache_key: context.cacheKey,
        prompt_version: OVERVIEW_PROMPT_VERSION,
        branch_id: context.branchId,
        branch: context.branchInfo.current_branch,
        base_branch: context.branchInfo.base_branch,
        base_sha: context.branchInfo.base_sha,
        merge_base_sha: context.branchInfo.merge_base_sha,
        head_sha: context.branchInfo.head_sha,
        has_local_changes: !!context.branchInfo.has_local_changes,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        content: '',
        error: e?.message || 'Overview generation failed',
      }
      await writeOverviewState(repoPath, context.branchId, data)
      return data
    } finally {
      if (jobs.get(key) === job) jobs.delete(key)
    }
  })()
  job.promise.catch(() => {})
  return job
}

export function buildOverviewPrompt(repoPath, context) {
  const info = context.branchInfo
  const scope = info.has_commits_ahead && info.merge_base_sha && info.head_sha
    ? `${info.merge_base_sha}..${info.head_sha}`
    : 'local working tree changes'
  const commandHints = ['git status --short']
  if (info.has_commits_ahead && info.merge_base_sha && info.head_sha) {
    commandHints.push(
      `git log --oneline --decorate --stat ${scope}`,
      `git diff --stat ${scope} -- . ':(exclude).reviews/**'`,
      `git diff --name-status ${scope} -- . ':(exclude).reviews/**'`,
      `git diff ${scope} -- <path>`
    )
  }
  if (info.has_local_changes) {
    commandHints.push(
      "git diff HEAD --stat -- . ':(exclude).reviews/**'",
      'git diff HEAD -- <path>'
    )
  }
  return `You are preparing a high-level code-review overview for a human reviewer before they inspect the implementation diff.

Repository: ${repoPath}
Current branch: ${info.current_branch || '(none)'}
Base branch: ${info.base_branch || '(unknown)'}
HEAD: ${info.head_sha || '(unknown)'}
Merge-base: ${info.merge_base_sha || '(unknown)'}
Primary review range: ${scope}
Local changes present: ${info.has_local_changes ? 'yes' : 'no'}

Use the local repository only. Ignore \`.reviews/\`; it is slop-review metadata, not implementation. Inspect git history, changed files, and source code as needed. You may run read-only commands such as:
${commandHints.map((cmd) => `- ${cmd}`).join('\n')}

Do not modify files, create commits, write review-thread JSON, or run destructive commands. This is an orientation pass, not a full code review.

Write the final answer as Markdown only, with this exact structure and no extra sections:

# Overview

## What Changed
- 3 to 5 bullets explaining the feature-level change.
- Prefer subsystem-level explanation over file-by-file inventory.
- Mention at most 4 file paths in this section.

## Mental Model
One or two short paragraphs explaining how the changed pieces fit together. This should be the easiest part for a reviewer to digest before opening the diff. Explain why each mentioned component matters. Mention at most 4 file paths here.

## Before vs After Behavior
- Contrast behavior before and after this branch at a high level.
- Focus on observable behavior, API/data shape, validation, persistence, workflow, CLI/config, or user-facing behavior.
- Use 3 to 6 bullets in the form "Before: ... / After: ...".
- If the branch mostly adds internal structure with little runtime behavior change, say that directly and describe the new review-relevant assumptions.

## Sketch
\`\`\`json
{
  "nodes": [
    { "id": "short-id", "label": "Short label", "detail": "Optional short detail" }
  ],
  "edges": [
    ["from-id", "to-id"]
  ]
}
\`\`\`

Sketch rules:
- Use 3 to 6 nodes.
- Use 2 to 7 edges.
- Node ids must be lowercase letters, numbers, underscores, or hyphens.
- Labels should be 1 to 4 words.
- Details should be 3 to 8 words.
- Model the conceptual flow, dependency flow, or request/data flow that best explains the change.

Do not produce an exhaustive file inventory. Do not include Review Path, Risk Areas, Verification, Contract Changes, or Change Map. Keep the prose concise, roughly 350-650 words. Do not praise the change. Do not invent intent that is not supported by the code.`
}

async function runCodexOverview(repoPath, prompt, job) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'slop-overview-'))
  try {
    const attempts = [
      { approval: ['--ask-for-approval', 'never'], ephemeral: true, output: true },
      { approval: ['--approval-policy', 'never'], ephemeral: true, output: true },
      { approval: [], ephemeral: true, output: true },
      { approval: ['--approval-policy', 'never'], ephemeral: false, output: true },
      { approval: [], ephemeral: false, output: true },
      { approval: [], ephemeral: false, output: false },
    ]

    let lastError = null
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]
      const outputFile = join(tmpDir, `overview-${i}.md`)
      try {
        const { stdout } = await runProcess(
          'codex',
          codexArgs({ repoPath, outputFile, ...attempt }),
          prompt,
          repoPath,
          job
        )
        let content = ''
        if (attempt.output) {
          try { content = await readFile(outputFile, 'utf8') } catch {}
        }
        content = content.trim() || stdout.trim()
        if (!content) throw new Error('Codex completed without producing an overview.')
        return content
      } catch (e) {
        lastError = e
        if (!isArgParseError(e)) throw e
      }
    }
    throw lastError || new Error('Codex overview failed.')
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

function codexArgs({ repoPath, outputFile, approval, ephemeral, output }) {
  const args = [
    ...approval,
    'exec',
    '--cd', repoPath,
    '--sandbox', 'read-only',
  ]
  if (ephemeral) args.push('--ephemeral')
  if (output) args.push('--output-last-message', outputFile)
  args.push('-')
  return args
}

function isArgParseError(e) {
  const text = `${e?.message || ''}\n${e?.stderr || ''}\n${e?.stdout || ''}`
  return /unexpected argument|unknown option|unrecognized option/i.test(text)
}

function appendCapped(current, chunk) {
  const next = current + chunk
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
}

function runProcess(command, args, stdin, cwd, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    job.child = child

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000).unref()
    }, CODEX_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', (d) => { stdout = appendCapped(stdout, d.toString()) })
    child.stderr.on('data', (d) => { stderr = appendCapped(stderr, d.toString()) })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to start Codex CLI: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`Codex overview timed out after ${Math.round(CODEX_TIMEOUT_MS / 60000)} minutes.`))
        return
      }
      if (code !== 0) {
        const detail = (stderr || stdout || `exit ${code}${signal ? ` (${signal})` : ''}`).trim()
        const err = new Error(`Codex overview failed: ${detail}`)
        err.stdout = stdout
        err.stderr = stderr
        err.code = code
        err.signal = signal
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })

    child.stdin.end(stdin)
  })
}

export function shutdownAllOverviewJobs() {
  for (const job of jobs.values()) {
    try { job.child?.kill('SIGTERM') } catch {}
  }
  jobs.clear()
}
