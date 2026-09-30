import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBeforeSend, normalizeRules, usedPercent, type Rule, type SendCtx } from './automations.ts'
import type { AccountUsage } from './accountUsage.ts'

const now = Date.parse('2026-09-30T20:00:00Z')
const at = (pct: number, resets = '2026-10-01T00:00:00Z'): AccountUsage => ({ fiveHour: { utilization: pct, resets_at: resets }, sevenDay: null })
const rule: Rule = { id: 'r1', enabled: true, when: { kind: 'usage_above', percent: 95 }, then: { kind: 'switch_account', order: [] } }
const ctx = (usage: Record<number, AccountUsage | null>, accountId = 1): SendCtx => ({
  sel: { provider: 'claude', accountId, model: 'opus' }, now,
  usage: id => usage[id] ?? null,
  peers: id => [1, 2, 3].filter(x => x !== id),
  accountName: id => `c${id}`
})

test('troca para a proxima conta abaixo do limite, mantendo modelo', () => {
  const r = applyBeforeSend([rule], ctx({ 1: at(97), 2: at(99), 3: at(10) }))
  assert.deepEqual(r.sel, { provider: 'claude', accountId: 3, model: 'opus' })
  assert.match(r.notes[0], /c1 em 97%.*c3/)
})

test('ordem da regra tem prioridade; uso desconhecido conta como disponivel', () => {
  const r = applyBeforeSend([{ ...rule, then: { kind: 'switch_account', order: [3, 2] } }], ctx({ 1: at(100) }))
  assert.equal(r.sel.accountId, 3)
})

test('nao dispara abaixo do limite, desligada, fora do Claude ou com janela ja reiniciada', () => {
  assert.equal(applyBeforeSend([rule], ctx({ 1: at(50) })).sel.accountId, 1)
  assert.equal(applyBeforeSend([{ ...rule, enabled: false }], ctx({ 1: at(99) })).sel.accountId, 1)
  assert.equal(applyBeforeSend([rule], { ...ctx({ 1: at(99) }), sel: { provider: 'codex' } }).sel.provider, 'codex')
  assert.equal(applyBeforeSend([rule], ctx({ 1: at(99, '2026-09-30T19:00:00Z') })).sel.accountId, 1)
  assert.equal(usedPercent(at(99, '2026-09-30T19:00:00Z'), now), null)
})

test('sem conta livre: mantem a atual e avisa', () => {
  const r = applyBeforeSend([rule], ctx({ 1: at(99), 2: at(96), 3: at(100) }))
  assert.equal(r.sel.accountId, 1)
  assert.match(r.notes[0], /nenhuma outra conta/)
})

test('normalizeRules descarta regra desconhecida e limita valores', () => {
  const n = normalizeRules([
    { id: 'a', enabled: true, when: { kind: 'usage_above', percent: 150 }, then: { kind: 'switch_account', order: [2, -1, 'x'] } },
    { id: 'b', enabled: true, when: { kind: 'rm_rf' }, then: { kind: 'switch_account' } },
    { id: 'bad id!', when: { kind: 'usage_above', percent: 90 }, then: { kind: 'switch_account' } }
  ])
  assert.deepEqual(n, [{ id: 'a', enabled: true, when: { kind: 'usage_above', percent: 100 }, then: { kind: 'switch_account', order: [2] } }])
  assert.deepEqual(normalizeRules('lixo'), [])
})
