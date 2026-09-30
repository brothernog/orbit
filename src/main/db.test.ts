import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate, openDb } from './db.ts'
import { composeReply, finishRun, reconcileRuns, savePartial, startRun } from './runs.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-db-'))
const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as any).user_version
const rows = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

// Banco como a versao ANTERIOR do app o criava: so v1, sem user_version, com contexto real de uso.
export function legacyDb(file: string) {
  const db = new DatabaseSync(file)
  MIGRATIONS[0](db)
  db.prepare("INSERT INTO accounts (name, config_dir) VALUES ('Principal', NULL), ('Segunda', 'C:/x')").run()
  db.prepare("INSERT INTO pins (game, title, status, agent, account_id, branch, worktree) VALUES ('C:/g', 'Bug do pulo', 'andamento', 'claude', 1, 'pin/1-bug-do-pulo', 'C:/g/.worktrees/pin-1-bug-do-pulo')").run()
  db.prepare("INSERT INTO pins (game, title, status) VALUES ('C:/g', 'Tela azul', 'feito'), ('C:/g', 'Novo', 'aberto')").run()
  const add = (key: string, role: string, text: string) => db.prepare('INSERT INTO messages (chat_key, role, text) VALUES (?,?,?)').run(key, role, text)
  const K = { pinClaude: 'pin:1|claude|1', pinCodex: 'pin:1|codex|', gameClaude2: 'game:C:/g|claude|2', gameGemini: 'game:C:/g|gemini|', orphanPin: 'pin:99|opencode|' }
  add(K.pinClaude, 'user', 'a1'); add(K.pinClaude, 'agent', 'a2')
  add(K.gameClaude2, 'user', 'b1'); add(K.pinCodex, 'user', 'c1'); add(K.pinClaude, 'user', 'a3')
  add(K.gameGemini, 'user', 'd1'); add(K.gameGemini, 'agent', 'd2'); add(K.orphanPin, 'user', 'e1')
  for (const [k, s] of [[K.pinClaude, 'sess-claude'], [K.pinCodex, 'sess-codex'], [K.gameClaude2, 'sess-c2']]) db.prepare('INSERT INTO chats (key, session_id) VALUES (?,?)').run(k, s)
  return db
}

test('migra banco antigo para tarefas preservando mensagens, ordem, sessoes, contas e worktrees', () => {
  const file = path.join(tmp, 'a.db')
  legacyDb(file).close()
  const db = openDb(file)
  assert.equal(version(db), MIGRATIONS.length)
  assert.equal(rows(db, 'SELECT * FROM messages').length, 8) // contagem preservada
  assert.equal(rows(db, 'SELECT * FROM messages WHERE task_id IS NULL').length, 0)
  assert.deepEqual(rows(db, 'SELECT text FROM messages ORDER BY id').map(r => r.text), ['a1', 'a2', 'b1', 'c1', 'a3', 'd1', 'd2', 'e1']) // ordem
  assert.equal(rows(db, 'SELECT * FROM accounts').length, 2)
  assert.equal(rows(db, 'SELECT * FROM pins').length, 3) // pins continuam existindo

  // um pin = uma tarefa, com estado, branch e worktree preservados
  const pinTasks = rows(db, "SELECT * FROM tasks WHERE legacy='pin' ORDER BY pin_id")
  assert.deepEqual(pinTasks.map(t => [t.title, t.state]), [['Bug do pulo', 'andamento'], ['Tela azul', 'concluida'], ['Novo', 'aberta']])
  assert.equal(pinTasks[0].branch, 'pin/1-bug-do-pulo')
  assert.equal(pinTasks[0].worktree, 'C:/g/.worktrees/pin-1-bug-do-pulo')
  // claude e codex do mesmo pin viram sessoes separadas da MESMA tarefa
  const t1 = pinTasks[0].id
  assert.equal(rows(db, 'SELECT * FROM messages WHERE task_id=?', t1).length, 4)
  assert.deepEqual(rows(db, 'SELECT provider, profile, session_id FROM task_sessions WHERE task_id=? ORDER BY provider', t1).map(r => [r.provider, r.profile, r.session_id]),
    [['claude', '1', 'sess-claude'], ['codex', '', 'sess-codex']])
  // chats gerais: uma tarefa legada por (pasta, agente, conta), sem fundir contextos
  const chats = rows(db, "SELECT * FROM tasks WHERE legacy='chat' ORDER BY id")
  assert.equal(chats.length, 3) // claude/Segunda, gemini, pin removido
  assert.ok(chats.some(c => c.title === 'Chat legado: claude (Segunda)' && c.game === 'C:/g'))
  assert.ok(chats.some(c => c.title === 'Chat legado: gemini'))
  assert.ok(chats.some(c => c.title === 'Problema removido #99'))
  for (const c of chats) assert.equal(rows(db, 'SELECT DISTINCT provider FROM messages WHERE task_id=?', c.id).length, 1)
  db.close()

  // backup consistente com o estado ANTERIOR, criado uma unica vez
  const baks = fs.readdirSync(tmp).filter(f => f.startsWith('a.db.v') && f.endsWith('.bak'))
  assert.equal(baks.length, 1)
  assert.match(baks[0], /a\.db\.v0\./)
  const bak = new DatabaseSync(path.join(tmp, baks[0]))
  assert.equal(rows(bak, 'SELECT * FROM messages').length, 8)
  assert.equal(rows(bak, "SELECT name FROM sqlite_master WHERE name='tasks'").length, 0)
  bak.close()

  // reiniciar nao duplica nada nem gera novo backup
  const again = openDb(file)
  assert.equal(rows(again, 'SELECT * FROM messages').length, 8)
  assert.equal(rows(again, 'SELECT * FROM tasks').length, 6)
  assert.equal(fs.readdirSync(tmp).filter(f => f.startsWith('a.db.v') && f.endsWith('.bak')).length, 1)
  again.close()
})

