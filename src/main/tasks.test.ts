import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from './db.ts'
import type { DatabaseSync } from 'node:sqlite'
import { finishRun, startRun } from './runs.ts'
import { agentBody, autoTitle, contextFor, createTask, DEFAULT_TITLE, deleteTask, getTask, listTasks, profileOf, renameTask, resetSession, saveMetric, getMetric, saveSession, sessionOf, setArchived, stripTitle, summaryTitle, taskForPin, taskMessages, titleIn } from './tasks.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-tasks-'))
const db = openDb(path.join(tmp, 't.db'))
const G = 'C:/jogo'

// Uma troca completa: mensagem do usuario + resposta do provedor.
function turn(taskId: number, provider: string, accountId: number | null, user: string, agent: string) {
  const id = startRun(db, { taskId, provider, accountId }, user)
  finishRun(db, id, { status: 'completed', text: agent, notes: [] })
}

test('varias tarefas independentes no mesmo projeto, com sessoes separadas', () => {
  const a = createTask(db, G), b = createTask(db, G)
  saveSession(db, a, 'claude', profileOf('claude', 1), 'sess-a')
  saveSession(db, b, 'claude', profileOf('claude', 1), 'sess-b')
  turn(a, 'claude', 1, 'pergunta A', 'resposta A')
  turn(b, 'claude', 1, 'pergunta B', 'resposta B')
  assert.equal(sessionOf(db, a, 'claude', '1'), 'sess-a')
  assert.equal(sessionOf(db, b, 'claude', '1'), 'sess-b')
  assert.deepEqual(taskMessages(db, a).map(m => m.text), ['pergunta A', 'resposta A'])
  assert.deepEqual(taskMessages(db, b).map(m => m.text), ['pergunta B', 'resposta B']) // nada vaza entre tarefas
})

test('sessao e por provedor e por conta; trocar de provedor nao esconde o historico', () => {
  const t = createTask(db, G)
  saveSession(db, t, 'claude', profileOf('claude', 1), 's-c1')
  saveSession(db, t, 'claude', profileOf('claude', 2), 's-c2')
  saveSession(db, t, 'codex', profileOf('codex', 1), 's-cx') // conta so vale para o Claude
  assert.deepEqual([sessionOf(db, t, 'claude', '1'), sessionOf(db, t, 'claude', '2'), sessionOf(db, t, 'codex', ''), sessionOf(db, t, 'gemini', '')], ['s-c1', 's-c2', 's-cx', undefined])
  turn(t, 'claude', 1, 'u1', 'r1'); turn(t, 'codex', null, 'u2', 'r2')
  assert.equal(taskMessages(db, t).length, 4) // as duas plataformas na mesma linha do tempo
})

test('contexto so e transferido quando a sessao nao viu a conversa, e e marcado como transferencia', () => {
  const t = createTask(db, G)
  assert.equal(contextFor(db, t, 'claude', 1, false), null) // tarefa vazia: nada a transferir
  turn(t, 'claude', 1, 'implemente o pulo', 'feito, veja jump.gd')
  saveSession(db, t, 'claude', '1', 's1')
  assert.equal(contextFor(db, t, 'claude', 1, true), null) // a sessao do Claude ja viu tudo

  const toCodex = contextFor(db, t, 'codex', null, false) // sessao nova em outra plataforma: recebe o historico
  assert.equal(toCodex?.count, 2)
  assert.match(toCodex!.text, /Usuario: implemente o pulo[\s\S]*Agente \(claude\): feito, veja jump\.gd/)
  assert.match(toCodex!.text, /Contexto transferido pelo dashboard/)

  turn(t, 'codex', null, 'agora teste', 'testes ok')
  saveSession(db, t, 'codex', '', 'cx1')
  turn(t, 'claude', 1, 'ultima duvida', 'ok') // claude respondeu depois do codex; codex nao viu isso
  const back = contextFor(db, t, 'codex', null, true)
  assert.equal(back?.count, 2)
  assert.match(back!.text, /ultima duvida/)
  assert.doesNotMatch(back!.text, /implemente o pulo/) // so o que a sessao do codex nao viu
  // No fluxo real, o envio do Claude depois do turno do Codex ja teria levado esse turno como contexto; entao ele esta em dia.
  assert.equal(contextFor(db, t, 'claude', 1, true), null)
  // Execucao que falhou nao avanca o marco: a sessao pode nao ter visto o contexto.
  const failed = startRun(db, { taskId: t, provider: 'gemini' }, 'oi gemini')
  finishRun(db, failed, { status: 'failed', text: '', notes: [], error: 'auth' })
  saveSession(db, t, 'gemini', '', 'gm1')
  assert.equal(contextFor(db, t, 'gemini', null, true), null) // sem resposta propria bem-sucedida: nao reenvia, sessao e nova para ela
})

