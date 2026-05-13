import { readFile, writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { branchDir } from './reviews.js'
import { getBlobShasAt } from './git.js'

/**
 * Per-branch "I've already reviewed these files" state. Lives at
 * `<repo>/.reviews/<branch_id>/_reviewed.json` — leading underscore keeps
 * it out of the thread reader.
 *
 * Persistence is keyed PER FILE by the blob SHA at marking time, not by
 * the branch's HEAD as a whole. On read we re-look-up each path's current
 * HEAD blob and return only entries where the stored blob still matches.
 * This gives us two properties the old `head_sha`-keyed model couldn't:
 *
 *   1. A push that modifies file A no longer wipes the mark on unrelated
 *      file B — only A's mark is invalidated because only A's blob
 *      diverged.
 *   2. Marking a file reviewed from a per-commit view is automatically
 *      gated: if the file has later changes between that commit and HEAD,
 *      the stored blob (HEAD blob at write time) won't match the blob the
 *      user actually viewed, so we never persist a misleading mark. The
 *      client mirrors this with an explicit toast so the UX isn't silent.
 *
 * Storage shape: `{ head_sha, files: [{path, blob_sha}] }`. The `head_sha`
 * field is informational — it captures which HEAD the marks were recorded
 * against — but it doesn't drive invalidation.
 */

function fileFor(repoPath, branchId) {
  return join(branchDir(repoPath, branchId), '_reviewed.json')
}

async function readPayload(repoPath, branchId) {
  const target = fileFor(repoPath, branchId)
  if (!existsSync(target)) return { head_sha: null, files: [] }
  try {
    const raw = await readFile(target, 'utf8')
    const data = JSON.parse(raw)
    return {
      head_sha: data?.head_sha || null,
      files: Array.isArray(data?.files)
        ? data.files.filter((f) => f && typeof f.path === 'string')
        : [],
    }
  } catch {
    return { head_sha: null, files: [] }
  }
}

/**
 * Return the subset of stored marks whose blob still matches HEAD. Marks
 * on files now absent at HEAD survive only when the mark was recorded
 * against an absent file too (both `null`) — i.e. the file was deleted at
 * marking time and is still deleted now. Any other transition (added,
 * re-added, content changed) drops the mark.
 */
export async function readReviewed(repoPath, branchId) {
  const payload = await readPayload(repoPath, branchId)
  if (!payload.files.length) return { head_sha: payload.head_sha, paths: [] }
  const headBlobs = await getBlobShasAt(repoPath, 'HEAD', payload.files.map((f) => f.path))
  const valid = payload.files
    .filter((f) => (headBlobs.get(f.path) ?? null) === (f.blob_sha ?? null))
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b))
  return { head_sha: payload.head_sha, paths: valid }
}

export async function writeReviewed(repoPath, branchId, headSha, paths) {
  if (!repoPath || !branchId) throw new Error('writeReviewed: missing repo/branch')
  if (!headSha)               throw new Error('writeReviewed: missing head_sha')
  const target = fileFor(repoPath, branchId)
  await mkdir(dirname(target), { recursive: true })

  const unique = [...new Set((paths || []).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  // Snapshot each path's HEAD blob at write time. That snapshot is what
  // future reads compare against — if a later push changes the blob, the
  // mismatch invalidates this mark alone (everything else with an
  // unchanged blob survives).
  const headBlobs = await getBlobShasAt(repoPath, 'HEAD', unique)
  const files = unique.map((path) => ({ path, blob_sha: headBlobs.get(path) ?? null }))
  const payload = { head_sha: headSha, files }

  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(payload, null, 2))
  await rename(tmp, target)
  try { await chmod(target, 0o600) } catch {}
  return { head_sha: headSha, paths: unique }
}

export async function clearReviewed(repoPath, branchId) {
  try {
    await unlink(fileFor(repoPath, branchId))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}
