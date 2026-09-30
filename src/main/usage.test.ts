// Contabilidade de uso com dados sinteticos (nenhuma chamada paga). Prova a logica de normalizacao, nao os provedores reais.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, type Metric } from './adapters.ts'
import { openDb } from './db.ts'
import { mergeMetric } from './runner.ts'
import { createTask } from './tasks.ts'
import { compareUsage, delegationReport, deltaFromCumulative, inputTotal, outputTotal, recordUsage, taskUsage } from './usage.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-usage-'))
const db = openDb(path.join(tmp, 't.db'))
const task = createTask(db, 'C:/x', 't')
let run = 0
const rec = (o: any) => recordUsage(db, { taskId: task, runId: ++run, provider: 'codex', ...o })
const row = (id: number) => db.prepare('SELECT * FROM usage_records WHERE id=?').get(id) as any

test('campos ausentes ficam NULL, nunca 0', () => {
  const r = row(rec({ metric: { consumedIn: 10, source: 's' } }))
  assert.deepEqual([r.input, r.output, r.cache_read, r.reasoning], [10, null, null, null])
  const none = row(rec({ promptChars: 500, durationMs: 20 })) // execucao sem nenhuma medida
  assert.deepEqual([none.input, none.output, none.prompt_chars, none.duration_ms], [null, null, 500, 20])
})

test('um registro por execucao (repetir nao duplica)', () => {
  const id = ++run
  recordUsage(db, { taskId: task, runId: id, provider: 'claude', metric: { consumedIn: 1, source: 's' } })
  assert.throws(() => recordUsage(db, { taskId: task, runId: id, provider: 'claude', metric: { consumedIn: 1, source: 's' } }), /UNIQUE/)
  assert.throws(() => recordUsage(db, { taskId: task, provider: 'claude' }), /runId OU delegationId/)
})

test('acumulado do thread vira delta so com base comparavel; reinicio nao gera delta negativo', () => {
  const cum = (i: number, o: number): Metric => ({ consumedIn: i, consumedOut: o, scope: 'thread', source: 'codex' })
  const s = 'sessao-A'
  const a = row(rec({ session: s, sessionWasNew: true, metric: cum(1000, 100) })) // sessao nova: base 0
  assert.deepEqual([a.input, a.output], [1000, 100])
  const b = row(rec({ session: s, metric: cum(2500, 260) })) // base = registro anterior
  assert.deepEqual([b.input, b.output], [1500, 160])
  assert.equal(JSON.parse(b.raw).input, 2500) // bruto preservado
  const reset = row(rec({ session: s, metric: cum(300, 30) })) // menor que a base: compactacao/reinicio
  assert.deepEqual([reset.input, reset.output], [null, null])
  assert.match(reset.note, /nenhum delta inventado/)
  const after = row(rec({ session: s, metric: cum(800, 90) })) // o valor pos-reinicio virou a nova base
  assert.deepEqual([after.input, after.output], [500, 60])
  const unknown = row(rec({ session: 'sessao-B', sessionWasNew: false, metric: cum(9000, 900) })) // sessao antiga, sem base
  assert.deepEqual([unknown.input, unknown.output], [null, null])
  assert.match(unknown.note, /sem base comparavel/)
  const next = row(rec({ session: 'sessao-B', metric: cum(9500, 950) }))
  assert.deepEqual([next.input, next.output], [500, 50])
  assert.deepEqual(deltaFromCumulative({ input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null }, null).delta.output, null)
})

test('sessoes diferentes (perfil/provedor) nao compartilham base', () => {
  const m: Metric = { consumedIn: 700, scope: 'thread', source: 'x' }
  rec({ session: 'S', sessionWasNew: true, metric: m })
  const other = row(recordUsage(db, { taskId: task, runId: ++run, provider: 'codex', profile: 'p2', session: 'S', sessionWasNew: true, metric: m }))
  assert.equal(other.input, 700)
})

