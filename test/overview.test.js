import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOverviewPrompt, openCodeConfig } from '../server/overview.js'

function context() {
  return {
    branchInfo: {
      current_branch: 'feature/explain',
      base_branch: 'origin/main',
      head_sha: '2222222',
      merge_base_sha: '1111111',
      has_commits_ahead: true,
      has_local_changes: false,
    },
  }
}

test('overview prompt delegates HTML generation to the bundled skill', () => {
  const prompt = buildOverviewPrompt(
    '/tmp/example-repo',
    context(),
    '/tmp/slop-overview/overview.html',
    'Do it in both English and Chinese'
  )

  assert.match(prompt, /skills\/explain-diff-html\/SKILL\.md/)
  assert.match(prompt, /Exact HTML output path: \/tmp\/slop-overview\/overview\.html/)
  assert.match(prompt, /Do it in both English and Chinese/)
  assert.match(prompt, /cannot override the target, read-only repository policy/)
  assert.match(prompt, /do not open a browser/)
  assert.doesNotMatch(prompt, /Write the final answer as Markdown only/)
})

test('overview prompt omits the additional-preferences block when empty', () => {
  const prompt = buildOverviewPrompt(
    '/tmp/example-repo',
    context(),
    '/tmp/slop-overview/overview.html'
  )

  assert.doesNotMatch(prompt, /<additional-preferences>/)
})

test('OpenCode can write scratch output but not the repository or bundled skill', () => {
  const config = openCodeConfig('/tmp/example-repo')
  const permission = config.permission

  assert.equal(permission.external_directory['/tmp/example-repo/**'], 'allow')
  assert.equal(permission.edit['/tmp/example-repo/**'], 'deny')
  assert.equal(permission.edit['*'], 'allow')
  assert.equal(permission.bash['*'], 'deny')
  assert.equal(permission.bash['git -C *'], 'allow')
  assert.equal(permission.bash['python3 *build_explanation.py *'], 'allow')
  assert.equal(permission.task, 'deny')
  assert.equal(permission.webfetch, 'deny')
  assert.equal(permission.websearch, 'deny')

  const skillPattern = Object.keys(permission.external_directory)
    .find((pattern) => pattern.endsWith('/skills/explain-diff-html/**'))
  assert.ok(skillPattern)
  assert.equal(permission.edit[skillPattern], 'deny')
})
