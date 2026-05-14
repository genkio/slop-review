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
// The race surface is narrower since the multi-repo removal — the bootstrap
// no longer mutates persisted state — but the SEED-write on first load
// still goes through writeBaseState, so parallel loadState() callers can
// still race the temp+rename pair.
//
// The test fixes the env BEFORE importing state.js because STATE_FILE is
// computed at module-load time. Setting SLOP_REVIEW_REPO exercises the
// in-memory bootstrap path so we can also assert it's NOT persisted.
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

    // Every returned state carries the in-memory bootstrap repo derived
    // from SLOP_REVIEW_REPO — present, but never persisted.
    for (const s of states) {
      assert.equal(s.repos.length, 1, 'in-memory state.repos has the bootstrap entry')
      assert.equal(s.repos[0].path, process.cwd(), 'bootstrap path matches cwd')
      assert.equal(s.config?.bootstrap_repo_id, s.repos[0].id, 'config.bootstrap_repo_id mirrors repo id')
    }

    // On-disk state is { version, config: {} } only. Runtime-only fields
    // (repos, config.home, config.bootstrap_*) are stripped before persist,
    // as is the orphaned `prompt_templates` key from the pre-skill era —
    // see writeBaseState in server/state.js.
    const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(onDisk.repos, undefined, 'repos is not persisted (multi-repo mode removed)')
    assert.equal(onDisk.config?.home, undefined, 'runtime-only config.home stripped before persist')
    assert.equal(onDisk.config?.bootstrap_repo_id, undefined, 'runtime-only bootstrap_repo_id stripped')
    assert.equal(onDisk.config?.bootstrap_repo_path, undefined, 'runtime-only bootstrap_repo_path stripped')
    assert.equal(typeof onDisk.version, 'number', 'schema version is persisted')
    assert.equal(onDisk.prompt_templates, undefined, 'orphaned prompt_templates is stripped on persist')

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
