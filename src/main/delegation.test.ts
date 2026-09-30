// Logica da delegacao com executores SIMULADOS (nenhuma CLI real, nenhuma chamada paga).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS } from './adapters.ts'
import { openDb } from './db.ts'
import {
  DEFAULT_SETTINGS, diffSnap, FILES_CHARS, fileExcerpts, findingContent, inScope, mcpWire, normalizeSettings, parseArgs, readOnlyEnv, reconcileDelegations, runDelegation, scopePaths, snapshot,
  WorkspaceGuard, type Child, type Deps, type ParentCtx
} from './delegation.ts'
import { ApprovalWaiters, approveSubset, getPackage, openGrant, resolvePackage, type PackageRow } from './consent.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { extractConclusion } from './envelope.ts'
import { addMemory } from './memory.ts'
import { readArtifact } from './artifacts.ts'
import type { ChatResult } from './runner.ts'
import { createTask } from './tasks.ts'
import { readFileRange } from './workspaceTools.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-deleg-'))
const ws = path.join(tmp, 'projeto')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'a.gd'), 'a')
fs.writeFileSync(path.join(ws, 'README.md'), 'x')
const db = openDb(path.join(tmp, 't.db'))
const taskId = createTask(db, ws, 'pai')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const S = DEFAULT_SETTINGS

const ok = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({ status: 'completed', text, notes: [], code: 0, ...extra })
type Fake = {
  runs: any[]; notes: string[]; deps: Deps; guard: WorkspaceGuard; settings: typeof S; otherActive: boolean; catalogErr: string | null; behavior: (p: any) => Promise<ChatResult> | ChatResult; cancelled: number
  requests: PackageRow[]; onRequest: (pkg: PackageRow) => void; limits: typeof DEFAULT_LIMITS; wire: boolean; wired: any[]; wireEnv?: Record<string, string>
}
function fake(): Fake {
  const f: Fake = {
    runs: [], notes: [], settings: { ...S }, otherActive: false, catalogErr: null, cancelled: 0, guard: new WorkspaceGuard(), requests: [], onRequest: () => {}, limits: { ...DEFAULT_LIMITS }, wire: false, wired: [],
    behavior: () => ok('resultado do filho'), deps: null as any
  }
  f.deps = {
    db, guard: f.guard, settings: () => f.settings, note: (_t, text) => f.notes.push(text), limits: () => f.limits, waiters: new ApprovalWaiters(),
    onContextRequest: pkg => { f.requests.push(pkg); f.onRequest(pkg) },
    childTools: async p => { if (!f.wire) return null; f.wired.push(p); return { extra: ['-c', 'mcp_servers.dashboard.url=x'], env: f.wireEnv ?? { DASHBOARD_MCP_TOKEN: 't' }, cleanup: () => { f.wired.push('cleanup') } } },
    catalogCheck: async () => f.catalogErr, envFor: p => ({ PROVIDER: p }), otherTasksActiveIn: () => f.otherActive,
    runChild: p => {
      f.runs.push(p)
      let cancel!: () => void
      const cancelled = new Promise<ChatResult>(r => { cancel = () => { f.cancelled++; r({ status: 'cancelled', text: 'parcial', notes: [], code: null }) } })
      const child: Child = { cancel, result: Promise.race([Promise.resolve(f.behavior(p)), cancelled]) }
      return child
    }
  }
  return f
}
const PARENT = 'chat:1:claude:1'
// Identidade efetiva do pai (criada pelo backend): mesma sessao + mesmo destinatario = mesmo grant entre chamadas.
const parentGrant = () => openGrant(db, { taskId, recipient: { logicalId: PARENT, provider: 'claude', profile: '1', model: null, effort: null, workspace: ws, scope: [] }, sessionId: 'sess-parent' })
const ctx = (over: Partial<ParentCtx> = {}): ParentCtx => ({ taskId, runId: 1, provider: 'claude', accountId: 1, cwd: ws, lineage: PARENT, auth: parentGrant(), depth: 0, fails: new Map(), children: new Set(), ...over })
// O usuario decide (pela interface, com o hash que ela exibiu) depois de um instante.
const decide = (f: Fake, decision: 'approve' | 'reject' | 'cancel', delay = 20) => {
  f.onRequest = pkg => setTimeout(() => { const r = resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision }); f.deps.waiters.resolved(pkg.id, r.pkg.state) }, delay)
}
const call = (f: Fake, c: ParentCtx, args: unknown, signal = new AbortController().signal) => runDelegation(f.deps, c, args, signal)
// Ids de delegacao recomecam do 1 apos apagar; limpa tambem o que aponta para eles (uso, pacotes, entregas, artefatos, memoria).
const reset = () => { for (const t of ['delegations', 'usage_records', 'context_packages', 'context_deliveries', 'artifacts', 'memory_items', 'exec_grants']) db.prepare(`DELETE FROM ${t}`).run() }

test('argumentos: so o que a ferramenta define; provedor precisa estar permitido', () => {
  const a = parseArgs({ objective: '  analise src/a.gd ', provider: 'codex', model: 'gpt-6-luna', effort: 'high', mode: 'edit', paths: ['src'], context: 'ctx' }, S)
  assert.deepEqual(a, { objective: 'analise src/a.gd', provider: 'codex', model: 'gpt-6-luna', effort: 'high', mode: 'edit', paths: ['src'], files: [], context: 'ctx', memoryIds: [], approvedPackageId: undefined, continuationOf: undefined })
  assert.deepEqual(parseArgs({ objective: 'x', provider: 'codex', memoryIds: [3, 4], approvedPackageId: 9, continuationOf: 2 }, S).memoryIds, [3, 4])
  for (const badRef of [{ memoryIds: 'a' }, { memoryIds: [0] }, { memoryIds: [1.5] }, { memoryIds: Array(21).fill(1) }, { approvedPackageId: -1 }, { continuationOf: 'x' }])
    assert.throws(() => parseArgs({ objective: 'x', provider: 'codex', ...badRef }, S), Error)
  assert.equal(parseArgs({ objective: 'x', provider: 'gemini' }, S).mode, 'read') // padrao: leitura
  for (const bad of [null, [], 'texto', {}, { objective: '', provider: 'codex' }, { objective: 'x' }, { objective: 'x', provider: 'rm -rf' },
    { objective: 'x'.repeat(4001), provider: 'codex' }, { objective: 'x', provider: 'codex', mode: 'root' }, { objective: 'x', provider: 'codex', model: 'a & calc' },
    { objective: 'x', provider: 'codex', paths: 'src' }, { objective: 'x', provider: 'codex', paths: Array(21).fill('a') }, { objective: 'x', provider: 'codex', context: 'c'.repeat(8001) },
    { objective: 'x', provider: 'codex', cwd: 'C:/' }].slice(0, 13)) assert.throws(() => parseArgs(bad, S), Error)
  assert.throws(() => parseArgs({ objective: 'x', provider: 'codex' }, { ...S, allowedProviders: ['claude'] }), /nao esta permitido/)
  // campos extras (cwd, comando, env...) sao ignorados: nao ha como o agente escolher pasta ou comando
  assert.ok(!('cwd' in parseArgs({ objective: 'x', provider: 'codex', cwd: 'C:/', command: 'calc' }, S)))
})

