// Benchmark "so o pai" (P) x "pai + filho" (D) numa conversa de 3 mensagens (pergunta + 2 continuacoes na MESMA sessao do pai), SEM o Electron:
// a CLI real do Claude como pai, o servidor MCP local com delegate_to_agent e a logica de delegacao do app (runDelegation) para o filho.
// P = delegacao desligada (como no app: pai sem MCP). D = delegacao ligada e a 1a mensagem pede para delegar a investigacao.
// Pai e filho SO LEEM (pai com Read/Grep/Glob: nada e alterado no alvo; no app o pai tem todas as ferramentas, entao o cabecalho real dele e maior).
// Rodadas alternadas P, D, P, D. USA QUOTA REAL. Bancos proprios (nunca o banco real). Ambiente sem o estado de uma sessao anfitria do Claude Code.
// Uso: node scripts/bench/pai-filho.mjs <pasta do projeto-alvo> [--rounds 2] [--model claude-sonnet-5-5] [--effort low] [--child-provider codex --child-model gpt-6-luna --child-effort max] [--out <pasta>] [--cli <executavel do claude>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt }
const target = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null
if (!target || !fs.existsSync(path.join(target, 'src/main/consent.ts'))) { console.error('Uso: node scripts/bench/pai-filho.mjs <pasta do projeto-alvo (este repositorio no commit 88c9eb5)> [--rounds 2]'); process.exit(2) }
const rounds = Math.min(Math.max(Number(opt('rounds', 2)) || 2, 1), 5)
const model = opt('model', 'claude-sonnet-5-5'), effort = opt('effort', 'low')
// Filho: por padrao o mesmo Claude do pai; --child-provider/--child-model/--child-effort trocam (ex.: um agente nomeado como codex/gpt-6-luna).
const childProvider = opt('child-provider', 'claude'), childModel = opt('child-model', model), childEffort = opt('child-effort', effort)
const outDir = path.resolve(opt('out', fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-bench-paifilho-'))))
fs.mkdirSync(outDir, { recursive: true })
const here = path.dirname(fileURLToPath(import.meta.url))
const src = p => pathToFileURL(path.join(here, '../../src/main', p)).href
const { AGENTS } = await import(src('adapters.ts'))
const { openDb } = await import(src('db.ts'))
const { createTask } = await import(src('tasks.ts'))
const { startRun, finishRun } = await import(src('runs.ts'))
const { ApprovalWaiters, bindGrantSession, openGrant } = await import(src('consent.ts'))
const { DEFAULT_SETTINGS, delegateTool, mcpWire, runDelegation, TOOL_NAME, WorkspaceGuard } = await import(src('delegation.ts'))
const { DEFAULT_LIMITS } = await import(src('limits.ts'))
const { newToken, startMcpServer } = await import(src('mcp.ts'))
const { callTaskTool, childToolset, toolsFor } = await import(src('taskContext.ts'))
const { runtimeBrief } = await import(src('prompt.ts'))
const { runChat } = await import(src('runner.ts'))
const { recordUsage } = await import(src('usage.ts'))
const { dropReceipts } = await import(src('workspaceTools.ts'))
const { hostlessEnv } = await import(src('providers.ts'))
const { pairTable } = await import(src('benchPair.ts'))
const { dropSkillSession, setSkillRoots } = await import(src('skills.ts'))
setSkillRoots([path.join(here, '../../resources/skills')])
const cli = opt('cli', AGENTS.claude.cmd)
const baseEnv = hostlessEnv(process.env).env

// Tarefa de "saida grande, resultado curto": exige ler varios arquivos; a resposta cabe em poucas linhas. As continuacoes dependem do que foi achado.
const Q = 'PAIFILHO: Em src/main, encontre onde um pacote de contexto e conferido (ID + hash) antes de ser entregue a um agente e diga se algum caminho entrega contexto existente sem essa conferencia. Responda em ate 8 linhas, citando arquivo:linha.'
const DELEGATE = `\n\nFaca a investigacao com delegate_to_agent (provider ${childProvider}, model ${childModel}, effort ${childEffort}, mode read) e responda com base no retorno.`
const FOLLOW = [
  'Das conferencias que voce citou, qual delas vale quando uma delegacao e continuada (continuationOf)? Responda em 2 linhas, citando arquivo:linha.',
  'Qual teste cobre essa conferencia? Cite o arquivo de teste e o nome do teste, em 2 linhas.'
]
const LABELS = ['pergunta', '1a continuacao', '2a continuacao']

const tokens = new Map()
const mcp = await startMcpServer({
  tools: c => c.tools, authorize: t => tokens.get(t) ?? null,
  call: async (c, name, args, signal) => {
    if (!c.tools.some(t => t.name === name)) return { text: 'Ferramenta nao anunciada.', isError: true }
    if (c.kind === 'parent' && name === TOOL_NAME) return runDelegation(c.deps, c.p, args, signal)
    return callTaskTool(c.db, DEFAULT_LIMITS, c.t, name, args)
  }
})

// Filho: exatamente como o app (taskContext.childToolset; recibos mantidos quando a sessao e a mesma).
const depsFor = db => ({
  db, guard: new WorkspaceGuard(), settings: () => DEFAULT_SETTINGS, limits: () => DEFAULT_LIMITS, waiters: new ApprovalWaiters(),
  catalogCheck: async () => null, envFor: () => baseEnv, otherTasksActiveIn: () => false, note: () => {}, onContextRequest: () => {},
  runChild: ({ provider, opts, cwd, env, input, session }) => runChat({ cmd: provider === 'claude' ? cli : AGENTS[provider].cmd, args: AGENTS[provider].chatArgs(session, opts), cwd, env, parse: AGENTS[provider].parse, input }),
  childTools: async p => {
    const token = newToken(), set = childToolset(p.provider, p.mode, p.scope)
    const w = mcpWire(p.provider, { url: mcp.url, token, timeoutSec: 600, dir: path.join(outDir, 'mcp'), tools: set.mcp.map(x => x.name), permission: false })
    if (!w) return null
    tokens.set(token, { kind: 'child', db, tools: set.mcp, t: { taskId: p.taskId, lineage: p.lineage, auth: p.auth, role: 'child', cwd: p.cwd, scope: p.scope, delegationId: p.delegationId, provider: p.provider } })
    return { extra: w.extra, env: w.env, tools: set.mcp.map(x => x.name), ...(set.native ? { native: set.native } : {}), cleanup: keep => { tokens.delete(token); if (!keep) { dropReceipts(p.auth.authId); dropSkillSession(p.auth.authId) } w.cleanup() } }
  }
})

const dbs = { P: openDb(path.join(outDir, 'benchP.db')), D: openDb(path.join(outDir, 'benchD.db')) }
const rows = [], log = []
async function conversation(v, round) {
  const db = dbs[v], deps = depsFor(db)
  const taskId = createTask(db, target, `PAIFILHO ${v} rodada ${round}`)
  const lineage = `chat:${taskId}:claude:`
  let sid
  for (const [step, text] of [Q + (v === 'D' ? DELEGATE : ''), ...FOLLOW].entries()) {
    const runId = startRun(db, { taskId, provider: 'claude', model, effort }, text)
    const grant = openGrant(db, { taskId, recipient: { logicalId: lineage, provider: 'claude', profile: '', model, effort, workspace: target, scope: [] }, sessionId: sid ?? null })
    let wire = null, token = ''
    if (v === 'D') { // como o app com a delegacao ligada: MCP com as ferramentas do pai e o resumo de regras so na sessao nova
      token = newToken()
      const tools = toolsFor('parent', delegateTool())
      wire = mcpWire('claude', { url: mcp.url, token, timeoutSec: DEFAULT_SETTINGS.timeoutMin * 60 + 120, dir: path.join(outDir, 'mcp'), tools: tools.map(x => x.name), permission: false })
      tokens.set(token, { kind: 'parent', db, deps, tools, p: { taskId, runId, provider: 'claude', cwd: target, lineage, auth: grant, depth: 0, fails: new Map(), children: new Set() }, t: { taskId, lineage, auth: grant, role: 'parent', cwd: target, scope: [], runId } })
    }
    const input = (wire && !sid ? `${runtimeBrief({ memoryTools: true, workspaceTools: false, skills: 'parent' })}\n\n` : '') + text
    const args = AGENTS.claude.chatArgs(sid, { model, effort, mode: 'read', ...(wire ? { extra: wire.extra } : {}) })
    const r = await runChat({ cmd: cli, args, cwd: target, env: { ...baseEnv, ...wire?.env }, parse: AGENTS.claude.parse, input, onSession: id => bindGrantSession(db, grant, id) }).result
    tokens.delete(token); wire?.cleanup()
    finishRun(db, runId, r)
    recordUsage(db, { taskId, runId, provider: 'claude', profile: '', model, effort, session: r.session ?? sid, sessionWasNew: !sid, metric: r.metric, promptChars: input.length, contextChars: 0, resultChars: r.text.length, toolCalls: r.tools?.length, retries: r.retries, durationMs: r.durationMs })
    if (sid && r.session && r.session !== sid) console.log(`  AVISO: o pai abriu outra sessao (${r.session}) em vez de continuar ${sid}; a continuacao nao vale.`)
    sid = r.session ?? sid
    const parent = db.prepare('SELECT provider, input, cache_read, cache_write, cache_read_included FROM usage_records WHERE run_id=?').get(runId) ?? null
    const children = db.prepare('SELECT u.provider, u.input, u.cache_read, u.cache_write, u.cache_read_included FROM usage_records u JOIN delegations d ON d.id = u.delegation_id WHERE d.parent_run_id=? ORDER BY u.id').all(runId)
    rows.push({ variant: v, round, step, parent, children })
    const dels = db.prepare('SELECT id, status, error FROM delegations WHERE parent_run_id=?').all(runId)
    log.push({ versao: v, rodada: round, mensagem: LABELS[step], status: r.status, erro: r.error, pai: parent, filhos: children, delegacoes: dels, ferramentasDoPai: r.tools ?? [], resposta: r.text.slice(0, 2000) })
    const n = x => x == null ? '—' : x
    console.log(`[${v}] rodada ${round} · ${LABELS[step]}: ${r.status} · pai: entrada ${n(parent?.input)} + cache lido ${n(parent?.cache_read)} + gravado ${n(parent?.cache_write)} · delegacoes: ${dels.map(d => `#${d.id} ${d.status}`).join(', ') || 'nenhuma'} · ferramentas do pai: ${(r.tools ?? []).join(', ') || 'nenhuma'}`)
    console.log(`  resposta: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    if (r.status !== 'completed') { console.log('  Execucao nao concluida: a conversa desta rodada para aqui.'); break }
  }
}

for (let i = 1; i <= rounds; i++) { await conversation('P', i); await conversation('D', i) }
mcp.close()
const table = pairTable(rows, LABELS)
fs.writeFileSync(path.join(outDir, 'resultado.json'), JSON.stringify({ modelo: model, esforco: effort, filho: { provedor: childProvider, modelo: childModel, esforco: childEffort }, rodadas: rounds, alvo: target, execucoes: log }, null, 2))
fs.writeFileSync(path.join(outDir, 'tabela.md'), table + '\n')
console.log(`\n${table}\n\nArquivos em ${outDir} (resultado.json com as respostas para a ficha de qualidade, tabela.md, benchP.db, benchD.db).`)
dbs.P.close(); dbs.D.close()
