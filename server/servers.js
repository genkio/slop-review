// Registry of running slop-review servers for one repo, so `--kill` (`-k`) can
// stop them from any terminal: the detached ones `--detach` leaves behind, but
// also a foreground session someone started in another pane.
//
// It lives at `<repo>/.reviews/_servers.json`, next to the review threads —
// per-repo by construction, already gitignored, and already excluded from every
// git-facing code path (so writing it mid-run can't disturb overview cache keys).
//
// The file is a hint, never the truth. Pids get recycled, a server can be killed
// with -9, and the machine can reboot; entries are therefore verified against the
// live process table before anything is signalled, and dead ones are pruned on
// read. Concurrent launches in the same repo read-modify-write without a lock, so
// a simultaneous pair can drop an entry — `pkill -f "slop-review.js --port"` is
// the fallback for that.
//
// Sync fs throughout: registration happens once at startup, and unregistering
// runs from a signal handler where there is nothing to await into.

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { reviewsRoot } from './reviews.js'

const SERVERS_FILE = '_servers.json'
const SERVERS_VERSION = 1
const SLOP_COMMAND_RE = /slop-review/
const KILL_GRACE_MS = 3000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function serversPath(repoPath) {
  return join(reviewsRoot(repoPath), SERVERS_FILE)
}

export function readServers(repoPath) {
  try {
    const data = JSON.parse(readFileSync(serversPath(repoPath), 'utf8'))
    if (data?.version !== SERVERS_VERSION || !Array.isArray(data.servers)) return []
    return data.servers.filter((s) => Number.isInteger(s?.pid) && s.pid > 0)
  } catch {
    return []
  }
}

function writeServers(repoPath, servers) {
  const target = serversPath(repoPath)
  // Empty means "nothing running": drop the file instead of leaving a husk in
  // `.reviews/`, so a repo that never uses --detach stays as clean as before.
  if (!servers.length) {
    try { unlinkSync(target) } catch {}
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: SERVERS_VERSION, servers }, null, 2))
  renameSync(tmp, target)
  try { chmodSync(target, 0o600) } catch {}
}

// Called from server/index.js once the listener is accepting connections, so the
// recorded port is the one actually bound (not the requested one).
export function registerServer(repoPath, { pid = process.pid, port, startedAt } = {}) {
  const others = readServers(repoPath).filter((s) => s.pid !== pid)
  writeServers(repoPath, [...others, { pid, port, started_at: startedAt || new Date().toISOString() }])
}

export function unregisterServer(repoPath, pid = process.pid) {
  const before = readServers(repoPath)
  const rest = before.filter((s) => s.pid !== pid)
  if (rest.length !== before.length) writeServers(repoPath, rest)
}

// `kill(pid, 0)` only proves *something* is alive at that pid — after a reboot or
// pid wraparound that something is a stranger, and signalling it would be a bug
// with real consequences. The command-line check is what makes this safe. EPERM
// (someone else's process) counts as not ours: we couldn't signal it anyway.
export function isLiveServer(pid, pattern = SLOP_COMMAND_RE) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  let command
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return true   // no usable `ps` (Windows): the registry's word is all we have
  }
  return pattern.test(command)
}

// Live servers for this repo, pruning entries that died without unregistering
// (kill -9, crash, reboot).
export function listServers(repoPath, isLive = isLiveServer) {
  const all = readServers(repoPath)
  const live = all.filter((s) => isLive(s.pid))
  if (live.length !== all.length) writeServers(repoPath, live)
  return live
}

/**
 * SIGTERM every server registered for this repo, then SIGKILL whatever is still
 * standing after the grace period. Returns { stopped, survived } so the caller
 * can report per-server and pick an exit code. Idempotent: no servers is not an
 * error, so `slop-review -k` is safe in a teardown chain.
 */
export async function killServers(repoPath, { isLive = isLiveServer, graceMs = KILL_GRACE_MS } = {}) {
  const targets = listServers(repoPath, isLive)
  for (const server of targets) {
    try { process.kill(server.pid, 'SIGTERM') } catch {}   // raced us: treat as stopped below
  }

  const deadline = Date.now() + graceMs
  let remaining = targets
  while (remaining.length && Date.now() < deadline) {
    await delay(100)
    remaining = remaining.filter((s) => isLive(s.pid))
  }
  for (const server of remaining) {
    try { process.kill(server.pid, 'SIGKILL') } catch {}
  }
  if (remaining.length) await delay(200)

  const survived = targets.filter((s) => isLive(s.pid))
  const survivedPids = new Set(survived.map((s) => s.pid))
  writeServers(repoPath, survived)
  return { stopped: targets.filter((s) => !survivedPids.has(s.pid)), survived }
}
