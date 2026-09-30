// Custo em US$ (ESTIMATIVA pelo preco publico de API) de um teste do roteiro scripts/bench/teste-economia.md. So leitura, so numeros.
// Uso:
//   node scripts/bench/custo-usd.mjs --desktop <pasta do export da sessao do Claude desktop, ja extraida>
//   node scripts/bench/custo-usd.mjs --db <dashboard.db do sandbox> [--task <id>]   (sem --task: lista as tarefas com uso)
// A assinatura nao cobra por token: o valor em US$ e o que a mesma conversa custaria na API, para comparar os testes entre si.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// US$ por milhao de tokens. Fontes (consulta 2026-09-29): Sonnet 5.5 em openrouter.ai/anthropic/claude-sonnet-5.5 e financefeeds.com;
// GPT-6 Luna em openrouter.ai/openai/gpt-6-luna e eesel.ai/blog/gpt-6-luna-pricing. Gravacao de cache no preco de 5 min nos dois lados.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cacheWrite: 0, cacheRead: 0.01, output: 0.5 }
}
const priceOf = model => PRICES[Object.keys(PRICES).find(k => model?.startsWith(k))] ?? null

// Tudo em tokens separados (entrada nova, cache gravado, cache lido, saida); null = o provedor nao informou (nunca vira 0).
export function usd(model, u) {
  const p = priceOf(model)
  if (!p || [u.input, u.cacheRead, u.output].some(x => x == null)) return null
  return (u.input * p.input + (u.cacheWrite ?? 0) * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6
}

const opt = n => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const rows = [] // { model, input, cacheWrite, cacheRead, output }

if (opt('desktop')) {
  // Transcricoes JSONL (sessao + subagentes). Cada resposta aparece uma vez por bloco de conteudo: conta cada message.id uma vez (o export traz a mesma transcricao em dois arquivos).
  const seen = new Map()
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsonl') && lines(path.join(d, e.name)))
  const lines = f => { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { let j; try { j = JSON.parse(l) } catch { continue } const m = j.message; if (m?.usage && m.id) seen.set(m.id, m) } }
  walk(path.resolve(opt('desktop')))
  for (const m of seen.values()) rows.push({ model: m.model, input: m.usage.input_tokens ?? null, cacheWrite: m.usage.cache_creation_input_tokens ?? null, cacheRead: m.usage.cache_read_input_tokens ?? null, output: m.usage.output_tokens ?? null })
} else if (opt('db')) {
  const db = new DatabaseSync(path.resolve(opt('db')), { readOnly: true })
  if (!opt('task')) {
    console.table(db.prepare('SELECT task_id, COUNT(*) execucoes, MIN(created_at) inicio FROM usage_records GROUP BY task_id ORDER BY task_id').all())
    process.exit(0)
  }
  for (const r of db.prepare('SELECT model, input, output, cache_read, cache_write, cache_read_included FROM usage_records WHERE task_id=?').all(Number(opt('task'))))
    // Codex informa o cache lido DENTRO da entrada: separa para nao cobrar duas vezes.
    rows.push({ model: r.model, input: r.cache_read_included === 1 && r.input != null && r.cache_read != null ? r.input - r.cache_read : r.input, cacheWrite: r.cache_write, cacheRead: r.cache_read, output: r.output })
} else { console.error('Uso: --desktop <pasta> | --db <dashboard.db> [--task <id>]'); process.exit(2) }

const by = new Map()
for (const r of rows) {
  const a = by.get(r.model) ?? { chamadas: 0, entrada: 0, cacheGravado: 0, cacheLido: 0, saida: 0, usd: 0, semPreco: 0 }
  a.chamadas++; a.entrada += r.input ?? 0; a.cacheGravado += r.cacheWrite ?? 0; a.cacheLido += r.cacheRead ?? 0; a.saida += r.output ?? 0
  const c = usd(r.model, r); c == null ? a.semPreco++ : (a.usd += c)
  by.set(r.model, a)
}
const tot = [...by.values()].reduce((t, a) => ({ tokens: t.tokens + a.entrada + a.cacheGravado + a.cacheLido + a.saida, usd: t.usd + a.usd }), { tokens: 0, usd: 0 })
console.table(Object.fromEntries([...by].map(([m, a]) => [m, { ...a, usd: a.usd.toFixed(4) }])))
console.log(`TOTAL: ${tot.tokens.toLocaleString('pt-BR')} tokens · US$ ${tot.usd.toFixed(4)} (estimativa, preco de API)${[...by.values()].some(a => a.semPreco) ? ' · ATENCAO: ha chamadas sem preco ou sem dado (fora da soma)' : ''}`)
