import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { inUse, moons, planetLayout, planetUsage } from './planet.ts'

const now = Date.parse('2026-09-29T10:00:00Z')
const w = (utilization: number, resets_at: string) => ({ utilization, resets_at })

test('planeta: a janela de 5 h vai no planeta mesmo com a semanal mais alta; a semanal segue para a dica', () => {
  assert.deepEqual(planetUsage('Claude, A', { fiveHour: w(30, '2026-09-29T12:00:00Z'), sevenDay: w(55, '2026-10-02T00:00:00Z') }, now),
    { source: 'Claude, A', pct: 30, window: '5h', resetsAt: '2026-09-29T12:00:00Z', week: 55 })
})

test('planeta: 5 h ja reiniciada cai para a semanal; sem janela viva, sem numero (nunca 0)', () => {
  assert.deepEqual(planetUsage('Codex', { fiveHour: w(90, '2026-09-29T09:00:00Z'), sevenDay: w(40, '2026-10-02T00:00:00Z') }, now),
    { source: 'Codex', pct: 40, window: 'semana', resetsAt: '2026-10-02T00:00:00Z' })
  assert.deepEqual(planetUsage('Codex', { fiveHour: w(10, '2026-09-29T08:00:00Z') }, now), { source: 'Codex' })
  assert.deepEqual(planetUsage('Claude, B', null, now), { source: 'Claude, B' })
})

test('planeta: contas em uso = rodando agora (sem repetir); sem nada rodando, a da execucao mais recente', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  assert.deepEqual(inUse(db), [])
  const run = (provider: string, account: number | null, status: string) =>
    db.prepare("INSERT INTO runs (chat_key, task_id, provider, account_id, status) VALUES ('', 1, ?, ?, ?)").run(provider, account, status)
  run('claude', 1, 'completed'); run('codex', null, 'completed'); run('gemini', null, 'completed')
  assert.deepEqual(inUse(db), [{ provider: 'codex' }]) // gemini nao informa limite: vale o ultimo claude/codex
  run('claude', 2, 'running'); run('claude', 2, 'running')
  db.prepare("INSERT INTO delegations (task_id, provider, mode, objective, status) VALUES (1, 'codex', 'write', 'x', 'running')").run()
  assert.deepEqual(inUse(db), [{ provider: 'claude', accountId: 2 }, { provider: 'codex' }])
})

test('planeta: o aviso cresce para o centro da tela com o planeta parado; altura limitada ao espaco ate a borda', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 }
  // canto inferior direito: abre para cima e para a esquerda, planeta no canto inferior direito da janela
  assert.deepEqual(planetLayout({ x: 1780, y: 900 }, wa, 132, { width: 420, height: 300 }),
    { right: true, bottom: true, bounds: { x: 1492, y: 732, width: 420, height: 300 } })
  // canto superior esquerdo: abre para baixo e para a direita
  assert.deepEqual(planetLayout({ x: 10, y: 10 }, wa, 132, { width: 420, height: 300 }),
    { right: false, bottom: false, bounds: { x: 10, y: 10, width: 420, height: 300 } })
  // aviso mais alto que o espaco: corta na borda; mais baixo que o planeta: nunca menor que ele
  assert.equal(planetLayout({ x: 1780, y: 600 }, wa, 132, { width: 420, height: 2000 }).bounds.height, 732)
  assert.equal(planetLayout({ x: 1780, y: 900 }, wa, 132, { width: 420, height: 40 }).bounds.height, 132)
  assert.deepEqual(planetLayout({ x: 50, y: 900 }, wa, 132).bounds, { x: 50, y: 900, width: 132, height: 132 })
})

test('planeta: luas = agentes trabalhando (direto ou delegados, rodando ou esperando aprovacao); terminados saem', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.prepare("INSERT INTO tasks (game, title) VALUES ('/g', 'Menu de pausa')").run()
  const del = (provider: string, status: string, objective: string) =>
    db.prepare("INSERT INTO delegations (task_id, provider, mode, objective, status) VALUES (1, ?, 'write', ?, ?)").run(provider, objective, status)
  const run = (provider: string, status: string) => db.prepare("INSERT INTO runs (chat_key, task_id, provider, status) VALUES ('', 1, ?, ?)").run(provider, status)
  del('codex', 'running', 'Corrigir pulo'); del('gemini', 'completed', 'Antiga'); del('claude', 'awaiting_context_approval', 'Revisar HUD')
  run('opencode', 'running'); run('claude', 'completed')
  assert.deepEqual(moons(db), [
    { key: 'r1', slot: 1, provider: 'opencode', delegated: false, waiting: false, title: 'Menu de pausa' },
    { key: 'd1', slot: 4, provider: 'codex', delegated: true, waiting: false, title: 'Corrigir pulo' },
    { key: 'd3', slot: 10, provider: 'claude', delegated: true, waiting: true, title: 'Revisar HUD' }
  ])
})
