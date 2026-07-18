// Terminal-driven overview generation for `slop-review --overview` (`-o`).
//
// Mirrors the web Overview flow (public/overview-modal.js) without a browser:
// detect the available coding-agent CLIs, let the user pick generators and add
// optional instructions in the terminal, then run the same
// ensureOverviewGeneration job and poll it to completion with live progress.
// The result is cached under <repo>/.reviews/, so the browser the bin shim
// opens afterwards shows the ready overview.

import { multiSelect, promptLine, PROMPT_CANCELLED } from './prompt.js'
import {
  getOverviewStatus,
  ensureOverviewGeneration,
  shutdownAllOverviewJobs,
} from '../server/overview.js'

const TOOL_LABELS = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }
const MAX_ADDITIONAL_PROMPT_LENGTH = 2000
const STATUS_POLL_MS = 1500
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

// Classify by THIS run's per-tool status, not has_content: a regeneration that
// fails keeps the prior document's has_content=true, but for the CLI report it
// still failed this time.
export function summarizeGenerations(requestedTools, generations = {}) {
  const succeeded = requestedTools.filter((tool) => generations[tool]?.status === 'ready')
  const failed = requestedTools.filter((tool) => generations[tool]?.status === 'error')
  return { succeeded, failed }
}

/**
 * Run the interactive overview flow. Returns one of:
 *   'launch' — generation was attempted (any outcome); proceed to open the app
 *   'cancel' — the user aborted the picker/prompt; the bin shim exits quietly
 *   'error'  — nothing could be generated (no diff / no CLI / no TTY)
 * All user-facing messaging happens here via `log`.
 */
export async function runOverviewCli(repoRoot, io = {}) {
  const log = io.log || ((m) => process.stdout.write(`${m}\n`))

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

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log('slop-review: --overview needs an interactive terminal to pick coding agents.')
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

  const answer = await promptLine({
    message: 'Additional instructions (optional, press enter to skip): ',
  })
  if (answer === PROMPT_CANCELLED) {
    log('slop-review: overview cancelled.')
    return 'cancel'
  }
  let additionalPrompt = (answer || '').trim()
  if (additionalPrompt.length > MAX_ADDITIONAL_PROMPT_LENGTH) {
    additionalPrompt = additionalPrompt.slice(0, MAX_ADDITIONAL_PROMPT_LENGTH)
    log(`(instructions trimmed to ${MAX_ADDITIONAL_PROMPT_LENGTH} characters)`)
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
    await ensureOverviewGeneration(repoRoot, {
      force: true,
      requestedTools,
      additionalPrompt,
    })

    const reported = new Set()
    let frame = 0
    let pending = requestedTools.map(toolLabel)
    let sinceFetch = STATUS_POLL_MS   // fetch on the first iteration
    let last = null

    // One loop animates the spinner every SPIN_MS and re-polls status every
    // STATUS_POLL_MS. Keeping both on the same loop avoids a spinner tick
    // interleaving with a just-completed tool's result line.
    while (true) {
      if (sinceFetch >= STATUS_POLL_MS) {
        sinceFetch = 0
        last = await getOverviewStatus(repoRoot)
        const generations = last.generations || {}
        let clearedForReport = false
        for (const tool of requestedTools) {
          const generation = generations[tool]
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
        if (last.status !== 'generating') break
      }
      if (isTTY && pending.length) {
        frame = (frame + 1) % SPINNER.length
        process.stdout.write(`${CLEAR_LINE}${DIM}${SPINNER[frame]} generating ${pending.join(', ')}…${RESET}`)
      }
      await delay(SPIN_MS)
      sinceFetch += SPIN_MS
    }
    clearSpinner()

    const { succeeded } = summarizeGenerations(requestedTools, last?.generations || {})
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
