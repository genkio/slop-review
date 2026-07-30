import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  serversPath,
  readServers,
  registerServer,
  unregisterServer,
  listServers,
  isLiveServer,
  killServers,
} from '../server/servers.js'

function repo() {
  return mkdtempSync(join(tmpdir(), 'slop-servers-'))
}

// A real process to signal, whose command line is nothing like slop-review's —
// so the identity check in isLiveServer can be exercised both ways.
function sleeper() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  child.on('error', () => {})
  return child
}

async function untilGone(pid, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

test('registerServer round-trips through the repo-local registry file', () => {
  const path = repo()
  registerServer(path, { pid: 4242, port: 9410 })

  assert.equal(serversPath(path), join(path, '.reviews', '_servers.json'))
  const [entry] = readServers(path)
  assert.equal(entry.pid, 4242)
  assert.equal(entry.port, 9410)
  assert.match(entry.started_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('registerServer keeps other servers and replaces its own pid', () => {
  const path = repo()
  registerServer(path, { pid: 1, port: 9410 })
  registerServer(path, { pid: 2, port: 9411 })
  registerServer(path, { pid: 1, port: 9412 })

  assert.deepEqual(
    readServers(path).map((s) => [s.pid, s.port]),
    [[2, 9411], [1, 9412]]
  )
})

test('unregisterServer drops the entry, removing the file once empty', () => {
  const path = repo()
  registerServer(path, { pid: 1, port: 9410 })
  registerServer(path, { pid: 2, port: 9411 })

  unregisterServer(path, 1)
  assert.deepEqual(readServers(path).map((s) => s.pid), [2])

  unregisterServer(path, 2)
  assert.equal(readServers(path).length, 0)
  assert.equal(existsSync(serversPath(path)), false)
})

test('readServers ignores a corrupt or foreign-version file', () => {
  assert.deepEqual(readServers(repo()), [])   // no file at all
})

test('listServers prunes entries whose process is gone', () => {
  const path = repo()
  registerServer(path, { pid: 1, port: 9410 })
  registerServer(path, { pid: 2, port: 9411 })

  const live = listServers(path, (pid) => pid === 2)
  assert.deepEqual(live.map((s) => s.pid), [2])
  assert.deepEqual(readServers(path).map((s) => s.pid), [2], 'prune is persisted')
})

test('isLiveServer requires both a live pid and a matching command line', async () => {
  const child = sleeper()
  assert.equal(isLiveServer(child.pid, /sleep/), true)
  // Guards against killing a recycled pid that now belongs to something else.
  assert.equal(isLiveServer(child.pid, /slop-review/), false)

  child.kill('SIGKILL')
  assert.equal(await untilGone(child.pid), true)
  assert.equal(isLiveServer(child.pid, /sleep/), false)
})

test('killServers stops registered servers and clears the registry', async () => {
  const path = repo()
  const child = sleeper()
  registerServer(path, { pid: child.pid, port: 9410 })

  const { stopped, survived } = await killServers(path, {
    isLive: (pid) => isLiveServer(pid, /sleep/),
  })

  assert.deepEqual(stopped.map((s) => s.pid), [child.pid])
  assert.deepEqual(survived, [])
  assert.equal(existsSync(serversPath(path)), false)
  assert.equal(await untilGone(child.pid), true)
})

test('killServers on an empty registry is a no-op, not an error', async () => {
  const { stopped, survived } = await killServers(repo())
  assert.deepEqual(stopped, [])
  assert.deepEqual(survived, [])
})
