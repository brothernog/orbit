// Ferramentas de contexto, operacoes locais, evidencia de testes e historico com consentimento. Dados sinteticos, sem chamadas pagas.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveArtifact } from './artifacts.ts'
import { bindGrantSession, createPackage, openGrant, planHistoryContext, recordDelivery, finishDelivery, resolvePackage, revokePackage, type Grant, type Recipient } from './consent.ts'
import { openDb } from './db.ts'
import { lookupTestEvidence, recordTestEvidence, summarizeTestOutput } from './evidence.ts'
import { DEFAULT_LIMITS, estimateTokens, normalizeLimits } from './limits.ts'
import { addMemory, buildCheckpoint, getMemory, setTodoState } from './memory.ts'
import { briefTokens, buildChildInput, runtimeBrief } from './prompt.ts'
import { callTaskTool, childToolset, toolsFor, type ToolCtx } from './taskContext.ts'
import type { ToolResult } from './mcp.ts'
import { contextFor, createTask, stripActivity } from './tasks.ts'
import { dropReceipts, findInWorkspace, globToRegex, listFilesUnder, readFileRange, receiptCount } from './workspaceTools.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-tc-'))
const ws = path.join(tmp, 'proj')
fs.mkdirSync(path.join(ws, 'src', 'player'), { recursive: true })
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true })
fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'player', 'jump.ts'), Array.from({ length: 30 }, (_, i) => `linha ${i + 1} pulo`).join('\n'))
fs.writeFileSync(path.join(ws, 'src', 'main.ts'), 'export const main = 1\n// TODO pulo duplo\n')
fs.writeFileSync(path.join(ws, 'docs', 'notas.md'), 'nada aqui\n')
fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'lib.js'), 'pulo em dependencia')
fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0, 1, 2, 112, 117, 108, 111]))
const db = openDb(path.join(tmp, 't.db'))
const T = createTask(db, ws, 'tarefa'), T2 = createTask(db, ws, 'outra')
const PARENT = 'chat:1:claude:1'
// Identidade efetiva (grant) que o backend cria para cada execucao; os testes a criam do mesmo jeito.
const rcp = (logicalId: string, over: Partial<Recipient> = {}): Recipient => ({ logicalId, provider: 'codex', profile: '', model: null, effort: null, workspace: ws, scope: [], ...over })
const grantOf = (taskId: number, r: Recipient, sessionId?: string | null): Grant => openGrant(db, { taskId, recipient: r, sessionId })
const parent: ToolCtx = { taskId: T, lineage: PARENT, auth: grantOf(T, rcp(PARENT, { provider: 'claude', profile: '1' }), 'sess-parent'), role: 'parent', cwd: ws, scope: [], runId: 5 }
const R: Recipient = rcp('del:7', { scope: ['src/player'] })
const child: ToolCtx = { taskId: T, lineage: 'del:7', auth: grantOf(T, R), role: 'child', cwd: ws, scope: ['src/player'], delegationId: 7 }
const call = (c: ToolCtx, name: string, args: any) => callTaskTool(db, DEFAULT_LIMITS, c, name, args) as ToolResult
const find = async (c: ToolCtx, args: any) => await callTaskTool(db, DEFAULT_LIMITS, c, 'find_in_workspace', args)

test('ferramentas anunciadas por papel: filho nunca recebe delegar; operacoes locais so para filho', () => {
  const names = (r: 'parent' | 'child', d?: any) => toolsFor(r, d).map(t => t.name)
  assert.deepEqual(names('parent'), ['read_task_context', 'record_task_memory', 'read_task_skill', 'ask_user', 'suggest_task', 'send_user_file'])
  assert.deepEqual(names('parent', { name: 'delegate_to_agent' }), ['delegate_to_agent', 'read_task_context', 'record_task_memory', 'read_task_skill', 'ask_user', 'suggest_task', 'send_user_file'])
  assert.deepEqual(names('child'), ['read_task_context', 'record_task_memory', 'find_in_workspace', 'read_file_range', 'test_evidence', 'read_task_skill'])
  assert.ok(!names('child').some(n => ['delegate_to_agent', 'ask_user', 'suggest_task', 'send_user_file'].includes(n))) // filho responde ao pai, nao ao usuario
  assert.equal(call(parent, 'find_in_workspace', { pattern: 'x' }).isError, true) // mesmo sabendo o nome, o pai nao chama
  assert.equal(call(parent, 'delegate_to_agent', {}).isError, true) // delegar nao passa por aqui
  assert.match(call(child, 'apagar_tudo', {}).text, /desconhecida/)
  const size = JSON.stringify(toolsFor('child')).length
  assert.ok(estimateTokens(size) < 1500, `esquemas do filho: ~${estimateTokens(size)} tokens`) // schemas pequenos e estaveis
})

test('record_task_memory: origem, evidencia por hash, privado a linhagem; erros viram resultado, nao excecao', () => {
  const r = call(parent, 'record_task_memory', { kind: 'decision', title: 'Salvar em JSON', content: 'Formato decidido.', paths: ['src'], evidenceFiles: ['src/main.ts'] })
  assert.equal(r.isError, false); assert.match(r.text, /Registrado m:\d+/); assert.match(r.text, /Privado a esta linhagem/)
  const id = Number(/m:(\d+)/.exec(r.text)![1])
  const m = getMemory(db, T, id)!
  assert.deepEqual([m.owner, m.origin_id, m.lineage, m.grant_id, m.evidence.files![0].path], ['run', 5, PARENT, parent.auth.authId, 'src/main.ts']) // o grant vem do token, nunca do agente
  assert.match(call(parent, 'record_task_memory', { kind: 'decision', title: 'Salvar em JSON', content: 'Formato decidido.', paths: ['src'], evidenceFiles: ['src/main.ts'] }).text, /ja existia/)
  assert.equal(call(parent, 'record_task_memory', { kind: 'segredo', title: 'x', content: 'y' }).isError, true)
  assert.equal(call(parent, 'record_task_memory', { kind: 'finding', title: 'x', content: 'y', evidenceFiles: ['../fora'] }).isError, true)
  assert.equal(call(parent, 'record_task_memory', null).isError, true)
  const c = call(child, 'record_task_memory', { kind: 'finding', title: 'Achado do filho', content: 'privado ao filho' })
  assert.equal(getMemory(db, T, Number(/m:(\d+)/.exec(c.text)![1]))!.owner, 'delegation')
})

