import test from 'node:test'
import assert from 'node:assert/strict'
import { duration, parseSteps, stepLabel, summary, type Steps } from './stepsView.ts'

const t = { edit: 3, read: 1, run: 11, search: 0, web: 0, other: 0, failed: 1, added: 105, removed: 9, files: 3 }
const s: Steps = { total: 15, items: [], totals: t }

test('resumo: comandos, falha, arquivos e linhas', () => {
  assert.equal(summary(s), 'Executou 11 comandos (1 falha), editou 3 arquivos, leu um arquivo +105 −9')
  assert.equal(summary({ ...s, totals: { ...t, run: 1, failed: 0, edit: 0, files: 0, read: 0, added: 0, removed: 0 } }), 'Executou um comando')
})
test('duracao e leitura tolerante do JSON', () => {
  assert.equal(duration(93_000), '1 min 33 s'); assert.equal(duration(4_000), '4 s')
  assert.equal(parseSteps('lixo'), null); assert.equal(parseSteps(null), null); assert.equal(parseSteps('{"items":[]}'), null)
  assert.ok(parseSteps(JSON.stringify(s)))
})
test('rotulo do passo', () => {
  assert.deepEqual(stepLabel({ kind: 'edit', tool: 'Edit', target: 'a.ts' }), { verb: 'Editado', target: 'a.ts' })
  assert.deepEqual(stepLabel({ kind: 'run', tool: 'npm test' }), { verb: 'Executado', target: 'npm test' })
})
