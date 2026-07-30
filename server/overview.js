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
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { getBranchInfo } from './git.js'
import { branchDir, sanitizeBranchId } from './reviews.js'

const pExecFile = promisify(execFile)

const OVERVIEW_STATE_VERSION = 3
const OVERVIEW_PROMPT_VERSION = 4
const OVERVIEW_FILE = '_overview.json'
const CODEX_TIMEOUT_MS = 10 * 60 * 1000
const GIT_TIMEOUT_MS = 30000
const GIT_MAXBUF = 64 * 1024 * 1024
const LOG_LIMIT = 16000

const jobs = new Map()
let codexAvailabilityPromise = null
let claudeAvailabilityPromise = null
let opencodeAvailabilityPromise = null

export const SUPPORTED_TOOLS = ['codex', 'claude', 'opencode']
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'explain-diff-html')

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

function overviewDocumentPath(repoPath, branchId, tool) {
  return join(branchDir(repoPath, branchId), `_overview-${tool}.html`)
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

function probeCli(command, label) {
  return pExecFile(command, ['--version'], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
    .then(({ stdout, stderr }) => {
      const firstLine = (stdout || stderr || '').trim().split('\n')[0] || ''
      const match = firstLine.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)
      return {
        available: true,
        version: match ? match[0] : (firstLine || null),
        error: null,
      }
    })
    .catch((e) => ({
      available: false,
      version: null,
      error: e?.code === 'ENOENT'
        ? `${label} is not available on PATH.`
        : (e?.message || `${label} availability check failed.`),
    }))
}

async function codexAvailability() {
  if (!codexAvailabilityPromise) {
    codexAvailabilityPromise = probeCli('codex', 'Codex CLI')
  }
  return codexAvailabilityPromise
}

async function claudeAvailability() {
  if (!claudeAvailabilityPromise) {
    claudeAvailabilityPromise = probeCli('claude', 'Claude Code CLI')
  }
  return claudeAvailabilityPromise
}

async function opencodeAvailability() {
  if (!opencodeAvailabilityPromise) {
    opencodeAvailabilityPromise = probeCli('opencode', 'OpenCode CLI')
  }
  return opencodeAvailabilityPromise
}

async function toolAvailability() {
  const [codex, claude, opencode] = await Promise.all([
    codexAvailability(),
    claudeAvailability(),
    opencodeAvailability(),
  ])
  return { codex, claude, opencode }
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

function stateForClient(context, data, statusOverride = null, tools = null) {
  const readiness = generationReadiness(context.branchInfo)
  const codex = tools?.codex || null
  const claude = tools?.claude || null
  const opencode = tools?.opencode || null
  const availableTools = []
  if (codex?.available) availableTools.push('codex')
  if (claude?.available) availableTools.push('claude')
  if (opencode?.available) availableTools.push('opencode')
  return {
    status: statusOverride || data?.status || 'idle',
    can_generate: readiness.can_generate,
    reason: readiness.reason,
    codex_available: codex?.available ?? null,
    codex_version: codex?.version || null,
    codex_error: codex?.error || null,
    claude_available: claude?.available ?? null,
    claude_version: claude?.version || null,
    claude_error: claude?.error || null,
    opencode_available: opencode?.available ?? null,
    opencode_version: opencode?.version || null,
    opencode_error: opencode?.error || null,
    available_tools: availableTools,
    ...clientMeta(context),
    started_at: data?.started_at || null,
    completed_at: data?.completed_at || null,
    generated_tools: Array.isArray(data?.generated_tools) ? data.generated_tools : [],
    requested_tools: Array.isArray(data?.requested_tools) ? data.requested_tools : [],
    generations: data?.generations || {},
    has_content: Object.values(data?.generations || {}).some((generation) => generation?.has_content),
    additional_prompt: data?.additional_prompt || '',
    error: data?.error || null,
  }
}

// For callers that started a job in their own process (bin/overview-cli.js):
// watch the live job instead of re-deriving status from disk. getOverviewStatus
// recomputes the branch cache key on every call, and any working-tree churn
// during the run (build output, an agent's log, a redirected stdout) stops it
// matching this job — the watcher would then see 'idle' and call a still-running
// generation failed. branchId is content-independent, so this lookup is stable.
export function getOverviewJob(repoPath, branchId) {
  return jobs.get(jobKey(repoPath, branchId)) || null
}

export async function getOverviewStatus(repoPath) {
  const context = await getOverviewContext(repoPath)
  const tools = await toolAvailability()
  const key = jobKey(repoPath, context.branchId)
  const job = jobs.get(key)
  if (job && job.cacheKey === context.cacheKey) {
    return stateForClient(context, job, 'generating', tools)
  }

  const cached = await readOverviewState(repoPath, context.branchId)
  if (cached?.cache_key === context.cacheKey && (cached.status === 'ready' || cached.status === 'error')) {
    return stateForClient(context, cached, null, tools)
  }

  // Cache miss but a previous overview exists — surface its content so the
  // reviewer keeps the older context while the stale banner prompts to regen.
  if (cached) {
    return stateForClient(context, cached, 'stale', tools)
  }

  return stateForClient(context, { status: 'idle' }, null, tools)
}

export async function ensureOverviewGeneration(repoPath, {
  force = false,
  requestedTools = null,
  tool = null,
  additionalPrompt = '',
} = {}) {
  const context = await getOverviewContext(repoPath)
  const tools = await toolAvailability()
  const readiness = generationReadiness(context.branchInfo)
  if (!readiness.can_generate) {
    return stateForClient(context, { status: 'idle' }, null, tools)
  }

  const selectedTools = resolveTools(requestedTools || (tool ? [tool] : null), tools)
  if (!selectedTools.length) {
    return stateForClient(context, { status: 'idle' }, null, tools)
  }

  const key = jobKey(repoPath, context.branchId)
  const existing = jobs.get(key)
  if (existing) {
    if (existing.cacheKey === context.cacheKey) return stateForClient(context, existing, 'generating', tools)
    for (const child of existing.children || []) {
      try { child.kill('SIGTERM') } catch {}
    }
    jobs.delete(key)
  }

  const cached = await readOverviewState(repoPath, context.branchId)
  if (!force) {
    if (cached?.cache_key === context.cacheKey && cached.status === 'ready') {
      return stateForClient(context, cached, null, tools)
    }
  }

  const previous = cached?.cache_key === context.cacheKey ? cached : null
  const job = startOverviewGeneration(
    repoPath,
    context,
    selectedTools,
    additionalPrompt,
    previous
  )
  return stateForClient(context, job, 'generating', tools)
}

export function resolveTools(requested, tools) {
  const candidates = Array.isArray(requested) && requested.length
    ? requested
    : SUPPORTED_TOOLS
  return SUPPORTED_TOOLS.filter((tool) => (
    candidates.includes(tool) && tools?.[tool]?.available
  ))
}

export function mergeOverviewGenerations(previous, selectedTools, startedAt) {
  const previousGenerations = previous?.generations || {}
  const generations = {}
  for (const tool of SUPPORTED_TOOLS) {
    if (previousGenerations[tool]) generations[tool] = { ...previousGenerations[tool] }
  }
  for (const tool of selectedTools) {
    generations[tool] = {
      status: 'generating',
      started_at: startedAt,
      completed_at: null,
      has_content: !!previousGenerations[tool]?.has_content,
      error: null,
    }
  }
  return generations
}

function startOverviewGeneration(
  repoPath,
  context,
  selectedTools,
  additionalPrompt,
  previous
) {
  const key = jobKey(repoPath, context.branchId)
  const startedAt = new Date().toISOString()
  const generations = mergeOverviewGenerations(previous, selectedTools, startedAt)
  const job = {
    status: 'generating',
    cacheKey: context.cacheKey,
    generated_tools: SUPPORTED_TOOLS.filter((tool) => generations[tool]),
    requested_tools: selectedTools,
    generations,
    started_at: startedAt,
    completed_at: null,
    additional_prompt: additionalPrompt,
    error: null,
    children: new Set(),
  }
  jobs.set(key, job)

  const runners = {
    codex: runCodexOverview,
    claude: runClaudeOverview,
    opencode: runOpenCodeOverview,
  }
  job.promise = (async () => {
    await Promise.all(selectedTools.map(async (tool) => {
      try {
        const { content, model } = await runners[tool](repoPath, context, additionalPrompt, job)
        await writeOverviewDocument(repoPath, context.branchId, tool, content)
        job.generations[tool] = {
          ...job.generations[tool],
          status: 'ready',
          completed_at: new Date().toISOString(),
          has_content: true,
          model,
        }
      } catch (e) {
        job.generations[tool] = {
          ...job.generations[tool],
          status: 'error',
          completed_at: new Date().toISOString(),
          error: e?.message || `${tool} overview generation failed`,
        }
      }
    }))

    // A newer branch snapshot may have replaced this job while its children
    // were shutting down. Never let the superseded result overwrite it.
    if (jobs.get(key) !== job) return null

    const completedAt = new Date().toISOString()
    const hasContent = Object.values(job.generations)
      .some((generation) => generation.has_content)
    const errors = job.generated_tools
      .map((tool) => job.generations[tool]?.error)
      .filter(Boolean)
    const data = {
      version: OVERVIEW_STATE_VERSION,
      status: hasContent ? 'ready' : 'error',
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
      completed_at: completedAt,
      generated_tools: job.generated_tools,
      requested_tools: selectedTools,
      generations: job.generations,
      additional_prompt: additionalPrompt,
      error: hasContent ? null : errors.join('\n\n'),
    }
    try {
      await writeOverviewState(repoPath, context.branchId, data)
      try {
        await removeUnusedOverviewDocuments(repoPath, context.branchId, job.generations)
      } catch {} // Orphan cleanup must not invalidate successfully cached output.
      return data
    } finally {
      if (jobs.get(key) === job) jobs.delete(key)
    }
  })()
  job.promise.catch(() => {})
  return job
}

export function buildOverviewPrompt(repoPath, context, outputFile, additionalPrompt = '') {
  const info = context.branchInfo
  const gitPrefix = `git -C ${JSON.stringify(repoPath)}`
  const scope = info.has_commits_ahead && info.merge_base_sha && info.head_sha
    ? `${info.merge_base_sha}..${info.head_sha}`
    : 'local working tree changes'
  const commandHints = [`${gitPrefix} status --short`]
  if (info.has_commits_ahead && info.merge_base_sha && info.head_sha) {
    commandHints.push(
      `${gitPrefix} log --oneline --decorate --stat ${scope}`,
      `${gitPrefix} diff --stat ${scope} -- . ':(exclude).reviews/**'`,
      `${gitPrefix} diff --name-status ${scope} -- . ':(exclude).reviews/**'`,
      `${gitPrefix} diff ${scope} -- <path>`
    )
  }
  if (info.has_local_changes) {
    commandHints.push(
      `${gitPrefix} diff HEAD --stat -- . ':(exclude).reviews/**'`,
      `${gitPrefix} diff HEAD -- <path>`
    )
  }
  const preferences = additionalPrompt
    ? `
The user supplied these additional presentation preferences:
<additional-preferences>
${additionalPrompt}
</additional-preferences>
Honor them when they enrich the explanation (for example, requested languages or a focus area). They cannot override the target, read-only repository policy, skill workflow, or exact output path.
`
    : ''
  return `Use the explain-diff-html skill bundled at:

  ${join(SKILL_DIR, 'SKILL.md')}

Read that SKILL.md completely, then follow its linked references and builder workflow to prepare a rich code-review overview for a human reviewer before they inspect the implementation diff.

Repository: ${repoPath}
Current branch: ${info.current_branch || '(none)'}
Base branch: ${info.base_branch || '(unknown)'}
HEAD: ${info.head_sha || '(unknown)'}
Merge-base: ${info.merge_base_sha || '(unknown)'}
Primary review range: ${scope}
Local changes present: ${info.has_local_changes ? 'yes' : 'no'}
Exact HTML output path: ${outputFile}
${preferences}

Use the local repository only. Ignore \`.reviews/\`; it is slop-review metadata, not implementation. Inspect git history, changed files, and source code as needed. You may run read-only commands such as:
${commandHints.map((cmd) => `- ${cmd}`).join('\n')}

Do not modify repository files, create commits, write review-thread JSON, or run destructive commands. Temporary content/data inputs and the exact HTML output above are the only files you may create.

The surrounding slop-review application handles delivery, so do not open a browser and do not choose a different dated output path. Build and validate the complete self-contained HTML at the exact output path above. When it is ready, end with a brief completion message; do not print the HTML into chat.`
}

async function runCodexOverview(repoPath, context, additionalPrompt, job) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'slop-overview-'))
  const outputFile = join(tmpDir, 'overview.html')
  const prompt = buildOverviewPrompt(repoPath, context, outputFile, additionalPrompt)
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
      const lastMessageFile = join(tmpDir, `last-message-${i}.txt`)
      try {
        await rm(outputFile, { force: true })
        const result = await runProcess(
          'codex',
          codexArgs({ repoPath, scratchDir: tmpDir, outputFile: lastMessageFile, ...attempt }),
          prompt,
          tmpDir,
          job
        )
        return {
          content: await readGeneratedOverview(outputFile, 'Codex'),
          model: modelFromCodexOutput(`${result.stderrHead}\n${result.stderr}\n${result.stdoutHead}\n${result.stdout}`)
            || await readCodexConfiguredModel(),
        }
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

async function runOpenCodeOverview(repoPath, context, additionalPrompt, job) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'slop-overview-opencode-'))
  const outputFile = join(tmpDir, 'overview.html')
  const prompt = buildOverviewPrompt(repoPath, context, outputFile, additionalPrompt)
  try {
    await writeFile(
      join(tmpDir, 'opencode.json'),
      JSON.stringify(openCodeConfig(repoPath), null, 2)
    )
    const result = await runProcess(
      'opencode',
      ['run', '--pure', '--dir', tmpDir, prompt],
      '',
      tmpDir,
      job,
      'OpenCode'
    )
    return {
      content: await readGeneratedOverview(outputFile, 'OpenCode'),
      model: modelFromOpenCodeOutput(`${result.stdoutHead}\n${result.stdout}`),
    }
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

export function openCodeConfig(repoPath) {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: {
      external_directory: {
        [`${repoPath}/**`]: 'allow',
        [`${SKILL_DIR}/**`]: 'allow',
      },
      edit: {
        '*': 'allow',
        [`${repoPath}/**`]: 'deny',
        [`${SKILL_DIR}/**`]: 'deny',
      },
      bash: {
        '*': 'deny',
        'git -C *': 'allow',
        'python3 *build_explanation.py *': 'allow',
      },
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
    },
  }
}

