#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer, connect } from 'node:net'
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
                      \`gh\` CLI). One-directional: GitHub -> local. When chained
                      with --browser/--carbonyl/--threads to open the UI, it
                      keeps re-syncing every 5 minutes until you quit (Ctrl-C
                      stops the loop along with slop-review).
      --browser, -b   Chain after --sync to open the UI in your default browser
                      once the sync finishes, landing on the full diff with the
                      first unresolved thread surfaced (like --carbonyl, but the
                      GUI browser).
      --threads, -t   Open straight into the comment-thread walk on launch
                      (full diff, first unresolved thread surfaced) without
                      syncing. The no-sync counterpart to --sync's resume view;
                      composes with --carbonyl / --browser / --port.
      --overview, -o  Generate the branch overview from the terminal before
                      launching: detect the available coding-agent CLIs, pick
                      generators and add optional instructions interactively,
                      run them, then open the UI on the ready overview. Needs
                      an interactive terminal. Composes with the launch flags.
      --agent <name>, -a <name>
                      Name the overview generator(s) instead of picking them
                      interactively (codex, claude, opencode). Repeatable and
                      comma-separated: \`-a codex -a claude\` == \`-a codex,claude\`.
                      Implies --overview and skips both prompts, so the run
                      needs no TTY and can be chained inside a script.
      --detach, -d    Leave the server running in a background process and exit
                      once it answers, instead of holding the terminal. The
                      browser still opens. Chains as
                      \`slop-review -o -a opencode -d && next-command\`: waits for
                      generation to finish, then the UI stays up while the next
                      command runs. Prints the pid to \`kill\` when you're done.
                      Not compatible with --carbonyl.
      --kill, -k      Stop the slop-review server(s) running for this repo, then
                      exit without launching. The teardown counterpart to
                      --detach; also stops a foreground session started in
                      another terminal. Exits 0 when nothing is running.
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

// `--overview` / `-o` runs the interactive overview flow (pick coding agents +
// optional instructions, generate, show progress) right before the normal
// launch, so the browser opens on a ready overview. Handled after the git-repo
// guard; generation needs no port, so it runs ahead of the port dance.
const overviewIdx = (() => {
  const long = args.indexOf('--overview')
  return long >= 0 ? long : args.indexOf('-o')   // `-o`: short alias, like `-c` for --carbonyl
})()
const wantOverview = overviewIdx >= 0
if (wantOverview) args.splice(overviewIdx, 1)

// `--agent` / `-a` names the generators up front, which makes --overview
// non-interactive (no picker, no instructions prompt, no TTY needed) so it can
// be chained inside a shell function. Repeatable, and each occurrence also
// accepts a comma-separated list; validation of the names happens in
// runOverviewCli, next to the CLI-availability probe. Naming an agent is a
// request to generate, so it implies --overview on its own.
const agentArgs = []
for (const flag of ['--agent', '-a']) {
  let i
  while ((i = args.indexOf(flag)) >= 0) {
    const value = args[i + 1]
    if (!value || value.startsWith('-')) {
      console.error(`slop-review: ${flag} needs an agent name (codex, claude, opencode)`)
      process.exit(1)
    }
    agentArgs.push(value)
    args.splice(i, 2)
  }
}
const doOverview = wantOverview || agentArgs.length > 0

// `--detach` / `-d` hands the server off to a background process and gives the
// shell its prompt back, so `slop -o -a opencode -d && next-command` blocks on
// generation (the exit code gates the chain) but leaves the UI serving while the
// next command runs. Incompatible with --carbonyl, which needs this terminal.
const detachIdx = (() => {
  const long = args.indexOf('--detach')
  return long >= 0 ? long : args.indexOf('-d')   // `-d`: short alias, like `-c` for --carbonyl
})()
const doDetach = detachIdx >= 0
if (doDetach) args.splice(detachIdx, 1)
if (doDetach && useCarbonyl) {
  console.error(`slop-review: --detach can't be combined with --carbonyl (the terminal browser needs this terminal).`)
  process.exit(1)
}

// `--kill` / `-k` is the teardown counterpart to --detach: stop the server(s)
// running for this repo and exit without launching anything. Handled after the
// git-repo guard, since the registry it reads lives in <repo>/.reviews/.
const killIdx = (() => {
  const long = args.indexOf('--kill')
  return long >= 0 ? long : args.indexOf('-k')   // `-k`: short alias, like `-c` for --carbonyl
})()
const doKill = killIdx >= 0
if (doKill) args.splice(killIdx, 1)

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

// --kill: stop every slop-review server registered for this repo (see
// server/servers.js) and exit. A one-shot like --sync, but it never falls through
// to a launch: it's teardown, and `slop-review -k && …` shouldn't start a server
// on the way out. Exits 0 when nothing was running so it's safe to call blind.
if (doKill) {
  const { killServers } = await import(join(PACKAGE_ROOT, 'server', 'servers.js'))
  const { stopped, survived } = await killServers(repoRoot)
  for (const server of stopped) {
    process.stdout.write(`slop-review: stopped pid ${server.pid}${server.port ? ` (port ${server.port})` : ''}\n`)
  }
  for (const server of survived) {
    console.error(`slop-review: pid ${server.pid} did not exit`)
  }
  if (!stopped.length && !survived.length) {
    process.stdout.write(`slop-review: no server running for ${repoRoot}\n`)
  }
  process.exit(survived.length ? 1 : 0)
}

