// Terminal-driven overview generation for `slop-review --overview` (`-o`).
//
// Mirrors the web Overview flow (public/overview-modal.js) without a browser:
// detect the available coding-agent CLIs, let the user pick generators and add
// optional instructions in the terminal, then run the same
// ensureOverviewGeneration job and watch it to completion with live progress.
// The result is cached under <repo>/.reviews/, so the browser the bin shim
// opens afterwards shows the ready overview.
//
// `--agent` / `-a` names the generators up front, which skips both prompts and
// makes the whole run non-interactive (no TTY needed) so it can be chained
// inside a shell function or script. `--prompt` / `-P` supplies the additional
// instructions the interactive flow asks for, so a scripted run can steer the
// generators the same way (e.g. multilingual output).

import { multiSelect, promptLine, PROMPT_CANCELLED } from './prompt.js'
import {
  getOverviewStatus,
  getOverviewJob,
  ensureOverviewGeneration,
  shutdownAllOverviewJobs,
  SUPPORTED_TOOLS,
} from '../server/overview.js'

const TOOL_LABELS = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
const MAX_ADDITIONAL_PROMPT_LENGTH = 2000
const SPIN_MS = 120
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const CLEAR_LINE = '\r\x1b[2K'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function toolLabel(tool) {
  return TOOL_LABELS[tool] || tool
}

function firstLine(text) {
  return (text || '').split('\n')[0].trim()
}

// Build the checkbox choices from a status payload. The suffix carries the CLI
// version plus how the tool fared on the previous run for this snapshot, so a
// re-run shows what would be replaced.
export function buildToolChoices(status) {
  const tools = Array.isArray(status?.available_tools) ? status.available_tools : []
  const versions = {
    codex: status?.codex_version,
    claude: status?.claude_version,
    opencode: status?.opencode_version,
  }
  return tools.map((tool) => {
    const generation = status?.generations?.[tool]
    const prior = generation?.status === 'error'
      ? 'previously failed'
      : (generation?.has_content ? 'previously generated' : '')
    const suffix = [versions[tool], prior].filter(Boolean).join(' · ')
    return { value: tool, label: toolLabel(tool), suffix }
  })
}

// Same fallback wording as the web modal's unavailableReason.
export function unavailableReason(status) {
  const parts = []
  if (status?.codex_error) parts.push(status.codex_error)
  if (status?.claude_error) parts.push(status.claude_error)
  if (status?.opencode_error) parts.push(status.opencode_error)
  return parts.join(' ') || 'No supported CLI (Codex, Claude Code, or OpenCode) is available on PATH.'
}

// `-a codex -a claude` and `-a codex,claude` request the same pair. Names match
// case-insensitively; unrecognized ones come back in `unknown` so the caller can
// report a typo instead of silently generating with fewer agents.
export function parseAgents(values = []) {
  const tools = []
  const unknown = []
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const name = part.trim().toLowerCase()
      if (!name) continue
      const bucket = SUPPORTED_TOOLS.includes(name) ? tools : unknown
      if (!bucket.includes(name)) bucket.push(name)
    }
  }
  return { tools, unknown }
}

// Why a named agent couldn't run: prefer the probe's own error (wrong PATH,
// broken install) over a generic "not on PATH", then point at what is usable.
export function missingAgentReason(status, missing) {
  const details = missing.map((tool) => (
    status?.[`${tool}_error`] || `${toolLabel(tool)} is not available on PATH.`
  ))
  const available = (status?.available_tools || []).map(toolLabel)
  return details.join(' ') + (available.length ? ` Available: ${available.join(', ')}.` : '')
}

// Classify by THIS run's per-tool status, not has_content: a regeneration that
// fails keeps the prior document's has_content=true, but for the CLI report it
// still failed this time.
export function summarizeGenerations(requestedTools, generations = {}) {
  const succeeded = requestedTools.filter((tool) => generations[tool]?.status === 'ready')
  const failed = requestedTools.filter((tool) => generations[tool]?.status === 'error')
  return { succeeded, failed }
}

// The web route rejects an over-long additional_prompt with a 400; the CLI has
// nobody to hand that error back to mid-run, so it trims and says so instead.
export function normalizeAdditionalPrompt(value, log) {
  const prompt = (value || '').trim()
  if (prompt.length <= MAX_ADDITIONAL_PROMPT_LENGTH) return prompt
  log?.(`(instructions trimmed to ${MAX_ADDITIONAL_PROMPT_LENGTH} characters)`)
  return prompt.slice(0, MAX_ADDITIONAL_PROMPT_LENGTH)
}

/**
 * Run the overview flow. With `options.agents` (from `--agent`) it is
 * non-interactive: no picker, no instructions prompt, no TTY required.
 * `options.additionalPrompt` (from `--prompt`) supplies the instructions
 * either path would otherwise ask for. Returns one of:
 *   'launch' — generation was attempted (any outcome); proceed to open the app
 *   'cancel' — the user aborted the picker/prompt; the bin shim exits quietly
 *   'error'  — nothing could be generated (no diff / no CLI / no TTY / bad agent)
 * All user-facing messaging happens here via `log`.
 */
