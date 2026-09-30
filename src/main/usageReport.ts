// "Onde se gasta": relatorio SO LEITURA sobre o uso REAL ja gravado (usage_records), para decidir o que otimizar. Nenhuma chamada a CLI.
// So numeros e IDs de tarefa (nenhum texto de conversa nem titulo). Campo nao informado fica fora das somas e e contado como "sem dado", nunca 0.
// Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import { totalInput } from './bench.ts'

type Row = { task_id: number; run_id: number | null; delegation_id: number | null; provider: string; model: string | null; session_id: string | null; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; cache_read_included: number | null; tool_calls: number | null; created_at: string }
type Agg = { runs: number; total: number; withTotal: number; output: number; withOutput: number; cacheRead: number; withCache: number; tools: number; cost: number; withCost: number }
const agg = (): Agg => ({ runs: 0, total: 0, withTotal: 0, output: 0, withOutput: 0, cacheRead: 0, withCache: 0, tools: 0, cost: 0, withCost: 0 })

// Custo RELATIVO de entrada (ESTIMATIVA), em "tokens de entrada nova equivalentes", pelos pesos do preco publico da API de cada provedor:
// Anthropic grava cache a 1,25x e le a 0,1x; OpenAI (Codex) le a 0,1x e nao cobra gravacao (o cache ja esta dentro da entrada informada).
// Provedor sem peso conhecido (Gemini, OpenCode: depende do modelo) fica sem estimativa, nunca 0. A quota da assinatura pode pesar diferente.
export const COST_WEIGHTS: Record<string, { read: number; write: number }> = { claude: { read: 0.1, write: 1.25 }, codex: { read: 0.1, write: 1 } }
export function relativeCost(r: Pick<Row, 'provider' | 'input' | 'cache_read' | 'cache_write' | 'cache_read_included'>): number | null {
  const w = COST_WEIGHTS[r.provider]
  if (!w || r.input == null) return null
  if (r.cache_read_included === 1) return r.cache_read == null ? null : (r.input - r.cache_read) + r.cache_read * w.read
  return r.cache_read == null || r.cache_write == null ? null : r.input + r.cache_read * w.read + r.cache_write * w.write
}
function add(a: Agg, r: Row) {
  a.runs++
  const t = totalInput(r), c = relativeCost(r)
  if (t != null) { a.total += t; a.withTotal++ }
  if (c != null) { a.cost += c; a.withCost++ }
  if (r.output != null) { a.output += r.output; a.withOutput++ }
  if (t != null && r.cache_read != null) { a.cacheRead += r.cache_read; a.withCache++ }
  a.tools += r.tool_calls ?? 0
}
const n = (x: number) => Math.round(x).toLocaleString('pt-BR')
const pct = (x: number, of: number) => (of ? `${Math.round((x / of) * 100)}%` : '—')
const avg = (sum: number, cnt: number) => (cnt ? n(sum / cnt) : '—')

// Faixas da posicao da execucao DENTRO da mesma sessao nativa do pai: mostra quanto a entrada cresce conforme a conversa acumula historico.
// Cache de prompt: a janela curta dos provedores e de ~5 min; dentro dela uma mensagem seguinte da mesma sessao deveria ler quase tudo do cache.
const CACHE_WINDOW_MS = 5 * 60_000, MISS_BELOW = 0.5
const BUCKETS: [number, number, string][] = [[1, 1, '1a mensagem'], [2, 3, '2a-3a'], [4, 7, '4a-7a'], [8, 15, '8a-15a'], [16, Infinity, '16a em diante']]