test('read_task_context: indice so com o que a linhagem pode ler; nada de outro filho, do usuario ou de outra tarefa', () => {
  addMemory(db, { taskId: T, owner: 'user', lineage: 'user', kind: 'constraint', title: 'Regra do usuario SIGILOSA', content: 'nunca compartilhar sem aprovar' })
  addMemory(db, { taskId: T2, owner: 'run', lineage: 'del:7', grantId: grantOf(T2, R).authId, kind: 'finding', title: 'Outra tarefa', content: 'mesma linhagem, outra tarefa' })
  const idx = call(child, 'read_task_context', {})
  assert.match(idx.text, /Achado do filho/)
  assert.ok(!/SIGILOSA|Outra tarefa|Salvar em JSON/.test(idx.text)) // usuario, outra tarefa e pai ficam de fora
  assert.equal(call(child, 'read_task_context', { query: 'sigilosa' }).text.startsWith('0 item(ns)'), true)
  const pidx = call(parent, 'read_task_context', {})
  assert.match(pidx.text, /Salvar em JSON/); assert.ok(!/Achado do filho|SIGILOSA/.test(pidx.text))
  assert.match(call(child, 'read_task_context', { itemId: 'm:1' }).text, /nao encontrado ou nao autorizado/) // id alheio nao revela nada
})

test('pacote aprovado torna itens legiveis so para o destinatario exato; antes da aprovacao ou apos recusa nada aparece', () => {
  const secret = addMemory(db, { taskId: T, owner: 'run', lineage: PARENT, grantId: parent.auth.authId, kind: 'finding', title: 'Descoberta A', content: 'o boss tem 3 fases', paths: ['src/player'] }).id
  const mk = () => createPackage(db, DEFAULT_LIMITS, { taskId: T, source: 'delegation', issuer: PARENT, recipient: R, items: [{ ref: `m:${secret}`, itemId: secret, revision: 1, kind: 'finding', title: 'Descoberta A', content: 'o boss tem 3 fases' }] })
  const pending = mk()
  assert.ok(!/Descoberta A/.test(call(child, 'read_task_context', {}).text)) // pendente: o destinatario nao ve nem o indice
  resolvePackage(db, { id: pending.id, hash: pending.hash, decision: 'reject' })
  assert.ok(!/Descoberta A/.test(call(child, 'read_task_context', {}).text)) // recusado: idem
  const ok = mk(); resolvePackage(db, { id: ok.id, hash: ok.hash, decision: 'approve' })
  const idx = call(child, 'read_task_context', {}).text
  assert.match(idx, /Descoberta A/); assert.match(idx, /snapshot aprovado|valid|validade desconhecida/)
  const item = call(child, 'read_task_context', { itemId: `p${ok.id}:m:${secret}` }).text
  assert.match(item, /o boss tem 3 fases/); assert.match(item, new RegExp(`pacote aprovado #${ok.id}`))
  // o snapshot e o que foi aprovado: nova revisao do item nao chega sem novo pedido
  addMemory(db, { taskId: T, owner: 'run', lineage: PARENT, grantId: parent.auth.authId, kind: 'finding', title: 'Descoberta A', content: 'o boss tem 5 fases', paths: ['src/player'], supersedes: secret })
  assert.match(call(child, 'read_task_context', { itemId: `p${ok.id}:m:${secret}` }).text, /o boss tem 3 fases/)
  assert.ok(!/5 fases/.test(call(child, 'read_task_context', {}).text))
  const other = (over: Partial<Recipient>) => ({ ...child, lineage: over.logicalId ?? 'del:7', auth: grantOf(T, { ...R, ...over }) })
  assert.ok(!/Descoberta A/.test(call(other({ logicalId: 'del:8' }), 'read_task_context', {}).text)) // outro destinatario
})

// Fase 1: nenhuma rota de consulta obtem o que a entrega recusaria. Mesma regra central (consent.ts) para indice, item e artefato.
test('consulta usa a MESMA autorizacao da entrega: modelo, esforco, perfil, area, escopo, tarefa e sessao diferentes nao herdam nada', () => {
  const t = createTask(db, ws, 'auth')
  const L = 'del:41'
  const RR = rcp(L, { scope: ['src'], model: 'gpt-6-luna' })
  const owner = (over: Partial<Recipient> = {}, session: string | null = null): ToolCtx => ({ taskId: t, lineage: over.logicalId ?? L, auth: grantOf(t, { ...RR, ...over }, session), role: 'child', cwd: ws, scope: ['src'], delegationId: 41 })
  const a = owner()
  const rec = call(a, 'record_task_memory', { kind: 'finding', title: 'Achado privado da sessao', content: 'segredo da sessao A' })
  const mid = Number(/m:(\d+)/.exec(rec.text)![1])
  const art = saveArtifact(db, { taskId: t, producer: L, readers: [a.auth.authId], kind: 'delegation', content: 'RESULTADO SIGILOSO' })
  const sees = (c: ToolCtx) => /Achado privado/.test(call(c, 'read_task_context', {}).text) || /SIGILOSO/.test(call(c, 'read_task_context', { artifactId: art.id }).text) || /segredo da sessao A/.test(call(c, 'read_task_context', { itemId: `m:${mid}` }).text)
  assert.equal(sees(a), true) // o proprio destino enxerga o que escreveu
  assert.equal(sees(owner()), false) // MESMA chave logica e mesmos atributos, mas sessao nova (grant novo): nao herda nada
  bindGrantSession(db, a.auth, 'nat-1')
  assert.equal(sees(owner({}, 'nat-1')), true) // continuacao legitima: mesma sessao nativa vinculada pelo backend, mesmo destinatario
  for (const change of [{ model: 'gpt-5.5' }, { effort: 'high' }, { profile: '2' }, { workspace: path.join(tmp, 'outra-area') }, { scope: ['docs'] }, { provider: 'gemini' }])
    assert.equal(sees(owner(change, 'nat-1')), false, `atributo alterado: ${JSON.stringify(change)}`) // mesma sessao, destino alterado
  assert.equal(sees(owner({}, 'nat-2')), false) // sessao substituta
  assert.equal(sees({ ...owner({}, 'nat-1'), taskId: T2 }), false) // tarefa diferente na mesma pasta
  // a linhagem antiga (mesma chave de conversa) nao serve de contorno: itens legados sem grant tambem exigem novo pedido
  const legacy = addMemory(db, { taskId: t, owner: 'run', lineage: L, kind: 'finding', title: 'Item legado sem grant', content: 'x' }).id
  assert.ok(!/Item legado/.test(call(owner({}, 'nat-1'), 'read_task_context', {}).text) && /nao encontrado/.test(call(owner({}, 'nat-1'), 'read_task_context', { itemId: `m:${legacy}` }).text))
})

