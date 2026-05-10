#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

// ----------------------------------------------------------------------
// CLI for slop-review. Run inside a git repo — the cwd is auto-bootstrapped
// as the active review target via the SLOP_REVIEW_REPO env var, which
// server/state.js picks up on its first loadState() call.
// ----------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(__dirname, '..')

// The slop-review Claude Code skill is installed via the `skills` npm package
// (`npx skills add genkio/slop-review`). At server startup we just check
// whether it's already there and nudge the user if not — the actual install
// is delegated to the canonical tooling.
const GLOBAL_SKILL_PATH = join(homedir(), '.claude', 'skills', 'slop-review', 'SKILL.md')

const args = process.argv.slice(2)

if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(`slop-review — local PR-review loop for human ↔ LLM

Usage:
  slop-review [options]

Run inside a git repository. The current directory is picked up as the
review target automatically. Review threads are stored in <repo>/.reviews/
(add it to .gitignore to keep them local-only).

Options:
  -p, --port <n>   Port to bind (default: 4919, falling back to a free port)
      --host <h>   Hostname to bind (default: 0.0.0.0)
      --no-open    Don't auto-open the browser
  -h, --help       Show this help

To enable AI-assisted reviewing (Claude Code, Cursor, etc.) install the
slop-review skill once:

  npx skills add genkio/slop-review
`)
  process.exit(0)
}

function takeArg(name) {
  const i = args.indexOf(name)
  if (i < 0 || i === args.length - 1) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

const portArg = takeArg('--port') || takeArg('-p')
const hostArg = takeArg('--host') || '0.0.0.0'
const noOpen = args.includes('--no-open')

// 1. Verify cwd is inside a git repo, and resolve to the worktree root so
//    `.reviews/` always sits next to the user's `.git/`.
let repoRoot
try {
  repoRoot = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  console.error(`slop-review: not a git repository: ${process.cwd()}`)
  console.error(`Run inside a git checkout, or run \`git init\` first.`)
  process.exit(1)
}

// 2. Pick a port. If --port is given, use it (fail loudly if taken). Otherwise
//    try the default (4919) and fall back to a kernel-assigned free port.
async function isPortFree(port, host) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, host)
  })
}

async function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, host, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

let port
if (portArg) {
  port = Number(portArg)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`slop-review: invalid --port: ${portArg}`)
    process.exit(1)
  }
  if (!(await isPortFree(port, hostArg))) {
    console.error(`slop-review: port ${port} is in use`)
    process.exit(1)
  }
} else {
  const preferred = 4919
  port = (await isPortFree(preferred, hostArg)) ? preferred : await findFreePort(hostArg)
}

// 3. Hand off to the server. Setting env vars before the dynamic import
//    is what plumbs the bootstrap repo + port through to state.js + index.js.
process.env.SLOP_REVIEW_REPO = repoRoot
process.env.SLOP_REVIEW_PORT = String(port)

const { start } = await import(join(PACKAGE_ROOT, 'server', 'index.js'))
await start({ port, hostname: hostArg })

// 3a. Skill-install nudge. Best-effort + non-blocking. Only show the tip if
//     the user is actually running Claude Code (~/.claude/skills/ exists as
//     a dir) AND the slop-review skill isn't there yet. The recommended
//     install path is the `skills` npm package (Vercel Labs), which auto-
//     discovers our `skills/slop-review/SKILL.md` layout.
try {
  const claudeSkillsRoot = join(homedir(), '.claude', 'skills')
  if (existsSync(claudeSkillsRoot) && statSync(claudeSkillsRoot).isDirectory()
      && !existsSync(GLOBAL_SKILL_PATH)) {
    process.stdout.write(
      `\ntip: install the slop-review skill to enable AI-assisted reviewing:\n` +
      `       npx skills add genkio/slop-review\n`
    )
  }
} catch {
  // Best-effort — never block startup on a missing home dir / permission issue.
}

// 4. Auto-open the browser. Localhost works regardless of bind host since
//    the server is listening on 0.0.0.0 and we're on the same machine.
if (!noOpen) {
  const url = `http://localhost:${port}/`
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'cmd'  :
                                    'xdg-open'
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true })
    child.on('error', () => {})  // swallow — fall back to manual click
    child.unref()
  } catch {
    // fall through silently — the URL is already printed by the server
  }
}