export async function runOverviewCli(repoRoot, options = {}) {
  const log = options.log || ((m) => process.stdout.write(`${m}\n`))

  const suppliedPrompt = normalizeAdditionalPrompt(options.additionalPrompt, log)

  const { tools: agents, unknown } = parseAgents(options.agents || [])
  if (unknown.length) {
    log(`slop-review: unknown agent${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (supported: ${SUPPORTED_TOOLS.join(', ')})`)
    return 'error'
  }

  let status
  try {
    status = await getOverviewStatus(repoRoot)
  } catch (e) {
    log(`slop-review: could not inspect the branch for an overview: ${e.message}`)
    return 'error'
  }

  if (!status.can_generate) {
    log(`slop-review: can't generate an overview - ${status.reason || 'nothing to review on this branch.'}`)
    return 'error'
  }

  const choices = buildToolChoices(status)
  if (!choices.length) {
    log(`slop-review: ${unavailableReason(status)}`)
    return 'error'
  }

  if (agents.length) {
    const missing = agents.filter((tool) => !(status.available_tools || []).includes(tool))
    if (missing.length) {
      log(`slop-review: ${missingAgentReason(status, missing)}`)
      return 'error'
    }
    log(`Branch overview · ${status.branch || 'current branch'}`)
    log(`Generators: ${agents.map(toolLabel).join(', ')}`)
    if (suppliedPrompt) log(`Instructions: ${firstLine(suppliedPrompt)}`)
    await generateOverview(repoRoot, agents, suppliedPrompt, log)
    return 'launch'
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log('slop-review: --overview needs an interactive terminal to pick coding agents. Pass --agent <name> to run without prompts.')
    return 'error'
  }

  log(`Branch overview · ${status.branch || 'current branch'}`)
  const selected = await multiSelect({
    message: 'Pick one or more coding agents (they run concurrently):',
    choices,
    hint: '↑/↓ move · space toggle · a all · enter generate · esc cancel',
  })
  if (selected === PROMPT_CANCELLED) {
    log('slop-review: overview cancelled.')
    return 'cancel'
  }
  log(`Generators: ${selected.map(toolLabel).join(', ')}`)

  // `--prompt` already answered this; asking again would just invite a
  // conflicting second answer.
  let additionalPrompt = suppliedPrompt
  if (additionalPrompt) {
    log(`Instructions: ${firstLine(additionalPrompt)}`)
  } else {
    const answer = await promptLine({
      message: 'Additional instructions (optional, press enter to skip): ',
    })
    if (answer === PROMPT_CANCELLED) {
      log('slop-review: overview cancelled.')
      return 'cancel'
    }
    additionalPrompt = normalizeAdditionalPrompt(answer, log)
  }

  await generateOverview(repoRoot, selected, additionalPrompt, log)
  return 'launch'
}

async function generateOverview(repoRoot, requestedTools, additionalPrompt, log) {
  // Overview jobs spawn child agent processes inside THIS process. Wire a
  // teardown so Ctrl-C during the (multi-minute) run kills codex/claude/
  // opencode instead of orphaning them. Removed once generation settles, so
  // the server's own handlers own the launched session.
  const onSignal = () => {
    try { shutdownAllOverviewJobs() } catch {}
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const isTTY = process.stdout.isTTY
  const clearSpinner = () => { if (isTTY) process.stdout.write(CLEAR_LINE) }

  try {
    const started = await ensureOverviewGeneration(repoRoot, {
      force: true,
      requestedTools,
      additionalPrompt,
    })
    // The job runs in this process, so watch it directly rather than re-reading
    // status from disk (see getOverviewJob). No job means generation never
    // started; report from the state we got back.
    const job = getOverviewJob(repoRoot, started.branch_id)
    const generations = () => (job ? job.generations : started.generations) || {}

    const reported = new Set()
    let frame = 0
    let pending = requestedTools.map(toolLabel)
    // Piped (`-a` in a script): no spinner, so announce the wait once instead
    // of leaving stdout silent for the whole multi-minute run.
    if (job && !isTTY) log(`generating ${pending.join(', ')}…`)

    let settled = !job
    job?.promise.then(() => { settled = true }, () => { settled = true })

    // One loop animates the spinner and reports each tool the moment it flips to
    // ready/error. The report runs before the spinner tick so a result line
    // never interleaves with a half-drawn spinner.
    while (true) {
      let clearedForReport = false
      for (const tool of requestedTools) {
        const generation = generations()[tool]
        if (!generation || reported.has(tool)) continue
        if (generation.status === 'ready' || generation.status === 'error') {
          reported.add(tool)
          if (!clearedForReport) { clearSpinner(); clearedForReport = true }
          if (generation.status === 'ready') {
            log(`  ${GREEN}✓${RESET} ${toolLabel(tool)}`)
          } else {
            log(`  ${RED}✗${RESET} ${toolLabel(tool)}: ${firstLine(generation.error) || 'generation failed'}`)
          }
        }
      }
      pending = requestedTools.filter((tool) => !reported.has(tool)).map(toolLabel)
      // Settled is checked after reporting so the final results always print.
      if (settled) break
      if (isTTY && pending.length) {
        frame = (frame + 1) % SPINNER.length
        process.stdout.write(`${CLEAR_LINE}${DIM}${SPINNER[frame]} generating ${pending.join(', ')}…${RESET}`)
      }
      await delay(SPIN_MS)
    }
    clearSpinner()

    const { succeeded } = summarizeGenerations(requestedTools, generations())
    if (succeeded.length) {
      log(`Overview ready: ${succeeded.map(toolLabel).join(', ')}.`)
    } else {
      log('slop-review: overview generation failed for every selected agent.')
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}