test('pacote: adulterado, revogado, de outra sessao ou de outro destino some do indice, do item e da delegacao; sessao ainda nao vinculada le pacote nao entregue', () => {
  const t = createTask(db, ws, 'pkg')
  const L = 'chat:71:codex:'
  const RR = rcp(L, { model: 'm1' })
  const ctxFor = (session: string | null, over: Partial<Recipient> = {}): ToolCtx => ({ taskId: t, lineage: L, auth: grantOf(t, { ...RR, ...over }, session), role: 'parent', cwd: ws, scope: [] })
  const src = addMemory(db, { taskId: t, owner: 'run', lineage: 'chat:71:claude:1', grantId: 'g:origem', kind: 'decision', title: 'Decisao compartilhada', content: 'usar JSON' }).id
  const mk = () => createPackage(db, DEFAULT_LIMITS, { taskId: t, source: 'memory', issuer: 'chat:71:claude:1', recipient: RR, items: [{ ref: `m:${src}`, itemId: src, revision: 1, kind: 'decision', title: 'Decisao compartilhada', content: 'usar JSON' }] })
  const p = mk(); resolvePackage(db, { id: p.id, hash: p.hash, decision: 'approve' })
  const visible = (c: ToolCtx) => /Decisao compartilhada/.test(call(c, 'read_task_context', {}).text) && /usar JSON/.test(call(c, 'read_task_context', { itemId: `p${p.id}:m:${src}` }).text)
  assert.equal(visible(ctxFor(null)), true) // sessao ainda nao vinculada + pacote ainda nao entregue a nenhuma sessao
  assert.equal(visible(ctxFor(null, { model: 'm2' })), false) // outro modelo: novo pedido
  assert.equal(visible(ctxFor(null, { workspace: path.join(tmp, 'x') })), false)
  // adulteracao no banco (conteudo do snapshot) invalida a consulta, nao so o envio
  const row = db.prepare('SELECT items FROM context_packages WHERE id=?').get(p.id) as any
  db.prepare('UPDATE context_packages SET items=? WHERE id=?').run(row.items.replace('usar JSON', 'apagar tudo'), p.id)
  assert.equal(/apagar tudo|Decisao compartilhada/.test(call(ctxFor(null), 'read_task_context', {}).text), false)
  db.prepare('UPDATE context_packages SET items=? WHERE id=?').run(row.items, p.id) // restaurado: volta a valer
  assert.equal(visible(ctxFor(null)), true)
  // entregue a uma sessao: so essa sessao continua lendo; sessao nova e outra sessao nao herdam
  db.prepare("UPDATE context_packages SET session_id='nat-A' WHERE id=?").run(p.id)
  assert.equal(visible(ctxFor('nat-A')), true)
  assert.equal(visible(ctxFor('nat-B')), false)
  assert.equal(visible(ctxFor(null)), false) // sessao nova: o pacote ja entregue a outra sessao nao vale (mesma regra da entrega)
  // a delegacao usa a mesma leitura: memoryIds so aceita o que o grant do pai pode ler
  assert.equal(revokePackage(db, p.id, t), true)
  assert.equal(visible(ctxFor('nat-A')), false) // revogado: nao consultavel
})

