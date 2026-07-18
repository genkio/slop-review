import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildToolChoices,
  unavailableReason,
  summarizeGenerations,
} from '../bin/overview-cli.js'

test('buildToolChoices maps available tools with version + prior-run suffix', () => {
  const choices = buildToolChoices({
    available_tools: ['codex', 'opencode'],
    codex_version: '0.5.0',
    opencode_version: '1.2.3',
    generations: {
      codex: { status: 'ready', has_content: true },
      opencode: { status: 'error', has_content: false, error: 'boom' },
    },
  })

  assert.deepEqual(choices, [
    { value: 'codex', label: 'Codex', suffix: '0.5.0 · previously generated' },
    { value: 'opencode', label: 'OpenCode', suffix: '1.2.3 · previously failed' },
  ])
})

test('buildToolChoices returns [] when nothing is available', () => {
  assert.deepEqual(buildToolChoices({ available_tools: [] }), [])
  assert.deepEqual(buildToolChoices({}), [])
})

test('buildToolChoices omits the suffix with no version and no prior run', () => {
  assert.deepEqual(buildToolChoices({ available_tools: ['claude'] }), [
    { value: 'claude', label: 'Claude', suffix: '' },
  ])
})

test('unavailableReason concatenates CLI errors, else a default hint', () => {
  assert.equal(
    unavailableReason({ codex_error: 'no codex', opencode_error: 'no opencode' }),
    'no codex no opencode'
  )
  assert.match(unavailableReason({}), /No supported CLI/)
})

test('summarizeGenerations classifies by this run status, not preserved content', () => {
  const { succeeded, failed } = summarizeGenerations(['codex', 'claude', 'opencode'], {
    codex: { status: 'ready', has_content: true },
    claude: { status: 'error', has_content: true }, // kept prior content, failed this run
    opencode: { status: 'error', has_content: false },
  })

  assert.deepEqual(succeeded, ['codex'])
  assert.deepEqual(failed, ['claude', 'opencode'])
})
