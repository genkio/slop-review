#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { statSync } from 'node:fs'

// ----------------------------------------------------------------------
// CLI for slop-review. Run inside a git repo — the cwd is auto-bootstrapped
// as the active review target via the SLOP_REVIEW_REPO env var, which
// server/state.js picks up on its first loadState() call.
// ----------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(__dirname, '..')

const args = process.argv.slice(2)

if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(`slop-review — local PR-review loop for human ↔ LLM

Usage:
  slop-review [options]

Run inside a git repository. The current directory is picked up as the
review target automatically. Review threads are stored in <repo>/.reviews/
(add it to .gitignore to keep them local-only).

Options:
  -p, --port <n>      Port to bind (default: first free port in 9410-9419, then any free port)
      --host <h>      Hostname to bind (default: 0.0.0.0)
      --no-open       Don't auto-open the browser
      --carbonyl [<p>], -c [<p>]
                      Open with the carbonyl terminal browser instead of the
                      default browser. With no argument, resolves \`carbonyl\`
                      from PATH (e.g. \`brew install genkio/tap/carbonyl\`).
                      Pass <p> to override with a binary or a directory
                      containing one.
      --sync, -s      Sync unresolved GitHub PR review threads for the current
                      branch into local review threads, then exit (requires the
                      \`gh\` CLI). One-directional: GitHub -> local.
      --browser, -b   Chain after --sync to open the UI in your default browser
                      once the sync finishes, landing on the full diff with the
                      first unresolved thread surfaced (like --carbonyl, but the
                      GUI browser).
      --threads, -t   Open straight into the comment-thread walk on launch
                      (full diff, first unresolved thread surfaced) without
                      syncing. The no-sync counterpart to --sync's resume view;
                      composes with --carbonyl / --browser / --port.
  -h, --help          Show this help
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
// --carbonyl is a hybrid flag: bare `--carbonyl` opts into the terminal
// browser and resolves the binary via PATH (works with the homebrew install
// at `genkio/tap/carbonyl`). `--carbonyl <p>` overrides that with an
// explicit binary or directory, useful for dev builds outside the standard
// PATH. The check `!next.startsWith('-')` is what disambiguates the two
// forms: it treats `--carbonyl --no-open` as bare, not as a path argument.
// `-c` is the short alias for muscle memory; both spellings accept the
// same optional path argument.
let carbonylArg = null
let useCarbonyl = false
const carbonylIdx = (() => {
  const long = args.indexOf('--carbonyl')
  if (long >= 0) return long
  return args.indexOf('-c')
})()
if (carbonylIdx >= 0) {
  useCarbonyl = true
  const next = args[carbonylIdx + 1]
  if (next && !next.startsWith('-')) {
    carbonylArg = next
    args.splice(carbonylIdx, 2)
  } else {
    args.splice(carbonylIdx, 1)
  }
}
const noOpenIdx = args.indexOf('--no-open')
const noOpen = noOpenIdx >= 0
if (noOpen) args.splice(noOpenIdx, 1)

// `--sync` is a one-shot mode handled below (after the git-repo guard, before
// the port dance). Consume it here so the unknown-arg check doesn't reject it.
const syncIdx = (() => {
  const long = args.indexOf('--sync')
  return long >= 0 ? long : args.indexOf('-s')   // `-s`: short alias, like `-c` for --carbonyl
})()
const doSync = syncIdx >= 0
if (doSync) args.splice(syncIdx, 1)

// `--browser` is the GUI-browser counterpart to `--carbonyl` for the
// open-after-sync flow. On its own it matches the default launch (the browser
// opens anyway); its real job is opting `--sync` into opening afterwards.
const browserIdx = (() => {
  const long = args.indexOf('--browser')
  return long >= 0 ? long : args.indexOf('-b')   // `-b`: short alias, like `-c` for --carbonyl
})()
const useBrowser = browserIdx >= 0
if (useBrowser) args.splice(browserIdx, 1)

// `--threads` / `-t` lands the launch on the same resume view `--sync` opens
// (full diff, first unresolved thread surfaced) but skips the GitHub sync, for
// jumping straight back into existing local threads. Composes with the launch
// flags; chained with `--sync` it also keeps the process alive to open after
// the sync (see openAfterSync below).
const threadsIdx = (() => {
  const long = args.indexOf('--threads')
  return long >= 0 ? long : args.indexOf('-t')   // `-t`: short alias, like `-c` for --carbonyl
})()
const doThreads = threadsIdx >= 0
if (doThreads) args.splice(threadsIdx, 1)

// Fail loud on anything left over so typos like `--arbonyl` surface
// immediately instead of silently dropping through to the default-browser
// branch. Positional args (URLs, repo paths, etc.) aren't a thing here:
// slop bootstraps from cwd, so any remaining token is necessarily an
// unrecognized flag.
if (args.length > 0) {
  console.error(`slop-review: unknown argument${args.length === 1 ? '' : 's'}: ${args.join(', ')}`)
  console.error(`Run \`slop-review --help\` for usage.`)
  process.exit(1)
}

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

