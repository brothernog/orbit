import assert from 'node:assert/strict'
import test from 'node:test'
import { resetText, usageNote } from './usageText.ts'

test('renovacao: tempo restante em ate 24 h, dia e hora depois', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')
  assert.equal(resetText('2026-09-28T16:16:00Z', now), 'Reinicia em 4 h 16 min')
  assert.equal(resetText('2026-09-28T12:05:00Z', now), 'Reinicia em 5 min')
  assert.equal(resetText('2026-09-28T11:00:00Z', now), 'Reiniciando')
  assert.ok(/^Reinicia (?!em)/.test(resetText('2026-10-01T19:00:00Z', now)))
  assert.equal(resetText('lixo', now), '')
  assert.equal(resetText(null, now), '')
})

test('snapshots identificam origem, idade e falha sem inventar data', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')
  assert.equal(usageNote({ seenAt: '2026-09-28T11:30:00Z', cached: true }, 'claude', now), 'Último valor visto há 30 min.')
  assert.equal(usageNote({ cached: true, refreshError: 'indisponivel' }, 'claude', now), 'Último valor visto (data indisponível) (consulta indisponível agora).')
  assert.equal(usageNote({ seenAt: '2026-09-28T11:21:00Z' }, 'codex', now), 'Do último uso do Codex há 39 min.')
  assert.equal(usageNote({ seenAt: 'invalido' }, 'claude', now), '')
  assert.equal(usageNote(null), '')
})
