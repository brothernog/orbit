// Contabilidade de uso por execucao/delegacao. Campo nao informado pelo provedor fica NULL (nunca 0).
// Sem dependencia de 'electron'. Estes numeros vem dos eventos das CLIs: nao medem o prompt oculto delas nem cota de assinatura.
import type { DatabaseSync } from 'node:sqlite'
import type { Metric } from './adapters.ts'

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]

export type UsageInput = {
  taskId: number; runId?: number; delegationId?: number
  provider: string; profile?: string; model?: string | null; effort?: string | null
  session?: string
  sessionWasNew?: boolean // a sessao nativa nasceu nesta execucao: um acumulado do thread equivale ao consumo da execucao (base 0)
  metric?: Metric
  promptChars?: number; contextChars?: number; resultChars?: number
  toolCalls?: number // ferramentas/comandos que a CLI informou ter executado: NAO e o numero de chamadas ao modelo (nenhuma CLI o informa de forma comparavel)
  retries?: number; durationMs?: number
}

type Fields = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }
const fieldsOf = (m?: Metric): Fields => ({
  input: m?.consumedIn ?? null, output: m?.consumedOut ?? null, cacheRead: m?.cacheRead ?? null, cacheWrite: m?.cacheWrite ?? null, reasoning: m?.reasoning ?? null
})
const KEYS: (keyof Fields)[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const flag = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0)

// Acumulado do thread -> consumo desta execucao. So subtrai quando a base e comparavel (mesma sessao, ultimo registro dela).
// Reinicio/compactacao/sessao substituida (acumulado menor que a base) nao gera delta negativo: o consumo fica NULL e o novo valor vira a base.
export function deltaFromCumulative(raw: Fields, base: Fields | null | 'unknown'): { delta: Fields; note?: string } {
  const empty: Fields = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }
  if (base === 'unknown') return { delta: empty, note: 'acumulado do thread sem base comparavel (sessao ja existia antes do registro): consumo desta execucao indisponivel' }
  const b = base ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const delta = { ...empty }
  for (const k of KEYS) {
    if (raw[k] === null) continue
    const prev = b[k] ?? 0
    if (raw[k]! < prev) return { delta: empty, note: 'acumulado menor que a base (reinicio, compactacao ou sessao substituida): consumo desta execucao indisponivel, nenhum delta inventado' }
    delta[k] = raw[k]! - prev
  }
  return { delta }
}

