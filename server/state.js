import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { SEED, STATE_VERSION } from './seed.js'

// state.json now lives in the user's config dir, not next to the package
// source. This makes the package installable via `npx slop-review` without
// every install creating its own state file. Honors XDG_CONFIG_HOME and
// allows full override via SLOP_REVIEW_STATE_FILE for tests / power users.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'slop-review')
  : join(homedir(), '.config', 'slop-review')

export const STATE_FILE =
  process.env.SLOP_REVIEW_STATE_FILE || join(CONFIG_DIR, 'state.json')

let bootstrappedLogged = false

function deriveRepoId(absPath) {
  const base =
    basename(absPath).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 8)
  return `${base}_${hash}`
}

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
    } else {
      let changed = false
      state.prompt_templates ??= {}
      for (const k of Object.keys(SEED.prompt_templates || {})) {
        if (!state.prompt_templates[k]) {
          state.prompt_templates[k] = SEED.prompt_templates[k]
          changed = true
        }
      }
      if (changed) await writeBaseState(state)
    }
  }

  state.config ??= {}
  state.config.home = homedir()

  // Bootstrap-from-cwd: when launched via `npx slop-review` (or any caller
  // that sets SLOP_REVIEW_REPO), make sure that repo is registered and tell
  // the frontend which repo to land on.
  const bootstrapPath = process.env.SLOP_REVIEW_REPO
  if (bootstrapPath) {
    const abs = resolve(bootstrapPath)
    const id = deriveRepoId(abs)
    if (!state.repos.find((r) => r.id === id)) {
      state.repos.push({
        id,
        path: abs,
        display_name: basename(abs),
        added_at: new Date().toISOString(),
      })
      await writeBaseState(state)
      if (!bootstrappedLogged) {
        console.log(`[slop-review] bootstrapped repo: ${abs} (${id})`)
        bootstrappedLogged = true
      }
    }
    state.config.bootstrap_repo_id = id
    state.config.bootstrap_repo_path = abs
  }

  return state
}

export async function saveState(state) {
  await writeBaseState(state)
}

async function writeBaseState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  // Strip runtime-only fields so they don't leak into the persisted file —
  // they're recomputed on every load.
  const persisted = { ...state, config: { ...(state.config || {}) } }
  delete persisted.config.home
  delete persisted.config.bootstrap_repo_id
  delete persisted.config.bootstrap_repo_path
  const tmp = STATE_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(persisted, null, 2))
  await rename(tmp, STATE_FILE)
  try {
    await chmod(STATE_FILE, 0o600)
  } catch {}
}

export function findRepo(state, id) {
  return state.repos.find((r) => r.id === id) || null
}
