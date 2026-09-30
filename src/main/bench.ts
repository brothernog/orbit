// Benchmark A x B (roteiro em scripts/bench/README.md): le o uso REAL que os provedores informaram (usage_records) nas tarefas de benchmark
// e compara duas versoes do app. So leitura e so numeros. Campo nao informado fica fora da media (nunca vira 0); sem nenhum valor = null.
// Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'

// part: 'pai claude', 'filho codex', 'jarvis'...
export type Sample = { bench: string; part: string; input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; total: number | null; tools: number | null; ms: number | null; promptChars: number | null; contextChars: number | null }
export const METRICS = [
  ['total', 'entrada total (tokens)'], ['input', 'entrada sem cache'], ['cacheRead', 'cache lido'], ['cacheWrite', 'cache gravado'], ['output', 'saida'],
  ['tools', 'ferramentas chamadas'], ['ms', 'duracao (ms)'], ['promptChars', 'prompt enviado (caracteres)'], ['contextChars', 'contexto aprovado (caracteres)']
] as const
export type MetricKey = (typeof METRICS)[number][0]

// Entrada total = o que ocupou a entrada do modelo. Se o provedor informou que o cache ja esta dentro de `input` (Codex), e o proprio input;
// senao input + cache lido + cache gravado, e so quando os tres foram informados.
export function totalInput(r: { input: number | null; cache_read: number | null; cache_write: number | null; cache_read_included: number | null }): number | null {
  if (r.input == null) return null
  if (r.cache_read_included === 1) return r.input
  return r.cache_read == null || r.cache_write == null ? null : r.input + r.cache_read + r.cache_write
}

// Tarefas de benchmark: a PRIMEIRA mensagem do usuario comeca com "BENCH-<id>:". Cada registro de uso delas vira uma amostra (pai ou filho).
export function benchSamples(db: DatabaseSync): Sample[] {
  const tasks = db.prepare(`SELECT m.task_id, m.text FROM messages m WHERE m.role='user' AND m.id = (SELECT MIN(id) FROM messages WHERE task_id=m.task_id AND role='user')`).all() as any[]
  const out: Sample[] = []
  for (const t of tasks) {
    const id = /^\s*BENCH-([\w-]+):/.exec(String(t.text))?.[1]
    if (!id) continue
    for (const r of db.prepare('SELECT * FROM usage_records WHERE task_id=? ORDER BY id').all(t.task_id) as any[])
      out.push({
        bench: id, part: `${r.delegation_id ? 'filho' : 'pai'} ${r.provider}`, input: r.input, cacheRead: r.cache_read, cacheWrite: r.cache_write, output: r.output, total: totalInput(r),
        tools: r.tool_calls ?? r.calls ?? null, ms: r.duration_ms, promptChars: r.prompt_chars, contextChars: r.context_chars
      })
  }
  return out
}

export type Stat = { n: number; mean: number; min: number; max: number } | null
export function stat(xs: (number | null)[]): Stat {
  const v = xs.filter((x): x is number => typeof x === 'number')
  return v.length ? { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) } : null
}

export const fmt = (s: Stat) => (s ? `${Math.round(s.mean).toLocaleString('pt-BR')} (${Math.round(s.min).toLocaleString('pt-BR')}–${Math.round(s.max).toLocaleString('pt-BR')}, n=${s.n})` : '— (nao informado)')
// Diferenca so quando as faixas NAO se sobrepoem; sobrepostas = dentro da variacao entre rodadas (nao ha diferenca mensuravel).
export function verdict(a: Stat, b: Stat, name = 'B'): string {
  if (!a || !b) return 'sem dado'
  const pct = a.mean ? `${b.mean <= a.mean ? '' : '+'}${Math.round(((b.mean - a.mean) / a.mean) * 100)}%` : ''
  if (b.max < a.min) return `${name} menor ${pct}`
  if (b.min > a.max) return `${name} maior ${pct}`
  return `dentro da variacao (${pct || '0%'})`
}

// Tabela markdown A x B por benchmark e parte (pai/filho + provedor, ou jarvis).
export function compareTable(a: Sample[], b: Sample[]): string {
  const groups = [...new Set([...a, ...b].map(s => `${s.bench}|${s.part}`))].sort()
  if (!groups.length) return 'Nenhuma tarefa de benchmark encontrada (a primeira mensagem deve comecar com "BENCH-<id>:").'
  const lines: string[] = []
  for (const g of groups) {
    const [bench, part] = g.split('|')
    const of = (xs: Sample[]) => xs.filter(s => s.bench === bench && s.part === part)
    const sa = of(a), sb = of(b)
    lines.push(`\n### BENCH-${bench} · ${part} (rodadas: A=${sa.length}, B=${sb.length})\n`, '| metrica | A (media, min–max) | B (media, min–max) | B x A |', '|---|---|---|---|')
    for (const [k, label] of METRICS) {
      const x = stat(sa.map(s => s[k])), y = stat(sb.map(s => s[k]))
      if (!x && !y) continue
      lines.push(`| ${label} | ${fmt(x)} | ${fmt(y)} | ${verdict(x, y)} |`)
    }
  }
  return lines.join('\n').trim()
}