export function recordUsage(db: DatabaseSync, u: UsageInput): number {
  if (!u.runId === !u.delegationId) throw new Error('recordUsage: informe runId OU delegationId.')
  const profile = u.profile ?? ''
  const m = u.metric
  let f = fieldsOf(m), note: string | undefined, raw: Fields | null = null
  if (m?.scope === 'thread') {
    raw = f
    let base: Fields | null | 'unknown'
    const prev = u.session ? get(db, "SELECT raw FROM usage_records WHERE task_id=? AND provider=? AND profile=? AND session_id=? AND raw IS NOT NULL ORDER BY id DESC LIMIT 1", u.taskId, u.provider, profile, u.session) : null
    if (prev?.raw) base = JSON.parse(prev.raw)
    else base = u.sessionWasNew ? null : 'unknown'
    ;({ delta: f, note } = deltaFromCumulative(raw, base))
  }
  const r = db.prepare(`INSERT INTO usage_records (task_id, run_id, delegation_id, provider, profile, model, effort, session_id, source, scope,
    input, output, cache_read, cache_write, reasoning, reasoning_included, cache_read_included, raw, estimated, note,
    prompt_chars, context_chars, result_chars, tool_calls, retries, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(u.taskId, u.runId ?? null, u.delegationId ?? null, u.provider, profile, u.model ?? null, u.effort ?? null, u.session ?? null, m?.source ?? null, m?.scope ?? null,
      f.input, f.output, f.cacheRead, f.cacheWrite, f.reasoning, flag(m?.reasoningIncluded), flag(m?.cacheReadIncluded), raw ? JSON.stringify(raw) : null,
      m?.estimated ? 1 : 0, note ?? null,
      u.promptChars ?? null, u.contextChars ?? null, u.resultChars ?? null, u.toolCalls ?? null, u.retries ?? 0, u.durationMs ?? null)
  return Number(r.lastInsertRowid)
}

// Entrada/saida "totais" sem contar duas vezes: raciocinio e cache so somam quando o provedor os rotula como SEPARADOS.
export const inputTotal = (r: any): number | null =>
  r.input === null ? null : r.input + (r.cache_read_included === 0 ? (r.cache_read ?? 0) + (r.cache_write ?? 0) : 0)
export const outputTotal = (r: any): number | null =>
  r.output === null ? null : r.output + (r.reasoning_included === 0 ? (r.reasoning ?? 0) : 0)

// Cada campo agregado carrega a soma do que e CONHECIDO e a cobertura: `known` registros com valor confiavel de `expected`. Nunca soma NULL como 0:
//   complete = todos os registros informaram; partial = so parte (a soma e "total conhecido", nao o consumo completo); unavailable = nenhum.
// `withValue` conta registros que contribuiram para a soma (inclui os de semantica ambigua, ex.: cache sem rotulo, que ficam fora de `known`).
export type Cover = 'complete' | 'partial' | 'unavailable'
export type Total = { sum: number | null; known: number; withValue: number; expected: number; state: Cover; estimated: boolean }
const total = (): Total => ({ sum: null, known: 0, withValue: 0, expected: 0, state: 'unavailable', estimated: false })
// value = numero a somar (null = nao informado); reliable = false quando o valor existe mas sua semantica e ambigua (nao prova total completo).
function feed(t: Total, value: number | null, reliable: boolean, estimated: boolean) {
  t.expected++
  if (value !== null) { t.sum = (t.sum ?? 0) + value; t.withValue++; if (estimated) t.estimated = true; if (reliable) t.known++ }
  t.state = t.withValue === 0 ? 'unavailable' : t.known === t.expected ? 'complete' : 'partial'
}
// Entrada total so e completa se, havendo cache informado, o provedor rotulou se ele esta incluido ou separado; idem raciocinio na saida.
const inputReliable = (r: any) => r.input !== null && !((r.cache_read !== null || r.cache_write !== null) && r.cache_read_included === null)
const outputReliable = (r: any) => r.output !== null && !(r.reasoning !== null && r.reasoning_included === null)

type Bucket = {
  records: number
  input: Total; output: Total; cacheRead: Total; cacheWrite: Total; reasoning: Total
  toolCalls: Total // ferramentas/comandos executados (NAO sao chamadas ao modelo)
  durationMs: Total
  promptChars: number; contextChars: number; resultChars: number // tamanho do payload em caracteres (nunca tokens)
  retries: number
  unavailable: number // registros sem entrada E sem saida informadas
}
const bucket = (): Bucket => ({
  records: 0, input: total(), output: total(), cacheRead: total(), cacheWrite: total(), reasoning: total(), toolCalls: total(), durationMs: total(),
  promptChars: 0, contextChars: 0, resultChars: 0, retries: 0, unavailable: 0
})
function feedBucket(b: Bucket, r: any) {
  const est = !!r.estimated
  b.records++
  feed(b.input, inputTotal(r), inputReliable(r), est); feed(b.output, outputTotal(r), outputReliable(r), est)
  feed(b.cacheRead, r.cache_read, true, est); feed(b.cacheWrite, r.cache_write, true, est); feed(b.reasoning, r.reasoning, true, est)
  feed(b.toolCalls, r.tool_calls, true, false); feed(b.durationMs, r.duration_ms, true, false)
  b.promptChars += r.prompt_chars ?? 0; b.contextChars += r.context_chars ?? 0; b.resultChars += r.result_chars ?? 0; b.retries += r.retries ?? 0
  if (r.input === null && r.output === null) b.unavailable++
}

// Pai (execucoes do usuario) + filhos (delegacoes) da tarefa + retrabalho (continuacoes, delegacoes que falharam, tentativas repetidas).
// Total de tokens so e "completo" quando entrada e saida sao ambas completas; senao a interface deve mostrar "total conhecido (parcial)".
export function taskUsage(db: DatabaseSync, taskId: number) {
  const rows = all(db, 'SELECT * FROM usage_records WHERE task_id=? ORDER BY id', taskId)
  const groups = { parent: bucket(), children: bucket(), all: bucket() }
  const byProvider = new Map<string, Bucket & { provider: string; model: string | null }>()
  for (const r of rows) {
    const key = `${r.provider}|${r.model ?? ''}`
    if (!byProvider.has(key)) byProvider.set(key, { ...bucket(), provider: r.provider, model: r.model })
    for (const b of [r.delegation_id ? groups.children : groups.parent, groups.all, byProvider.get(key)!]) feedBucket(b, r)
  }
  const d = get(db, "SELECT COUNT(*) total, SUM(continuation_of IS NOT NULL) continuations, SUM(status='failed') failed FROM delegations WHERE task_id=?", taskId)
  const rework = { delegations: d?.total ?? 0, continuations: d?.continuations ?? 0, failedDelegations: d?.failed ?? 0, retries: groups.all.retries }
  const fin = <B extends Bucket>(b: B) => ({ ...b, tokens: tokenTotal(b) }) // `tokens` = entrada + saida com a cobertura: a interface so le, nao recalcula
  return {
    parent: fin(groups.parent), children: fin(groups.children), all: fin(groups.all), byProvider: [...byProvider.values()].map(fin), rework,
    modelCalls: { state: 'unavailable' as Cover, note: 'as CLIs nao informam o numero de chamadas ao modelo; toolCalls conta ferramentas executadas' }
  }
}

// Delegacoes dos ultimos `days` dias, por provedor/modelo: o que os filhos consumiram (com cobertura) e quantos caracteres voltaram ao pai.
// So agrega o que foi registrado; nao estima quanto o agente principal teria gasto (isso seria um palpite, nao uma medida).
export function delegationReport(db: DatabaseSync, days = 7) {
  const since = `-${Math.max(1, Math.round(days))} days`
  const rows = all(db, "SELECT u.*, d.result, d.status FROM usage_records u JOIN delegations d ON d.id=u.delegation_id WHERE u.created_at >= datetime('now', ?) ORDER BY u.id", since)
  const by = new Map<string, Bucket & { provider: string; model: string | null; returnedChars: number; failed: number }>()
  for (const r of rows) {
    const key = `${r.provider}|${r.model ?? ''}`
    if (!by.has(key)) by.set(key, { ...bucket(), provider: r.provider, model: r.model, returnedChars: 0, failed: 0 })
    const b = by.get(key)!
    feedBucket(b, r); b.returnedChars += (r.result ?? '').length; if (r.status === 'failed') b.failed++
  }
  return [...by.values()].map(b => ({ provider: b.provider, model: b.model, delegations: b.records, failed: b.failed, tokens: tokenTotal(b), returnedChars: b.returnedChars }))
}

// Tokens de entrada + saida de um bucket com a honestidade da cobertura: `complete` so se AMBOS os campos forem completos.
export function tokenTotal(b: Pick<Bucket, 'input' | 'output'>): { sum: number | null; state: Cover; estimated: boolean } {
  const parts = [b.input, b.output]
  const known = parts.filter(p => p.sum !== null)
  const state: Cover = !known.length ? 'unavailable' : parts.every(p => p.state === 'complete') ? 'complete' : 'partial'
  return { sum: known.length ? known.reduce((n, p) => n + p.sum!, 0) : null, state, estimated: parts.some(p => p.estimated) }
}

// Comparacao entre duas estrategias/execucoes. So conclui "menos consumo" com cobertura completa dos dois lados E a mesma condicao de cache;
// quem reporta menos campos nunca parece mais barato. Sem isso devolve os numeros conhecidos com o motivo da nao comparabilidade.
export function compareUsage(a: Pick<Bucket, 'input' | 'output' | 'cacheRead'>, b: Pick<Bucket, 'input' | 'output' | 'cacheRead'>) {
  const ta = tokenTotal(a), tb = tokenTotal(b)
  const why: string[] = []
  if (ta.state !== 'complete') why.push(`A com cobertura ${ta.state}`)
  if (tb.state !== 'complete') why.push(`B com cobertura ${tb.state}`)
  if (a.cacheRead.state !== b.cacheRead.state) why.push(`condicao de cache diferente (A: ${a.cacheRead.state}, B: ${b.cacheRead.state})`)
  if (ta.estimated || tb.estimated) why.push('ha valores estimados')
  const comparable = why.length === 0
  return { comparable, a: ta, b: tb, delta: comparable ? tb.sum! - ta.sum! : null, cache: { a: a.cacheRead.state, b: b.cacheRead.state }, why }
}