test('raciocinio e cache: somados so quando o provedor os rotula como separados', () => {
  const codex = row(rec({ metric: { consumedIn: 1000, consumedOut: 200, cacheRead: 800, reasoning: 150, reasoningIncluded: true, cacheReadIncluded: true, scope: 'run', source: 'c' } }))
  assert.deepEqual([inputTotal(codex), outputTotal(codex)], [1000, 200]) // ja incluidos: nada de dupla contagem
  const claude = row(rec({ metric: { consumedIn: 50, consumedOut: 20, cacheRead: 900, cacheWrite: 30, cacheReadIncluded: false, scope: 'run', source: 'c' } }))
  assert.equal(inputTotal(claude), 980) // separado: entrada total = entrada + cache lido + cache gravado
  const unknown = row(rec({ metric: { consumedIn: 5, consumedOut: 7, reasoning: 3, scope: 'run', source: 'o' } })) // raciocinio de semantica desconhecida
  assert.equal(outputTotal(unknown), 7) // nao soma no escuro; o campo fica registrado
  assert.equal(unknown.reasoning, 3)
})

test('adaptadores extraem cache/raciocinio; evento de passo repetido nao soma duas vezes', () => {
  const codex = AGENTS.codex.parse({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 8 } })[0] as any
  assert.deepEqual([codex.metric.cacheRead, codex.metric.reasoning, codex.metric.reasoningIncluded], [60, 8, true])
  const claude = AGENTS.claude.parse({ type: 'result', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 500, cache_creation_input_tokens: 6 }, result: 'ok' }) as any[]
  const cm = claude.find(e => e.kind === 'context').metric
  assert.deepEqual([cm.consumedIn, cm.cacheRead, cm.cacheWrite, cm.cacheReadIncluded], [3, 500, 6, false])
  const step = { type: 'step_finish', part: { id: 'p1', reason: 'tool-calls', tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 5, write: 1 } } } }
  const e = AGENTS.opencode.parse(step)[0] as any
  assert.equal(e.key, 'p1')
  assert.equal(mergeMetric(undefined, e.metric, true).cacheRead, 5)
})

test('agregacao pai + filhos: soma sem dupla contagem e total parcial explicito', () => {
  const t2 = createTask(db, 'C:/x', 't2')
  recordUsage(db, { taskId: t2, runId: 900, provider: 'claude', model: 'opus', metric: { consumedIn: 100, consumedOut: 10, cacheRead: 400, cacheReadIncluded: false, scope: 'run', source: 's' }, promptChars: 1000, toolCalls: 3 })
  recordUsage(db, { taskId: t2, delegationId: 1, provider: 'codex', model: 'luna', metric: { consumedIn: 50, consumedOut: 5, scope: 'run', source: 's' }, resultChars: 700 })
  recordUsage(db, { taskId: t2, delegationId: 2, provider: 'gemini', promptChars: 200 }) // sem metrica
  const u = taskUsage(db, t2)
  assert.deepEqual([u.parent.input.sum, u.parent.output.sum, u.children.input.sum, u.children.output.sum], [500, 10, 50, 5])
  assert.deepEqual([u.all.input.sum, u.all.output.sum, u.all.records, u.all.unavailable], [550, 15, 3, 1])
  assert.deepEqual([u.all.input.state, u.all.input.known, u.all.input.expected], ['partial', 2, 3]) // 2 de 3 execucoes informaram: total CONHECIDO, nao completo
  assert.deepEqual([u.all.tokens.sum, u.all.tokens.state], [565, 'partial'])
  assert.deepEqual([u.parent.tokens.state, u.children.tokens.state], ['complete', 'partial'])
  assert.equal(u.parent.promptChars + u.children.promptChars, 1200)
  assert.equal(u.byProvider.length, 3)
  const empty = taskUsage(db, createTask(db, 'C:/x', 'vazia')).all
  assert.deepEqual([empty.input.sum, empty.input.state, empty.tokens.sum, empty.tokens.state], [null, 'unavailable', null, 'unavailable']) // nenhum dado: indisponivel, nao 0
})