// Handed to the server (start() below): syncEnabled turns on the recurring
// re-sync loop for this session, syncSeed carries the launch sync's result so
// the loop's status starts populated instead of "never synced". Both are inert
// on a normal launch (no --sync).
let syncEnabled = false
let syncSeed = null

// --sync is a one-shot: pull unresolved GitHub PR review threads into
// <repo>/.reviews/ and (by default) exit, without binding a port. Placed after
// the git-repo guard (so it shares the same repoRoot resolution) and before
// the port logic. When chained with --browser, --carbonyl, or --threads it
// keeps the process alive afterwards, so the normal server-start + open path
// below launches the UI straight into the synced threads, and the server keeps
// re-syncing every few minutes (surfaced as the "Synced …" badge in the diff
// header).
if (doSync) {
  const { runSync, formatSyncStats } = await import(join(PACKAGE_ROOT, 'server', 'sync.js'))
  const openAfterSync = useBrowser || useCarbonyl || doThreads || doOverview || doDetach
  syncEnabled = openAfterSync
  try {
    const result = await runSync(repoRoot, { log: (m) => process.stdout.write(`${m}\n`) })
    syncSeed = result
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
  // through to start the server (which then runs the recurring sync) and open
  // the resume view.
  if (!openAfterSync) process.exit(0)
}

// --overview: interactively pick coding agents + optional instructions (or take
// them from --agent), then generate the branch overview(s) up front (blocking,
// with terminal progress) so the launch below opens on a ready overview. The
// result is cached in <repo>/.reviews/. Cancelling the picker exits quietly; a
// pre-flight problem (no diff, no CLI, no TTY, unknown agent) exits with an
// error. Any actual generation attempt falls through to the normal launch, even
// if a generator failed.
if (doOverview) {
  const { runOverviewCli } = await import(join(PACKAGE_ROOT, 'bin', 'overview-cli.js'))
  const action = await runOverviewCli(repoRoot, { agents: agentArgs })
  if (action === 'cancel') process.exit(0)
  if (action === 'error') process.exit(1)
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

// 2b. --detach: re-exec ourselves as a background process that owns the server
//     and the browser open, then exit 0. A process can't background itself out
//     of the shell's job control, so the hand-off has to be a new one. The child
//     gets the launch flags only — never -o/-a, since the overview it would open
//     on is already generated and cached above; SLOP_REVIEW_OPEN_OVERVIEW passes
//     the deep link on without re-running the generators. The port is picked here
//     so the URL can be printed before exiting.
if (doDetach) {
  const detachArgs = [process.argv[1], '--port', String(port), '--host', hostArg]
  // `--sync` in the child keeps the recurring re-sync loop alive; --threads is
  // what makes both open on the resume view (see openAfterSync above).
  if (doSync) detachArgs.push('--sync', '--threads')
  else if (doThreads) detachArgs.push('--threads')
  if (noOpen) detachArgs.push('--no-open')

  const childEnv = { ...process.env }
  if (doOverview) childEnv.SLOP_REVIEW_OPEN_OVERVIEW = '1'
  else delete childEnv.SLOP_REVIEW_OPEN_OVERVIEW

  const child = spawn(process.execPath, detachArgs, {
    cwd: process.cwd(),
    env: childEnv,
    detached: true,      // own session: survives Ctrl-C and the terminal closing
    stdio: 'ignore',
  })
  child.unref()

  // Wait for the port to answer before exiting: `slop -d && next` should only
  // advance once the UI is actually reachable, and with stdio ignored a failed
  // bind would otherwise be silent.
  const DETACH_READY_MS = 5000
  const deadline = Date.now() + DETACH_READY_MS
  let serving = false
  while (!serving && Date.now() < deadline) {
    serving = await new Promise((resolve) => {
      const probe = connect({ port, host: 'localhost' })
      const done = (result) => { probe.destroy(); resolve(result) }
      probe.once('connect', () => done(true))
      probe.once('error', () => done(false))
      probe.setTimeout(500, () => done(false))
    })
    if (!serving) await new Promise((r) => setTimeout(r, 100))
  }
  if (!serving) {
    console.error(`slop-review: the detached server didn't come up on port ${port}.`)
    process.exit(1)
  }
  process.stdout.write(`slop-review: serving http://localhost:${port}/ in the background (pid ${child.pid}); \`kill ${child.pid}\` to stop.\n`)
  process.exit(0)
}

// 3. Hand off to the server. Setting env vars before the dynamic import
//    is what plumbs the bootstrap repo + port through to state.js + index.js.
process.env.SLOP_REVIEW_REPO = repoRoot
process.env.SLOP_REVIEW_PORT = String(port)

const { start } = await import(join(PACKAGE_ROOT, 'server', 'index.js'))
await start({ port, hostname: hostArg, startSync: syncEnabled, syncSeed })

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
  // --overview adds ?overview=1 so the diff page auto-opens the (just-generated)
  // overview modal on mount. Both params ride the SPA hash and compose.
  // SLOP_REVIEW_OPEN_OVERVIEW: set by the --detach parent, whose already-cached
  // overview the child should open on without generating anything itself.
  const hashParams = []
  if (doSync || doThreads) hashParams.push('resume=1')
  if (doOverview || process.env.SLOP_REVIEW_OPEN_OVERVIEW === '1') hashParams.push('overview=1')
  const routeHash = hashParams.length ? `#/diff?${hashParams.join('&')}` : ''
  const url = useCarbonyl
    ? `http://localhost:${port}/?carbonyl=1${routeHash}`
    : `http://localhost:${port}/${routeHash}`
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
