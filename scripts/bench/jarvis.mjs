// Benchmark do Jarvis: a MESMA pergunta, com o MESMO retrato sintetico, no modo antigo (A = compativel) e no novo (B = enxuto), alternando.
// USA A SUA QUOTA DO CLAUDE (poucas chamadas curtas; padrao 3 rodadas = 6 chamadas). Nao abre o app nem o banco.
// Uso: node scripts/bench/jarvis.mjs [--rounds 3] [--model claude-sonnet-5-5] [--effort low] [--out jarvis.json]
// Conta: a do ambiente atual (CLAUDE_CONFIG_DIR, se definido; senao o login padrao da CLI).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt }
const rounds = Math.min(Math.max(Number(opt('rounds', 3)) || 3, 1), 10)
const model = opt('model', 'claude-sonnet-5-5'), effort = opt('effort', 'low'), outFile = opt('out', 'jarvis.json')
const src = p => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/main', p)).href
const { AGENTS } = await import(src('adapters.ts'))
const { buildPrompt, jarvisArgs, JARVIS_INSTRUCTIONS, JARVIS_SYSTEM_FILE } = await import(src('jarvis.ts'))
const { runChat } = await import(src('runner.ts'))
const { totalInput } = await import(src('bench.ts'))
const { hostlessEnv } = await import(src('providers.ts'))

const snap = {
  now: '29/09/2026 09:00',
  projects: [
    { name: 'Sky Raiders', kind: 'game', stack: 'Godot', branch: 'main', uncommitted: 3, worktrees: 1, openTasks: 2, lastActivity: '2026-09-28', recent: ['Salto duplo', 'Menu de pausa'] },
    { name: 'Painel', kind: 'app', stack: 'Electron', branch: 'feat/uso', uncommitted: 0, worktrees: 0, openTasks: 1, lastActivity: '2026-09-27', recent: ['Painel de uso'] }
  ],
  agents: [], todo: [{ topic: 'Hoje', text: 'Testar o salto duplo no controle', done: false, project: 'Sky Raiders' }]
}
const question = 'O que eu deveria fazer primeiro hoje?'
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-bench-jarvis-'))
fs.writeFileSync(path.join(cwd, JARVIS_SYSTEM_FILE), JARVIS_INSTRUCTIONS)

const result = { A: [], B: [], erros: [] }
for (let i = 0; i < rounds; i++) for (const lean of [false, true]) { // alterna A, B: nenhum dos dois pega sempre o cache quente
  const r = await runChat({ cmd: AGENTS.claude.cmd, args: jarvisArgs({ model, effort, lean }), cwd, env: hostlessEnv(process.env).env, parse: AGENTS.claude.parse, input: buildPrompt(snap, [], question, { lean }) }).result
  const label = lean ? 'B (enxuto)' : 'A (compativel)'
  if (r.status !== 'completed') {
    result.erros.push({ modo: label, rodada: i + 1, erro: String(r.error ?? r.status).slice(0, 300) })
    console.error(`${label} rodada ${i + 1}: FALHOU (${r.error ?? r.status})${lean ? ' -> a CLI pode nao aceitar o modo enxuto; o app cairia no compativel.' : ''}`)
    continue
  }
  const m = r.metric ?? {}
  const s = { bench: 'jarvis', part: 'jarvis', input: m.consumedIn ?? null, cacheRead: m.cacheRead ?? null, cacheWrite: m.cacheWrite ?? null, output: m.consumedOut ?? null,
    total: totalInput({ input: m.consumedIn ?? null, cache_read: m.cacheRead ?? null, cache_write: m.cacheWrite ?? null, cache_read_included: m.cacheReadIncluded ? 1 : 0 }),
    tools: r.tools?.length ?? null, ms: r.durationMs ?? null, promptChars: null, contextChars: null }
  ;(lean ? result.B : result.A).push(s)
  console.log(`${label} rodada ${i + 1}: entrada total ${s.total ?? '—'}, saida ${s.output ?? '—'}, ferramentas ${s.tools ?? '—'}\n  resposta: ${(r.answer || r.text).replace(/\s+/g, ' ').slice(0, 200)}`)
}
fs.writeFileSync(outFile, JSON.stringify({ modelo: model, esforco: effort, rodadas: rounds, ...result }, null, 2))
fs.rmSync(cwd, { recursive: true, force: true })
console.log(`\nResultado salvo em ${outFile}. Compare as respostas acima (qualidade) e passe o arquivo ao report.mjs.`)