// Fase 4: cada campo tem soma conhecida + cobertura; NULL nunca vira zero observado e soma parcial nunca e chamada de completa.
test('cobertura: so entrada, so saida, nenhum campo, mistura, zero real e ferramentas separadas de chamadas ao modelo', () => {
  const T = (name: string) => createTask(db, 'C:/x', name)
  const put = (t: number, o: any) => recordUsage(db, { taskId: t, runId: ++run, provider: 'codex', ...o })
  const m = (o: Partial<Metric>): Metric => ({ scope: 'run', source: 's', ...o })
  let t = T('so entrada'); put(t, { metric: m({ consumedIn: 10 }) })
  let u = taskUsage(db, t).all
  assert.deepEqual([u.input.sum, u.input.state, u.output.sum, u.output.state, u.tokens.sum, u.tokens.state], [10, 'complete', null, 'unavailable', 10, 'partial']) // entrada sozinha nao e o total
  t = T('so saida'); put(t, { metric: m({ consumedOut: 7 }) })
  u = taskUsage(db, t).all
  assert.deepEqual([u.tokens.sum, u.tokens.state, u.input.sum], [7, 'partial', null])
  t = T('nenhum'); put(t, { promptChars: 100 })
  u = taskUsage(db, t).all
  assert.deepEqual([u.tokens.sum, u.tokens.state, u.unavailable, u.promptChars], [null, 'unavailable', 1, 100]) // payload conhecido, tokens desconhecidos
  t = T('zero real'); put(t, { metric: m({ consumedIn: 0, consumedOut: 0 }) })
  u = taskUsage(db, t).all
  assert.deepEqual([u.tokens.sum, u.tokens.state], [0, 'complete']) // zero informado pelo provedor e diferente de ausencia
  t = T('mistura'); put(t, { metric: m({ consumedIn: 100, consumedOut: 10 }) }); put(t, { metric: m({ consumedIn: 50 }) }); put(t, {})
  u = taskUsage(db, t).all
  assert.deepEqual([u.input.sum, u.input.known, u.input.expected, u.input.state, u.output.sum, u.output.known, u.output.state], [150, 2, 3, 'partial', 10, 1, 'partial'])
  assert.equal(u.tokens.state, 'partial')
  // cache separado x incluso: soma so quando rotulado; cache SEM rotulo torna a entrada total ambigua (parcial), sem dupla contagem
  t = T('cache'); put(t, { metric: m({ consumedIn: 50, consumedOut: 20, cacheRead: 900, cacheWrite: 30, cacheReadIncluded: false }) })
  u = taskUsage(db, t).all
  assert.deepEqual([u.input.sum, u.input.state, u.cacheRead.sum, u.cacheRead.state, u.cacheWrite.sum], [980, 'complete', 900, 'complete', 30])
  t = T('cache incluso'); put(t, { metric: m({ consumedIn: 1000, consumedOut: 200, cacheRead: 800, cacheReadIncluded: true, reasoning: 150, reasoningIncluded: true }) })
  u = taskUsage(db, t).all
  assert.deepEqual([u.input.sum, u.output.sum, u.tokens.sum, u.tokens.state, u.reasoning.sum], [1000, 200, 1200, 'complete', 150]) // ja incluidos: nada de dupla contagem
  t = T('ambiguo'); put(t, { metric: m({ consumedIn: 5, consumedOut: 7, cacheRead: 3, reasoning: 2 }) }) // semantica de cache/raciocinio nao informada
  u = taskUsage(db, t).all
  assert.deepEqual([u.input.sum, u.input.state, u.output.sum, u.output.state, u.tokens.state], [5, 'partial', 7, 'partial', 'partial'])
  // estimativa e rotulada e ferramentas nao sao chamadas ao modelo
  t = T('estimado'); put(t, { metric: m({ consumedIn: 10, consumedOut: 1, estimated: true }), toolCalls: 4 })
  u = taskUsage(db, t).all
  assert.equal(u.tokens.estimated, true); assert.deepEqual([u.toolCalls.sum, u.toolCalls.state], [4, 'complete'])
  assert.equal(taskUsage(db, t).modelCalls.state, 'unavailable') // nao se inventa contagem de inferencias
  t = T('sem ferramentas informadas'); put(t, {}); put(t, { toolCalls: 0 })
  u = taskUsage(db, t).all
  assert.deepEqual([u.toolCalls.sum, u.toolCalls.known, u.toolCalls.expected, u.toolCalls.state], [0, 1, 2, 'partial']) // 0 real (1 registro) x nao informado (outro)
  assert.equal((db.prepare('SELECT tool_calls FROM usage_records WHERE task_id=? ORDER BY id').all(t) as any[])[0].tool_calls, null)
})

