// Agentes ativos de uma tarefa: pai em curso + filhos da MESMA execucao, ferramenta atual so de quem ainda roda. Banco sintetico.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { createTask } from './tasks.ts'
import { taskAgents } from './agentsLive.ts'

const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-live-')), 't.db'))
const add = (taskId: number, runId: number, status: string, objective: string) => Number(db.prepare(
  "INSERT INTO delegations (task_id, parent_run_id, provider, model, mode, objective, status, started_at) VALUES (?,?,?,?,?,?,?,'2026-01-01 10:00:00')"
).run(taskId, runId, 'codex', 'gpt-x', 'read', objective, status).lastInsertRowid)

test('sem pai rodando: ninguem ativo', () => {
  const t = createTask(db, 'C:/jogo', 'a')
  add(t, 1, 'running', 'x')
  assert.deepEqual(taskAgents(db, t, undefined, new Map()), [])
})

test('pai + filhos da execucao atual; filho de outra execucao fica de fora; doing so de quem roda', () => {
  const t = createTask(db, 'C:/jogo', 'b')
  add(t, 5, 'completed', 'antigo')
  const run = add(t, 7, 'running', 'investigar colisao')
  const done = add(t, 7, 'failed', 'rodar testes')
  const doing = new Map([[run, { tool: 'Read', detail: 'a.gd' }], [done, { tool: 'Bash' }]])
  const list = taskAgents(db, t, { runId: 7, provider: 'claude', model: 'opus', startedAt: 1, doing: { tool: 'Edit' } }, doing)
  assert.deepEqual(list.map(a => [a.kind, a.title, a.status, a.doing?.tool]), [
    ['parent', '', 'running', 'Edit'], ['child', 'investigar colisao', 'running', 'Read'], ['child', 'rodar testes', 'failed', undefined]
  ])
  assert.equal(list[1].startedAt, Date.parse('2026-01-01T10:00:00Z'))
  assert.equal(list[1].endedAt, null)
})