test('escopo: caminhos relativos dentro da area; .., absolutos, unidade e junction para fora sao recusados', () => {
  assert.deepEqual(scopePaths(ws, ['src', 'src/a.gd', 'novo/arquivo.gd', '.']), ['src', 'src/a.gd', 'novo/arquivo.gd', '.'])
  for (const p of ['../fora', 'src/../../fora', path.join(tmp, 'segredo'), 'C:/Windows', '/etc/passwd']) assert.throws(() => scopePaths(ws, [p]), /fora da area/)
  const outside = path.join(tmp, 'fora'); fs.mkdirSync(outside)
  try { fs.symlinkSync(outside, path.join(ws, 'atalho'), 'junction') } catch { return }
  assert.throws(() => scopePaths(ws, ['atalho/x']), /fora do jogo|fora da area/)
})

test('instantaneos apontam arquivos alterados, criados e removidos e o escopo', () => {
  const a = snapshot(ws)!
  fs.writeFileSync(path.join(ws, 'src', 'novo.gd'), 'n')
  fs.writeFileSync(path.join(ws, 'README.md'), 'mudou de tamanho')
  const b = snapshot(ws)!
  assert.deepEqual(diffSnap(a, b), ['README.md', 'src/novo.gd'])
  fs.rmSync(path.join(ws, 'src', 'novo.gd'))
  assert.deepEqual(diffSnap(b, snapshot(ws)!), ['src/novo.gd'])
  assert.equal(snapshot(ws, 1), null) // pasta grande demais: nao finge acompanhar
  assert.ok(inScope('src/a.gd', ['src']) && !inScope('README.md', ['src']) && inScope('README.md', []) && !inScope('srcx/a', ['src']))
  fs.writeFileSync(path.join(ws, 'README.md'), 'x')
})