export function whereReport(db: DatabaseSync, o: { days?: number } = {}): string {
  const since = o.days ? `AND created_at >= datetime('now', '-${Math.max(1, Math.floor(o.days))} days')` : ''
  const rows = db.prepare(`SELECT task_id, run_id, delegation_id, provider, model, session_id, input, output, cache_read, cache_write, cache_read_included, tool_calls, created_at FROM usage_records WHERE 1=1 ${since} ORDER BY id`).all() as Row[]
  if (!rows.length) return 'Nenhum registro de uso no periodo.'
  const all = agg(); rows.forEach(r => add(all, r))
  const out: string[] = [`# Onde se gasta (${rows.length} execucoes${o.days ? `, ultimos ${o.days} dias` : ''})`, '',
    'Numeros informados pelos provedores. "Entrada total" = entrada + cache lido + cache gravado (ou so a entrada quando o provedor ja inclui o cache).',
    `Execucoes sem entrada informada: ${all.runs - all.withTotal} (fora das somas). O Jarvis nao grava uso e nao aparece aqui.`,
    '"Custo relativo (est.)" = ESTIMATIVA em tokens de entrada nova equivalentes, pelos pesos do preco publico da API (Claude: cache lido 0,1x, gravado 1,25x; Codex: lido 0,1x). Gemini/OpenCode sem peso: "—". A quota da assinatura pode pesar diferente.', '']

  // 1. Por papel e provedor/modelo
  const byPart = new Map<string, Agg>()
  for (const r of rows) { const k = `${r.delegation_id ? 'filho' : 'pai'}|${r.provider}|${r.model ?? 'padrao'}`; if (!byPart.has(k)) byPart.set(k, agg()); add(byPart.get(k)!, r) }
  out.push('## Por papel e provedor', '', '| papel | provedor | modelo | execucoes | entrada total | % do total | media por execucao | cache lido | custo relativo (est.) | % do custo (est.) | saida | ferramentas |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [k, a] of [...byPart].sort((x, y) => y[1].total - x[1].total)) {
    const [part, prov, model] = k.split('|')
    out.push(`| ${part} | ${prov} | ${model} | ${a.runs} | ${n(a.total)} | ${pct(a.total, all.total)} | ${avg(a.total, a.withTotal)} | ${pct(a.cacheRead, a.total)} | ${a.withCost ? n(a.cost) : '—'} | ${a.withCost ? pct(a.cost, all.cost) : '—'} | ${a.withOutput ? n(a.output) : '—'} | ${a.tools} |`)
  }

  // 2. Crescimento da entrada do pai conforme a sessao avanca (+ execucoes em que o cache deveria ter batido e nao bateu)
  const pos = new Map<string, { p: number; at: number }>(), byPos = BUCKETS.map(() => agg())
  const misses: { task: number; p: number; gapMin: number; hit: number }[] = []
  let eligible = 0
  for (const r of rows) {
    if (r.delegation_id || !r.session_id) continue
    const key = `${r.provider}|${r.session_id}`, at = Date.parse(`${r.created_at.replace(' ', 'T')}Z`)
    const prev = pos.get(key), p = (prev?.p ?? 0) + 1
    pos.set(key, { p, at })
    add(byPos[BUCKETS.findIndex(([lo, hi]) => p >= lo && p <= hi)], r)
    const t = totalInput(r)
    if (prev && at - prev.at <= CACHE_WINDOW_MS && t && r.cache_read != null) {
      eligible++
      if (r.cache_read / t < MISS_BELOW) misses.push({ task: r.task_id, p, gapMin: Math.round((at - prev.at) / 60000), hit: r.cache_read / t })
    }
  }
  out.push('', '## Pai: entrada por mensagem conforme a sessao cresce', '', '| posicao na sessao | execucoes | media de entrada total | media de cache lido | % lido do cache |', '|---|---|---|---|---|')
  BUCKETS.forEach(([, , label], i) => { const a = byPos[i]; if (a.runs) out.push(`| ${label} | ${a.runs} | ${avg(a.total, a.withTotal)} | ${avg(a.cacheRead, a.withCache)} | ${pct(a.cacheRead, a.total)} |`) })
  out.push('', `Cache que deveria ter batido: ${eligible} mensagem(ns) do pai ate ${CACHE_WINDOW_MS / 60000} min depois da anterior na mesma sessao; ${misses.length} com menos de ${MISS_BELOW * 100}% lido do cache (possivel quebra de prefixo: instrucoes, ferramentas ou historico mudaram).`)
  if (misses.length) out.push('', '| tarefa | posicao na sessao | minutos desde a anterior | % lido do cache |', '|---|---|---|---|', ...misses.slice(0, 10).map(m => `| #${m.task} | ${m.p} | ${m.gapMin} | ${Math.round(m.hit * 100)}% |`))

  // 3. Tarefas que mais gastaram (so o ID)
  const byTask = new Map<number, { pai: Agg; filho: Agg }>()
  for (const r of rows) { if (!byTask.has(r.task_id)) byTask.set(r.task_id, { pai: agg(), filho: agg() }); add(byTask.get(r.task_id)![r.delegation_id ? 'filho' : 'pai'], r) }
  out.push('', '## Tarefas que mais gastaram (ID da tarefa; abra no app para ver qual e)', '', '| tarefa | entrada total | % do total | execucoes do pai | media do pai | delegacoes | media do filho |', '|---|---|---|---|---|---|---|')
  for (const [id, t] of [...byTask].sort((x, y) => (y[1].pai.total + y[1].filho.total) - (x[1].pai.total + x[1].filho.total)).slice(0, 10))
    out.push(`| #${id} | ${t.pai.withTotal + t.filho.withTotal ? n(t.pai.total + t.filho.total) : '—'} | ${t.pai.withTotal + t.filho.withTotal ? pct(t.pai.total + t.filho.total, all.total) : '—'} | ${t.pai.runs} | ${avg(t.pai.total, t.pai.withTotal)} | ${t.filho.runs} | ${avg(t.filho.total, t.filho.withTotal)} |`)
  return out.join('\n')
}