test('migracao tolera formatos estranhos de bancos reais (chaves sem mensagem, conta invalida, datas nulas)', () => {
  const file = path.join(tmp, 'odd.db')
  const db = new DatabaseSync(file)
  MIGRATIONS[0](db)
  db.prepare("INSERT INTO chats (key, session_id) VALUES ('game:C:/g|claude|undefined', 's1'), ('pin:5|codex|', 's2'), ('game:C:/g|gemini|', NULL)").run() // sessoes sem mensagens
  db.prepare("INSERT INTO messages (chat_key, role, text, created_at) VALUES ('game:C:/g|claude|undefined', 'user', 'x', NULL), ('game:C:/g with space|opencode|', 'agent', 'y', '2026-01-01 00:00:00')").run()
  db.prepare("INSERT INTO pins (game, title) VALUES ('C:/g', 'so titulo')").run() // colunas opcionais nulas
  db.close()
  const m = openDb(file)
  assert.equal(rows(m, 'SELECT * FROM messages WHERE task_id IS NULL').length, 0)
  assert.equal(rows(m, 'SELECT * FROM messages').length, 2)
  assert.equal(rows(m, "SELECT * FROM task_sessions WHERE session_id='s1'").length, 1)
  assert.equal(rows(m, "SELECT * FROM tasks WHERE legacy='pin'").length, 1)
  assert.equal(version(m), MIGRATIONS.length)
  m.close()
})

test('execucao que estava running durante a migracao e associada a tarefa e reconciliada', () => {
  const file = path.join(tmp, 'r.db')
  const old = legacyDb(file)
  for (const m of MIGRATIONS.slice(1, 2)) m(old) // v2 (runs)
  old.exec('PRAGMA user_version = 2')
  old.prepare("INSERT INTO runs (chat_key, partial) VALUES ('pin:1|claude|1', 'texto parcial')").run()
  old.close()
  const db = openDb(file)
  const run = rows(db, 'SELECT * FROM runs')[0]
  assert.ok(run.task_id)
  assert.equal(run.provider, 'claude')
  assert.equal(reconcileRuns(db), 1)
  const last = rows(db, "SELECT * FROM messages WHERE role='agent' ORDER BY id DESC LIMIT 1")[0]
  assert.equal(last.task_id, run.task_id)
  assert.match(last.text, /texto parcial[\s\S]*interrompida/)
  db.close()
})

