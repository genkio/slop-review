import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SEED, STATE_VERSION } from './seed.js'
import { deriveRepoId } from '../core/repo-id.js'

// state.json lives in the user's config dir, not next to the package
// source. This makes the package installable via `npx slop-review` without
// every install creating its own state file. Honors XDG_CONFIG_HOME and
// allows full override via SLOP_REVIEW_STATE_FILE for tests / power users.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'slop-review')
  : join(homedir(), '.config', 'slop-review')

export const STATE_FILE =
  process.env.SLOP_REVIEW_STATE_FILE || join(CONFIG_DIR, 'state.json')

let bootstrappedLogged = false

export async function loadState() {
  let state
  if (!existsSync(STATE_FILE)) {
    state = structuredClone(SEED)
    await writeBaseState(state)
  } else {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    if (!state.version || state.version < STATE_VERSION) {
      console.log('[slop-review] state schema outdated — reseeding from SEED')
      state = structuredClone(SEED)
      await writeBaseState(state)
    }
  }

  state.config ??= {}
  state.config.home = homedir()

  // Bootstrap: SLOP_REVIEW_REPO is required (validated at server start in
  // server/index.js). The active repo is synthesized in-memory on every
  // load and never persisted — there's exactly one, derived from cwd.
  const bootstrapPath = process.env.SLOP_REVIEW_REPO
  if (bootstrapPath) {
    const abs = resolve(bootstrapPath)
    const id = deriveRepoId(abs)
    state.repos = [{
      id,
      path: abs,
      display_name: basename(abs),
      added_at: new Date().toISOString(),
    }]
    state.config.bootstrap_repo_id = id
    state.config.bootstrap_repo_path = abs
    if (!bootstrappedLogged) {
      console.log(`[slop-review] bootstrapped repo: ${abs} (${id})`)
      bootstrappedLogged = true
    }
  } else {
    state.repos = []
  }

  return state
}

export async function saveState(state) {
  await writeBaseState(state)
}

// Serialize state writes so concurrent loadState() callers can't race on
// the temp+rename pair. Two writers sharing one `.tmp` path would have the
// second rename fail with ENOENT once the first consumed the temp; chaining
// also keeps the on-disk update order deterministic.
let writeChain = Promise.resolve()

async function writeBaseState(state) {
  const run = async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    // Strip runtime-only fields so they don't leak into the persisted file —
    // they're recomputed on every load. `repos` is also runtime-only now;
    // the persisted shape is { version, config: {} }. `prompt_templates`
    // is an orphan from the pre-skill era (the Aggregate Prompt clipboard
    // handoff that moved to the slop-review skill) — stripping it here
    // (rather than via a STATE_VERSION bump + reseed) avoids wiping out
    // legitimate user-facing config like `config.repo_ui_state`. Next
    // persist after this change clears the orphan from existing files.
    const persisted = { ...state, config: { ...(state.config || {}) } }
    delete persisted.config.home
    delete persisted.config.bootstrap_repo_id
    delete persisted.config.bootstrap_repo_path
    delete persisted.repos
    delete persisted.prompt_templates
    // Unique tmp suffix per write defends against callers that bypass the
    // chain (e.g. parallel tests) — fixed `.tmp` collides on rename.
    const tmp = `${STATE_FILE}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
    await writeFile(tmp, JSON.stringify(persisted, null, 2))
    await rename(tmp, STATE_FILE)
    try {
      await chmod(STATE_FILE, 0o600)
    } catch {}
  }
  // Run regardless of prior chain state so one failed write doesn't poison
  // subsequent ones; shed errors so later awaiters don't observe them.
  const next = writeChain.then(run, run)
  writeChain = next.then(() => undefined, () => undefined)
  return next
}

export function findRepo(state, id) {
  return state.repos.find((r) => r.id === id) || null
}
