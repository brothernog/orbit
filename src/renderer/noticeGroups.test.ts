import test from 'node:test'
import assert from 'node:assert/strict'
import { groupNotices } from './noticeGroups.ts'

test('agrupa por projeto sem diferenciar maiusculas, na ordem do aviso mais novo', () => {
  const l = [{ k: 1, game: 'C:/b' }, { k: 2, game: 'C:/a' }, { k: 3, game: 'c:/B' }]
  assert.deepEqual(groupNotices(l).map(g => g.map(x => x.k)), [[1, 3], [2]])
  assert.deepEqual(groupNotices([]), [])
})