test('pai, filhos e retrabalho: continuacoes, delegacoes que falharam e tentativas aparecem separados', () => {
  const t = createTask(db, 'C:/x', 'retrabalho')
  let did = 500 // ids proprios: o banco do arquivo ja tem registros de uso com delegation_id de outros testes
  const del = (status: string, cont: number | null) => Number(db.prepare("INSERT INTO delegations (id, task_id, provider, mode, objective, status, continuation_of) VALUES (?,?,?,?,?,?,?)").run(++did, t, 'codex', 'read', 'x', status, cont).lastInsertRowid)
  const d1 = del('failed', null); del('completed', d1); del('completed', null)
  recordUsage(db, { taskId: t, runId: ++run, provider: 'claude', metric: { consumedIn: 1, consumedOut: 1, source: 's' }, retries: 2 })
  recordUsage(db, { taskId: t, delegationId: d1, provider: 'codex', metric: { consumedIn: 2, consumedOut: 2, source: 's' }, retries: 1 })
  const u = taskUsage(db, t)
  assert.deepEqual(u.rework, { delegations: 3, continuations: 1, failedDelegations: 1, retries: 3 })
  assert.deepEqual([u.parent.records, u.children.records, u.parent.tokens.sum, u.children.tokens.sum, u.all.tokens.sum], [1, 1, 2, 4, 6])
})

test('comparacao entre estrategias: so conclui com cobertura completa e mesma condicao de cache; quem reporta menos campos nao parece mais barato', () => {
  const bucketOf = (...ms: Partial<Metric>[]) => { const t = createTask(db, 'C:/x', 'b'); for (const o of ms) recordUsage(db, { taskId: t, runId: ++run, provider: 'codex', metric: { scope: 'run', source: 's', ...o } }); return taskUsage(db, t).all }
  const a = bucketOf({ consumedIn: 1000, consumedOut: 100, cacheRead: 500, cacheReadIncluded: true })
  const b = bucketOf({ consumedIn: 400, consumedOut: 50, cacheRead: 200, cacheReadIncluded: true })
  const ok = compareUsage(a, b)
  assert.deepEqual([ok.comparable, ok.delta, ok.why], [true, -650, []])
  const fewer = bucketOf({ consumedIn: 10 }) // reporta menos campos: parece baratissimo, mas nao e comparavel
  const bad = compareUsage(a, fewer)
  assert.deepEqual([bad.comparable, bad.delta], [false, null]); assert.match(bad.why.join(' '), /B com cobertura partial/)
  const noCache = bucketOf({ consumedIn: 400, consumedOut: 50 }) // outra condicao de cache (nao informado)
  assert.match(compareUsage(a, noCache).why.join(' '), /condicao de cache diferente \(A: complete, B: unavailable\)/)
  assert.match(compareUsage(bucketOf({ consumedIn: 1, consumedOut: 1, estimated: true }), bucketOf({ consumedIn: 1, consumedOut: 1, estimated: true })).why.join(' '), /estimados/)
})

test('relatorio de delegacoes: agrupa por modelo, NULL nao vira zero, so os ultimos dias e sem estimar o que o pai gastaria', () => {
  const t = createTask(db, 'C:/rel', 'r')
  const del = (result: string, status = 'completed') => Number(db.prepare("INSERT INTO delegations (task_id, provider, model, mode, objective, status, result) VALUES (?, 'opencode', 'flash', 'read', 'o', ?, ?)").run(t, status, result).lastInsertRowid)
  const u = (delegationId: number, metric?: any) => recordUsage(db, { taskId: t, delegationId, provider: 'opencode', model: 'flash', metric })
  u(del('x'.repeat(100)), { consumedIn: 1000, consumedOut: 50, source: 's' })
  u(del('y'.repeat(20), 'failed'))
  const old = del('z'); u(old, { consumedIn: 9, consumedOut: 9, source: 's' })
  db.prepare("UPDATE usage_records SET created_at=datetime('now','-30 days') WHERE delegation_id=?").run(old)
  const r = delegationReport(db, 7).find(x => x.model === 'flash')!
  assert.deepEqual([r.delegations, r.failed, r.returnedChars], [2, 1, 120])
  assert.deepEqual([r.tokens.sum, r.tokens.state], [1050, 'partial']) // a delegacao sem medida deixa o total parcial, nunca soma 0
  assert.ok(!('saved' in r) && !('savings' in r))
})