// --sync is a one-shot: pull unresolved GitHub PR review threads into
// <repo>/.reviews/ and (by default) exit, without binding a port. Placed after
// the git-repo guard (so it shares the same repoRoot resolution) and before
// the port logic. When chained with --browser, --carbonyl, or --threads it
// keeps the process alive afterwards, so the normal server-start + open path
// below launches the UI straight into the synced threads.
if (doSync) {
  const { runSync, formatSyncStats } = await import(join(PACKAGE_ROOT, 'server', 'sync.js'))
  const openAfterSync = useBrowser || useCarbonyl || doThreads
  try {
    const result = await runSync(repoRoot, { log: (m) => process.stdout.write(`${m}\n`) })
    if (result.status === 'ok') {
      process.stdout.write(`${formatSyncStats(result.stats)}\n`)
    } else if (result.status === 'no-pr') {
      // "no PR for this branch" is benign (nothing to sync): stdout, no error.
      process.stdout.write(`slop-review: ${result.message}\n`)
    } else {
      // Hard usage problem (not-github / no-gh / detached): never open.
      console.error(`slop-review: ${result.message}`)
      process.exit(1)
    }
  } catch (e) {
    console.error(`slop-review: sync failed: ${e.message}`)
    process.exit(1)
  }
  // Plain `--sync` ends here; chained with --browser/--carbonyl it falls
  // through to start the server and open the resume view.
  if (!openAfterSync) process.exit(0)
}

// 2. Pick a port. If --port is given, use it (fail loudly if taken). Otherwise
//    walk a small known range (9410-9419), then fall back to a kernel-assigned
//    free port if all are taken. The range shares the common prefix `941` so a
//    single Vimium-style browser-extension exclusion rule keyed to
//    `http://localhost:941*/*` covers every port the range can hand out —
//    across launches and concurrent instances, without re-editing per port.
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
  const RANGE_START = 9410
  const RANGE_END = 9419
  port = null
  for (let p = RANGE_START; p <= RANGE_END; p++) {
    if (await isPortFree(p, hostArg)) { port = p; break }
  }
  if (port == null) port = await findFreePort(hostArg)
}

// 3. Hand off to the server. Setting env vars before the dynamic import
//    is what plumbs the bootstrap repo + port through to state.js + index.js.
process.env.SLOP_REVIEW_REPO = repoRoot
process.env.SLOP_REVIEW_PORT = String(port)

const { start } = await import(join(PACKAGE_ROOT, 'server', 'index.js'))
await start({ port, hostname: hostArg })

// 4. Auto-open the browser. Localhost works regardless of bind host since
//    the server is listening on 0.0.0.0 and we're on the same machine.
//
//    Carbonyl branch: launch the terminal browser foregrounded in this
//    process group with stdio inherited (it needs the TTY for rendering and
//    keyboard input). The slop server keeps running in the same process,
//    sharing the terminal. The default-browser branch stays detached/silent
//    so the user can keep using their shell.
if (!noOpen) {
  // Carbonyl gets a `?carbonyl=1` query so the page can self-identify and
  // load the carbonyl-only CSS shim (see public/carbonyl.css). Hash routing
  // preserves the query across SPA navigation, and a full reload keeps it
  // too, so a single launch-time flag is enough; no UA sniff needed.
  // --sync (when it opens afterwards) and --threads both deep-link to the full
  // diff with the first unresolved thread surfaced (?resume=1, consumed by the
  // diff page). --threads is the no-sync route to that same resume view.
  const resumeHash = (doSync || doThreads) ? '#/diff?resume=1' : ''
  const url = useCarbonyl
    ? `http://localhost:${port}/?carbonyl=1${resumeHash}`
    : `http://localhost:${port}/${resumeHash}`
  if (useCarbonyl) {
    let binary
    if (carbonylArg) {
      binary = carbonylArg
      try {
        const stat = statSync(binary)
        if (stat.isDirectory()) binary = join(binary, 'carbonyl')
      } catch {
        console.error(`slop-review: --carbonyl path not found: ${carbonylArg}`)
        process.exit(1)
      }
    } else {
      // Bare `--carbonyl`: let spawn resolve `carbonyl` via PATH. The error
      // handler below upgrades ENOENT into a friendly "install via brew"
      // hint so users know how to get the binary on PATH.
      binary = 'carbonyl'
    }
    const child = spawn(binary, [url], { stdio: 'inherit' })
    child.on('error', (err) => {
      if (err.code === 'ENOENT' && !carbonylArg) {
        console.error(`slop-review: \`carbonyl\` not found on PATH.`)
        console.error(`Install via \`brew install genkio/tap/carbonyl\`, or pass --carbonyl <path>.`)
        process.exit(1)
      }
      console.error(`slop-review: failed to launch carbonyl (${binary}): ${err.message}`)
    })
    // Tie slop's lifetime to carbonyl's. When the user quits the browser
    // (Ctrl+C in the carbonyl pane), the server should go down with it so
    // a single quit drops the whole stack -- otherwise slop lingers as an
    // orphan and the user has to hunt it down with a second Ctrl+C.
    child.on('exit', (code) => process.exit(code ?? 0))
  } else {
    const cmd =
      process.platform === 'darwin' ? 'open' :
      process.platform === 'win32'  ? 'cmd'  :
                                      'xdg-open'
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
      const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true })
      child.on('error', () => {})  // swallow, fall back to manual click
      child.unref()
    } catch {
      // fall through silently. The URL is already printed by the server
    }
  }
}