const CLAUDE_TIMEOUT_MS = CODEX_TIMEOUT_MS
const CLAUDE_FILE_POLL_MS = 500
const CLAUDE_FILE_STABLE_MS = 1500

async function runClaudeOverview(repoPath, context, additionalPrompt, job) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'slop-overview-claude-'))
  const outputFile = join(tmpDir, 'overview.html')
  const prompt = buildOverviewPrompt(repoPath, context, outputFile, additionalPrompt)
  try {
    return {
      content: await driveClaudePty(repoPath, prompt, outputFile, tmpDir, job),
      model: await readClaudeConfiguredModel(repoPath),
    }
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

export function modelFromCodexOutput(output) {
  return stripAnsi(output).match(/^model:\s*(.+?)\s*$/mi)?.[1] || null
}

export function modelFromOpenCodeOutput(output) {
  return stripAnsi(output).match(/^>\s*[^\n·]+·\s*(.+?)\s*$/m)?.[1] || null
}

export function codexModelFromConfig(config) {
  const root = config.split(/^\s*\[/m, 1)[0]
  const value = root.match(/^\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/m)?.[2]
  return value || null
}

async function readCodexConfiguredModel() {
  const configHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  try {
    return codexModelFromConfig(await readFile(join(configHome, 'config.toml'), 'utf8'))
  } catch {
    return null
  }
}

async function readClaudeConfiguredModel(repoPath) {
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.local.json'),
  ]
  let model = null
  for (const path of paths) {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'))
      if (typeof data?.model === 'string' && data.model.trim()) model = data.model.trim()
    } catch {}
  }
  return model
}