test('banco novo nao gera backup; banco de versao futura e recusado sem alteracao', () => {
  const fresh = path.join(tmp, 'b.db')
  openDb(fresh).close()
  assert.equal(fs.readdirSync(tmp).filter(f => f.startsWith('b.db.v')).length, 0)
  const db = new DatabaseSync(fresh)
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`)
  assert.throws(() => migrate(db, fresh), /mais nova/)
  assert.equal(version(db), MIGRATIONS.length + 5)
  db.close()
})

test('migracao que falha reverte tudo (transacional)', () => {
  const db = legacyDb(path.join(tmp, 'c.db'))
  MIGRATIONS.push(d => { d.exec('CREATE TABLE tmp_x (a)'); throw new Error('falha proposital') })
  try {
    assert.throws(() => migrate(db, path.join(tmp, 'c.db')), /falha proposital/)
    assert.equal(version(db), MIGRATIONS.length - 1) // parou na ultima versao aplicada com sucesso
    assert.equal(rows(db, "SELECT name FROM sqlite_master WHERE name='tmp_x'").length, 0)
    assert.equal(rows(db, 'SELECT * FROM messages').length, 8)
  } finally { MIGRATIONS.pop() }
  db.close()
})

test('migracao para tarefas que nao fecha a conta das mensagens aborta sem perder dados', () => {
  const file = path.join(tmp, 'x.db')
  const db = legacyDb(file)
  db.prepare("INSERT INTO messages (chat_key, role, text) VALUES ('', 'user', 'chave vazia')").run() // chave sem agente/conta
  db.close()
  const again = new DatabaseSync(file)
  // chave invalida ainda vira tarefa legada (nao se perde); a contagem final tem de fechar
  migrate(again, file)
  assert.equal(rows(again, 'SELECT * FROM messages WHERE task_id IS NULL').length, 0)
  assert.equal(rows(again, 'SELECT * FROM messages').length, 9)
  again.close()
})

test('execucoes: concluida, falha e cancelada gravam uma unica mensagem com estado e configuracao', () => {
  const db = openDb(path.join(tmp, 'd.db'))
  db.prepare("INSERT INTO tasks (game, title) VALUES ('C:/g', 't')").run()
  const cfg = { taskId: 1, provider: 'codex', accountId: null, model: 'm1', effort: 'high' }
  const r1 = startRun(db, cfg, 'oi')
  assert.ok(finishRun(db, r1, { status: 'completed', text: 'ola', notes: [] }))
  assert.equal(finishRun(db, r1, { status: 'completed', text: 'ola', notes: [] }), false) // idempotente
  const r2 = startRun(db, cfg, 'de novo', 'aviso do sistema')
  finishRun(db, r2, { status: 'failed', text: 'parcial', notes: [], category: 'auth', error: 'token expirado ```x```' })
  const r3 = startRun(db, { ...cfg, provider: 'claude', accountId: 2, model: null, effort: null }, 'cancela')
  finishRun(db, r3, { status: 'cancelled', text: 'meio', notes: ['nota'] })
  const msgs = rows(db, 'SELECT role, status, text, provider, account_id, model, effort FROM messages ORDER BY id')
  assert.deepEqual(msgs.map(m => [m.role, m.status]), [['user', null], ['agent', 'completed'], ['system', null], ['user', null], ['agent', 'failed'], ['user', null], ['agent', 'cancelled']])
  assert.match(msgs[4].text, /parcial[\s\S]*Falhou.*auth/)
  assert.doesNotMatch(msgs[4].text, /```x```/) // cerca de codigo nao quebra
  assert.match(msgs[6].text, /meio[\s\S]*nota[\s\S]*cancelada/)
  assert.deepEqual([msgs[1].provider, msgs[1].model, msgs[1].effort], ['codex', 'm1', 'high']) // configuracao de cada execucao fica gravada
  assert.deepEqual([msgs[6].provider, msgs[6].account_id], ['claude', 2])
  assert.deepEqual(rows(db, 'SELECT status FROM runs ORDER BY id').map(r => r.status), ['completed', 'failed', 'cancelled'])
  assert.equal(rows(db, 'SELECT state FROM tasks')[0].state, 'andamento') // executar move a tarefa para "andamento"
  db.close()
})

test('reinicio reconcilia execucoes interrompidas uma unica vez, mantendo o parcial', () => {
  const file = path.join(tmp, 'e.db')
  const db = openDb(file)
  db.prepare("INSERT INTO tasks (game, title) VALUES ('C:/g', 't')").run()
  const id = startRun(db, { taskId: 1, provider: 'gemini' }, 'pergunta')
  savePartial(db, id, 'metade da resposta')
  db.close() // "app morreu" com a execucao running
  const db2 = openDb(file)
  assert.equal(reconcileRuns(db2), 1)
  assert.equal(reconcileRuns(db2), 0) // repetir nao duplica
  const msgs = rows(db2, 'SELECT role, status, text, provider FROM messages ORDER BY id')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1].status, 'failed')
  assert.equal(msgs[1].provider, 'gemini')
  assert.match(msgs[1].text, /metade da resposta[\s\S]*interrompida/)
  assert.equal(rows(db2, 'SELECT status FROM runs')[0].status, 'failed')
  db2.close()
})

test('composeReply mostra o estado final', () => {
  assert.equal(composeReply({ status: 'completed', text: 'ok', notes: [] }), 'ok')
  assert.match(composeReply({ status: 'failed', text: '', notes: [], error: 'x' }), /Falhou/)
})

test('v6/v7 (uso, memoria, pacotes, artefatos) sobre um banco da versao anterior: dados preservados, tabelas novas vazias, backup criado', () => {
  const file = path.join(tmp, 'v5.db')
  const old = new DatabaseSync(file)
  for (let v = 0; v < 5; v++) MIGRATIONS[v](old) // esquema da versao anterior (v5)
  old.exec('PRAGMA user_version = 5')
  old.prepare("INSERT INTO tasks (game, title) VALUES ('C:/g', 'tarefa')").run()
  old.prepare("INSERT INTO messages (chat_key, role, text, task_id) VALUES ('task:1', 'user', 'oi', 1), ('task:1', 'agent', 'ola', 1)").run()
  old.prepare("INSERT INTO delegations (task_id, provider, mode, objective, status, result) VALUES (1, 'codex', 'read', 'leia', 'completed', 'resultado antigo')").run()
  old.close()
  const db = openDb(file)
  assert.equal(version(db), MIGRATIONS.length)
  assert.deepEqual(rows(db, 'SELECT text, clean FROM messages ORDER BY id').map(r => ({ ...r })), [{ text: 'oi', clean: null }, { text: 'ola', clean: null }]) // historico intacto; clean so nas novas
  assert.deepEqual(rows(db, 'SELECT status, result, package_id, continuation_of, artifact_id, lineage FROM delegations').map(r => ({ ...r })), [{ status: 'completed', result: 'resultado antigo', package_id: null, continuation_of: null, artifact_id: null, lineage: null }])
  for (const t of ['usage_records', 'memory_items', 'context_packages', 'context_deliveries', 'artifacts']) assert.equal(rows(db, `SELECT COUNT(*) n FROM ${t}`)[0].n, 0, t)
  assert.ok(fs.readdirSync(tmp).some(n => /^v5\.db\.v5\..*\.bak$/.test(n))) // copia consistente antes de migrar
  // falha no meio da v7 desfaz tudo (transacao): a v6 fica aplicada e a v7 nao deixa tabelas pela metade
  const file2 = path.join(tmp, 'v6fail.db')
  const d2 = new DatabaseSync(file2)
  for (let v = 0; v < 6; v++) MIGRATIONS[v](d2)
  d2.exec('PRAGMA user_version = 6; CREATE TABLE artifacts (x INTEGER)') // conflito proposital com a v7
  d2.close()
  const d3 = new DatabaseSync(file2)
  assert.throws(() => migrate(d3, file2), /already exists/)
  assert.equal(version(d3), 6)
  assert.equal(rows(d3, "SELECT name FROM sqlite_master WHERE name IN ('memory_items','context_packages','context_deliveries')").length, 0)
  d3.close(); db.close()
})

test('v9 (identidade de execucao) sobre um banco v8 com memoria e artefatos legados: nada e apagado, o legado fica sem grant', () => {
  const file = path.join(tmp, 'v8.db')
  const old = new DatabaseSync(file)
  for (let v = 0; v < 8; v++) MIGRATIONS[v](old) // esquema da versao anterior (v8)
  old.exec('PRAGMA user_version = 8')
  old.prepare("INSERT INTO tasks (game, title) VALUES ('C:/g', 'tarefa')").run()
  old.prepare("INSERT INTO messages (chat_key, role, text, task_id) VALUES ('task:1', 'user', 'oi', 1)").run()
  old.prepare("INSERT INTO memory_items (task_id, owner, lineage, kind, title, content, hash, norm) VALUES (1, 'run', 'chat:1:codex:', 'decision', 'Antiga', 'decisao legada', 'h', 'n')").run()
  old.prepare("INSERT INTO artifacts (task_id, producer, readers, kind, content, size, hash) VALUES (1, 'del:1', '[\"chat:1:codex:\"]', 'delegation', 'legado', 6, 'h')").run()
  old.prepare("INSERT INTO usage_records (task_id, run_id, provider, calls) VALUES (1, 1, 'codex', 4), (1, 2, 'codex', NULL)").run()
  old.close()
  const db = openDb(file)
  assert.equal(version(db), MIGRATIONS.length)
  // v10: o contador antigo "calls" (ferramentas) passa a tool_calls; valores preservados e NULL continua NULL
  assert.deepEqual(rows(db, 'SELECT tool_calls FROM usage_records ORDER BY id').map(r => r.tool_calls), [4, null])
  assert.deepEqual(rows(db, 'SELECT title, content, grant_id FROM memory_items').map(r => ({ ...r })), [{ title: 'Antiga', content: 'decisao legada', grant_id: null }]) // preservado; sem identidade suficiente
  assert.equal(rows(db, 'SELECT COUNT(*) n FROM artifacts')[0].n, 1)
  assert.equal(rows(db, 'SELECT COUNT(*) n FROM exec_grants')[0].n, 0) // tabela nova, vazia: o backend cria os grants a cada execucao
  assert.ok(fs.readdirSync(tmp).some(n => /^v8\.db\.v8\..*\.bak$/.test(n)))
  db.close()
})

test('v17–19 preservam planejamento/comandos v16 e acrescentam registros de produção vazios', () => {
  const file = path.join(tmp, 'v16.db'), old = new DatabaseSync(file)
  for (const migration of MIGRATIONS.slice(0, 16)) migration(old)
  old.exec('PRAGMA user_version = 16')
  old.prepare("INSERT INTO tasks (game,title) VALUES ('C:/g','Produzir')").run()
  old.prepare("INSERT INTO task_steps (task_id,position,title,instruction,state) VALUES (1,1,'Fazer','Faça','accepted')").run()
  old.prepare("INSERT INTO command_runs (task_id,workspace,name,program,args,status,exit_code,output) VALUES (1,'C:/g','Build','node','[]','completed',0,'saída preservada')").run()
  old.prepare("INSERT INTO settings (key,value) VALUES ('todoBoard','{\"revision\":2,\"topics\":[]}')").run()
  old.close()
  const current = openDb(file)
  assert.equal(version(current), MIGRATIONS.length)
  assert.equal(rows(current, 'SELECT state FROM task_steps')[0].state, 'accepted')
  assert.equal(rows(current, 'SELECT output FROM command_runs')[0].output, 'saída preservada')
  assert.equal(rows(current, "SELECT value FROM settings WHERE key='todoBoard'")[0].value, '{"revision":2,"topics":[]}')
  for (const table of ['project_assets', 'asset_versions', 'project_playtests', 'project_builds']) assert.equal(rows(current, `SELECT COUNT(*) n FROM ${table}`)[0].n, 0)
  assert.ok(fs.readdirSync(tmp).some(n => /^v16\.db\.v16\..*\.bak$/.test(n)))
  current.close()
  const again = openDb(file); assert.equal(rows(again, 'SELECT COUNT(*) n FROM tasks')[0].n, 1); again.close()
})

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }) // handles SQLite ainda abertos no Windows
