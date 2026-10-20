import test from 'node:test'
import assert from 'node:assert/strict'
import { languageForPath, highlightLine } from '../public/syntax.js'

test('maps .php and .phtml to php', () => {
  assert.equal(languageForPath('src/Controller/Home.php'), 'php')
  assert.equal(languageForPath('templates/view.PHTML'), 'php')
})

test('highlights php keywords, variables and strings', () => {
  const html = highlightLine('public function run($this, "x") { return null; }', 'php')
  assert.match(html, /<span class="hl-keyword">public<\/span>/)
  assert.match(html, /<span class="hl-keyword">function<\/span>/)
  assert.match(html, /<span class="hl-literal" data-token="\$this">\$this<\/span>/)
  assert.match(html, /<span class="hl-string">&quot;x&quot;<\/span>/)
  assert.match(html, /<span class="hl-literal" data-token="null">null<\/span>/)
})

test('treats both // and # as php line comments', () => {
  assert.match(highlightLine('$a = 1; // note', 'php'), /<span class="hl-comment">\/\/ note<\/span>/)
  assert.match(highlightLine('$a = 1; # note', 'php'), /<span class="hl-comment"># note<\/span>/)
})

test('does not treat a php 8 attribute as a comment', () => {
  const html = highlightLine('#[Route("/home")]', 'php')
  assert.doesNotMatch(html, /hl-comment/)
  assert.match(html, /<span class="hl-class" data-token="Route">Route<\/span>/)
})

test('bash keeps #[ as a comment', () => {
  assert.match(highlightLine('#[ not an attribute', 'bash'), /<span class="hl-comment">/)
})
