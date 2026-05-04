import { readFile, writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { branchDir } from './reviews.js'

/**
 * Per-branch "I've already reviewed these files" state. Lives at
 * `.reviews/<repo_id>/<branch_id>/_reviewed.json` — leading underscore
 * keeps it out of the thread reader.
 *
 * Persistence is keyed by `head_sha`: a new push to the branch (different
 * head_sha) means the diff might have changed any file, so the simplest
 * correct behavior is "reset on push" — return an empty set when the
 * stored SHA mismatches. The on-disk file isn't rewritten until the next
 * mark-reviewed PUT.
 */

function fileFor(repoId, branchId) {
  return join(branchDir(repoId, branchId), '_reviewed.json')
}

export async function readReviewed(repoId, branchId, currentHeadSha = null) {
  const target = fileFor(repoId, branchId)
  if (!existsSync(target)) return { head_sha: null, paths: [] }
  try {
    const raw = await readFile(target, 'utf8')
    const data = JSON.parse(raw)
    const stored = data?.head_sha || null
    const paths  = Array.isArray(data?.paths) ? data.paths : []
    if (currentHeadSha && stored && stored !== currentHeadSha) {
      return { head_sha: stored, paths: [] }
    }
    return { head_sha: stored, paths }
  } catch {
    return { head_sha: null, paths: [] }
  }
}

export async function writeReviewed(repoId, branchId, headSha, paths) {
  if (!repoId || !branchId) throw new Error('writeReviewed: missing repo/branch')
  if (!headSha)             throw new Error('writeReviewed: missing head_sha')
  const target = fileFor(repoId, branchId)
  await mkdir(dirname(target), { recursive: true })

  const unique = [...new Set((paths || []).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const payload = { head_sha: headSha, paths: unique }

  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(payload, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
  return payload
}

export async function clearReviewed(repoId, branchId) {
  try {
    await unlink(fileFor(repoId, branchId))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