test('respostas que falharam (so mensagem de erro) nao viram contexto transferido', () => {
  const t = createTask(db, G)
  turn(t, 'claude', 1, 'pergunta boa', 'resposta boa')
  const bad = startRun(db, { taskId: t, provider: 'opencode' }, 'tentativa que falhou')
  finishRun(db, bad, { status: 'failed', text: '', notes: [], category: 'auth', error: 'ERRO-SECRETO-DO-OPENCODE' })
  const c = contextFor(db, t, 'codex', null, false)!
  assert.match(c.text, /pergunta boa[\s\S]*resposta boa[\s\S]*tentativa que falhou/) // o pedido do usuario segue no historico
  assert.doesNotMatch(c.text, /ERRO-SECRETO/)
})

test('limite de tamanho do contexto transferido mantem as mensagens mais recentes', () => {
  const t = createTask(db, G)
  for (let i = 0; i < 20; i++) turn(t, 'claude', 1, `pergunta ${i} ${'x'.repeat(1000)}`, `resposta ${i} ${'y'.repeat(1000)}`)
  const c = contextFor(db, t, 'gemini', null, false, 5000)!
  assert.ok(c.text.length < 6500)
  assert.match(c.text, /resposta 19/)
  assert.doesNotMatch(c.text, /pergunta 0 /)
})

test('resposta sem conclusao marcada (codex/gemini/opencode) acima do limite: vao as ULTIMAS falas, nao a narracao do comeco', () => {
  const t = createTask(db, G)
  const narration = Array.from({ length: 40 }, (_, i) => `Vou olhar o passo ${i} agora.${' n'.repeat(50)}`)
  const final = 'RESPOSTA FINAL: o bug esta em player.gd:42 (sinal conectado duas vezes).'
  const run = startRun(db, { taskId: t, provider: 'codex' }, 'ache o bug')
  finishRun(db, run, { status: 'completed', text: [...narration, final].join('\n\n'), notes: [], messages: [...narration, final], answer: final, answerBasis: 'limited' })
  const row = db.prepare("SELECT clean, clean_parts FROM messages WHERE task_id=? AND role='agent'").get(t) as any
  assert.ok(row.clean.startsWith('Vou olhar o passo 0') && row.clean.endsWith(final)) // clean continua integral (auditoria)
  assert.equal(JSON.parse(row.clean_parts).length, 41)
  const c = contextFor(db, t, 'claude', 1, false)!
  assert.match(c.body, /RESPOSTA FINAL: o bug esta em player\.gd:42/) // antes: o corte do comeco (3000) descartava justamente a resposta
  assert.doesNotMatch(c.body, /passo 0 /)
  assert.match(c.body, /\d+ fala\(s\) anterior\(es\) do agente nesta resposta omitida\(s\)/) // o corte e declarado, nunca silencioso
  assert.ok(c.body.length < 3000 + 200)
  // dentro do limite: vai inteira, como antes; resposta marcada pela CLI (claude) nao guarda falas
  const t2 = createTask(db, G)
  const r2 = startRun(db, { taskId: t2, provider: 'codex' }, 'curta')
  finishRun(db, r2, { status: 'completed', text: 'a\n\nb', notes: [], messages: ['Vou ver.', 'Feito: b'], answer: 'Feito: b', answerBasis: 'limited' })
  assert.match(contextFor(db, t2, 'claude', 1, false)!.body, /Vou ver\.\n\nFeito: b/)
  const r3 = startRun(db, { taskId: t2, provider: 'claude', accountId: 1 }, 'x')
  finishRun(db, r3, { status: 'completed', text: 'x', notes: [], messages: ['Vou ver.', 'ok'], answer: 'ok', answerBasis: 'explicit' })
  assert.equal((db.prepare("SELECT clean_parts FROM messages WHERE task_id=? AND provider='claude' AND role='agent'").get(t2) as any).clean_parts, null)
})

