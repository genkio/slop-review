import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { highlightLine, languageForPath } from '../public/syntax.js'

// The baseline was captured from the pre-refactor public/syntax.js (the
// monolithic HTML-producing highlighter) over a corpus exercising every
// language and token path. The refactor split that into a shared core
// tokenizer (core/syntax.js) + a browser HTML adapter; this test pins that
// the split produces BYTE-IDENTICAL HTML, so the SPA is unchanged.
const __dirname = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'syntax-baseline.json'), 'utf8'),
)

test('highlightLine is byte-identical to the pre-refactor baseline', () => {
  for (const [text, lang, expected] of baseline.highlight) {
    assert.equal(
      highlightLine(text, lang),
      expected,
      `lang=${JSON.stringify(lang)} text=${JSON.stringify(text)}`,
    )
  }
})

test('languageForPath is byte-identical to the pre-refactor baseline', () => {
  for (const [path, expected] of baseline.langs) {
    assert.equal(languageForPath(path), expected, `path=${JSON.stringify(path)}`)
  }
})
