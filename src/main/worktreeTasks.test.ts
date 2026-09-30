import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db.ts'
import { createPackage, finishDelivery, getPackage, openGrant, recordDelivery, resolvePackage } from './consent.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { createSend, getSend, recoverSend } from './sends.ts'
import { createTask, getTask, saveSession, taskForPin } from './tasks.ts'
import { resetWorkspace, unlinkWorktree } from './worktreeTasks.ts'

const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
function fixture(t: any) {
  const db = new DatabaseSync(':memory:'); migrate(db); t.after(() => db.close())
  const task = createTask(db, 'game', 'Tarefa'), other = createTask(db, 'game', 'Outra')
  const pkg = (id = task) => createPackage(db, DEFAULT_LIMITS, { taskId: id, source: 'history', issuer: 'dashboard',
    recipient: { logicalId: `chat:${id}:codex:`, provider: 'codex', profile: '', workspace: 'game/.worktrees/task', scope: [] },
    items: [{ ref: 'history', kind: 'history', title: 'Histórico', content: 'Conteúdo preservado.' }] })
  const pending = pkg(), extra = pkg(), approved = pkg(), untouched = pkg(other)
  resolvePackage(db, { id: approved.id, hash: approved.hash, decision: 'approve' })
  finishDelivery(db, recordDelivery(db, approved, 'native-session'), 'confirmed')
  openGrant(db, { taskId: task, recipient: approved.recipient, sessionId: 'native-session' })
  const send = createSend(db, { taskId: task, packageId: pending.id, text: 'Ordem recuperável.', sel: { provider: 'codex' } })
  for (const id of [task, other]) for (const [provider, profile] of [['codex', ''], ['claude', '1'], ['claude', '2']]) {
    saveSession(db, id, provider, profile, `session-${id}-${provider}-${profile}`)
    db.prepare('INSERT INTO metrics(task_id,provider,profile,at,occupied) VALUES (?,?,?,?,?)').run(id, provider, profile, 'now', 42)
  }
  return { db, task, other, pending, extra, approved, untouched, send }
}

test('trocar workspace invalida só pendentes e sessões; conserva texto, consentimento aprovado e evidências', t => {
  const f = fixture(t), { db, task, other } = f
  db.prepare("INSERT INTO messages(chat_key,task_id,role,text) VALUES ('',?,'user','Histórico humano')").run(task)
  db.prepare("INSERT INTO runs(chat_key,task_id,provider,status,partial) VALUES ('',?,'codex','completed','Resposta anterior')").run(task)
  db.prepare("INSERT INTO memory_items(task_id,owner,lineage,kind,title,content,hash,norm) VALUES (?,'user','user','decision','Decisão','Memória','hash','memória')").run(task)
  db.prepare("INSERT INTO usage_records(task_id,provider,input,output) VALUES (?,'codex',NULL,12)").run(task)
  db.prepare("INSERT INTO command_runs(task_id,workspace,name,program,args,status,output,exit_code) VALUES (?,'game/.worktrees/task','Build','node','[]','completed','Saída',0)").run(task)
  db.prepare("INSERT INTO project_builds(game,title,version,platform,hash,size,file_name,notes,source_task_id,source_command_id,command) VALUES ('game','Build','1','desktop','hash',10,'build.zip','Revisado',?,1,'{\"workspace\":\"game/.worktrees/task\"}')").run(task)
  const tables = ['messages', 'runs', 'memory_items', 'usage_records', 'command_runs', 'project_builds', 'context_deliveries', 'exec_grants']
  const snapshots = tables.map(table => rows(db, table)), approvedBefore = getPackage(db, f.approved.id)
  assert.deepEqual(resetWorkspace(db, [task, task], 'Pasta alterada.'), { packageIds: [f.pending.id, f.extra.id] })
  assert.deepEqual(rows(db, 'task_sessions').map((r: any) => r.task_id), [other, other, other])
  assert.deepEqual(rows(db, 'metrics').map((r: any) => r.task_id), [other, other, other])
  assert.equal(getPackage(db, f.pending.id)!.state, 'cancelled')
  assert.equal(getPackage(db, f.extra.id)!.reason, 'Pasta alterada.')
  assert.deepEqual(getPackage(db, f.approved.id), approvedBefore)
  assert.equal(getPackage(db, f.untouched.id)!.state, 'pending')
  assert.equal(getSend(db, f.send.id)!.state, 'cancelled')
  assert.equal(recoverSend(db, f.send.id), 'Ordem recuperável.')
  for (let i = 0; i < tables.length; i++) assert.deepEqual(rows(db, tables[i]), snapshots[i], tables[i])
  assert.deepEqual(resetWorkspace(db, [], 'Sem mudança.'), { packageIds: [] })
  assert.throws(() => resetWorkspace(db, [0], 'Inválido.'), /tarefa invalido/)
})