test('artefatos: so quem foi autorizado pelo backend le; o nome do produtor e da linhagem nao concede acesso', () => {
  const t = createTask(db, ws, 'art')
  const RR = rcp('chat:81:codex:')
  const p1: ToolCtx = { taskId: t, lineage: RR.logicalId, auth: grantOf(t, RR, 'nat-1'), role: 'parent', cwd: ws, scope: [] }
  const p2: ToolCtx = { ...p1, auth: grantOf(t, RR, 'nat-2') } // mesma linhagem, sessao substituta
  const art = saveArtifact(db, { taskId: t, producer: 'del:9', readers: [p1.auth.authId], kind: 'delegation', content: 'resultado do filho' })
  assert.match(call(p1, 'read_task_context', { artifactId: art.id }).text, /resultado do filho/)
  assert.match(call(p2, 'read_task_context', { artifactId: art.id }).text, /nao encontrado ou nao autorizado/)
  assert.ok(!/artefato #/.test(call(p2, 'read_task_context', {}).text)) // o indice tambem nao revela
  // o produtor (filho) sem ser leitor tambem nao le por ter o mesmo nome de linhagem
  const other = grantOf(t, rcp('del:9'))
  assert.match(call({ ...p1, lineage: 'del:9', auth: other, role: 'child' }, 'read_task_context', { artifactId: art.id }).text, /nao encontrado ou nao autorizado/)
})

test('read_task_context: filtros, paginacao com cursor, limites e ampliacao explicita; artefatos paginados e autorizados', () => {
  const t = createTask(db, ws, 'pag')
  const ctx: ToolCtx = { taskId: t, lineage: 'chat:9:codex:', auth: grantOf(t, rcp('chat:9:codex:'), 's9'), role: 'parent', cwd: ws, scope: [] }
  for (let i = 1; i <= 25; i++) addMemory(db, { taskId: t, owner: 'run', lineage: ctx.lineage, grantId: ctx.auth.authId, kind: i % 2 ? 'finding' : 'decision', title: `Item ${i}`, content: `conteudo do item ${i} sobre pulo`, paths: i > 20 ? ['docs'] : ['src'] })
  const p1 = call(ctx, 'read_task_context', {})
  assert.match(p1.text, /25 item\(ns\) autorizado\(s\); mostrando 1-10 \(proximo cursor: 10\)/)
  assert.equal(p1.text.split('\n').filter(l => l.startsWith('m:')).length, 10) // 10 resultados por pagina
  assert.match(call(ctx, 'read_task_context', { cursor: '10' }).text, /mostrando 11-20/)
  assert.match(call(ctx, 'read_task_context', { cursor: '20' }).text, /^25 item\(ns\) autorizado\(s\)\n/) // ultima pagina: sem cursor
  assert.match(call(ctx, 'read_task_context', { expand: true }).text, /mostrando 1-25|25 item/) // ampliacao explicita
  assert.match(call(ctx, 'read_task_context', { kind: 'decision' }).text, /^12 item/)
  assert.match(call(ctx, 'read_task_context', { path: 'docs' }).text, /^5 item/)
  assert.match(call(ctx, 'read_task_context', { query: 'item 25' }).text, /^1 item/)
  const big = saveArtifact(db, { taskId: t, producer: 'del:1', readers: [ctx.auth.authId], kind: 'delegation', title: 'R', content: 'ABC'.repeat(4000) })
  const a1 = call(ctx, 'read_task_context', { artifactId: big.id }).text
  assert.match(a1, /caracteres 0-6000 de 12000[\s\S]*proxima pagina: offset 6000/)
  assert.match(call(ctx, 'read_task_context', { artifactId: big.id, offset: 6000 }).text, /caracteres 6000-12000 de 12000 .* fim/)
  assert.match(call({ ...ctx, lineage: 'chat:9:gemini:', auth: grantOf(t, rcp('chat:9:gemini:', { provider: 'gemini' }), 's9') }, 'read_task_context', { artifactId: big.id }).text, /nao encontrado ou nao autorizado/)
  assert.match(call(ctx, 'read_task_context', {}).text, /Artefatos:\nartefato #\d+ \[delegation\]/)
  assert.equal(call(ctx, 'read_task_context', { cursor: 'x' }).isError, true)
})

test('validade aparece no indice: arquivo de evidencia alterado marca DESATUALIZADO', () => {
  const t = createTask(db, ws, 'val')
  const ctx: ToolCtx = { taskId: t, lineage: 'chat:8:codex:', auth: grantOf(t, rcp('chat:8:codex:'), 's8'), role: 'parent', cwd: ws, scope: [] }
  call(ctx, 'record_task_memory', { kind: 'finding', title: 'Depende do main', content: 'main exporta 1', evidenceFiles: ['src/main.ts'] })
  assert.match(call(ctx, 'read_task_context', {}).text, /· valido/)
  fs.appendFileSync(path.join(ws, 'src', 'main.ts'), '// mudou\n')
  assert.match(call(ctx, 'read_task_context', {}).text, /DESATUALIZADO \(mudou: src\/main\.ts\)/)
})

test('operacoes locais: busca limitada com total e truncamento, escopo, binarios, node_modules e caminhos fora da area', async () => {
  const c: ToolCtx = { ...child, scope: [] }
  const all = (await find(c, { pattern: 'pulo' })).text
  assert.match(all, /^31 ocorrencia\(s\) em 2 arquivo\(s\)/) // jump.ts (30) e main.ts (1); o binario nao entra e node_modules e ignorado
  assert.ok(!/node_modules|bin\.dat/.test(all))
  const lim = (await find(c, { pattern: 'pulo', maxResults: 5 })).text
  assert.match(lim, /TRUNCADO/); assert.equal(lim.split('\n').filter(l => /:\d+:/.test(l)).length, 5)
  assert.match((await find(child, { pattern: 'pulo' })).text, /^30 ocorrencia\(s\) em 1 arquivo\(s\)/) // escopo src/player: main.ts fora
  assert.match((await find(c, { mode: 'list', glob: '**/*.md' })).text, /^1 arquivo\(s\)\ndocs\/notas\.md/)
  assert.match((await find(c, { pattern: 'a.c', regex: false })).text, /^0 ocorrencia/) // literal, nao regex
  assert.match((await find(c, { pattern: 'pu.o', regex: true })).text, /ocorrencia/)
  for (const bad of [{ path: '../fora' }, { path: 'C:/Windows' }, { pattern: '(', regex: true }, { pattern: 'x'.repeat(201) }, { pattern: 'x', path: 'nao-existe' }])
    assert.equal((await find(c, bad)).isError, true, JSON.stringify(bad))
  assert.ok(globToRegex('src/**/*.ts').test('src/a/b/c.ts') && globToRegex('src/**/*.ts').test('src/c.ts') && !globToRegex('*.ts').test('src/c.ts'))
})

test('leitura por intervalo: limites e escopo', () => {
  const r = call(child, 'read_file_range', { path: 'src/player/jump.ts', startLine: 3, endLine: 5 }).text
  assert.match(r, /^src\/player\/jump\.ts \(linhas 3-5 de 30; hash [0-9a-f]{12}; ha mais linhas/)
  assert.match(r, /\n3\tlinha 3 pulo\n4\t/)
  assert.equal(call(child, 'read_file_range', { path: 'src/main.ts' }).isError, true) // fora do escopo da delegacao
  assert.equal(call({ ...child, scope: [] }, 'read_file_range', { path: 'bin.dat' }).isError, true) // binario
  assert.equal(call({ ...child, scope: [] }, 'read_file_range', { path: '../x' }).isError, true)
  const long = call({ ...child, scope: [] }, 'read_file_range', { path: 'src/player/jump.ts', startLine: 1, endLine: 9999 }).text
  assert.match(long, /linhas 1-30 de 30/) // arquivo curto: nao trunca
  fs.writeFileSync(path.join(ws, 'grande.txt'), Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n'))
  assert.match(call({ ...child, scope: [] }, 'read_file_range', { path: 'grande.txt', startLine: 1, endLine: 1000 }).text, /TRUNCADO em 400 linhas/)
  assert.deepEqual(listFilesUnder({ cwd: ws }, 'src').sort(), ['src/main.ts', 'src/player/jump.ts'])
  assert.throws(() => listFilesUnder({ cwd: ws }, 'src', 1), /Mais de 1 arquivos/) // lista de dependencias nunca truncada em silencio
})

// Fase 2: o cache so suprime o que a MESMA sessao comprovadamente recebeu (mesmo arquivo, intervalo exato, conteudo inalterado).
test('recibo de leitura: nunca esconde linha inedita; suprime so a repeticao exata, inalterada e da mesma sessao', () => {
  const t = createTask(db, ws, 'recibos')
  const mkc = (session: string, over: Partial<ToolCtx> = {}): ToolCtx => ({ taskId: t, lineage: 'del:61', auth: grantOf(t, rcp('del:61', { scope: [] }), session), role: 'child', cwd: ws, scope: [], delegationId: 61, ...over })
  const a = mkc('rc-1')
  const file = path.join(ws, 'recibo.txt')
  fs.writeFileSync(file, Array.from({ length: 60 }, (_, i) => `r${i + 1}`).join('\n'))
  const rd = (c: ToolCtx, args: any) => call(c, 'read_file_range', { path: 'recibo.txt', ...args })
  const tok = (s: string) => /readToken (rt_[0-9a-f]+)/.exec(s)?.[1]
  const first = rd(a, { startLine: 1, endLine: 1 }).text
  const t1 = tok(first)!; assert.ok(t1); assert.match(first, /\n1\tr1$/)
  const hash = /hash ([0-9a-f]{12})/.exec(first)![1]
  // achado original: linha 1 lida, depois linhas 20-25 com o mesmo hash NUNCA pode voltar "sem conteudo"
  for (const args of [{ startLine: 20, endLine: 25, ifHash: hash }, { startLine: 20, endLine: 25, readToken: t1 }, { startLine: 1, endLine: 5, readToken: t1 }, { startLine: 1, endLine: 2, readToken: t1 }]) {
    const r = rd(a, args).text
    assert.match(r, /\n\d+\tr\d+/, JSON.stringify(args)); assert.ok(!/nenhum conteudo reenviado/.test(r), JSON.stringify(args))
  }
  assert.match(rd(a, { startLine: 1, endLine: 1, ifHash: hash }).text, /\n1\tr1$/) // ifHash isolado (contrato antigo): devolve normalmente
  // repeticao exata com recibo valido: suprimida, e diz o que aconteceu
  const t2 = tok(rd(a, { startLine: 20, endLine: 25 }).text)!
  const rep = rd(a, { startLine: 20, endLine: 25, readToken: t2 }).text
  assert.match(rep, /ja foi entregue nesta sessao e o arquivo nao mudou[\s\S]*nenhum conteudo reenviado/); assert.ok(!/\n20\tr20/.test(rep))
  // sobreposto numa ponta: so as linhas que faltam, com o motivo, e um recibo que cobre a uniao
  const tail = rd(a, { startLine: 20, endLine: 26, readToken: t2 }).text
  assert.match(tail, /linhas 20-25 ja entregues nesta sessao[\s\S]*exibindo 26-26[\s\S]*\(vale para 20-26\)\)\n26\tr26$/); assert.ok(!/\n20\tr20/.test(tail))
  assert.match(rd(a, { startLine: 22, endLine: 26, readToken: tok(tail) }).text, /contido no intervalo 20-26[\s\S]*nenhum conteudo reenviado/)
  const headPart = rd(a, { startLine: 17, endLine: 21, readToken: t2 }).text
  assert.match(headPart, /linhas 20-21 ja entregues[\s\S]*exibindo 17-19/); assert.match(headPart, /\n17\tr17\n18\tr18\n19\tr19$/)
  // contido no recibo: nada reenviado; recibo no MEIO do pedido: leitura inteira (nunca dois buracos)
  assert.match(rd(a, { startLine: 21, endLine: 25, readToken: t2 }).text, /contido no intervalo 20-25[\s\S]*nenhum conteudo reenviado/)
  const around = rd(a, { startLine: 18, endLine: 27, readToken: t2 }).text
  assert.match(around, /\n18\tr18[\s\S]*\n22\tr22[\s\S]*\n27\tr27$/); assert.ok(!/ja entregues/.test(around))
  // outra sessao / outra tarefa, token inventado, token de outro arquivo: leitura normal (nunca erro)
  const other = mkc('rc-2')
  assert.match(rd(other, { startLine: 20, endLine: 25, readToken: t2 }).text, /\n20\tr20/)
  assert.match(rd({ ...a, taskId: T2 }, { startLine: 20, endLine: 25, readToken: t2 }).text, /nao pertence a esta tarefa/) // identidade de outra tarefa e recusada
  assert.match(rd(a, { startLine: 20, endLine: 25, readToken: 'rt_inventado' }).text, /\n20\tr20/)
  fs.writeFileSync(path.join(ws, 'recibo2.txt'), Array.from({ length: 60 }, (_, i) => `r${i + 1}`).join('\n'))
  assert.match(call(a, 'read_file_range', { path: 'recibo2.txt', startLine: 20, endLine: 25, readToken: t2 }).text, /\n20\tr20/) // mesmo intervalo, OUTRO arquivo
  // arquivo alterado: hash novo, leitura volta inteira e emite recibo novo
  fs.appendFileSync(file, '\nmais')
  const changed = rd(a, { startLine: 20, endLine: 25, readToken: t2 }).text
  assert.match(changed, /\n20\tr20/); assert.ok(tok(changed) && tok(changed) !== t2)
  // reinicio: sem recibos em memoria a leitura e normal
  dropReceipts(a.auth.authId)
  assert.equal(receiptCount(a.auth.authId), 0)
  assert.match(rd(a, { startLine: 20, endLine: 25, readToken: tok(changed) }).text, /\n20\tr20/)
  // entrega truncada/cortada nao gera recibo reutilizavel; o limite por sessao descarta os mais antigos
  fs.writeFileSync(path.join(ws, 'longa.txt'), `${'x'.repeat(2500)}\ncurta`)
  const longa = call(a, 'read_file_range', { path: 'longa.txt' }).text
  assert.match(longa, /linhas acima de 2000 caracteres foram cortadas/); assert.equal(tok(longa), undefined)
  fs.writeFileSync(path.join(ws, 'grande2.txt'), Array.from({ length: 1000 }, (_, i) => `g${i}`).join('\n'))
  const trunc = call(a, 'read_file_range', { path: 'grande2.txt', startLine: 1, endLine: 1000 }).text
  assert.match(trunc, /TRUNCADO em 400/); assert.equal(tok(trunc), undefined)
  for (let i = 1; i <= 70; i++) rd(a, { startLine: i, endLine: i })
  assert.ok(receiptCount(a.auth.authId) <= 64)
  // escopo continua valendo: caminho fora dele e recusado mesmo com token
  assert.equal(call({ ...a, scope: ['src/player'] }, 'read_file_range', { path: 'recibo.txt', readToken: t2 }).isError, true)
})

test('resumo de testes so de formatos conhecidos; desconhecido fica rotulado', () => {
  assert.equal(summarizeTestOutput('# tests 12\n# pass 11\n# fail 1\n')!.summary, '12 testes, 11 passaram, 1 falharam')
  assert.equal(summarizeTestOutput('ℹ tests 108\nℹ suites 0\nℹ pass 108\nℹ fail 0\n')!.summary, '108 testes, 108 passaram, 0 falharam')
  assert.match(summarizeTestOutput('Tests:       1 failed, 5 passed, 6 total')!.summary, /1 failed, 5 passed/)
  assert.equal(summarizeTestOutput('=== 5 passed, 1 failed in 0.30s ===')!.format, 'pytest')
  assert.equal(summarizeTestOutput('a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2345: y')!.summary, '2 erro(s) de tipo')
  assert.equal(summarizeTestOutput('todos ok!'), null)
})

// Fase 3: pular um teste so com execucao OBSERVADA, de sucesso, comando/cwd exatos, dependencias completas e inalteradas. Relato do agente nunca basta.
test('evidencia de teste: relato do agente e consultavel mas nunca dispensa o teste; o endpoint do agente nao declara execucao observada', () => {
  const t = createTask(db, ws, 'ev')
  const c = { taskId: t, lineage: 'del:3', grantId: grantOf(t, rcp('del:3')).authId, cwd: ws, owner: 'delegation' as const, originId: 3 }
  const r = recordTestEvidence(db, c, { command: 'npm test', exitCode: 0, output: '# tests 3\n# pass 3\n# fail 0\n', durationMs: 900, inputs: ['src/main.ts'], hermetic: true, env: 'win32 node26' })
  assert.match(r.summary, /node:test\/TAP: 3 testes/); assert.equal(r.source, 'agent_reported')
  assert.equal((db.prepare('SELECT content FROM artifacts WHERE id=?').get(r.artifactId) as any).content, '# tests 3\n# pass 3\n# fail 0\n') // saida completa guardada
  const lk = lookupTestEvidence(db, c, { command: 'npm test', env: 'win32 node26' })
  assert.equal(lk.reusable, false); assert.equal(lk.evidenceSource, 'agent_reported'); assert.equal(lk.dependenciesUnchanged, true) // consultavel e informativo
  assert.match(lk.reason, /apenas RELATADA pelo agente[\s\S]*nao autoriza pular/)
  // o agente nao consegue se declarar "observado": campo source (ou qualquer outro) enviado pelo endpoint e ignorado
  const viaTool = call(child, 'test_evidence', { action: 'record', command: 'npm run x', exitCode: 0, output: 'ok', hermetic: true, env: 'e', inputs: ['src/player'], source: 'executor_observed', reusable: true, evidenceSource: 'executor_observed' })
  assert.match(viaTool.text, /"source":"agent_reported"/); assert.match(viaTool.text, /formato de saida desconhecido/) // formato desconhecido rotulado
  const via = JSON.parse(call(child, 'test_evidence', { action: 'lookup', command: 'npm run x', env: 'e' }).text)
  assert.deepEqual([via.reusable, via.evidenceSource], [false, 'agent_reported'])
  assert.equal(call(child, 'test_evidence', { action: 'x', command: 'c' }).isError, true)
  assert.equal(call(parent, 'test_evidence', { action: 'lookup', command: 'npm test' }).isError, true) // so o filho
  // evidencia de outra linhagem/sessao nao serve
  assert.match(lookupTestEvidence(db, { ...c, lineage: 'del:99', grantId: grantOf(t, rcp('del:99')).authId }, { command: 'npm test', env: 'win32 node26' }).reason, /nenhuma evidencia/)
  assert.match(lookupTestEvidence(db, { ...c, grantId: grantOf(t, rcp('del:3')).authId }, { command: 'npm test', env: 'win32 node26' }).reason, /nenhuma evidencia/)
})

test('evidencia observada: reuso exige comando e cwd exatos, dependencias reenumeradas (adicao/remocao/renomeacao), lockfiles, sucesso, hermetico e ambiente', () => {
  const evws = path.join(tmp, 'evws')
  fs.mkdirSync(path.join(evws, 'src'), { recursive: true }); fs.mkdirSync(path.join(evws, 'outro'), { recursive: true })
  const w = (rel: string, txt: string) => fs.writeFileSync(path.join(evws, rel), txt)
  w('src/a.test.ts', 'a'); w('src/b.ts', 'b'); w('package.json', '{}'); w('package-lock.json', '{"v":1}'); w('outro/x.ts', 'x')
  const t = createTask(db, evws, 'obs')
  const c = { taskId: t, lineage: 'del:5', grantId: grantOf(t, rcp('del:5')).authId, cwd: evws, owner: 'delegation' as const, originId: 5 }
  const ENV = 'win32 node26'
  const rec = (over: any = {}, source: 'agent_reported' | 'executor_observed' = 'executor_observed') =>
    recordTestEvidence(db, c, { command: 'npm test', exitCode: 0, output: '# tests 3\n# pass 3\n# fail 0\n', inputs: ['src'], hermetic: true, env: ENV, ...over }, source)
  const lk = (over: any = {}) => lookupTestEvidence(db, c, { command: 'npm test', env: ENV, ...over })
  const first = rec()
  assert.equal(first.dependencies, 4) // src/a.test.ts, src/b.ts + package.json e package-lock.json (configuracoes/lockfiles entram sozinhos)
  assert.deepEqual([lk().reusable, lk().evidenceSource], [true, 'executor_observed']) // caminho completo e conservador
  // comando e ambiente EXATOS
  for (const command of ['NPM test', 'npm  test', 'npm test --silent', 'npm t', 'npm test é'])
    assert.match(lk({ command }).reason, /nenhuma evidencia registrada para este comando exato/, command)
  assert.equal(lk({ command: '  npm test  ' }).reusable, true) // so as pontas do texto sao aparadas, nunca o miolo dos argumentos
  assert.match(lk({ env: 'linux' }).reason, /ambiente/); assert.match(lk({ env: undefined }).reason, /ambiente/)
  // cwd real: o mesmo comando em outra pasta nao serve
  assert.match(lookupTestEvidence(db, { ...c, cwd: path.join(evws, 'src') }, { command: 'npm test', env: ENV }).reason, /nenhuma evidencia registrada para este comando exato neste diretorio/)
  // arquivo NOVO na pasta declarada, removido, renomeado e alterado: todos invalidam
  const mut = (name: string, f: () => void, undo: () => void, re: RegExp) => { f(); const r = lk(); assert.equal(r.reusable, false, name); assert.match(r.reason, re, name); undo(); assert.equal(lk().reusable, true, `${name}: restaurado`) }
  mut('teste novo', () => w('src/c.test.ts', 'novo'), () => fs.rmSync(path.join(evws, 'src/c.test.ts')), /dependencias mudaram \(\+src\/c\.test\.ts\)/)
  mut('removido', () => fs.renameSync(path.join(evws, 'src/b.ts'), path.join(tmp, 'b.tmp')), () => fs.renameSync(path.join(tmp, 'b.tmp'), path.join(evws, 'src/b.ts')), /-src\/b\.ts/)
  mut('renomeado', () => fs.renameSync(path.join(evws, 'src/b.ts'), path.join(evws, 'src/b2.ts')), () => fs.renameSync(path.join(evws, 'src/b2.ts'), path.join(evws, 'src/b.ts')), /\+src\/b2\.ts[\s\S]*-src\/b\.ts/)
  mut('conteudo', () => w('src/b.ts', 'B!'), () => w('src/b.ts', 'b'), /~src\/b\.ts/)
  mut('lockfile alterado', () => w('package-lock.json', '{"v":2}'), () => w('package-lock.json', '{"v":1}'), /~package-lock\.json/)
  mut('configuracao nova (tsconfig)', () => w('tsconfig.json', '{}'), () => fs.rmSync(path.join(evws, 'tsconfig.json')), /\+tsconfig\.json/)
  mut('lockfile removido', () => fs.renameSync(path.join(evws, 'package-lock.json'), path.join(tmp, 'lock.tmp')), () => fs.renameSync(path.join(tmp, 'lock.tmp'), path.join(evws, 'package-lock.json')), /reenumeradas|-package-lock/)
  w('outro/x.ts', 'fora das raizes declaradas'); assert.equal(lk().reusable, true) // fora das raizes e nao configuracao: nao invalida
  // evidencia de falha, com rede, nao hermetica, sem dependencias declaradas ou raiz inexistente: nunca dispensa o teste, mas fica registrada
  const t2 = createTask(db, evws, 'obs2'); const c2 = { ...c, taskId: t2, grantId: grantOf(t2, rcp('del:5')).authId }
  const other = (over: any) => { recordTestEvidence(db, c2, { command: 'x', exitCode: 0, output: 'boom', env: 'e', hermetic: true, inputs: ['src'], ...over }, 'executor_observed'); return lookupTestEvidence(db, c2, { command: 'x', env: 'e' }) }
  assert.match(other({ exitCode: 1 }).reason, /FALHOU/)
  assert.match(other({ network: true }).reason, /rede\/externo/); assert.match(other({ hermetic: false }).reason, /hermetico/)
  assert.match(other({ inputs: [] }).reason, /sem cobertura completa das dependencias \(nenhuma dependencia declarada\)/)
  const gone = other({ inputs: ['nao-existe'] }); assert.equal(gone.reusable, false); assert.match(gone.reason, /sem cobertura completa/)
  assert.ok((db.prepare("SELECT COUNT(*) n FROM memory_items WHERE task_id=? AND kind='validation'").get(t2) as any).n >= 5) // a evidencia (inclusive de falha) foi preservada
  // relato do agente sobre o MESMO comando nao vira observado, e o registro legado (sem fonte) fica desconhecido
  rec({ command: 'npm run lint' }, 'agent_reported'); assert.match(lk({ command: 'npm run lint' }).reason, /RELATADA/)
  addMemory(db, { taskId: t, owner: 'delegation', lineage: 'del:5', grantId: c.grantId, kind: 'validation', title: 'Teste legado', content: 'x',
    evidence: { files: [], test: { command: 'npm run legado', cwd: '.', exitCode: 0, hermetic: true, network: false, env: ENV, summary: 's' } } })
  assert.match(lk({ command: 'npm run legado' }).reason, /nenhuma evidencia registrada/) // cwd '.' antigo nao casa com o diretorio real
})

test('checkpoint deterministico reune objetivo, restricoes, decisoes, pendencias e proxima acao sem apagar nada', () => {
  const t = createTask(db, ws, 'cp')
  const L = 'chat:5:codex:'
  const add = (kind: string, title: string, extra: any = {}) => addMemory(db, { taskId: t, owner: 'run', lineage: L, kind, title, content: `c ${title}`, ...extra }).id
  assert.equal(buildCheckpoint(db, t, L), null) // nada registrado: sem checkpoint vazio
  add('objective', 'Fase 1'); add('constraint', 'Sem rede'); add('decision', 'Usar JSON'); add('validation', 'Testes ok'); add('finding', 'achado x')
  const t1 = add('todo', 'passo 1'); const t2 = add('todo', 'passo 2', { deps: [t1] })
  const id = buildCheckpoint(db, t, L)!
  const m = getMemory(db, t, id)!
  assert.match(m.content, /Objetivo:\n- m:\d+ Fase 1[\s\S]*Restricoes:[\s\S]*Decisoes:[\s\S]*Evidencias \(validacoes\):[\s\S]*Pendencias:[\s\S]*Descobertas registradas: 1[\s\S]*Proxima acao: m:\d+ passo 1/)
  setTodoState(db, t, t1, 'done')
  const id2 = buildCheckpoint(db, t, L)!
  assert.match(getMemory(db, t, id2)!.content, new RegExp(`Proxima acao: m:${t2} passo 2`))
  assert.equal(getMemory(db, t, id)!.state, 'superseded') // o anterior continua no banco
  for (let i = 0; i < 80; i++) add('decision', `Decisao numero ${i} com titulo razoavelmente longo para estourar o limite`)
  const big = getMemory(db, t, buildCheckpoint(db, t, L)!)!
  assert.ok(big.content.length <= 4000); assert.match(big.content, /linhas omitidas: consulte o indice/)
})

test('historico entre provedores: pedido de aprovacao, nada enviado antes, recusa sem insistencia, entrega so do aprovado e uma vez', () => {
  const t = createTask(db, ws, 'hist')
  const R2: Recipient = { logicalId: `chat:${t}:codex:`, provider: 'codex', profile: '', model: 'gpt-6-luna', effort: null, workspace: ws, scope: [] }
  const cand = { body: 'Usuario: oi\n\nAgente (claude): ola', count: 2 }
  const p1 = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: cand })
  assert.equal(p1.created, true); assert.equal(p1.deliver.length, 0) // nada segue antes da aprovacao
  assert.equal(p1.pending!.source, 'history'); assert.match(p1.pending!.items[0].content, /Agente \(claude\): ola/)
  const again = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: cand })
  assert.deepEqual([again.created, again.pending?.id, again.deliver.length], [false, p1.pending!.id, 0]) // mesmo pedido: nao duplica
  resolvePackage(db, { id: p1.pending!.id, hash: p1.pending!.hash, decision: 'reject' })
  const rej = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: cand })
  assert.deepEqual([rej.created, rej.pending, rej.deliver.length], [false, undefined, 0]) // recusado: sem insistencia
  // novo conteudo -> novo pedido; aprovado e entregue uma unica vez, apenas ao destino aprovado
  const cand2 = { body: 'Usuario: mais uma', count: 1 }
  const p2 = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: cand2 }).pending!
  resolvePackage(db, { id: p2.id, hash: p2.hash, decision: 'approve' })
  const ready = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: null })
  assert.deepEqual(ready.deliver.map(d => d.pkg.id), [p2.id])
  assert.equal(planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: { ...R2, model: 'gpt-5.5' }, sessionId: null, candidate: null }).deliver.length, 0) // modelo trocado: novo pedido
  assert.equal(planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: { ...R2, profile: '2' }, sessionId: null, candidate: null }).deliver.length, 0)
  const d1 = recordDelivery(db, ready.deliver[0].pkg, '', ready.deliver[0].items)
  assert.equal(planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: null, candidate: null }).deliver[0].uncertain, true) // enviado sem confirmacao
  finishDelivery(db, d1, 'confirmed', 'sess-1')
  assert.equal(planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: 'sess-1', candidate: null }).deliver.length, 0) // uma vez so
  // historico gigante: pedido nao criado, explicacao
  const huge = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R2, sessionId: 'sess-1', candidate: { body: 'x'.repeat(7000), count: 9 } })
  assert.match(huge.error!, /excede os limites/); assert.equal(huge.created, false)
})

