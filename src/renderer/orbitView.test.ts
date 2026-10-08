import test from 'node:test'
import assert from 'node:assert/strict'
import { latestOrbitFile, mergeOrbitAgents, orbitDiffPosition, orbitTaskFiles } from './orbitView.ts'
import type { OrbitAgent } from './api.ts'

const agent = (id: string, path: string, at: number): OrbitAgent => ({ id, provider: 'codex', active: true,
  activity: { kind: 'read', path, line: 8, position: 'reported', at },
  events: [{ kind: 'read', path, line: 8, position: 'reported', at }] })

test('fotografia atrasada não apaga atividade recebida nem agentes novos', () => {
  const old = agent('a', 'src/old.ts', 1), current = agent('a', 'src/new.ts', 2), second = agent('b', 'src/b.ts', 3)
  assert.deepEqual(mergeOrbitAgents([old], [current, second]), [current, second])
  assert.equal(latestOrbitFile({ ...current, activity: { kind: 'thinking', summary: 'Resumo exposto', at: 4 } })?.path, 'src/new.ts')
  assert.equal(latestOrbitFile({ ...current, lastFile: current.activity, events: [], activity: { kind: 'thinking', at: 5 } })?.path, 'src/new.ts')
})

test('posição estimada vem do primeiro trecho, inclusive exclusão completa', () => {
  assert.deepEqual(orbitDiffPosition('@@ -7,3 +8,2 @@\n+x\n@@ -80 +81 @@'), { line: 8, endLine: 9, position: 'diff' })
  assert.deepEqual(orbitDiffPosition('@@ -1,3 +0,0 @@\n-x'), { line: 1, endLine: 1, position: 'diff' })
  assert.equal(orbitDiffPosition('Binary files differ'), undefined)
})

test('planeta reúne visitas e gravações da tarefa sem outros arquivos do projeto', () => {
  const files = orbitTaskFiles([agent('a', 'src/visited.ts', 1)], [
    { path: 'src/visited.ts', added: 3, removed: 1, lastWrite: 50 },
    { path: 'src/other-task.ts', added: 9, removed: 2, lastWrite: 50 }
  ], { 'src/written.ts': 90 }, 100)
  assert.deepEqual(files, [
    { path: 'src/visited.ts', added: 3, removed: 1, updatedAt: 50, hot: true },
    { path: 'src/written.ts', added: null, removed: null, updatedAt: 90, hot: true }
  ])
  assert.equal(orbitTaskFiles([agent('a', 'src/visited.ts', 1)], [], {}, 10000)[0].hot, false)
  assert.deepEqual(orbitTaskFiles([{ ...agent('a', 'C:/attachments/image.png', 1), visited: ['src/retained.ts'] }], [], {}, 10000).map(f => f.path), ['src/retained.ts'])
  const edit = { kind: 'edit' as const, path: 'src/visited.ts', added: 2, removed: 1, at: 80 }
  const counted = orbitTaskFiles([{ ...agent('a', 'src/visited.ts', 1), events: [edit] }], [
    { path: 'src/visited.ts', added: 30, removed: 12, lastWrite: 50 }
  ], {}, 100)[0]
  assert.equal(counted.editAdded, 2); assert.equal(counted.editRemoved, 1)
  assert.equal(counted.added, 30); assert.equal(counted.removed, 12)
})

import { orbitAddedLines } from './orbitView.ts'
test('orbitAddedLines numera linhas adicionadas pelo arquivo novo', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10 +11 @@', '+z'].join('\n')
  assert.deepEqual([...orbitAddedLines(diff)], [2, 3, 11])
})