test('leitura: executa o filho com modo read (limitado pelo executor), sem recursao e devolve o resultado', async () => {
  reset()
  const f = fake()
  const r = await call(f, ctx(), { objective: 'leia src/a.gd e resuma', provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
  assert.equal(r.isError, false)
  assert.match(r.text, /^\[Delegacao #\d+ concluida\]\nArquivos alterados: nenhum\nConclusao \(completa\):\nresultado do filho/) // envelope curto: estado, arquivos, conclusao
  assert.match(r.text, /Detalhes completos: artefato #\d+/)
  const p = f.runs[0]
  assert.deepEqual(p.opts, { model: 'gpt-6-luna', effort: 'low', mode: 'read' })
  assert.equal(p.cwd, ws) // area derivada da tarefa do pai, nunca do agente
  assert.ok(!('extra' in p.opts)) // o filho NAO recebe a ferramenta de delegacao (sem recursao)
  assert.match(p.input, /nao pode delegar[\s\S]*SOMENTE LEITURA[\s\S]*Ordem direta:\nleia src\/a\.gd e resuma/) // ordem estavel: instrucoes estaticas, modo, ordem direta
  assert.ok(!/Contexto aprovado|Contexto informado/.test(p.input)) // sem contexto candidato, nada alem da ordem direta
  assert.deepEqual(AGENTS.codex.chatArgs(undefined, p.opts).slice(0, 6), ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m']) // leitura efetiva na sandbox
  const row = db.prepare('SELECT * FROM delegations').get() as any
  assert.deepEqual([row.status, row.mode, row.provider, row.task_id], ['completed', 'read', 'codex', taskId])
  assert.equal(f.notes.length, 2) // inicio e fim visiveis no chat do pai
  assert.match(f.notes[0], /↳ Delegacao #\d+ para codex\/gpt-6-luna \(low\) em modo somente leitura/)
  assert.match(f.notes[1], /concluida[\s\S]*resultado do filho/)
})

test('delegação herda somente a capacidade Godot capturada na invocação do pai', async () => {
  reset()
  const f = fake(); f.wire = true
  const parent = ctx(); parent.engines = { godot: 'jogos' }
  assert.equal((await call(f, parent, { objective: 'leia a cena', provider: 'codex', mode: 'read' })).isError, false)
  assert.deepEqual(f.wired[0].engines, { godot: 'jogos' })
  reset()
  const plain = fake(); plain.wire = true
  assert.equal((await call(plain, ctx(), { objective: 'leia a cena', provider: 'codex', mode: 'read' })).isError, false)
  assert.equal(plain.wired[0].engines, undefined)
})

test('leitura efetiva por provedor: nao depende so do prompt', () => {
  assert.ok(AGENTS.claude.chatArgs(undefined, { mode: 'read' }).join(' ').includes('--tools Read,Grep,Glob'))
  assert.ok(!AGENTS.claude.chatArgs(undefined, { mode: 'edit' }).includes('--tools'))
  assert.ok(AGENTS.gemini.chatArgs(undefined, { mode: 'read' }).join(' ').includes('--approval-mode plan'))
  assert.ok(AGENTS.codex.chatArgs(undefined, { mode: 'edit' }).join(' ').includes('-s workspace-write'))
  assert.deepEqual(Object.keys(JSON.parse(readOnlyEnv('opencode').OPENCODE_CONFIG_CONTENT).permission).sort(), ['bash', 'edit', 'write']) // opencode: permissoes negadas por configuracao
  assert.deepEqual(readOnlyEnv('claude'), { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' }) // sem Bash: instrucoes de git e git status so custariam tokens
  assert.deepEqual(readOnlyEnv('codex'), {})
})

test('leitura que alterou arquivos e sinalizada (a protecao do executor falhou)', async () => {
  reset()
  const f = fake()
  f.behavior = () => { fs.writeFileSync(path.join(ws, 'intruso.txt'), 'x'); return ok('li e escrevi') }
  const r = await call(f, ctx(), { objective: 'so leia', provider: 'opencode' })
  assert.match(r.text, /ATENCAO: o modo leitura alterou arquivos/)
  assert.match(f.notes[1], /intruso\.txt/)
  fs.rmSync(path.join(ws, 'intruso.txt'))
})

test('edicao: arquivos alterados listados, fora do escopo sinalizado, um escritor por area', async () => {
  reset()
  const f = fake()
  let during: any
  f.behavior = async () => {
    fs.writeFileSync(path.join(ws, 'src', 'b.gd'), 'dentro')
    fs.writeFileSync(path.join(ws, 'fora.txt'), 'fora')
    during = { otherTask: f.guard.blockedFor(ws, taskId + 1), ownTask: f.guard.blockedFor(ws, taskId), second: f.guard.acquireEdit(ws, taskId + 2, 99, false) }
    return ok('editei')
  }
  const r = await call(f, ctx(), { objective: 'implemente', provider: 'codex', mode: 'edit', paths: ['src'] })
  assert.equal(r.isError, false)
  assert.match(r.text, /Arquivos alterados: 2: fora\.txt, src\/b\.gd/)
  assert.match(r.text, /FORA DO ESCOPO: fora\.txt/)
  assert.match(during.otherTask, /reservada por uma delegacao de edicao/) // outras tarefas ficam bloqueadas enquanto o filho edita
  assert.equal(during.ownTask, null)
  assert.match(during.second, /Um escritor por area/) // segundo escritor recusado
  assert.equal(f.guard.blockedFor(ws, taskId + 1), null) // liberado no fim
  assert.equal(JSON.parse((db.prepare('SELECT out_of_scope FROM delegations').get() as any).out_of_scope)[0], 'fora.txt')
  assert.equal(f.runs[0].opts.mode, 'edit')
  for (const x of ['src/b.gd', 'fora.txt']) fs.rmSync(path.join(ws, x))
})

test('edicao recusada se outra tarefa esta executando na mesma pasta ou se as edicoes estao desativadas', async () => {
  reset()
  const f = fake()
  f.otherActive = true
  const r = await call(f, ctx(), { objective: 'x', provider: 'codex', mode: 'edit' })
  assert.equal(r.isError, true)
  assert.match(r.text, /Outra tarefa esta executando nesta mesma pasta/)
  assert.equal(f.runs.length, 0)
  assert.equal(f.guard.blockedFor(ws, taskId + 1), null) // nao ficou reservada
  f.otherActive = false
  f.settings.allowEdit = false
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', mode: 'edit' })).text, /edicao estao desativadas/)
})

test('recusas: desativada, recursao, provedor nao permitido, escopo fora da area, modelo indisponivel (sem substituir)', async () => {
  reset()
  const f = fake()
  f.settings.enabled = false
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex' })).text, /desativada/)
  f.settings.enabled = true
  assert.match((await call(f, ctx({ depth: 1 }), { objective: 'x', provider: 'codex' })).text, /recursao nao e permitida/)
  f.settings.allowedProviders = ['claude']
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex' })).text, /nao esta permitido/)
  f.settings.allowedProviders = ['claude', 'codex']
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', paths: ['../segredo'] })).text, /fora da area/)
  f.catalogErr = 'O modelo "gpt-6-luna" nao consta no catalogo de codex.'
  const r = await call(f, ctx(), { objective: 'x', provider: 'codex', model: 'gpt-6-luna' })
  assert.equal(r.isError, true)
  assert.match(r.text, /nao consta no catalogo[\s\S]*Nenhuma substituicao de modelo foi feita/)
  assert.equal(f.runs.length, 0) // nada foi executado com outro modelo
  assert.equal((db.prepare('SELECT COUNT(*) n FROM delegations').get() as any).n, 0) // recusas antes de executar nao consomem a cota
})

test('falha de autenticacao do filho e devolvida; duas falhas seguidas bloqueiam novas tentativas; limite por tarefa', async () => {
  reset()
  const f = fake()
  f.behavior = () => ({ status: 'failed', text: '', notes: [], code: 1, category: 'auth', error: 'IneligibleTierError: cliente nao suportado' })
  const c = ctx()
  const r1 = await call(f, c, { objective: 'a', provider: 'gemini' })
  assert.equal(r1.isError, true)
  assert.match(r1.text, /falhou\][\s\S]*Erro \(auth\): IneligibleTierError/)
  await call(f, c, { objective: 'b', provider: 'gemini' })
  const r3 = await call(f, c, { objective: 'c', provider: 'gemini' })
  assert.match(r3.text, /duas delegacoes seguidas para gemini falharam/)
  assert.equal(f.runs.length, 2) // nao repete a falha indefinidamente
  assert.equal((db.prepare("SELECT COUNT(*) n FROM delegations WHERE category='auth'").get() as any).n, 2)
  f.behavior = () => ok('ok')
  assert.equal((await call(f, c, { objective: 'd', provider: 'codex' })).isError, false) // outro provedor segue livre
  f.settings.maxPerTask = 3
  assert.match((await call(f, ctx(), { objective: 'e', provider: 'codex' })).text, /limite de 3 delegacoes por tarefa/)
})

test('cancelar o pai (ou o cliente MCP desistir) cancela o filho ativo; timeout tambem', async () => {
  reset()
  const f = fake()
  f.behavior = () => new Promise<ChatResult>(() => {}) // nunca termina sozinho
  const c = ctx()
  const ac = new AbortController()
  const p = call(f, c, { objective: 'longo', provider: 'codex' }, ac.signal)
  await sleep(50)
  assert.equal(c.children.size, 1) // registrado no pai para ser cancelado junto
  ;[...c.children][0].cancel() // cancelar o pai
  const r = await p
  assert.equal(r.isError, true)
  assert.match(r.text, /cancelada/)
  assert.equal(c.children.size, 0)
  assert.equal((db.prepare('SELECT status FROM delegations ORDER BY id DESC').get() as any).status, 'cancelled')

  const ac2 = new AbortController()
  const p2 = call(f, ctx(), { objective: 'longo 2', provider: 'codex' }, ac2.signal)
  await sleep(50)
  ac2.abort() // cliente MCP cancelou a chamada
  assert.match((await p2).text, /cancelada/)
  assert.equal(f.cancelled, 2)

  f.settings.timeoutMin = 0.0005 // ~30ms
  f.settings = { ...f.settings, timeoutMin: 0.0005 }
  const r3 = await call(f, ctx(), { objective: 'demora', provider: 'codex' })
  assert.match(r3.text, /Tempo limite/)
  assert.equal((db.prepare('SELECT status FROM delegations ORDER BY id DESC').get() as any).status, 'failed')
})

test('consumo do filho e registrado quando disponivel; reinicio reconcilia delegacoes interrompidas', async () => {
  reset()
  const f = fake()
  f.behavior = () => ok('ok', { metric: { consumedIn: 111, consumedOut: 22, scope: 'run', source: 'x' } })
  await call(f, ctx(), { objective: 'x', provider: 'codex' })
  assert.deepEqual(JSON.parse((db.prepare('SELECT consumed FROM delegations').get() as any).consumed), { in: 111, out: 22, scope: 'run' })
  db.prepare("INSERT INTO delegations (task_id, provider, mode, objective) VALUES (?, 'codex', 'read', 'travada')").run(taskId)
  assert.equal(reconcileDelegations(db), 1)
  assert.equal(reconcileDelegations(db), 0)
  assert.equal((db.prepare("SELECT status FROM delegations WHERE objective='travada'").get() as any).status, 'failed')
})

test('configuracoes: valores limitados a faixas seguras', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  const n = normalizeSettings({ enabled: 'sim', maxPerTask: 9999, timeoutMin: -5, allowEdit: false, allowedProviders: ['claude', 'inexistente', 7] })
  assert.deepEqual(n, { enabled: false, maxPerTask: 50, timeoutMin: 1, allowEdit: false, allowedProviders: ['claude'], requireParentSuspension: false, readAgent: '' })
  assert.equal(normalizeSettings({ requireParentSuspension: true }).requireParentSuspension, true)
  assert.equal(normalizeSettings({ readAgent: '  Leitor  ' }).readAgent, 'Leitor'); assert.equal(normalizeSettings({ readAgent: 7 }).readAgent, '')
})

test('como cada provedor enxerga a ferramenta: sem tocar configuracao global; gemini nao suportado', () => {
  const o = { url: 'http://127.0.0.1:5555/mcp', token: 'abcdef0123456789abcdef', timeoutSec: 900, dir: path.join(tmp, 'mcp') }
  const cx = mcpWire('codex', o)!
  assert.deepEqual(cx.extra, ['-c', 'mcp_servers.dashboard.url=http://127.0.0.1:5555/mcp', '-c', 'mcp_servers.dashboard.bearer_token_env_var=DASHBOARD_MCP_TOKEN', '-c', 'mcp_servers.dashboard.tool_timeout_sec=900'])
  assert.deepEqual(cx.env, { DASHBOARD_MCP_TOKEN: o.token }) // o token vai por variavel de ambiente, nao pela linha de comando
  assert.ok(!cx.extra.join(' ').includes(o.token))
  const cl = mcpWire('claude', o)!
  const file = cl.extra[1]
  assert.ok(path.isAbsolute(file) && !file.includes('"')) // sem aspas no argumento: claude.exe (sem cmd.exe) as receberia literais e recusaria a configuracao
  assert.equal(cl.extra[0], '--mcp-config')
  assert.deepEqual(cl.extra.slice(2), ['--allowedTools', 'mcp__dashboard__delegate_to_agent']) // so a ferramenta de delegacao e liberada no headless
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.dashboard.headers.Authorization, `Bearer ${o.token}`)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.dashboard.timeout, o.timeoutSec * 1000) // sem isto o Claude aborta a delegacao apos 300 s sem resposta
  cl.cleanup()
  assert.equal(fs.existsSync(file), false) // arquivo com o token removido ao fim da execucao
  // strict (filho Claude de leitura): so o servidor do dashboard, sem os MCP globais/do projeto; edicao e pai (sem strict) nao recebem o flag
  const ro = mcpWire('claude', { ...o, strict: true })!; assert.ok(ro.extra.includes('--strict-mcp-config')); assert.equal(ro.extra[1], file); ro.cleanup()
  const ed = mcpWire('claude', { ...o, strict: false })!; assert.ok(!ed.extra.includes('--strict-mcp-config')); ed.cleanup()
  assert.ok(!cl.extra.includes('--strict-mcp-config'))
  assert.ok(!mcpWire('codex', { ...o, strict: true })!.extra.join(' ').includes('strict')) // so o Claude tem essa via
  // Pai com ask_user: o AskUserQuestion nativo (sem resposta no headless) sai; quem nao recebe ask_user (filho) fica como estava
  const pa = mcpWire('claude', { ...o, tools: ['read_task_context', 'ask_user'] })!
  assert.deepEqual(pa.extra.slice(2), ['--disallowedTools', 'AskUserQuestion', '--allowedTools', 'mcp__dashboard__read_task_context', 'mcp__dashboard__ask_user']); pa.cleanup()
  const oc = mcpWire('opencode', o)!
  assert.equal(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT).mcp.dashboard.url, o.url)
  assert.equal(mcpWire('gemini', o), null)
  // extra entra ANTES de `resume` e do `-` final no codex
  const args = AGENTS.codex.chatArgs('sid-1', { extra: cx.extra })
  assert.ok(args.indexOf('mcp_servers.dashboard.tool_timeout_sec=900') < args.indexOf('resume') && args.at(-1) === '-')
})

const lastDeleg = () => db.prepare('SELECT * FROM delegations ORDER BY id DESC').get() as any

test('contexto candidato exige aprovacao: o filho nao inicia antes e recebe exatamente o pacote aprovado', async () => {
  reset()
  const f = fake()
  let atRequest: any
  f.onRequest = pkg => {
    atRequest = { runs: f.runs.length, status: lastDeleg().status, state: pkg.state }
    setTimeout(() => { const r = resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision: 'approve' }); f.deps.waiters.resolved(pkg.id, r.pkg.state) }, 30)
  }
  const r = await call(f, ctx(), { objective: 'faca X', provider: 'codex', model: 'gpt-6-luna', context: 'a decisao anterior foi usar JSON' })
  assert.equal(r.isError, false)
  assert.deepEqual(atRequest, { runs: 0, status: 'awaiting_context_approval', state: 'pending' }) // nenhum processo antes da decisao
  const p = f.runs[0]
  assert.match(p.input, /Ordem direta:\nfaca X[\s\S]*Contexto aprovado pelo usuario[\s\S]*a decisao anterior foi usar JSON/)
  assert.ok(p.input.indexOf('Ordem direta') < p.input.indexOf('Contexto aprovado')) // ordem estavel: ordem direta antes do pacote
  const pkg = getPackage(db, f.requests[0].id)!
  assert.deepEqual([pkg.state, pkg.recipient.provider, pkg.recipient.model, pkg.recipient.logicalId, pkg.issuer], ['approved', 'codex', 'gpt-6-luna', `del:${lastDeleg().id}`, PARENT])
  assert.equal(lastDeleg().package_id, pkg.id)
  assert.deepEqual(db.prepare('SELECT result FROM context_deliveries WHERE package_id=?').all(pkg.id).map((x: any) => x.result), ['confirmed'])
})

test('recusa: o filho recebe so a ordem direta e nada do pacote recusado (nem resumo nem titulo)', async () => {
  reset()
  const f = fake()
  decide(f, 'reject')
  const r = await call(f, ctx(), { objective: 'investigue por conta propria', provider: 'codex', context: 'SEGREDINHO da conversa anterior' })
  assert.equal(r.isError, false)
  assert.equal(f.runs.length, 1) // recusa nao cancela a delegacao
  assert.ok(!/SEGREDINHO|Contexto informado|Contexto aprovado/.test(f.runs[0].input))
  assert.match(f.runs[0].input, /Ordem direta:\ninvestigue por conta propria/)
  assert.equal(getPackage(db, f.requests[0].id)!.state, 'rejected')
  assert.ok(f.notes.some(n => /contexto recusado/.test(n)))
  assert.equal((db.prepare('SELECT COUNT(*) n FROM context_deliveries WHERE package_id=?').get(f.requests[0].id) as any).n, 0)
})

test('cancelar, expirar ou o pai desistir durante a espera: o filho nunca inicia e o pedido fica invalido', async () => {
  reset()
  let f = fake()
  decide(f, 'cancel')
  let r = await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' })
  assert.match(r.text, /nao iniciada/); assert.equal(f.runs.length, 0)
  assert.equal(lastDeleg().status, 'cancelled')
  assert.equal(getPackage(db, f.requests[0].id)!.state, 'cancelled')

  f = fake(); f.limits.approvalTimeoutMin = 0.0003 // ~18ms sem resposta
  r = await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' })
  assert.match(r.text, /sem resposta do usuario/); assert.equal(f.runs.length, 0)
  const pkg = getPackage(db, f.requests[0].id)!
  assert.equal(pkg.state, 'expired')
  assert.throws(() => resolvePackage(db, { id: pkg.id, hash: pkg.hash, decision: 'approve' }), /ja foi resolvido \(expired\)/) // aprovar tarde nao inicia processo orfao

  f = fake()
  const ac = new AbortController()
  f.onRequest = () => setTimeout(() => ac.abort(), 30) // transporte MCP expirou / pai cancelado
  r = await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' }, ac.signal)
  assert.equal(r.isError, true); assert.equal(f.runs.length, 0)
  assert.equal(getPackage(db, f.requests[0].id)!.state, 'cancelled')
  assert.equal(lastDeleg().status, 'cancelled')
})

test('o tempo de espera humana nao conta no timeout de execucao do filho', async () => {
  reset()
  const f = fake()
  f.settings = { ...f.settings, timeoutMin: 0.0008 } // ~48ms de execucao
  decide(f, 'approve', 120) // o humano demora mais que o timeout do filho
  f.behavior = async () => { await sleep(5); return ok('terminou a tempo') }
  const r = await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' })
  assert.equal(r.isError, false)
  assert.match(r.text, /terminou a tempo/)
})

test('pacote acima dos limites e recusado com orientacao (sem cortar em silencio)', async () => {
  reset()
  const f = fake()
  const r = await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'c'.repeat(2500) })
  assert.equal(r.isError, true)
  assert.match(r.text, /excede os limites[\s\S]*ampliar o limite em Configuracoes/)
  assert.equal(f.runs.length, 0); assert.equal(f.requests.length, 0) // nada foi pedido nem enviado
  assert.equal(lastDeleg().status, 'failed')
})

