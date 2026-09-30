import assert from 'node:assert/strict'
import test from 'node:test'
import { ago, agoText, clock, elapsedMin, minutesSince, same, sqlDate } from './time.ts'

test('datas do SQLite sao UTC; ISO com Z nao ganha outro Z', () => {
  assert.equal(sqlDate('2026-01-02 10:00:00').toISOString(), '2026-01-02T10:00:00.000Z')
  assert.equal(sqlDate('2026-01-02T10:00:00.000Z').toISOString(), '2026-01-02T10:00:00.000Z')
})

test('textos relativos', t => {
  const now = Date.parse('2026-01-02T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  assert.equal(ago('2026-01-02 11:59:00'), 'agora')
  assert.equal(ago('2026-01-02 11:30:00'), '30 min')
  assert.equal(ago('2026-01-02T09:00:00Z'), '3 h')
  assert.equal(ago('2025-12-30 12:00:00'), '3 d')
  assert.equal(ago('2026-01-02 12:05:00'), '') // futuro (relogio adiantado)
  assert.equal(ago('lixo'), '')
  assert.equal(agoText('2026-01-02 11:59:00'), 'agora')
  assert.equal(agoText('2026-01-02T11:30:00.000Z'), 'há 30 min')
  assert.equal(minutesSince('2026-01-02 11:30:00'), 30)
  assert.equal(minutesSince(null), Infinity)
  assert.equal(clock(now - 247_000), '4:07')
  assert.equal(clock(now - 3_900_000), '1h 05m')
  assert.equal(clock(now + 5000), '0:00')
  assert.equal(elapsedMin(now - 12 * 60000), '12 min')
  assert.equal(elapsedMin(now - 65 * 60000), '1h 5min')
})

test('mesma pasta sem diferenciar caixa', () => {
  assert.ok(same('C:\\Jogos\\A', 'c:\\jogos\\a'))
  assert.ok(!same('C:\\Jogos\\A', 'C:\\Jogos\\B'))
})