test('historico transferido nao carrega marcadores de ferramenta nem avisos como se fossem descobertas', () => {
  const t = createTask(db, ws, 'ctx')
  const ins = (role: string, text: string, provider: string | null, clean: string | null = null) =>
    db.prepare("INSERT INTO messages (chat_key, role, text, task_id, provider, status, clean) VALUES (?,?,?,?,?,?,?)").run(`task:${t}`, role, text, t, provider, role === 'agent' ? 'completed' : null, clean)
  ins('user', 'faca X', null)
  ins('agent', 'Vou ver.\n\n`> rg -n foo src`\n\nAchei o bug em a.ts.\n\n`> npm test`\n\n> Acoes negadas pela protecao do Claude: Bash.', 'claude')
  ins('agent', 'resposta limpa', 'gemini', 'resposta limpa (versao clean)')
  const c = contextFor(db, t, 'codex', null, false)!
  assert.ok(!/rg -n foo|npm test/.test(c.text)); assert.match(c.text, /Achei o bug em a\.ts/)
  assert.match(c.text, /resposta limpa \(versao clean\)/) // usa o campo clean quando existe
  assert.equal(stripActivity('a\n\n`> cmd`\n\nb\n_Execucao cancelada._'), 'a\n\nb')
  assert.match(c.body, /^Usuario: faca X/); assert.ok(!c.body.includes('[Contexto transferido'))
})