test('memoryIds: so itens disponiveis e validos da linhagem do pai; item aprovado chega com revisao', async () => {
  reset()
  const f = fake()
  const mem = (lineage: string, title: string, content: string, grantId: string | null = null) => addMemory(db, { taskId, owner: 'run', lineage, grantId, kind: 'decision', title, content }).id
  const own = mem(PARENT, 'Formato de save', 'Usar JSON versionado.', parentGrant().authId)
  const foreign = mem('del:999', 'Privado de outro filho', 'nao deve vazar')
  const sameLineageOtherSession = mem(PARENT, 'Da sessao anterior', 'mesma linhagem, outra sessao', openGrant(db, { taskId, recipient: { logicalId: PARENT, provider: 'claude', profile: '1', model: null, effort: null, workspace: ws, scope: [] }, sessionId: 'sess-antiga' }).authId)
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', memoryIds: [sameLineageOtherSession] })).text, /nao esta disponivel para voce/) // mesma chave de conversa nao e contorno
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', memoryIds: [foreign] })).text, /nao esta disponivel para voce/)
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', memoryIds: [123456] })).text, /nao esta disponivel/)
  db.prepare("UPDATE memory_items SET state='stale' WHERE id=?").run(own)
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', memoryIds: [own] })).text, /desatualizado/)
  db.prepare("UPDATE memory_items SET state='active' WHERE id=?").run(own)
  decide(f, 'approve')
  const r = await call(f, ctx(), { objective: 'aplique a decisao', provider: 'codex', memoryIds: [own] })
  assert.equal(r.isError, false)
  const pkg = getPackage(db, f.requests[0].id)!
  assert.deepEqual(pkg.items.map(i => [i.ref, i.itemId, i.revision, i.title]), [[`m:${own}`, own, 1, 'Formato de save']])
  assert.match(f.runs[0].input, /Usar JSON versionado/)
  assert.ok(!/nao deve vazar|Privado de outro filho/.test(f.runs[0].input))
})

