// Sugestoes de tarefa (suggest_task): registro validado, limite e duplicata, dispensar, usar (cria a tarefa, nao envia) e exclusao. Banco sintetico.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { createTask, deleteTask, getTask } from './tasks.ts'
import { dismissSuggestion, listSuggestions, MAX_OPEN, startSuggestion, suggestTask } from './suggestions.ts'

const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-sug-')), 't.db'))
const S = { title: 'Corrigir colisao na rampa', tldr: 'O inimigo atravessa a rampa do nivel 2.', prompt: 'Em scenes/level2.tscn o CollisionShape da rampa...' }

test('registrar: valida campos, evita duplicata e limita os cartoes abertos por tarefa', () => {
  const t = createTask(db, 'C:/jogo', 'Origem')
  const ok = suggestTask(db, { taskId: t, runId: 1, provider: 'claude' }, S)
  assert.equal(ok.isError, false)
  assert.match(ok.text, /Continue o trabalho atual/)
  const [s] = listSuggestions(db, t)
  assert.deepEqual([s.title, s.tldr, s.prompt, s.provider, s.state], [S.title, S.tldr, S.prompt, 'claude', 'open'])
  assert.match(suggestTask(db, { taskId: t }, { ...S, title: S.title.toUpperCase() }).text, /Ja existe/) // duplicata nao cria outro cartao
  for (const bad of [{}, { ...S, prompt: ' ' }, { ...S, title: 'x'.repeat(81) }, { ...S, tldr: 3 }]) assert.equal(suggestTask(db, { taskId: t }, bad).isError, true)
  for (let i = 1; i < MAX_OPEN; i++) suggestTask(db, { taskId: t }, { ...S, title: `Item ${i}` })
  const full = suggestTask(db, { taskId: t }, { ...S, title: 'Mais um' })
  assert.equal(full.isError, true)
  assert.equal(listSuggestions(db, t).length, MAX_OPEN)
})

test('usar cria uma tarefa nova no mesmo projeto e devolve a ordem para o compositor; dispensar some; uma vez so', () => {
  const t = createTask(db, 'C:/jogo2', 'Origem')
  suggestTask(db, { taskId: t }, S); suggestTask(db, { taskId: t }, { ...S, title: 'Outra' })
  const [a, b] = listSuggestions(db, t)
  const r = startSuggestion(db, a.id)
  assert.deepEqual([r.game, r.text, getTask(db, r.taskId).title], ['C:/jogo2', S.prompt, S.title])
  assert.equal((db.prepare('SELECT COUNT(*) n FROM messages WHERE task_id=?').get(r.taskId) as any).n, 0) // nada foi enviado
  assert.throws(() => startSuggestion(db, a.id), /ja foi usada/)
  const tasks = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n
  dismissSuggestion(db, b.id)
  assert.throws(() => startSuggestion(db, b.id), /ja foi usada/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, tasks) // falha nao cria tarefa (transacao)
  assert.throws(() => dismissSuggestion(db, b.id))
  assert.deepEqual(listSuggestions(db, t), [])
})

test('excluir a tarefa de origem apaga as sugestoes dela; a tarefa criada nao guarda vinculo', () => {
  const t = createTask(db, 'C:/jogo3', 'Origem')
  suggestTask(db, { taskId: t }, S); suggestTask(db, { taskId: t }, { ...S, title: 'Outra' })
  const made = startSuggestion(db, listSuggestions(db, t)[0].id).taskId
  deleteTask(db, t)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM task_suggestions WHERE task_id=?').get(t) as any).n, 0)
  assert.equal(getTask(db, made).title, S.title) // a tarefa nova continua
  deleteTask(db, made)
})
