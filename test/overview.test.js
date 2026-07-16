import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOverviewPrompt,
  mergeOverviewGenerations,
  openCodeConfig,
  resolveTools,
} from '../server/overview.js'

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

test('overview generation keeps each selected available tool in stable tab order', () => {
  const availability = {
    codex: { available: true },
    claude: { available: false },
    opencode: { available: true },
  }

  assert.deepEqual(resolveTools(['opencode', 'codex', 'opencode'], availability), ['codex', 'opencode'])
  assert.deepEqual(resolveTools(null, availability), ['codex', 'opencode'])
  assert.deepEqual(resolveTools(['claude'], availability), [])
})

test('regeneration replaces only selected agents and retains prior results', () => {
  const previous = {
    generations: {
      codex: {
        status: 'error',
        started_at: '2026-07-16T10:00:00.000Z',
        completed_at: '2026-07-16T10:01:00.000Z',
        has_content: false,
        error: 'Codex failed',
      },
      opencode: {
        status: 'ready',
        started_at: '2026-07-16T10:00:00.000Z',
        completed_at: '2026-07-16T10:02:00.000Z',
        has_content: true,
        error: null,
      },
    },
  }

  const generations = mergeOverviewGenerations(
    previous,
    ['codex'],
    '2026-07-17T10:00:00.000Z'
  )

  assert.deepEqual(generations.opencode, previous.generations.opencode)
  assert.deepEqual(generations.codex, {
    status: 'generating',
    started_at: '2026-07-17T10:00:00.000Z',
    completed_at: null,
    has_content: false,
    error: null,
  })
})

test('regenerating an existing result preserves its content until replacement succeeds', () => {
  const generations = mergeOverviewGenerations({
    generations: {
      opencode: {
        status: 'ready',
        started_at: '2026-07-16T10:00:00.000Z',
        completed_at: '2026-07-16T10:02:00.000Z',
        has_content: true,
        error: null,
      },
    },
  }, ['opencode'], '2026-07-17T10:00:00.000Z')

  assert.equal(generations.opencode.status, 'generating')
  assert.equal(generations.opencode.has_content, true)
})
