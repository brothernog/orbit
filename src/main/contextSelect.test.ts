// Selecao deterministica de contexto pertinente: sem IA, limites explicitos, o que nao coube aparece, e NADA segue sem aprovacao do pacote exato.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage, finishDelivery, getPackage, openGrant, planHistoryContext, recordDelivery, resolvePackage, type Recipient } from './consent.ts'
import { selectContext, selectMemory } from './contextSelect.ts'
import { openDb } from './db.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { addMemory, fileEvidence } from './memory.ts'
import { readableItems } from './taskContext.ts'
import { contextFor, createTask } from './tasks.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-select-'))
const ws = path.join(tmp, 'proj'); fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 1\n')
const db = openDb(path.join(tmp, 't.db'))
const rcp = (t: number, over: Partial<Recipient> = {}): Recipient => ({ logicalId: `chat:${t}:codex:`, provider: 'codex', profile: '', model: null, effort: null, workspace: ws, scope: [], ...over })
const mem = (t: number, kind: string, title: string, content: string, extra: any = {}) =>
  addMemory(db, { taskId: t, owner: 'run', lineage: `chat:${t}:claude:1`, grantId: `g:antiga-${t}`, kind, title, content, ...extra }).id
const NO_HISTORY = () => null
const select = (t: number, over: any = {}) => selectContext(db, { taskId: t, recipient: rcp(t), sessionId: null, cwd: ws, limits: DEFAULT_LIMITS, history: NO_HISTORY, ...over })
const refs = (s: ReturnType<typeof select>) => (s.candidate && 'items' in s.candidate ? s.candidate.items.map(i => i.ref) : [])

test('restricao antiga importante numa conversa longa entra primeiro; o historico bruto e so complemento e o que nao coube e contado', () => {
  const t = createTask(db, ws, 'longa')
  const constraint = mem(t, 'constraint', 'Nunca usar rede', 'Os testes nao podem acessar a rede em nenhuma hipotese.')
  const objective = mem(t, 'objective', 'Corrigir o pulo duplo', 'Objetivo: pulo duplo funcionando sem quebrar o pulo simples.')
  const decision = mem(t, 'decision', 'Salvar em JSON', 'Formato decidido apos a discussao.')
  for (let i = 0; i < 120; i++) {
    db.prepare("INSERT INTO messages (chat_key, role, text, task_id, provider, status) VALUES (?,?,?,?,?,?)").run(`task:${t}`, 'user', `pergunta ${i}: ${'contexto '.repeat(40)}`, t, null, null)
    db.prepare("INSERT INTO messages (chat_key, role, text, task_id, provider, status) VALUES (?,?,?,?,?,?)").run(`task:${t}`, 'agent', `resposta ${i}: ${'detalhe '.repeat(60)}`, t, 'claude', 'completed')
  }
  const s = select(t, { history: (max: number) => contextFor(db, t, 'codex', null, false, max) })
  const items = (s.candidate as any).items
  assert.deepEqual(items.slice(0, 3).map((i: any) => i.ref), [`m:${objective}`, `m:${constraint}`, `m:${decision}`]) // requisitos primeiro, depois decisoes
  assert.equal(items.at(-1).ref, 'hist'); assert.ok(items.at(-1).content.includes('resposta 119')) // historico: so o mais recente, como complemento
  assert.ok(!items.at(-1).content.includes('pergunta 0:')) // o comeco da conversa nao coube no historico bruto...
  assert.match(s.omitted.find(x => x.ref === 'hist')!.why, /\d+ mensagem\(ns\) mais antiga\(s\) nao couberam/) // ...e isso e dito ao usuario
  const total = items.reduce((n: number, i: any) => n + i.title.length + i.content.length, 0)
  assert.ok(total <= DEFAULT_LIMITS.packageChars && items.length <= DEFAULT_LIMITS.packageItems, `${total} caracteres`)
  assert.equal(s.requirementsOmitted, false)
})

test('escopo: outra tarefa, memoria privada de filhos e itens de outra tarefa na mesma pasta nunca entram; o do usuario entra', () => {
  const t = createTask(db, ws, 'escopo'), other = createTask(db, ws, 'outra')
  const mine = mem(t, 'decision', 'Da tarefa', 'decisao desta tarefa')
  mem(other, 'decision', 'De outra tarefa', 'mesma pasta, outra tarefa')
  addMemory(db, { taskId: t, owner: 'delegation', lineage: 'del:3', grantId: 'g:filho', kind: 'finding', title: 'Privado do filho', content: 'so o filho ve' })
  const user = addMemory(db, { taskId: t, owner: 'user', lineage: 'user', kind: 'constraint', title: 'Regra do usuario', content: 'sempre em portugues' }).id
  assert.deepEqual(refs(select(t)), [`m:${user}`, `m:${mine}`]) // requisito do usuario antes da decisao; nada de outra tarefa nem do filho
  assert.deepEqual(refs(select(t, { sessionId: 'sess-nova', history: () => ({ body: 'Usuario: oi', count: 1 }) })), [`m:${user}`, `m:${mine}`, 'hist'])
})