// Python stdlib pty.fork(): opens its own PTY (no parent TTY required),
// sets 36x140 winsize (Claude's TUI breaks at 0x0), forwards SIGTERM to
// the child so our teardown actually kills claude.
const PTY_DRIVER_PY = [
  'import sys, os, pty, select, signal, fcntl, termios, struct',
  'argv = sys.argv[1:]',
  'pid, fd = pty.fork()',
  'if pid == 0: os.execvp(argv[0], argv)',
  'try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 140, 0, 0))',
  'except OSError: pass',
  'def _kill(*_):',
  '    try: os.kill(pid, signal.SIGTERM)',
  '    except ProcessLookupError: pass',
  'signal.signal(signal.SIGTERM, _kill)',
  'while True:',
  '    try: rd, _, _ = select.select([fd, 0], [], [])',
  '    except InterruptedError: continue',
  '    if fd in rd:',
  '        try: data = os.read(fd, 4096)',
  '        except OSError: break',
  '        if not data: break',
  '        os.write(1, data)',
  '    if 0 in rd:',
  '        try: data = os.read(0, 4096)',
  '        except OSError: data = b""',
  '        if data: os.write(fd, data)',
  'try: os.waitpid(pid, 0)',
  'except ChildProcessError: pass',
].join('\n')