test('resumo curto de regras respeita o alvo de ~500 tokens; entrada do filho segue ordem estavel e sem ids no prefixo', () => {
  assert.ok(briefTokens({ memoryTools: true, workspaceTools: true }) <= DEFAULT_LIMITS.checklistTokens, `${briefTokens({ memoryTools: true, workspaceTools: true })} tokens estimados`)
  assert.ok(!/find_in_workspace|read_task_context/.test(runtimeBrief({ memoryTools: false, workspaceTools: false }))) // nao promete ferramenta inexistente
  const mk = (id: number) => buildChildInput({ mode: 'read', scope: [], objective: 'OBJ', brief: runtimeBrief({ memoryTools: true, workspaceTools: false }), packageText: 'PACOTE', delegationId: id })
  const a = mk(1), b = mk(99)
  const cut = (s: string) => s.slice(0, s.indexOf('Ordem direta'))
  assert.equal(cut(a), cut(b)) // prefixo identico entre delegacoes (favorece cache onde existir)
  assert.ok(a.indexOf('Ordem direta') < a.indexOf('PACOTE') && a.indexOf('PACOTE') < a.indexOf('[Delegacao #1]'))
  assert.deepEqual(normalizeLimits({ packageChars: 1, conclusionChars: 'x', queryResults: 999 }), { ...DEFAULT_LIMITS, packageChars: 500, queryResults: 50 })
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('ferramentas do filho: Claude sem busca duplicada; escopo em leitura so pelo MCP; outros provedores inalterados', () => {
  const names = (x: { mcp: { name: string }[] }) => x.mcp.map(t => t.name)
  const all = toolsFor('child').map(t => t.name)
  assert.deepEqual(childToolset('codex', 'read', []), { mcp: toolsFor('child') })
  assert.deepEqual(childToolset('opencode', 'edit', ['src']).native, undefined)
  const r = childToolset('claude', 'read', [])
  assert.deepEqual([names(r).includes('find_in_workspace'), names(r).includes('read_file_range'), names(r).includes('test_evidence'), r.native], [false, true, false, ['Grep', 'Glob']])
  const scoped = childToolset('claude', 'read', ['src/player'])
  assert.deepEqual([names(scoped), scoped.native], [all.filter(n => n !== 'test_evidence'), []]) // escopo: nenhuma nativa (elas nao respeitam o escopo)
  const e = childToolset('claude', 'edit', [])
  assert.deepEqual([names(e).includes('find_in_workspace'), names(e).includes('test_evidence'), e.native], [false, true, undefined]) // edicao: nativas padrao (Edit exige o Read nativo) e roda testes
})

test('recibos: sessoes mais antigas sao descartadas acima do limite; a usada recentemente fica', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-rc-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\ny')
  readFileRange({ cwd: dir, session: 's-0' }, { path: 'a.txt' })
  readFileRange({ cwd: dir, session: 's-1' }, { path: 'a.txt' })
  for (let i = 2; i < 201; i++) { readFileRange({ cwd: dir, session: `s-${i}` }, { path: 'a.txt' }); if (i === 100) readFileRange({ cwd: dir, session: 's-1' }, { path: 'a.txt', startLine: 2 }) }
  assert.equal(receiptCount('s-0'), 0) // a mais antiga saiu
  assert.ok(receiptCount('s-1') > 0 && receiptCount('s-200') > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('read_file_range respeita queryChars sem esconder linhas ou emitir recibo para leitura incompleta', () => {
  fs.writeFileSync(path.join(ws, 'budget.txt'), Array.from({ length: 12 }, (_, i) => 'linha ' + (i + 1) + ' ' + 'x'.repeat(90)).join('\n'))
  const c = { ...child, scope: [] }
  const limits = { ...DEFAULT_LIMITS, queryChars: 250 }
  const first = callTaskTool(db, limits, c, 'read_file_range', { path: 'budget.txt', startLine: 1, endLine: 12 }) as ToolResult
  assert.equal(first.isError, false)
  const rows = first.text.split('\n').slice(1)
  assert.ok(rows.join('\n').length <= limits.queryChars)
  assert.equal(rows.length, 2)
  assert.match(first.text, /CORTADO no limite de tamanho: exibindo 1-2/)
  assert.doesNotMatch(first.text, /readToken rt_/)
  const next = callTaskTool(db, limits, c, 'read_file_range', { path: 'budget.txt', startLine: 3, endLine: 4 }) as ToolResult
  assert.match(next.text, /\n3\tlinha 3/)
  assert.match(next.text, /\n4\tlinha 4/)
  assert.match(next.text, /readToken rt_/)
  const tiny = callTaskTool(db, { ...limits, queryChars: 10 }, c, 'read_file_range', { path: 'budget.txt', startLine: 1, endLine: 1 }) as ToolResult
  assert.match(tiny.text, /nenhuma linha coube/)
  assert.doesNotMatch(tiny.text, /readToken rt_/)
})

test('find_in_workspace: regex catastrofica nao trava o app; raiz resolvida uma vez; resultado igual ao da varredura', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-find-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), `linha\n${'a'.repeat(40)}!\nfim ${i}\n`)
  const real = fs.realpathSync, calls = { n: 0 }
  t.mock.method(fs, 'realpathSync', (...a: any[]) => { calls.n++; return (real as any)(...a) })
  const ok = await findInWorkspace({ cwd: dir }, { pattern: 'fim \\d+', regex: true, maxResults: 3 })
  assert.match(ok, /^40 ocorrencia\(s\) em 40 arquivo\(s\); mostrando 3 \(TRUNCADO/)
  assert.match(ok, /\nf00\.txt:3: fim 0\nf01\.txt:3: fim 1\nf02\.txt:3: fim 2$/)
  assert.ok(calls.n <= 3, `realpathSync chamado ${calls.n} vezes para 40 arquivos`)
  t.mock.restoreAll()
  let ticks = 0
  const timer = setInterval(() => ticks++, 20)
  const started = Date.now()
  try {
    const slow = await findInWorkspace({ cwd: dir }, { pattern: '(a+)+$', regex: true }, { budgetMs: 400 }) // exponencial em "aaa…a!"
    assert.match(slow, /^0 ocorrencia\(s\) em 0 arquivo\(s\)\nAVISO: busca interrompida no limite/)
  } finally { clearInterval(timer) }
  assert.ok(Date.now() - started < 5000); assert.ok(ticks >= 5, `event loop parado: ${ticks} ticks`)
  assert.match(await findInWorkspace({ cwd: dir }, { mode: 'list', glob: 'f0*.txt' }), /^10 arquivo\(s\)\nf00\.txt \(\d+ bytes\)/)
})
