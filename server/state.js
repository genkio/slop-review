import { readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { SEED, STATE_VERSION } from './seed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const STATE_FILE = join(__dirname, '..', 'state.json')

// Resolved once from server's __dirname so `state.config.slop_review_root`
// stays correct even if the user moves the project directory. Never trusted
// from disk — overwritten on every load.
const SLOP_REVIEW_ROOT = resolve(__dirname, '..')

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
  state.config.slop_review_root = SLOP_REVIEW_ROOT
  state.config.home = homedir()
  return state
}

export async function saveState(state) {
  await writeBaseState(state)
}

async function writeBaseState(state) {
  const tmp = STATE_FILE + '.tmp'
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, STATE_FILE)
  try {
    await chmod(STATE_FILE, 0o600)
  } catch {}
}

export function findRepo(state, id) {
  return state.repos.find((r) => r.id === id) || null
}
