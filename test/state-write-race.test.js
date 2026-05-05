import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regression for the temp+rename race fixed in `fix(state): serialize writes
// and use unique temp paths`. Before the fix, parallel first-load writes
// against a fresh state file collided on the fixed `STATE_FILE + '.tmp'`
// path: one rename consumed the temp, the rest crashed with ENOENT and
// surfaced as 500s on the first /api/* burst from the browser.
//
// The test fixes the env BEFORE importing state.js because STATE_FILE is
// computed at module-load time. Setting SLOP_REVIEW_REPO also exercises the
// bootstrap-upsert write branch (loadState's heaviest write path).
test('parallel loadState() does not race on temp+rename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-state-race-'))
  const stateFile = join(dir, 'state.json')
  process.env.SLOP_REVIEW_STATE_FILE = stateFile
  process.env.SLOP_REVIEW_REPO = process.cwd()

  try {
    const { loadState } = await import('../server/state.js')

    const N = 16
    const states = await Promise.all(Array.from({ length: N }, () => loadState()))
    assert.equal(states.length, N, 'all parallel loadState() calls fulfilled')

    // On-disk state should be the result of an idempotent upsert: one repo,
    // not N copies. Runtime-only fields must not be persisted.
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(onDisk.repos.length, 1, 'bootstrap upsert is idempotent across parallel callers')
    assert.equal(onDisk.repos[0].path, process.cwd(), 'bootstrap path stamped onto the upserted repo')
    assert.equal(onDisk.config?.home, undefined, 'runtime-only config.home stripped before persist')
    assert.equal(onDisk.config?.bootstrap_repo_id, undefined, 'runtime-only bootstrap_repo_id stripped')
    assert.equal(onDisk.config?.bootstrap_repo_path, undefined, 'runtime-only bootstrap_repo_path stripped')

    // No leftover unique-tmp files lying around — every writer's rename
    // either consumed its tmp or the unique-suffix layer kept them isolated.
    const stragglers = readdirSync(dir).filter((f) => f.startsWith('state.json.tmp'))
    assert.deepEqual(stragglers, [], 'no leaked .tmp files after parallel writes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.SLOP_REVIEW_STATE_FILE
    delete process.env.SLOP_REVIEW_REPO
  }
})
