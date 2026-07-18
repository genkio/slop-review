import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// build_explanation.py is the one command every overview generator is allowed
// to run, so it enforces which diagrams grok-mermaid can actually render. These
// tests drive its validate_diagram_source directly. Skip gracefully where
// python3 is absent (it's a documented Overview prerequisite, not a hard dep of
// the server).
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'explain-diff-html', 'scripts')

function hasPython() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function check(source) {
  const py = `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)}); import build_explanation as b; b.validate_diagram_source(${JSON.stringify(source)}, "diagrams[0]")`
  try {
    // -B: don't write __pycache__ next to the imported build script.
    execFileSync('python3', ['-B', '-c', py], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
    return { ok: true, err: '' }
  } catch (e) {
    return { ok: false, err: String(e.stderr || '') }
  }
}

const skip = hasPython() ? false : 'python3 not available'

test('accepts a flowchart', { skip }, () => {
  assert.equal(check('flowchart TD\n  A-->B').ok, true)
})

test('rejects unsupported diagram types', { skip }, () => {
  const r = check('pie\n  "a": 1')
  assert.equal(r.ok, false)
  assert.match(r.err, /can't render 'pie'/)
})

test('rejects a semicolon in a sequence diagram', { skip }, () => {
  const r = check('sequenceDiagram\n  A->>DB: BEGIN; SELECT; COMMIT')
  assert.equal(r.ok, false)
  assert.match(r.err, /statement separator|remove ';'/)
})

test('accepts a sequence diagram without semicolons', { skip }, () => {
  assert.equal(check('sequenceDiagram\n  A->>DB: BEGIN, then SELECT').ok, true)
})

test('rejects a direction statement in a state diagram', { skip }, () => {
  const r = check('stateDiagram-v2\n  direction LR\n  [*] --> A')
  assert.equal(r.ok, false)
  assert.match(r.err, /direction/)
})

test('accepts a state diagram without a direction statement', { skip }, () => {
  assert.equal(check('stateDiagram-v2\n  [*] --> A\n  A --> B: go').ok, true)
})