test('agentBody: ultima fala maior que o limite e falas corrompidas nao perdem a resposta nem quebram', () => {
  const big = 'z'.repeat(5000)
  const b = agentBody({ text: '', clean: `inicio\n\n${big}`, clean_parts: JSON.stringify(['inicio', big]) })
  assert.match(b, /^\(1 fala\(s\) anterior/); assert.ok(b.includes('zzz') && !b.includes('inicio'))
  const legacy = 'w'.repeat(4000)
  assert.equal(agentBody({ text: legacy, clean: legacy, clean_parts: '{nao e json' }), legacy) // sem falas validas: comportamento antigo (corte no chamador)
  assert.equal(agentBody({ text: legacy, clean: null }), legacy)
})

test('criar, renomear, buscar, ordenar por atividade e arquivar sem apagar nada', () => {
  const game = 'C:/outro'
  const a = createTask(db, game, 'Chefe final'), b = createTask(db, game, 'Menu inicial'), c = createTask(db, game)
  assert.equal(getTask(db, c).title, DEFAULT_TITLE)
  autoTitle(db, c, '  Corrigir   a camera\ntremendo  ')
  assert.equal(getTask(db, c).title, 'Corrigir a camera tremendo')
  autoTitle(db, a, 'nao deve trocar') // so titulo padrao vira automatico
  assert.equal(getTask(db, a).title, 'Chefe final')
  // resumo do agente: substitui o provisorio; renomeado pelo usuario, nao troca
  const d = createTask(db, game), prov = autoTitle(db, d, 'C:\\Users\\u\\jogo arruma isso')!
  const reply = 'Pronto, arrumei.\n<titulo>Corrigir colisão do jogador</titulo>'
  assert.equal(titleIn(reply), 'Corrigir colisão do jogador')
  assert.equal(stripTitle(reply), 'Pronto, arrumei.')
  assert.equal(stripTitle('Pronto.\n<titu'), 'Pronto.') // tag ainda chegando no streaming
  assert.equal(stripTitle('Pronto.\n<titulo>Corr'), 'Pronto.')
  assert.equal(titleIn('sem tag'), null)
  summaryTitle(db, d, 'Corrigir colisão do jogador', prov)
  assert.equal(getTask(db, d).title, 'Corrigir colisão do jogador')
  const e = createTask(db, game), prov2 = autoTitle(db, e, 'oi')!
  renameTask(db, e, 'Meu nome')
  summaryTitle(db, e, 'Outro', prov2)
  assert.equal(getTask(db, e).title, 'Meu nome')
  assert.equal(autoTitle(db, e, 'x'), null)
  for (const until = Date.now() + 3; Date.now() < until;); // updated_at tem resolucao de ms: sem isto a atividade empata com a criacao de `e` (desempate por id)
  turn(a, 'claude', 1, 'ajustar dificuldade', 'ok') // atividade mais recente
  assert.equal(listTasks(db, game)[0].id, a)
  renameTask(db, b, 'Menu principal')
  assert.throws(() => renameTask(db, b, '   '), /vazio/)
  assert.deepEqual(listTasks(db, game, { search: 'dificuldade' }).map(t => t.id), [a]) // busca no texto das mensagens
  assert.deepEqual(listTasks(db, game, { search: 'principal' }).map(t => t.id), [b]) // e no titulo
  assert.deepEqual(listTasks(db, game, { search: '100%' }), []) // curingas do LIKE sao escapados

  db.prepare("UPDATE tasks SET worktree='C:/jogo/.worktrees/x' WHERE id=?").run(a)
  setArchived(db, a, true)
  assert.ok(!listTasks(db, game).some(t => t.id === a))
  assert.deepEqual(listTasks(db, game, { archived: true }).map(t => t.id), [a])
  assert.equal(taskMessages(db, a).length, 2) // mensagens intactas
  assert.equal(getTask(db, a).worktree, 'C:/jogo/.worktrees/x') // vinculo de worktree intacto
  setArchived(db, a, false)
  assert.ok(listTasks(db, game).some(t => t.id === a))
})

test('tarefa de um problema (pin) e reaproveitada e mantem branch/worktree', () => {
  const pin = { id: 7, game: G, title: 'Bug', branch: 'pin/7-bug', worktree: 'C:/jogo/.worktrees/pin-7-bug' }
  const id = taskForPin(db, pin)
  assert.equal(taskForPin(db, pin), id)
  const t = getTask(db, id)
  assert.deepEqual([t.pin_id, t.branch, t.worktree], [7, 'pin/7-bug', 'C:/jogo/.worktrees/pin-7-bug'])
})

test('nova sessao: esquece so a sessao e a medida deste provedor/perfil; sem sessao o historico volta a ser candidato', () => {
  const t = createTask(db, 'C:/ns', 'ns')
  saveSession(db, t, 'claude', '1', 's-1'); saveSession(db, t, 'codex', '', 'c-1')
  saveMetric(db, t, 'claude', '1', null, null, { occupied: 500_000, source: 's' })
  assert.equal(resetSession(db, t, 'claude', '1'), true)
  assert.equal(sessionOf(db, t, 'claude', '1'), undefined)
  assert.equal(getMetric(db, t, 'claude', '1'), null)
  assert.equal(sessionOf(db, t, 'codex', ''), 'c-1') // outro provedor intacto
  assert.equal(resetSession(db, t, 'claude', '1'), false) // repetir nao faz nada
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('excluir tarefa apaga tudo dela (inclusive entregas de pacote) e nada das outras', () => {
  const a = createTask(db, G, 'apagar'), b = createTask(db, G, 'manter')
  turn(a, 'codex', null, 'oi a', 'resposta a')
  turn(b, 'codex', null, 'oi b', 'resposta b')
  saveSession(db, a, 'codex', '', 'sess-a')
  const pkg = Number(db.prepare("INSERT INTO context_packages (task_id, source, issuer, recipient, provider, items, hash, size, state) VALUES (?, 'history', 'u', 'x', 'codex', '[]', 'h', 0, 'approved')").run(a).lastInsertRowid)
  db.prepare("INSERT INTO context_deliveries (package_id, recipient, revisions) VALUES (?, 'x', '{}')").run(pkg)
  const count = (sql: string, ...p: any[]) => (db.prepare(sql).get(...p) as any).n
  const withTask = (id: number) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[])
    .filter(t => (db.prepare(`PRAGMA table_info("${t.name}")`).all() as any[]).some(c => c.name === 'task_id'))
    .reduce((n, t) => n + count(`SELECT COUNT(*) n FROM "${t.name}" WHERE task_id=?`, id), 0)
  assert.ok(withTask(a) > 0)
  const bBefore = withTask(b)
  deleteTask(db, a)
  assert.equal(getTask(db, a), undefined)
  assert.equal(withTask(a), 0)
  assert.equal(count('SELECT COUNT(*) n FROM context_deliveries WHERE package_id=?', pkg), 0)
  assert.equal(withTask(b), bBefore) // a outra tarefa fica intacta
  assert.equal(getTask(db, b).title, 'manter')
})

test('historico: chat so recebe as colunas exibidas; contexto le so a janela e conta as omitidas como antes', () => {
  const t = createTask(db, 'C:/g/historico')
  const put = db.prepare('INSERT INTO messages (chat_key, role, text, task_id, provider, status, clean, clean_parts) VALUES (?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 400; i++) {
    put.run('', 'user', `pergunta ${i} ` + 'u'.repeat(i % 7 * 300), t, null, null, null, null)
    if (i % 11 === 0) put.run('', 'agent', '`> Edit a.ts`\n_Execucao cancelada._', t, 'codex', 'cancelled', null, null) // so atividade: corpo vazio, nao conta
    else if (i % 13 === 0) put.run('', 'agent', `falhou ${i}`, t, 'codex', 'failed', null, null)
    else put.run('', 'agent', `bruto ${i}`, t, 'claude', 'completed', `limpo ${i} ` + 'c'.repeat(i % 5 * 900), JSON.stringify([`fala a ${i} ` + 'x'.repeat(2000), `fala b ${i} ` + 'y'.repeat(1500)]))
  }
  const [first] = taskMessages(db, t)
  assert.deepEqual(Object.keys(first).sort(), ['account_id', 'created_at', 'effort', 'id', 'model', 'provider', 'role', 'status', 'steps', 'text'])
  // Referencia: a implementacao anterior (historico inteiro em memoria).
  const reference = (maxChars: number) => {
    const rows = db.prepare("SELECT id, role, provider, text, clean, clean_parts FROM messages WHERE task_id=? AND id>? AND role IN ('user','agent') AND text<>'' AND NOT (role='agent' AND status='failed') ORDER BY id").all(t, 0) as any[]
    const lines: string[] = []; let size = 0, considered = 0, full = false
    for (const m of rows.reverse()) {
      const body = m.role === 'agent' ? agentBody(m) : m.text
      if (!body) continue
      considered++
      if (full) continue
      const line = `${m.role === 'user' ? 'Usuario' : `Agente (${m.provider ?? 'desconhecido'})`}: ${body.length > 3000 ? body.slice(0, 3000) : body}`
      if (size + line.length > maxChars && lines.length) { full = true; continue }
      lines.unshift(line); size += line.length + 2
    }
    return { count: lines.length, omitted: considered - lines.length }
  }
  for (const max of [500, 12_000, 60_000, 10_000_000]) {
    const got = contextFor(db, t, 'claude', null, false, max)!
    assert.deepEqual({ count: got.count, omitted: got.omitted }, reference(max), `maxChars ${max}`)
  }
  // Carga limitada: com a janela padrao, so as mensagens da janela (+1, a que nao coube) vem com clean_parts.
  let loaded = 0
  const spy = new Proxy(db, { get(target, prop) {
    if (prop !== 'prepare') { const v = (target as any)[prop]; return typeof v === 'function' ? v.bind(target) : v }
    return (sql: string) => { const st = target.prepare(sql); return /clean_parts/.test(sql) ? { iterate: function* (...a: any[]) { for (const r of st.iterate(...a)) { loaded++; yield r } } } : st }
  } }) as DatabaseSync
  const window = contextFor(spy, t, 'claude', null, false)!
  assert.ok(window.omitted > 500); assert.ok(loaded > window.count && loaded < 40, `linhas completas lidas: ${loaded} de ~780`) // janela + a que nao coube + vazias no meio
})
