import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { findSymbolDefinition } from '../server/git.js'

// findSymbolDefinition greps HEAD, so the source has to be committed. Build a
// throwaway repo holding one Python file whose symbols span every def shape
// the matcher cares about (and a couple it must NOT treat as defs).
function makePyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'slop-symbol-def-'))
  const work = join(root, 'work')
  const g = (args) => execFileSync('git', args, { cwd: work, stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'pipe' })
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'user.name', 'Test'])
  g(['config', 'commit.gpgsign', 'false'])

  const py = [
    'import os',              // 1
    '',                       // 2
    'MAX_SIZE = 100',         // 3  module-level binding
    'SCALE: float = 1.5',     // 4  annotated module-level binding
    '',                       // 5
    'def compute(total):',    // 6  function def ('total' is only a param here)
    '    total += 1',         // 7  indented augmented assignment (NOT a def)
    '    return total',       // 8
    '',                       // 9
    'class Widget:',          // 10 class def
    '    def render(self):',  // 11 method def (indented)
    '        return compute(MAX_SIZE)', // 12
    '',                       // 13
    'result = compute(0)',    // 14
    '',
  ].join('\n')
  writeFileSync(join(work, 'app.py'), py)
  g(['add', 'app.py'])
  g(['commit', '-m', 'init'])
  return { root, work }
}

test('findSymbolDefinition: a Python function def is recognized', async () => {
  const { root, work } = makePyRepo()
  try {
    const r = await findSymbolDefinition(work, 'compute')
    assert.equal(r.found, true)
    assert.equal(r.lang, 'python')
    assert.equal(r.is_def, true)
    assert.equal(r.line, 6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findSymbolDefinition: a class and an indented method def are recognized', async () => {
  const { root, work } = makePyRepo()
  try {
    const cls = await findSymbolDefinition(work, 'Widget')
    assert.equal(cls.is_def, true)
    assert.equal(cls.line, 10)
    const method = await findSymbolDefinition(work, 'render')
    assert.equal(method.is_def, true)
    assert.equal(method.line, 11)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findSymbolDefinition: a module-level binding counts as a def', async () => {
  const { root, work } = makePyRepo()
  try {
    const plain = await findSymbolDefinition(work, 'MAX_SIZE')
    assert.equal(plain.is_def, true)
    assert.equal(plain.line, 3)
    const annotated = await findSymbolDefinition(work, 'SCALE')
    assert.equal(annotated.is_def, true)
    assert.equal(annotated.line, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findSymbolDefinition: an indented/augmented assignment is NOT a def (found, but is_def false)', async () => {
  const { root, work } = makePyRepo()
  try {
    // `total` shows up only as a param, an indented `+=`, and a return: no
    // def-shaped line, so it falls back to first occurrence with is_def false.
    const r = await findSymbolDefinition(work, 'total')
    assert.equal(r.found, true)
    assert.equal(r.is_def, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
