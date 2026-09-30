// Benchmark "so o pai" (P) x "pai + filho" (D) na MESMA conversa (pergunta + continuacoes), roteiro em scripts/bench/README.md.
// O que se compara e a conta INTEIRA de cada mensagem do usuario: execucao do pai + todas as delegacoes que ela abriu. So numeros
// informados pelo provedor; qualquer parte sem dado deixa a mensagem sem total (nunca vira 0). Sem dependencia de 'electron'.
import { fmt, stat, totalInput, verdict } from './bench.ts'
import { relativeCost } from './usageReport.ts'

export type UsageLike = { provider: string; input: number | null; cache_read: number | null; cache_write: number | null; cache_read_included: number | null }
export type PairRow = { variant: 'P' | 'D'; round: number; step: number; parent: UsageLike | null; children: UsageLike[] }

// Entrada total e custo relativo (estimativa) de UMA mensagem do usuario: pai + filhos. null se qualquer parte nao foi informada.
export function stepFigures(r: PairRow): { total: number | null; cost: number | null; childTotal: number | null; delegations: number } {
  const parts = r.parent ? [r.parent, ...r.children] : []
  const sum = (f: (u: UsageLike) => number | null) => { const v = parts.map(f); return parts.length && v.every(x => x != null) ? (v as number[]).reduce((a, b) => a + b, 0) : null }
  const kids = r.children.map(totalInput)
  return { total: sum(totalInput), cost: sum(relativeCost), childTotal: kids.every(x => x != null) ? (kids as number[]).reduce((a, b) => a + b, 0) : null, delegations: r.children.length }
}

// Tabela P x D por mensagem (e o acumulado da conversa), com media e faixa entre rodadas. "D menor/maior" so quando as faixas nao se sobrepoem.
export function pairTable(rows: PairRow[], labels: string[]): string {
  const f = rows.map(r => ({ ...r, ...stepFigures(r) }))
  const rounds = (v: 'P' | 'D') => [...new Set(f.filter(r => r.variant === v).map(r => r.round))]
  // Acumulado por rodada: so quando TODAS as mensagens daquela rodada tem total.
  const acc = (v: 'P' | 'D', k: 'total' | 'cost') => rounds(v).map(rd => {
    const xs = f.filter(r => r.variant === v && r.round === rd).map(r => r[k])
    return xs.length === labels.length && xs.every(x => x != null) ? (xs as number[]).reduce((a, b) => a + b, 0) : null
  })
  const at = (v: 'P' | 'D', step: number, k: 'total' | 'cost' | 'childTotal' | 'delegations') => f.filter(r => r.variant === v && r.step === step).map(r => r[k])
  const out = [`Rodadas: P=${rounds('P').length}, D=${rounds('D').length}. Entrada total = pai + filhos daquela mensagem. Custo relativo = ESTIMATIVA (pesos do preco publico da API).`, '',
    '| mensagem | metrica | P: so o pai | D: pai + filho | D x P |', '|---|---|---|---|---|']
  labels.forEach((label, i) => {
    for (const [k, name] of [['total', 'entrada total'], ['cost', 'custo relativo (est.)']] as const) {
      const p = stat(at('P', i, k)), d = stat(at('D', i, k))
      out.push(`| ${label} | ${name} | ${fmt(p)} | ${fmt(d)} | ${verdict(p, d, 'D')} |`)
    }
    out.push(`| ${label} | delegacoes / entrada dos filhos (D) | — | ${fmt(stat(at('D', i, 'delegations')))} / ${fmt(stat(at('D', i, 'childTotal')))} | |`)
  })
  for (const [k, name] of [['total', 'entrada total'], ['cost', 'custo relativo (est.)']] as const) {
    const p = stat(acc('P', k)), d = stat(acc('D', k))
    out.push(`| **conversa inteira** | ${name} | ${fmt(p)} | ${fmt(d)} | ${verdict(p, d, 'D')} |`)
  }
  return out.join('\n')
}
