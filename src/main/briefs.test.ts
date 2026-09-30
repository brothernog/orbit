import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import { finishRun, startRun } from './runs.ts'
import { createTask } from './tasks.ts'
import { addMemory } from './memory.ts'
import { taskBriefs } from './briefs.ts'

const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-brief-')), 't.db'))
const G = 'C:/jogo'

test('resumo sai da memoria da tarefa; sem memoria, da primeira frase da ultima resposta', () => {
  const a = createTask(db, G), b = createTask(db, G)
  finishRun(db, startRun(db, { taskId: a, provider: 'claude' }, 'oi'), { status: 'completed', text: 'Achei o bug em `a.ts`. Depois explico o resto.', notes: [] })
  finishRun(db, startRun(db, { taskId: b, provider: 'codex' }, 'oi'), { status: 'failed', text: '', notes: [], error: 'x' })
  const mem = (kind: string, title: string, todoState?: string) => addMemory(db, { taskId: b, owner: 'run', lineage: 'x', kind, title, content: title, todoState })
  mem('objective', 'Corrigir o save'); mem('checkpoint', 'Save grava em JSON'); mem('todo', 'Testar no Windows'); mem('todo', 'Ja feito', 'done')
  const [ba, bb] = [a, b].map(id => taskBriefs(db, G).find(x => x.id === id)!)
  assert.deepEqual([ba.last, ba.result, ba.goal, ba.next], ['completed', 'Achei o bug em a.ts.', null, null])
  assert.deepEqual([bb.last, bb.goal, bb.result, bb.next, bb.awaiting], ['failed', 'Corrigir o save', 'Save grava em JSON', 'Testar no Windows', false])
})

test('pedido de permissao pendente aparece no resumo; resolvido some', () => {
  const t = createTask(db, G)
  const ins = db.prepare("INSERT INTO permission_requests (task_id, provider, tool, kind, command, summary, cwd, state) VALUES (?, 'claude', 'Bash', 'bash', 'npm test', 'Rodar: npm test', 'C:/jogo', ?)")
  ins.run(t, 'denied')
  assert.equal(taskBriefs(db, G).find(x => x.id === t)!.permission, null)
  ins.run(t, 'pending')
  assert.equal(taskBriefs(db, G).find(x => x.id === t)!.permission, 'Rodar: npm test')
})