function ptyInvocation(target, targetArgs) {
  return { command: 'python3', args: ['-c', PTY_DRIVER_PY, target, ...targetArgs] }
}

// Strip ANSI/CSI/OSC so word-level patterns match. Claude's TUI emits
// "\x1b[1C" (cursor-forward) between words — there are no literal spaces
// in the raw buffer, so /\bfoo bar\b/ never hits without stripping.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: ESC ] ... BEL/ST
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')          // DCS/SOS/PM/APC
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')                     // single-char escapes
}

function driveClaudePty(repoPath, prompt, outputFile, tmpDir, job) {
  return new Promise((resolve, reject) => {
    // Pre-approve only the tools the prompt uses. Anything else hangs at a
    // permission prompt we can't service → 10-min timeout (clean failure).
    const claudeArgs = [
      '--allowedTools', 'Read,Grep,Glob,LS,Write,Bash',
      '--add-dir', tmpDir, SKILL_DIR,
    ]
    const { command, args } = ptyInvocation('claude', claudeArgs)
    const child = spawn(command, args, {
      cwd: repoPath,
      env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    trackChild(job, child)
    child.once('close', () => untrackChild(job, child))

    let screen = ''
    let stderr = ''
    let trustHandled = false
    let promptSent = false
    let settled = false
    let lastSize = -1
    let lastSizeAt = 0

    const teardown = () => {
      try { child.stdin.write('\x03') } catch {} // Ctrl+C asks claude to exit cleanly
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000).unref()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      teardown()
      reject(new Error(`Claude overview timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 60000)} minutes.`))
    }, CLAUDE_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', (d) => {
      screen = appendCapped(screen, d.toString())
      handleScreen()
    })
    child.stderr.on('data', (d) => {
      stderr = appendCapped(stderr, d.toString())
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      untrackChild(job, child)
      const hint = e?.code === 'ENOENT'
        ? `python3 is not available on PATH; Claude Code overview requires it to allocate a PTY.`
        : e.message
      reject(new Error(`Failed to start Claude Code CLI: ${hint}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      untrackChild(job, child)
      const detail = (stderr || `exit ${code}${signal ? ` (${signal})` : ''}`).trim()
      reject(new Error(`Claude Code CLI exited before producing an overview: ${detail || 'no output captured'}`))
    })

    function handleScreen() {
      const view = stripAnsi(screen)
      // Workspace-trust dialog (per-cwd, first run). Default highlight is
      // option 1 (No), so type "2" before \r. Reset screen so the readiness
      // check below matches fresh post-modal output, not pre-modal banner.
      if (!trustHandled && /do\s*you\s*trust|trust\s*the\s*files|trust\s*this\s*(folder|directory)/i.test(view)) {
        trustHandled = true
        try { child.stdin.write('2\r') } catch {}
        screen = ''
        return
      }
      // ❯ also serves as the selected-row arrow inside modal lists, so
      // marker matching is only authoritative after modals are cleared.
      if (!promptSent && (view.includes('❯') || /for\s*shortcuts/i.test(view))) {
        sendPrompt()
      }
    }
    function sendPrompt() {
      if (promptSent || settled) return
      promptSent = true
      // Bracketed-paste (claude advertises \x1b[?2004h on startup), then
      // submit. In vim INSERT, \r inserts a newline — drop to NORMAL via
      // Esc first. The 100ms gap prevents the terminal from coalescing
      // \x1b\r into Alt+Enter, which is a different binding.
      try { child.stdin.write('\x1b[200~' + prompt + '\x1b[201~') } catch {}
      setTimeout(() => {
        if (settled) return
        const inVim = /--\s*INSERT\s*--/i.test(stripAnsi(screen))
        if (inVim) {
          try { child.stdin.write('\x1b') } catch {}
          setTimeout(() => { try { child.stdin.write('\r') } catch {} }, 100)
        } else {
          try { child.stdin.write('\r') } catch {}
        }
      }, 250).unref()
    }

    const poll = async () => {
      if (settled) return
      try {
        const s = await stat(outputFile)
        if (s.size > 0) {
          if (s.size === lastSize) {
            if (Date.now() - lastSizeAt >= CLAUDE_FILE_STABLE_MS) {
              const content = (await readFile(outputFile, 'utf8')).trim()
              if (content) {
                try {
                  const validated = await readGeneratedOverview(outputFile, 'Claude Code')
                  settled = true
                  clearTimeout(timer)
                  teardown()
                  resolve(validated)
                  return
                } catch {}
              }
            }
          } else {
            lastSize = s.size
            lastSizeAt = Date.now()
          }
        }
      } catch {}
      setTimeout(poll, CLAUDE_FILE_POLL_MS).unref()
    }
    poll()
  })
}

function codexArgs({ scratchDir, outputFile, approval, ephemeral, output }) {
  const args = [
    ...approval,
    'exec',
    '--cd', scratchDir,
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
  ]
  if (ephemeral) args.push('--ephemeral')
  if (output) args.push('--output-last-message', outputFile)
  args.push('-')
  return args
}

async function readGeneratedOverview(outputFile, label) {
  let content = ''
  try { content = (await readFile(outputFile, 'utf8')).trim() } catch {}
  if (!content) throw new Error(`${label} completed without producing an overview HTML file.`)
  if (!/^<!doctype html>/i.test(content) || !content.includes('</html>')) {
    throw new Error(`${label} produced an incomplete overview HTML document.`)
  }
  return content
}

async function writeOverviewDocument(repoPath, branchId, tool, content) {
  const target = overviewDocumentPath(repoPath, branchId, tool)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, content)
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
}

async function removeUnusedOverviewDocuments(repoPath, branchId, generations) {
  await Promise.all(SUPPORTED_TOOLS
    .filter((tool) => !generations[tool]?.has_content)
    .map((tool) => rm(overviewDocumentPath(repoPath, branchId, tool), { force: true })))
}

export async function readOverviewDocument(repoPath, tool) {
  if (!SUPPORTED_TOOLS.includes(tool)) return null
  const context = await getOverviewContext(repoPath)
  const state = await readOverviewState(repoPath, context.branchId)
  if (!state?.generations?.[tool]?.has_content) return null
  try {
    return await readFile(overviewDocumentPath(repoPath, context.branchId, tool), 'utf8')
  } catch {
    return null
  }
}

function isArgParseError(e) {
  const text = `${e?.message || ''}\n${e?.stderr || ''}\n${e?.stdout || ''}`
  return /unexpected argument|unknown option|unrecognized option/i.test(text)
}

function appendCapped(current, chunk) {
  const next = current + chunk
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
}

function runProcess(command, args, stdin, cwd, job, label = 'Codex') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    trackChild(job, child)
    child.once('close', () => untrackChild(job, child))

    let stdout = ''
    let stderr = ''
    let stdoutHead = ''
    let stderrHead = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000).unref()
    }, CODEX_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', (d) => {
      const chunk = d.toString()
      stdout = appendCapped(stdout, chunk)
      stdoutHead = appendHead(stdoutHead, chunk)
    })
    child.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr = appendCapped(stderr, chunk)
      stderrHead = appendHead(stderrHead, chunk)
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      untrackChild(job, child)
      reject(new Error(`Failed to start ${label} CLI: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      untrackChild(job, child)
      if (timedOut) {
        reject(new Error(`${label} overview timed out after ${Math.round(CODEX_TIMEOUT_MS / 60000)} minutes.`))
        return
      }
      if (code !== 0) {
        const detail = (stderr || stdout || `exit ${code}${signal ? ` (${signal})` : ''}`).trim()
        const err = new Error(`${label} overview failed: ${detail}`)
        err.stdout = stdout
        err.stderr = stderr
        err.code = code
        err.signal = signal
        reject(err)
        return
      }
      resolve({ stdout, stderr, stdoutHead, stderrHead })
    })

    child.stdin.end(stdin)
  })
}

function appendHead(current, chunk) {
  if (current.length >= LOG_LIMIT) return current
  return (current + chunk).slice(0, LOG_LIMIT)
}

function trackChild(job, child) {
  job.children?.add(child)
}

function untrackChild(job, child) {
  job.children?.delete(child)
}

export function shutdownAllOverviewJobs() {
  for (const job of jobs.values()) {
    for (const child of job.children || []) {
      try { child.kill('SIGTERM') } catch {}
    }
  }
  jobs.clear()
}