test('remover worktree limpa todas as referências, inclusive alias após remoção; pin não recria vínculo', t => {
  const { db, task, other } = fixture(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-worktree-tasks-'))
  assert.equal(path.resolve(path.dirname(root)), path.resolve(os.tmpdir()))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const parent = path.join(root, 'worktrees'), alias = path.join(root, 'alias')
  fs.mkdirSync(parent); fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const removed = path.join(parent, 'removed'), pinPath = path.join(alias, 'removed')
  const pin = Number(db.prepare("INSERT INTO pins(game,title,worktree,branch) VALUES ('game','Problema',?,'task/source')").run(pinPath).lastInsertRowid)
  const orphanPin = Number(db.prepare("INSERT INTO pins(game,title,worktree,branch) VALUES ('game','Sem tarefa',?,'task/source')").run(removed.toUpperCase()).lastInsertRowid)
  const same = createTask(db, 'game', 'Mesma pasta')
  db.prepare("UPDATE tasks SET pin_id=?,worktree=?,branch='task/source' WHERE id=?").run(pin, pinPath, task)
  db.prepare("UPDATE tasks SET worktree=?,branch='task/source' WHERE id=?").run(path.join(parent, '.', 'removed'), same)
  db.prepare("UPDATE tasks SET pin_id=?,worktree=?,branch='task/other' WHERE id=?").run(pin, path.join(parent, 'other'), other)
  const result = unlinkWorktree(db, removed)
  assert.deepEqual(result.taskIds, [task, same])
  assert.deepEqual([getTask(db, task).worktree, getTask(db, task).branch, getTask(db, same).worktree], [null, null, null])
  assert.deepEqual(rows(db, 'pins').map((p: any) => [p.worktree, p.branch]), [[null, null], [null, null]])
  const newTask = taskForPin(db, db.prepare('SELECT * FROM pins WHERE id=?').get(orphanPin))
  assert.deepEqual([getTask(db, newTask).worktree, getTask(db, newTask).branch], [null, null])
  assert.equal(getTask(db, other).worktree, path.join(parent, 'other'))
  assert.equal(getTask(db, other).branch, 'task/other')
  assert.deepEqual(unlinkWorktree(db, removed), { taskIds: [], packageIds: [] })
})

test('envio iniciando ou execução viva impede mudança sem cancelar nada', t => {
  const f = fixture(t), { db, task, other } = f
  const cases = [
    ["INSERT INTO pending_sends(task_id,text,sel,state) VALUES (?,'Ordem','{}','starting')", 'pending_sends'],
    ["INSERT INTO delegations(task_id,provider,mode,objective,status) VALUES (?,'codex','execute','Objetivo','running')", 'delegations'],
    ["INSERT INTO delegations(task_id,provider,mode,objective,status) VALUES (?,'codex','execute','Objetivo','awaiting_context_approval')", 'delegations'],
    ["INSERT INTO runs(chat_key,task_id,status) VALUES ('',?,'running')", 'runs'],
    ["INSERT INTO command_runs(task_id,workspace,name,program,args) VALUES (?,'game','Teste','node','[]')", 'command_runs']
  ]
  for (const [sql, table] of cases) {
    const id = Number(db.prepare(sql).run(other).lastInsertRowid)
    assert.throws(() => resetWorkspace(db, [task, other], 'Mudança.'), /Pare as execuções/)
    assert.equal(rows(db, 'task_sessions').length, 6)
    assert.equal(getPackage(db, f.pending.id)!.state, 'pending')
    assert.equal(getSend(db, f.send.id)!.state, 'awaiting_context_approval')
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)
  }
})

test('savepoints respeitam transação do caller e falhas revertem referências e cancelamentos juntos', t => {
  const f = fixture(t), { db, task } = f
  db.exec('BEGIN')
  resetWorkspace(db, [task], 'Pasta alterada.')
  assert.equal(getSend(db, f.send.id)!.state, 'cancelled')
  db.exec('ROLLBACK')
  assert.equal(getSend(db, f.send.id)!.state, 'awaiting_context_approval')
  assert.equal(rows(db, 'task_sessions').length, 6)
  db.prepare("UPDATE tasks SET worktree='game/.worktrees/task',branch='task/source' WHERE id=?").run(task)
  db.exec("CREATE TRIGGER fail_workspace BEFORE UPDATE OF worktree ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  assert.throws(() => unlinkWorktree(db, 'game/.worktrees/task'), /synthetic failure/)
  assert.equal(getTask(db, task).worktree, 'game/.worktrees/task')
  assert.equal(getTask(db, task).branch, 'task/source')
  assert.equal(getPackage(db, f.pending.id)!.state, 'pending')
  assert.equal(getSend(db, f.send.id)!.state, 'awaiting_context_approval')
  assert.equal(rows(db, 'metrics').length, 6)
  assert.equal(rows(db, 'task_sessions').length, 6)
})