test('pacote aprovado so vale para o destinatario aprovado', async () => {
  reset()
  const f = fake()
  decide(f, 'approve')
  await call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' })
  const pkgId = f.requests[0].id
  const r = await call(f, ctx(), { objective: 'y', provider: 'codex', approvedPackageId: pkgId }) // nova delegacao = outro destinatario
  assert.equal(r.isError, true)
  assert.match(r.text, /outro destinatario/)
  assert.equal(f.runs.length, 1) // o segundo filho nao rodou
  assert.match((await call(f, ctx(), { objective: 'y', provider: 'codex', approvedPackageId: 424242 })).text, /inexistente/)
})

test('continuacao: mesma sessao e mesma linhagem, sem repetir instrucoes nem o pacote ja entregue', async () => {
  reset()
  const f = fake()
  f.behavior = () => ok('primeira entrega', { session: 'sess-A' })
  decide(f, 'approve')
  const r1 = await call(f, ctx(), { objective: 'implemente', provider: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'edit', paths: ['src'], context: 'requisito A' })
  assert.equal(r1.isError, false)
  const first = lastDeleg(); const pkgId = f.requests[0].id
  f.onRequest = () => {} // a continuacao nao pede nada novo
  f.behavior = () => ok('correcao feita', { session: 'sess-A' })
  const r2 = await call(f, ctx(), { objective: 'corrija o caso B', provider: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'edit', paths: ['src'], continuationOf: first.id, approvedPackageId: pkgId })
  assert.equal(r2.isError, false)
  assert.match(r2.text, /continuacao da #\d+/)
  const p = f.runs[1]
  assert.equal(p.session, 'sess-A') // retoma a sessao correta
  assert.match(p.input, /^\[Continuacao da delegacao #\d+\]/)
  assert.ok(!/Delegacao do dashboard|Regras permanentes|requisito A|Contexto aprovado/.test(p.input)) // nada repetido: a sessao ja tem
  assert.match(p.input, /Ordem direta:\ncorrija o caso B/)
  const second = lastDeleg()
  assert.deepEqual([second.lineage, second.continuation_of], [first.lineage, first.id]) // mesma linhagem
  assert.equal(f.requests.length, 1)
  fs.rmSync(path.join(ws, 'fora-do-escopo.txt'), { force: true })
})

test('identidade do filho: a continuacao legitima reencontra o mesmo grant; delegacao nova nao herda memoria nem artefatos do anterior', async () => {
  reset()
  const f = fake()
  f.wire = true
  f.behavior = () => ok('primeira', { session: 'sess-G' })
  const base = { objective: 'implemente', provider: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'read', paths: ['src'] }
  await call(f, ctx(), base)
  const first = lastDeleg(), g1 = f.wired.find((w: any) => w !== 'cleanup').auth
  assert.match(g1.authId, /^g:/) // identidade interna criada pelo backend (o filho nao informa a propria)
  assert.equal((db.prepare('SELECT session_id FROM exec_grants WHERE auth_id=?').get(g1.authId) as any).session_id, 'sess-G') // vinculada depois ao ID informado pelo executor
  f.wired.length = 0
  f.behavior = () => ok('correcao', { session: 'sess-G' })
  await call(f, ctx(), { ...base, continuationOf: first.id })
  assert.equal(f.wired.find((w: any) => w !== 'cleanup').auth.authId, g1.authId) // mesma sessao + mesmo destinatario = mesma identidade
  f.wired.length = 0
  await call(f, ctx(), base) // nova delegacao (sessao nova): outro destino
  const g3 = f.wired.find((w: any) => w !== 'cleanup').auth
  assert.notEqual(g3.authId, g1.authId)
  // o artefato da primeira execucao foi autorizado ao pai e ao filho daquela sessao, nao ao filho novo
  const art = readArtifact(db, { taskId, reader: g1.authId, id: first.artifact_id, limit: 10 })
  assert.ok(art); assert.equal(readArtifact(db, { taskId, reader: g3.authId, id: first.artifact_id, limit: 10 }), null)
})

test('continuacao recusada quando a sessao nao e compativel: provedor, modelo, esforco, modo, escopo, conta, area, sem sessao', async () => {
  reset()
  const f = fake()
  f.behavior = () => ok('ok', { session: 'sess-B' })
  const base = { objective: 'x', provider: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'read', paths: ['src'] }
  await call(f, ctx(), base)
  const first = lastDeleg()
  const runs = f.runs.length
  const cases: [any, Partial<ParentCtx>, RegExp][] = [
    [{ provider: 'opencode' }, {}, /provedor diferente/], [{ model: 'gpt-5.5' }, {}, /modelo diferente/], [{ effort: 'high' }, {}, /esforco diferente/],
    [{ mode: 'edit' }, {}, /modo diferente/], [{ paths: ['docs'] }, {}, /escopo diferente/]
  ]
  for (const [over, parent, why] of cases) {
    const r = await call(f, ctx(parent), { ...base, ...over, continuationOf: first.id })
    assert.equal(r.isError, true); assert.match(r.text, why); assert.match(r.text, /Chame sem continuationOf/)
  }
  // conta: o pai (claude, conta 1) delegando para claude usaria a conta 1; a delegacao anterior nao tinha conta
  const acc = await call(f, ctx({ provider: 'claude', accountId: 2 }), { ...base, provider: 'claude', model: undefined, effort: undefined, continuationOf: first.id })
  assert.match(acc.text, /provedor diferente|conta diferente/)
  db.prepare('UPDATE delegations SET workspace=? WHERE id=?').run(path.join(tmp, 'outra-area'), first.id)
  assert.match((await call(f, ctx(), { ...base, continuationOf: first.id })).text, /area de trabalho diferente/)
  db.prepare('UPDATE delegations SET workspace=?, session_id=NULL WHERE id=?').run(ws, first.id)
  assert.match((await call(f, ctx(), { ...base, continuationOf: first.id })).text, /nao ha sessao registrada/)
  assert.match((await call(f, ctx(), { ...base, continuationOf: 987654 })).text, /inexistente nesta tarefa/)
  assert.equal(f.runs.length, runs) // nenhuma execucao foi iniciada por reaproveitamento indevido
})

test('resultado grande: envelope curto com extrato identificado, alertas obrigatorios e artefato completo paginavel', async () => {
  reset()
  const f = fake()
  const big = 'paragrafo de detalhes\n\n'.repeat(700) // ~16k caracteres
  f.behavior = () => ok(big, { answer: big, answerBasis: 'limited', tools: ['npm test', 'rg x'] })
  const r = await call(f, ctx(), { objective: 'investigue', provider: 'codex', mode: 'read' })
  assert.ok(r.text.length < 4200, `envelope de ${r.text.length} caracteres`) // 3000 de conclusao + metadados
  assert.match(r.text, /EXTRATO: \d+ de \d+ caracteres[\s\S]*nao e um resumo/)
  assert.match(r.text, /extracao limitada/)
  assert.match(r.text, /2 ferramenta\(s\) executada\(s\)/)
  const row = lastDeleg()
  const full = readArtifact(db, { taskId, reader: parentGrant().authId, id: row.artifact_id, limit: 100_000 })! // o pai autorizado recebe o resultado novo do filho
  assert.equal(full.size, big.length) // o total continua recuperavel
  assert.equal(readArtifact(db, { taskId, reader: 'del:outro', id: row.artifact_id, limit: 10 }), null)
  const otherSession = openGrant(db, { taskId, recipient: { logicalId: PARENT, provider: 'claude', profile: '1', model: null, effort: null, workspace: ws, scope: [] }, sessionId: 'sess-substituta' })
  assert.equal(readArtifact(db, { taskId, reader: otherSession.authId, id: row.artifact_id, limit: 10 }), null) // sessao substituta do pai nao herda o artefato do filho
  assert.ok(row.result.length <= 3000) // o banco guarda o extrato + a referencia; o texto completo vive uma vez, no artefato
  // falha com resultado parcial enorme: estado, erro e violacoes nunca somem por causa do alvo de tamanho
  f.behavior = () => { fs.writeFileSync(path.join(ws, 'intruso2.txt'), 'x'); return { status: 'failed', text: big, answer: big, notes: [], code: 1, category: 'protocol', error: 'saida truncada pelo provedor' } }
  const bad = await call(f, ctx(), { objective: 'investigue de novo', provider: 'opencode', mode: 'read' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /falhou\]/); assert.match(bad.text, /Erro \(protocol\): saida truncada pelo provedor/)
  assert.match(bad.text, /ATENCAO: o modo leitura alterou arquivos/); assert.match(bad.text, /intruso2\.txt/); assert.match(bad.text, /Resultado parcial \(EXTRATO/)
  fs.rmSync(path.join(ws, 'intruso2.txt'), { force: true })
})

test('conclusao delimitada do filho: o pai recebe o bloco (nao o comeco da narrativa) e o estado/alertas reais; sem bloco, extrato rotulado', async () => {
  reset()
  const f = fake()
  const narrative = Array.from({ length: 300 }, (_, i) => `Investiguei o caso ${i} e nada mudou por aqui ainda.`).join('\n\n')
  const block = '[CONCLUSAO]\nResultado: corrigido em src/a.gd\nTestes/evidencias: nao executei os testes\nArquivos: src/a.gd\nBloqueios: nenhum\n[/CONCLUSAO]'
  f.behavior = () => ok(`${narrative}\n\n${block}`, { answer: `${narrative}\n\n${block}`, answerBasis: 'limited' })
  const r = await call(f, ctx(), { objective: 'corrija', provider: 'codex', mode: 'read' })
  assert.match(r.text, /bloco final delimitado pelo agente[\s\S]*Resultado: corrigido em src\/a\.gd/)
  assert.ok(!/Investiguei o caso 0 /.test(r.text) && r.text.length < 1400, `envelope de ${r.text.length}`)
  assert.match(r.text, /TESTES NAO EXECUTADOS \(segundo o proprio agente\)/) // o que o agente admitiu nao some
  const row = lastDeleg()
  assert.match(row.result, /^Resultado: corrigido/); assert.ok(row.result.length < 400) // o banco guarda o bloco, nao a narrativa
  const full = readArtifact(db, { taskId, reader: parentGrant().authId, id: row.artifact_id, limit: 100_000 })!
  assert.ok(full.content.includes('Investiguei o caso 0 ') && full.content.includes('[CONCLUSAO]')) // texto completo recuperavel
  assert.ok(f.notes.some(n => /Delegacao #\d+ concluida/.test(n) && /Resultado: corrigido/.test(n) && !/Investiguei o caso 0 /.test(n)))
  // falha DEPOIS de um texto de sucesso: o bloco nao esconde o erro nem o estado
  f.behavior = () => ({ status: 'failed', text: `${narrative}\n${block}`, answer: block, notes: [], code: 1, category: 'protocol', error: 'saida truncada' })
  const bad = await call(f, ctx(), { objective: 'corrija de novo', provider: 'opencode', mode: 'read' })
  assert.equal(bad.isError, true); assert.match(bad.text, /falhou\][\s\S]*Erro \(protocol\): saida truncada[\s\S]*NOTA: o estado acima e o real/)
  // sem bloco: extrato rotulado (comportamento anterior)
  f.behavior = () => ok(narrative, { answer: narrative, answerBasis: 'limited' })
  assert.match((await call(f, ctx(), { objective: 'x', provider: 'codex', mode: 'read' })).text, /EXTRATO: \d+ de \d+ caracteres, o comeco do texto do agente; nao e um resumo/)
  // o filho e instruido a fechar com o bloco (so na sessao nova; a continuacao ja tem a instrucao)
  assert.match(f.runs[0].input, /\[CONCLUSAO\]\nResultado: \.\.\.\nTestes\/evidencias:[\s\S]*\[\/CONCLUSAO\]/)
})

test('exigir suspensao do pai: delegacao de edicao recusada porque nao ha mecanismo verificavel', async () => {
  reset()
  const f = fake()
  f.settings = { ...f.settings, requireParentSuspension: true }
  const r = await call(f, ctx(), { objective: 'x', provider: 'codex', mode: 'edit' })
  assert.match(r.text, /nenhum mecanismo verificavel de suspensao/); assert.equal(f.runs.length, 0)
  assert.equal((await call(f, ctx(), { objective: 'x', provider: 'codex', mode: 'read' })).isError, false) // leitura segue livre
})

test('filho recebe so ferramentas de contexto (extra/env) e o resumo curto de regras; sem transporte compativel nao ha consulta incremental', async () => {
  reset()
  const f = fake()
  f.wire = true
  await call(f, ctx(), { objective: 'x', provider: 'codex' })
  assert.deepEqual(f.runs[0].opts.extra, ['-c', 'mcp_servers.dashboard.url=x'])
  assert.equal(f.runs[0].env.DASHBOARD_MCP_TOKEN, 't')
  assert.match(f.runs[0].input, /read_task_context[\s\S]*find_in_workspace/)
  assert.equal(f.wired.at(-1), 'cleanup') // token/arquivo removidos ao fim
  assert.match(f.wired[0].lineage, /^del:\d+$/); assert.deepEqual(f.wired[0].scope, [])
  f.wire = false
  await call(f, ctx(), { objective: 'y', provider: 'gemini' })
  assert.ok(!('extra' in f.runs[1].opts)); assert.ok(!/read_task_context/.test(f.runs[1].input))
})

test('agente nomeado: "Fabricio" chega ao executor como codex/gpt-6-luna sem o usuario digitar o modelo; anotado no chat', async () => {
  reset()
  const f = fake()
  f.deps.aliases = () => [{ name: 'Fabricio', provider: 'codex', model: 'gpt-6-luna' }]
  const seen: any[] = []
  f.deps.catalogCheck = async (p, m, e) => { seen.push([p, m, e]); return null } // o mesmo teste de catalogo da delegacao
  const r = await call(f, ctx(), { objective: 'leia src/a.gd', agent: 'fabricio' })
  assert.equal(r.isError, false)
  assert.deepEqual(seen, [['codex', 'gpt-6-luna', undefined]])
  assert.deepEqual(f.runs[0].opts, { model: 'gpt-6-luna', effort: undefined, mode: 'read' })
  assert.equal(lastDeleg().provider, 'codex'); assert.equal(lastDeleg().model, 'gpt-6-luna')
  assert.match(f.notes[0], /para Fabricio = codex\/gpt-6-luna em modo somente leitura/)
  f.catalogErr = null
  // apelido removido depois de salvar: a chamada e recusada com a lista atual (o agente nao usa um catalogo velho)
  f.deps.aliases = () => []
  assert.match((await call(f, ctx(), { objective: 'x', agent: 'Fabricio' })).text, /nao existe\. Agentes cadastrados: nenhum/)
  assert.equal(f.runs.length, 1)
})

test('reinicio do app: pedido de delegacao pendente expira e a delegacao falha; pedido de historico sobrevive', async () => {
  reset()
  const f = fake()
  f.limits.approvalTimeoutMin = 0.05 // 3s: a espera segue "aberta" durante a verificacao
  const p = call(f, ctx(), { objective: 'x', provider: 'codex', context: 'algo' })
  await sleep(50)
  const pending = getPackage(db, f.requests[0].id)!
  const hist = db.prepare("INSERT INTO context_packages (task_id, source, issuer, recipient, provider, items, hash, size) VALUES (?, 'history', 'dashboard', 'chat:1:codex:', 'codex', '[]', 'h', 0)").run(taskId)
  assert.equal(pending.state, 'pending')
  assert.equal(reconcileDelegations(db), 1) // a delegacao 'awaiting_context_approval' vira falha interrompida
  assert.equal(getPackage(db, pending.id)!.state, 'expired')
  assert.equal(getPackage(db, Number(hist.lastInsertRowid))!.state, 'pending') // sem processo dependente: continua aguardando o usuario
  assert.throws(() => resolvePackage(db, { id: pending.id, hash: pending.hash, decision: 'approve' }), /ja foi resolvido \(expired\)/)
  f.deps.waiters.resolved(pending.id, 'cancelled') // libera a espera pendente do teste
  await p
})

test('opencode: as ferramentas MCP do filho nao apagam a protecao somente-leitura (configuracoes mescladas)', async () => {
  reset()
  const f = fake()
  f.wire = true
  f.wireEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { dashboard: { type: 'remote', url: 'http://127.0.0.1:1/mcp' } } }) }
  await call(f, ctx(), { objective: 'so leia', provider: 'opencode', mode: 'read' })
  const cfg = JSON.parse(f.runs[0].env.OPENCODE_CONFIG_CONTENT)
  assert.deepEqual(cfg.permission, { edit: 'deny', bash: 'deny', write: 'deny' }) // leitura continua imposta pelo executor
  assert.equal(cfg.mcp.dashboard.url, 'http://127.0.0.1:1/mcp') // e o filho tem as ferramentas de contexto
  await call(f, ctx(), { objective: 'edite', provider: 'opencode', mode: 'edit' })
  assert.ok(!('permission' in JSON.parse(f.runs[1].env.OPENCODE_CONFIG_CONTENT))) // modo edicao: sem negacoes
})

test('uso da delegacao e fato deterministico do pai sao registrados; entrega interrompida nao e confirmada', async () => {
  reset()
  const f = fake()
  f.behavior = () => ok('ok', { metric: { consumedIn: 500, consumedOut: 40, cacheRead: 300, cacheReadIncluded: true, scope: 'run', source: 'x' }, tools: ['a', 'b'], retries: 1, durationMs: 1234 })
  await call(f, ctx(), { objective: 'leia', provider: 'codex', model: 'gpt-6-luna' })
  const row = lastDeleg()
  const u = db.prepare('SELECT * FROM usage_records WHERE delegation_id=?').get(row.id) as any
  assert.deepEqual([u.provider, u.model, u.input, u.output, u.cache_read, u.tool_calls, u.retries, u.duration_ms], ['codex', 'gpt-6-luna', 500, 40, 300, 2, 1, 1234]) // tool_calls = ferramentas informadas pela CLI, nao chamadas ao modelo
  assert.ok(u.prompt_chars > 0 && u.result_chars === 2) // so tamanhos; nenhum texto vai para o registro
  const finding = db.prepare("SELECT * FROM memory_items WHERE lineage=? AND kind='finding' AND origin_id=?").get(PARENT, row.id) as any
  assert.match(finding.content, /Resultado completo: artefato #\d+/)
  assert.doesNotMatch(finding.content, /Conclusao do filho/) // sem bloco [CONCLUSAO]: a narrativa nao vira memoria
  assert.ok(db.prepare("SELECT 1 FROM memory_items WHERE lineage=? AND kind='checkpoint' AND state='active'").get(PARENT)) // checkpoint deterministico em conclusao de unidade
  // envio interrompido: filho falha depois de receber o pacote aprovado
  const g = fake(); decide(g, 'approve'); g.behavior = () => ({ status: 'failed', text: '', notes: [], code: 1, error: 'caiu' })
  await call(g, ctx(), { objective: 'x', provider: 'codex', context: 'ctx importante' })
  assert.deepEqual(db.prepare('SELECT result FROM context_deliveries WHERE package_id=?').all(g.requests[0].id).map((x: any) => x.result), ['sent'])
})

test('fato do pai traz o bloco [CONCLUSAO] do filho (sem reabrir o artefato) e cabe no limite por item do pacote', async () => {
  reset()
  const f = fake()
  const block = '[CONCLUSAO]\nResultado: sinal duplicado em src/a.gd\nTestes/evidencias: npm test passou\nArquivos: src/a.gd\nBloqueios: nenhum\n[/CONCLUSAO]'
  f.behavior = () => ok(`Narrativa longa.\n\n${block}`, { answer: `Narrativa longa.\n\n${block}`, answerBasis: 'limited' })
  await call(f, ctx(), { objective: 'ache o bug', provider: 'codex' })
  const finding = db.prepare("SELECT content FROM memory_items WHERE lineage=? AND kind='finding' AND origin_id=?").get(PARENT, lastDeleg().id) as any
  assert.match(finding.content, /Conclusao do filho:\nResultado: sinal duplicado em src\/a\.gd\nTestes\/evidencias: npm test passou[\s\S]*Resultado completo: artefato #\d+$/)
  assert.doesNotMatch(finding.content, /Narrativa longa/)
  const concl = extractConclusion(`[CONCLUSAO]\nResultado: ${'r'.repeat(3000)}\n[/CONCLUSAO]`)
  const long = findingContent({ objective: 'o'.repeat(400), changed: Array.from({ length: 30 }, (_, i) => `src/arquivo_${i}.gd`), outOfScope: ['x/y'], conclusion: concl, artifactId: 7, maxChars: DEFAULT_LIMITS.itemChars })
  assert.ok(long.length <= DEFAULT_LIMITS.itemChars, `${long.length}`) // senao o item inteiro sairia do pacote candidato
  assert.match(long, /\(continua no artefato\)\nResultado completo: artefato #7$/)
  assert.doesNotMatch(findingContent({ objective: 'x', changed: [], outOfScope: [], conclusion: concl, artifactId: 7, maxChars: 300 }), /Conclusao do filho/) // sem espaco util: so o ponteiro
})

test('aprovacao parcial durante a delegacao: o filho recebe SO os itens mantidos', async () => {
  reset()
  const f = fake()
  const m1 = addMemory(db, { taskId, owner: 'run', lineage: PARENT, grantId: parentGrant().authId, kind: 'decision', title: 'Usar sinais', content: 'DECISAO-MANTIDA' })
  const m2 = addMemory(db, { taskId, owner: 'run', lineage: PARENT, grantId: parentGrant().authId, kind: 'finding', title: 'Log grande', content: 'ACHADO-DESMARCADO' })
  f.onRequest = pkg => setTimeout(() => { const r = approveSubset(db, f.limits, { id: pkg.id, hash: pkg.hash, keep: [`m:${m1.id}`] }); f.deps.waiters.resolved(pkg.id, r.pkg.state) }, 10)
  const r = await call(f, ctx(), { objective: 'corrija', provider: 'codex', memoryIds: [m1.id, m2.id] })
  assert.equal(r.isError, false)
  assert.match(f.runs[0].input, /DECISAO-MANTIDA/); assert.doesNotMatch(f.runs[0].input, /ACHADO-DESMARCADO/)
  const row = lastDeleg()
  assert.equal(getPackage(db, row.package_id)!.items.length, 1) // a delegacao aponta para o pacote que foi de fato entregue
  assert.equal(db.prepare("SELECT result FROM context_deliveries WHERE package_id=?").get(row.package_id)!.result, 'confirmed')
})

test('filho Claude: ferramentas nativas sem duplicar o MCP; recibos/skills so sobrevivem na mesma sessao', async () => {
  reset()
  const f = fake()
  const keeps: (boolean | undefined)[] = []
  f.deps.childTools = async () => ({ extra: [], env: {}, native: ['Grep', 'Glob'], tools: ['read_task_context', 'read_file_range'], cleanup: keep => { keeps.push(keep) } })
  f.behavior = () => ok('feito', { session: 'sess-filho' })
  await call(f, ctx(), { objective: 'leia', provider: 'claude', mode: 'read' })
  const args = AGENTS.claude.chatArgs(undefined, f.runs[0].opts).join(' ')
  assert.match(args, /--tools Grep,Glob/); assert.doesNotMatch(args, /Read/) // leitura pelo read_file_range (escopo + readToken)
  assert.match(f.runs[0].input, /Busque com Grep\/Glob \(Grep em modo content com -C[^)]*\) e leia com read_file_range/)
  assert.doesNotMatch(f.runs[0].input, /test_evidence/) // nao anunciada: o resumo nao cita
  assert.doesNotMatch(f.runs[0].input, /godot_scene/) // sem ferramentas Godot anunciadas: nenhuma linha Godot
  assert.equal(f.runs[0].env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, '1')
  const first = lastDeleg().id
  await call(f, ctx(), { objective: 'corrija a leitura', provider: 'claude', mode: 'read', continuationOf: first }) // retomou a MESMA sessao
  f.behavior = () => ok('feito', { session: 'sess-OUTRA' }) // a CLI abriu outra sessao em silencio: nada do que foi entregue vale
  await call(f, ctx(), { objective: 'de novo', provider: 'claude', mode: 'read', continuationOf: first })
  f.behavior = () => ({ status: 'failed', text: '', notes: [], code: 1, error: 'x' }) // sem sessao informada
  await call(f, ctx(), { objective: 'nova', provider: 'claude', mode: 'read' })
  assert.deepEqual(keeps, [true, true, false, false])
})

test('trechos indicados pelo pai: lidos do disco com as regras do filho, entregues com a ordem, sem pacote; recibo vale para o filho', async () => {
  reset()
  fs.writeFileSync(path.join(ws, 'src', 'b.gd'), Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\n'))
  const f = fake(); f.wire = true
  const r = await call(f, ctx(), { objective: 'explique b', provider: 'codex', paths: ['src'], files: [{ path: 'src/b.gd', startLine: 3, endLine: 5 }, { path: 'README.md' }, { path: '../fora.txt' }] })
  assert.equal(r.isError, false)
  const input = f.runs[0].input as string
  assert.match(input, /\[Trechos indicados pelo pai, lidos agora do disco pelo dashboard; ja estao com voce, nao os releia \(para ampliar, read_file_range/)
  assert.match(input, /src\/b\.gd \(linhas 3-5 de 30;[^\n]*readToken (rt_\w+)\)\n3\tlinha 3\n4\tlinha 4\n5\tlinha 5/)
  assert.match(input, /README\.md: nao anexado \([^)]*fora do escopo/) // escopo do filho vale para os trechos
  assert.match(input, /\.\.\/fora\.txt: nao anexado \(Caminho fora da area/)
  assert.ok(input.indexOf('Ordem direta') < input.indexOf('[Trechos indicados'))
  assert.equal((db.prepare('SELECT COUNT(*) n FROM context_packages').get() as any).n, 0) // leitura nova: nenhum pedido de aprovacao
  assert.match(f.notes[0], /trechos anexados: src\/b\.gd, README\.md, \.\.\/fora\.txt/)
  // O recibo foi emitido para a identidade do filho: ele amplia sem receber de novo o que ja tem
  const token = /readToken (rt_\w+)/.exec(input)![1]
  assert.match(readFileRange({ cwd: ws, session: f.wired[0].auth.authId }, { path: 'src/b.gd', startLine: 3, endLine: 5, readToken: token }), /ja foi entregue nesta sessao/)
  // Sem MCP (sem read_file_range): trecho vai, sem token e sem mencionar a ferramenta
  const g = fake()
  await call(g, ctx(), { objective: 'explique b', provider: 'gemini', files: [{ path: 'src/b.gd', startLine: 1, endLine: 2 }] })
  assert.doesNotMatch(g.runs[0].input, /readToken|read_file_range/)
  assert.match(g.runs[0].input, /1\tlinha 1\n2\tlinha 2/)
  // Argumentos invalidos sao recusados antes de qualquer execucao
  for (const bad of [{ files: 'src/b.gd' }, { files: [{}] }, { files: [{ path: 'a', startLine: 0 }] }, { files: Array(6).fill({ path: 'a' }) }])
    assert.throws(() => parseArgs({ objective: 'x', provider: 'codex', ...bad }, S), /files deve ser/)
  fs.rmSync(path.join(ws, 'src', 'b.gd'))
})

test('trechos: orcamento total fixo; o que nao cabe e cortado com rotulo e sem recibo, nunca em silencio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-fx-'))
  fs.writeFileSync(path.join(dir, 'g.txt'), Array.from({ length: 400 }, (_, i) => `${i}`.padEnd(60, 'x')).join('\n'))
  const out = fileExcerpts([{ path: 'g.txt', endLine: 400 }, { path: 'g.txt', startLine: 1, endLine: 2 }, { path: 'g.txt' }], { cwd: dir, scope: [], session: 'fx' })
  assert.ok(out.length <= FILES_CHARS + 200)
  assert.match(out, /CORTADO no limite de tamanho: exibindo 1-\d+, leia o resto se precisar/)
  assert.doesNotMatch(out.split('\n')[0], /readToken/) // cortado: sem recibo
  assert.match(out, /g\.txt: nao anexado \(limite de 12000 caracteres dos trechos\)/)
  assert.equal(fileExcerpts([], { cwd: dir, scope: [] }), '')
  fs.rmSync(dir, { recursive: true, force: true })
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
