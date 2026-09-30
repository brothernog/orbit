import test from 'node:test'
import assert from 'node:assert/strict'
import { createPulse, delta, type Totals } from './pulse.ts'

const T = (o: Record<string, [number, number]>): Totals => new Map(Object.entries(o).map(([f, [a, r]]) => [f, { a, r }]))
const tick = () => new Promise(r => setTimeout(r, 5))

test('delta: escrever, apagar e commit (arquivo sai da lista) nao viram a mesma coisa', () => {
  assert.deepEqual(delta(T({}), T({ 'a.gd': [10, 0] })), { v: 10, del: false })
  assert.deepEqual(delta(T({ 'a.gd': [10, 0] }), T({ 'a.gd': [10, 8] })), { v: 8, del: true })
  assert.deepEqual(delta(T({ 'a.gd': [10, 2] }), T({ 'a.gd': [4, 2] })), { v: 6, del: true }) // adicao desfeita
  assert.deepEqual(delta(T({ 'a.gd': [10, 2] }), T({})), { v: 0, del: false }) // commit: nada gravado
})

test('pulso: linha de base ao entrar, evento por rodada de gravacao com o provedor, sai quem terminou', async () => {
  let clock = 1_000_000
  const samples: Totals[] = [T({ 'velho.gd': [50, 0] }), T({ 'velho.gd': [50, 0], 'novo.gd': [12, 0] }), T({ 'velho.gd': [50, 0], 'novo.gd': [12, 0] })]
  let fire: (() => void) | null = null, closed = 0, got: string[] = []
  const p = createPulse({
    watch: (_d, cb) => { fire = cb; return () => { closed++ } },
    sample: async () => samples.shift()!,
    onEvent: g => got.push(g), now: () => clock, settleMs: 0,
  })
  p.track([{ dir: 'C:/jogo', game: 'C:/jogo', provider: 'claude' }])
  await tick()
  assert.deepEqual(p.events(), {}) // o que ja estava sujo nao vira pico
  fire!(); await tick(); await tick()
  assert.deepEqual(p.events()['C:/jogo'], [{ t: clock, v: 12, provider: 'claude', del: false }])
  assert.deepEqual(got, ['C:/jogo'])
  fire!(); await tick(); await tick()
  assert.equal(p.events()['C:/jogo'].length, 1) // gravacao sem mudanca de linhas: sem evento
  p.track([])
  assert.equal(closed, 1)
  clock += 3600_001
  assert.deepEqual(p.events(), {}) // passou uma hora: some
})
