import assert from 'node:assert/strict'
import test from 'node:test'
import { splitTools, toolSummary } from './toolRuns.ts'

test('ferramentas seguidas viram um grupo; texto em volta fica intacto', () => {
  const s = splitTools('Comeco.\n\n`> Edit`\n\n`> Edit`\n\n`> Read`\n\nFim.')
  assert.deepEqual(s, [{ md: 'Comeco.\n' }, { tools: ['Edit', 'Edit', 'Read'] }, { md: 'Fim.' }])
  assert.equal(toolSummary(['Edit', 'Edit', 'Read', 'npm test --x']), 'Edit ×2, Read, npm ×1'.replace(' ×1', ''))
})
