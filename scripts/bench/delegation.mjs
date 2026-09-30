// Benchmark da delegacao Claude em modo leitura SEM o Electron: a logica de delegacao do app (runDelegation), o servidor MCP local e a CLI real.
// A = comportamento anterior (Read,Grep,Glob nativos + todas as ferramentas MCP; recibos/skills descartados ao fim de cada execucao).
// B = atual (taskContext.childToolset; recibos mantidos quando a sessao e a mesma). O resto (descricoes, ambiente, instrucoes de git) e o atual nas duas:
// a diferenca medida e so a de ferramentas e recibos. Rodadas alternadas A, B, A, B e, depois, uma continuacao
// do mesmo filho em cada versao. USA QUOTA REAL (so o filho; nenhum pai roda). Bancos proprios (nunca o banco real).
// Uso: node scripts/bench/delegation.mjs <pasta do projeto-alvo> [--rounds 2] [--model claude-sonnet-5-5] [--effort low] [--out <pasta>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt }
const target = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null
if (!target || !fs.existsSync(path.join(target, 'src/main/workspaceTools.ts'))) { console.error('Uso: node scripts/bench/delegation.mjs <pasta do projeto-alvo (este repositorio num commit fixo)> [--rounds 2]'); process.exit(2) }
const rounds = Math.min(Math.max(Number(opt('rounds', 2)) || 2, 1), 5)
const model = opt('model', 'claude-sonnet-5-5'), effort = opt('effort', 'low')
const outDir = path.resolve(opt('out', fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-bench-deleg-'))))
fs.mkdirSync(outDir, { recursive: true })
const src = p => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/main', p)).href
const { AGENTS } = await import(src('adapters.ts'))
const { openDb } = await import(src('db.ts'))
const { createTask } = await import(src('tasks.ts'))
const { startRun, finishRun } = await import(src('runs.ts'))
const { ApprovalWaiters, openGrant } = await import(src('consent.ts'))
const { DEFAULT_SETTINGS, mcpWire, runDelegation, WorkspaceGuard } = await import(src('delegation.ts'))
const { DEFAULT_LIMITS } = await import(src('limits.ts'))
const { newToken, startMcpServer } = await import(src('mcp.ts'))
const { callTaskTool, childToolset, toolsFor } = await import(src('taskContext.ts'))
const { runChat } = await import(src('runner.ts'))
const { dropReceipts } = await import(src('workspaceTools.ts'))
const { hostlessEnv } = await import(src('providers.ts'))
const { benchSamples, compareTable } = await import(src('bench.ts'))
const { dropSkillSession, setSkillRoots } = await import(src('skills.ts'))
setSkillRoots([path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources/skills')])

const OBJ = 'Em src/main/workspaceTools.ts, explique em ate 5 linhas como o readToken evita reenviar o mesmo trecho, citando arquivo:linha.'
const CONT = 'Confira de novo, relendo, o trecho de src/main/workspaceTools.ts que voce citou e confirme em 1 linha qual funcao emite o recibo.'
const tokens = new Map()
const mcp = await startMcpServer({
  tools: c => c.tools, authorize: t => tokens.get(t) ?? null,
  call: async (c, name, args) => (c.tools.some(t => t.name === name) ? callTaskTool(c.db, DEFAULT_LIMITS, c.t, name, args) : { text: 'Ferramenta nao anunciada.', isError: true })
})

function variant(v) {
  const db = openDb(path.join(outDir, `bench${v}.db`))
  const taskId = createTask(db, target, `BENCH ${v}`)
  finishRun(db, startRun(db, { taskId, provider: 'claude' }, `BENCH-1: delegacao Claude em leitura (${v})`), { status: 'completed', text: 'ok', notes: [] })
  const runs = []
  const deps = {
    db, guard: new WorkspaceGuard(), settings: () => DEFAULT_SETTINGS, limits: () => DEFAULT_LIMITS, waiters: new ApprovalWaiters(),
    catalogCheck: async () => null, envFor: () => hostlessEnv(process.env).env, otherTasksActiveIn: () => false, note: () => {}, onContextRequest: () => {},
    runChild: ({ provider, opts, cwd, env, input, session }) => {
      const a = AGENTS[provider]
      const child = runChat({ cmd: a.cmd, args: a.chatArgs(session, opts), cwd, env, parse: a.parse, input })
      const all = a.chatArgs(session, opts), i = all.findIndex(x => x.startsWith('--tools'))
      const nativeTools = i < 0 ? 'padrao da CLI' : all[i] === '--tools' ? all[i + 1] : 'nenhuma'
      child.result.then(r => runs.push({ tools: r.tools ?? [], nativeTools }))
      return child
    },
    // envFor como o app: sem o estado de uma sessao anfitria do Claude Code (na nuvem a continuacao herdava a sessao do host).
    childTools: async p => {
      const token = newToken()
      const set = v === 'A' ? { mcp: toolsFor('child') } : childToolset(p.provider, p.mode, p.scope)
      const w = mcpWire(p.provider, { url: mcp.url, token, timeoutSec: 600, dir: path.join(outDir, 'mcp'), tools: set.mcp.map(x => x.name), permission: false })
      if (!w) return null
      tokens.set(token, { db, tools: set.mcp, t: { taskId: p.taskId, lineage: p.lineage, auth: p.auth, role: 'child', cwd: p.cwd, scope: p.scope, delegationId: p.delegationId, provider: p.provider } })
      return { extra: w.extra, env: w.env, tools: set.mcp.map(x => x.name), ...(set.native ? { native: set.native } : {}), cleanup: keep => { tokens.delete(token); if (v === 'A' || !keep) { dropReceipts(p.auth.authId); dropSkillSession(p.auth.authId) } w.cleanup() } }
    }
  }
  const auth = openGrant(db, { taskId, recipient: { logicalId: `chat:${taskId}:claude:`, provider: 'claude', profile: '', model: null, effort: null, workspace: target, scope: [] }, sessionId: `bench-${v}` })
  const ctx = { taskId, runId: 1, provider: 'claude', cwd: target, lineage: `chat:${taskId}:claude:`, auth, depth: 0, fails: new Map(), children: new Set() }
  return { v, db, runs, call: args => runDelegation(deps, ctx, { provider: 'claude', model, effort, mode: 'read', ...args }, new AbortController().signal) }
}

const A = variant('A'), B = variant('B')
const log = []
const one = async (x, label, args) => {
  const r = await x.call(args)
  const d = x.db.prepare('SELECT id, status, result, session_id FROM delegations ORDER BY id DESC').get()
  const u = x.db.prepare('SELECT * FROM usage_records WHERE delegation_id=?').get(d.id) ?? {}
  const run = x.runs.at(-1) ?? { tools: [], nativeTools: '?' }
  const row = { versao: x.v, etapa: label, status: d.status, entrada: u.input, cacheLido: u.cache_read, cacheGravado: u.cache_write, saida: u.output, ferramentas: run.tools, nativasPermitidas: run.nativeTools, conclusao: String(d.result ?? '').slice(0, 600), erro: r.isError ? r.text.slice(0, 300) : undefined }
  log.push(row)
  console.log(`\n[${x.v}] ${label}: ${d.status} · entrada ${u.input ?? '—'} + cache lido ${u.cache_read ?? '—'} + gravado ${u.cache_write ?? '—'} · saida ${u.output ?? '—'} · nativas permitidas: ${run.nativeTools} · chamadas: ${run.tools.join(', ') || 'nenhuma'}`)
  console.log(`  conclusao: ${row.conclusao.replace(/\s+/g, ' ').slice(0, 300)}`)
  return d
}
let lastA, lastB
for (let i = 1; i <= rounds; i++) { lastA = await one(A, `rodada ${i}`, { objective: OBJ }); lastB = await one(B, `rodada ${i}`, { objective: OBJ }) }
await one(A, 'continuacao', { objective: CONT, continuationOf: lastA.id })
await one(B, 'continuacao', { objective: CONT, continuationOf: lastB.id })
mcp.close()

// Tabela A x B: as rodadas e a continuacao em grupos separados (a mesma tarefa guarda as duas).
const samples = x => { const s = benchSamples(x.db); const cont = x.db.prepare("SELECT id FROM delegations WHERE continuation_of IS NOT NULL").all().length; return s.map((y, i) => (i >= s.length - cont ? { ...y, bench: '1-continuacao' } : y)) }
const table = compareTable(samples(A), samples(B))
fs.writeFileSync(path.join(outDir, 'resultado.json'), JSON.stringify({ modelo: model, esforco: effort, rodadas: rounds, alvo: target, execucoes: log }, null, 2))
fs.writeFileSync(path.join(outDir, 'tabela.md'), table + '\n')
console.log(`\n${table}\n\nArquivos em ${outDir} (resultado.json, tabela.md, benchA.db, benchB.db).`)
A.db.close(); B.db.close()
