import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOf, initials, moveTo, newGroup, placeBefore, taskToRemember } from './groups.ts'

test('grupos: projeto fica em um grupo so, mover abre o destino, null tira do grupo', () => {
  let g = newGroup([], 'Trabalho', '#7cc4ff', ['A', 'B'])
  g = newGroup(g, 'Jogos', '#69d6b5', ['B'])
  assert.deepEqual(g.map(x => [x.name, x.games]), [['Trabalho', ['A']], ['Jogos', ['B']]])
  g = moveTo(g.map(x => ({ ...x, open: false })), 'A', g[1].id)
  assert.deepEqual(g.map(x => [x.games, x.open]), [[[], false], [['B', 'A'], true]])
  assert.equal(groupOf(moveTo(g, 'A', null), 'A'), null)
  assert.equal(groupOf(g, 'B')?.name, 'Jogos')
})

test('sigla do workspace', () => {
  assert.equal(initials('Case Opened'), 'CO')
  assert.equal(initials('trace'), 'TR')
  assert.equal(initials('fx-webhook'), 'FW')
})

test('reordenar arrastando', () => {
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(placeBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c'])
  assert.deepEqual(placeBefore(['a', 'b'], 'a', null), ['b', 'a'])
})

test('ultima tarefa: abrir tarefa de outra pasta nao grava a tarefa da pasta anterior como a da nova', () => {
  const a = [{ id: 1, game: 'C:/A' }], b = [{ id: 7, game: 'C:/B' }]
  assert.equal(taskToRemember('C:/B', 1, a), null) // render da troca: game=B, mas taskId/tasks ainda sao de A
  assert.equal(taskToRemember('C:/B', 7, b), 7)
  assert.equal(taskToRemember('c:/b', 7, b), 7)
  assert.equal(taskToRemember('C:/B', null, b), null)
  assert.equal(taskToRemember('C:/B', 7, null), null)
})