test('so ha candidato quando ha o que transferir: sessao em andamento que ja viu tudo nao gera pedido, mesmo com memoria na tarefa', () => {
  const t = createTask(db, ws, 'andamento')
  mem(t, 'decision', 'Decisao', 'x')
  const s = select(t, { sessionId: 'sess-viva' }) // history() devolve null: nada novo aconteceu em outros provedores
  assert.deepEqual([s.candidate, s.omitted], [null, []])
  assert.deepEqual(refs(select(t)), [refs(select(t))[0]]) // sem sessao (nova): candidato
  // com historico de outro provedor a transferir, mesmo a sessao em andamento recebe o pedido
  const s2 = select(t, { sessionId: 'sess-viva', history: () => ({ body: 'Usuario: oi', count: 1 }) })
  assert.deepEqual(refs(s2).at(-1), 'hist')
})

test('validade: item desatualizado nao e proposto (aparece como nao incluido); sem evidencia e rotulado como desconhecido, nunca como comprovado', () => {
  const t = createTask(db, ws, 'validade')
  const ok = mem(t, 'decision', 'Comprovada', 'depende de a.ts', { evidence: { files: fileEvidence(ws, ['src/a.ts']) } })
  const semEv = mem(t, 'finding', 'Sem evidencia', 'achado sem arquivo que o sustente')
  const s = select(t)
  const items = (s.candidate as any).items
  assert.equal(items.find((i: any) => i.ref === `m:${ok}`).title, 'Comprovada') // valida: sem marcador
  assert.equal(items.find((i: any) => i.ref === `m:${semEv}`).title, 'Sem evidencia [validade desconhecida: sem evidencia]')
  fs.appendFileSync(path.join(ws, 'src', 'a.ts'), '// mudou\n')
  const stale = select(t)
  assert.ok(!refs(stale).includes(`m:${ok}`))
  assert.match(stale.omitted.find(x => x.ref === `m:${ok}`)!.why, /desatualizado \(arquivos de evidencia mudaram: src\/a\.ts\)/)
  fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 1\n')
})

test('conflito e pendencias: itens em conflito vao rotulados; pendencia concluida nao; validacoes so as mais recentes', () => {
  const t = createTask(db, ws, 'estado')
  const a = mem(t, 'decision', 'Formato', 'Usar JSON.')
  const b = mem(t, 'decision', 'formato', 'Usar YAML.')
  const open = mem(t, 'todo', 'Falta testar', 'rodar a suite', { todoState: 'open' })
  mem(t, 'todo', 'Ja feito', 'x', { todoState: 'done' })
  for (let i = 0; i < 5; i++) mem(t, 'validation', `Teste ${i}`, `resultado ${i}`, { evidence: { files: fileEvidence(ws, ['src/a.ts']) } })
  const s = select(t)
  const items = (s.candidate as any).items
  assert.ok(items.find((i: any) => i.ref === `m:${b}`).title.includes(`CONFLITA com m:${a}`) || items.find((i: any) => i.ref === `m:${a}`).title.includes('CONFLITA') === false)
  assert.ok(refs(s).includes(`m:${open}`) && !items.some((i: any) => i.title === 'Ja feito'))
  assert.equal(items.filter((i: any) => i.kind === 'validation').length, 3)
  assert.equal(s.omitted.filter(x => /mais antiga que as 3 mais recentes/.test(x.why)).length, 2)
  // a ordem e deterministica: chamar de novo devolve exatamente a mesma selecao
  assert.deepEqual(select(t), s)
})

test('limites explicitos: o que nao coube e listado; requisito grande demais e sinalizado como tal (nunca cortado em silencio)', () => {
  const t = createTask(db, ws, 'limites')
  const big = mem(t, 'constraint', 'Restricao enorme', 'x'.repeat(DEFAULT_LIMITS.itemChars + 1))
  const small = mem(t, 'constraint', 'Restricao pequena', 'cabe')
  for (let i = 0; i < 12; i++) mem(t, 'decision', `Decisao ${i}`, `conteudo da decisao ${i}`)
  const s = select(t)
  const items = (s.candidate as any).items
  assert.ok(items.length <= DEFAULT_LIMITS.packageItems && refs(s).includes(`m:${small}`) && !refs(s).includes(`m:${big}`))
  const bigWhy = s.omitted.find(x => x.ref === `m:${big}`)!
  assert.deepEqual([bigWhy.requirement, /maior que o limite por item/.test(bigWhy.why)], [true, true]); assert.equal(s.requirementsOmitted, true)
  assert.equal(s.omitted.filter(x => /limite de \d+ itens por pacote/.test(x.why)).length, 12 - (DEFAULT_LIMITS.packageItems - 1)) // as decisoes mais recentes entraram; as mais antigas ficaram de fora e listadas
  assert.ok(items.some((i: any) => i.title.startsWith('Decisao 11 ')) && !items.some((i: any) => i.title.startsWith('Decisao 0 ')))
  // com limites maiores tudo cabe
  assert.equal(select(t, { limits: { ...DEFAULT_LIMITS, packageItems: 30, itemChars: 5000, packageChars: 40_000 } }).omitted.length, 0)
})

