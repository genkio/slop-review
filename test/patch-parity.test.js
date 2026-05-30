import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parsePatch, pairRows } from '../core/patch.js'

// Baseline captured from the original parsePatch/annotateIntraLine/pairRows
// while they still lived in public/diff.js (which is not Node-importable, so
// the functions were extracted to a temp module for the capture). This pins
// that the verbatim lift into core/patch.js changed nothing, including the
// _intraLeft/_intraRight stamps and the split-pairing structure.
const __dirname = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'patch-baseline.json'), 'utf8'),
)

const SAMPLE = `@@ -1,4 +1,5 @@ function f() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
@@ -10,2 +11,2 @@
-old line
+new line`

test('parsePatch + pairRows are byte-identical to the pre-move baseline', () => {
  const hunks = parsePatch(SAMPLE)
  const paired = hunks.map((h) => pairRows(h.rows))
  // Compare via JSON so the mutated counters (_oldNo/_newNo) and intra-line
  // stamps are all included in the equality check.
  assert.equal(JSON.stringify({ hunks, paired }), JSON.stringify(baseline))
})

test('parsePatch tolerates empty / preamble-only input', () => {
  assert.deepEqual(parsePatch(''), [])
  assert.deepEqual(parsePatch('no hunks here\njust preamble'), [])
})
