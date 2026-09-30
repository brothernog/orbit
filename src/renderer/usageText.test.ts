import assert from 'node:assert/strict'
import test from 'node:test'
import { resetText } from './usageText.ts'

test('renovacao: tempo restante em ate 24 h, dia e hora depois', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')
  assert.equal(resetText('2026-09-28T16:16:00Z', now), 'Reinicia em 4 h 16 min')
  assert.equal(resetText('2026-09-28T12:05:00Z', now), 'Reinicia em 5 min')
  assert.equal(resetText('2026-09-28T11:00:00Z', now), 'Reiniciando')
  assert.ok(/^Reinicia (?!em)/.test(resetText('2026-10-01T19:00:00Z', now)))
  assert.equal(resetText('lixo', now), '')
})