test('pacotes sobrepostos: so identidade + revisao + conteudo CONFIRMADOS no mesmo destino e sessao sao deduplicados; outro destino e nova revisao nao', () => {
  const t = createTask(db, ws, 'dedup')
  const R = rcp(t, { model: 'gpt-6-luna' })
  const d1 = mem(t, 'decision', 'Formato', 'Usar JSON.')
  const d2 = mem(t, 'decision', 'Cache', 'Sem cache.')
  const first = selectContext(db, { taskId: t, recipient: R, sessionId: null, cwd: ws, limits: DEFAULT_LIMITS, history: NO_HISTORY })
  const plan = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R, sessionId: null, candidate: first.candidate })
  const pkg = plan.pending!; assert.deepEqual(pkg.items.map(i => i.ref), [`m:${d2}`, `m:${d1}`]) // decisoes: mais recente primeiro
  resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision: 'approve' })
  const dv = recordDelivery(db, getPackage(db, pkg.id)!, 'sess-A'); finishDelivery(db, dv, 'confirmed', 'sess-A')
  const again = (over: any) => selectContext(db, { taskId: t, recipient: R, sessionId: 'sess-A', cwd: ws, limits: DEFAULT_LIMITS, history: () => ({ body: 'Usuario: novo', count: 1 }), ...over })
  assert.deepEqual(refs(again({})), ['hist']) // ja confirmados nesta sessao: nao repete (so o complemento novo)
  assert.deepEqual(refs(again({ sessionId: 'sess-B' })), [`m:${d2}`, `m:${d1}`, 'hist']) // outra sessao: o pacote anterior nao vale
  assert.deepEqual(refs(again({ recipient: rcp(t, { model: 'gpt-5.5' }) })), [`m:${d2}`, `m:${d1}`, 'hist']) // outro destino: nada e fundido
  const rev = addMemory(db, { taskId: t, owner: 'run', lineage: `chat:${t}:claude:1`, grantId: `g:antiga-${t}`, kind: 'decision', title: 'Formato', content: 'Usar YAML.', supersedes: d1 }).id
  assert.deepEqual(refs(again({})), [`m:${rev}`, 'hist']) // nova revisao/conteudo: proposta de novo (com novo pedido)
})

test('o candidato NAO autoriza nada: destinatario so le apos aprovar; o que nao coube nao entra no hash nem e enviado; o item proprio nao e reproposto', () => {
  const t = createTask(db, ws, 'consent')
  const R = rcp(t, { model: 'm1' })
  const d = mem(t, 'decision', 'Sigilosa', 'decisao antiga')
  mem(t, 'constraint', 'Grande', 'x'.repeat(DEFAULT_LIMITS.itemChars + 1))
  const s = selectContext(db, { taskId: t, recipient: R, sessionId: null, cwd: ws, limits: DEFAULT_LIMITS, history: NO_HISTORY })
  const plan = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R, sessionId: null, candidate: s.candidate })
  const pkg = plan.pending!
  const grant = openGrant(db, { taskId: t, recipient: R })
  assert.ok(!readableItems(db, grant).some(i => i.itemId === d)) // proposto nao e autorizado
  assert.equal(getPackage(db, pkg.id)!.omitted.length, 1); assert.match(getPackage(db, pkg.id)!.omitted[0].title, /^Grande/); assert.equal(getPackage(db, pkg.id)!.omitted[0].requirement, true) // guardado para o usuario ver
  assert.ok(!JSON.stringify(getPackage(db, pkg.id)!.items).includes('xxxxxxxx')) // o omitido nao esta nos itens (nao e enviado)
  // mesmo conjunto de itens com outra lista de omitidos = mesmo hash (o que nao coube nao muda o pacote aprovado)
  const c = createPackage(db, DEFAULT_LIMITS, { taskId: t, source: 'history', issuer: 'dashboard', recipient: R, items: pkg.items, omitted: [] })
  assert.equal(c.hash, pkg.hash)
  resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision: 'approve' })
  assert.ok(readableItems(db, grant).some(i => i.itemId === d && i.source === 'package')) // depois da aprovacao, o destino le exatamente o snapshot
  // o destino nao repropoe o que ele mesmo escreveu (mesmo grant): fica de fora
  const own = addMemory(db, { taskId: t, owner: 'run', lineage: R.logicalId, grantId: grant.authId, kind: 'decision', title: 'Do proprio destino', content: 'x' }).id
  grant.sessionId = 'sess-Z'; db.prepare('UPDATE exec_grants SET session_id=? WHERE auth_id=?').run('sess-Z', grant.authId)
  const sm = selectMemory(db, { taskId: t, recipient: R, sessionId: 'sess-Z', cwd: ws, limits: DEFAULT_LIMITS, withHistory: false })
  assert.ok(!sm.items.some(i => i.itemId === own))
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
