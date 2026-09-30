// CLIs simuladas com eventos no formato de cada provedor. Nenhuma chamada paga.
// Prova a logica do executor e dos adaptadores; NAO prova o comportamento das CLIs reais.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS, safeArg } from './adapters.ts'
import { runChat, type ChatResult } from './runner.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-run-'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const script = path.join(tmp, 'fake.js')
fs.writeFileSync(script, `
const fs = require('fs'), cp = require('child_process')
const [mode, arg] = process.argv.slice(2)
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
let input = ''
process.stdin.on('data', d => input += d)
const done = fn => process.stdin.on('end', fn)
if (mode === 'echo-input') done(() => { out({ type: 'thread.started', thread_id: 't1' }); out({ type: 'item.completed', item: { type: 'agent_message', text: 'recebi:' + input } }); out({ type: 'turn.completed', usage: { input_tokens: 1 } }) })
if (mode === 'fragmented') done(() => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'uma resposta longa' } })
  process.stdout.write(line.slice(0, 20))
  setTimeout(() => { process.stdout.write(line.slice(20) + '\\n' + JSON.stringify({ type: 'turn.completed' })) }, 150) // ultimo evento SEM newline
})
if (mode === 'stdout-error') done(() => { out({ type: 'error', error: { name: 'UnknownError', data: { message: 'model not found' } } }); process.exit(1) })
if (mode === 'opencode-error') done(() => { out({ type: 'error', sessionID: 's1', error: { name: 'UnknownError', data: { message: 'Unexpected server error' } } }); process.exit(1) })
if (mode === 'opencode-generic-cause') done(() => {
  process.stderr.write('timestamp=2026-09-29T00:51:46.821Z level=ERROR run=x message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/x-preview-f-free. Did you mean: longcat-2.5-preview-free, mimo-v2.6-flash-free?)])"\\n')
  process.stderr.write('x'.repeat(5000) + ' pilha de chamadas longa\\n') // empurra a causa para fora do fim (tail) do stderr
  out({ type: 'error', sessionID: 's1', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1' } } }); process.exit(1)
})
if (mode === 'opencode-generic-only') done(() => { out({ type: 'error', sessionID: 's1', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.' } } }); process.exit(1) })
if (mode === 'stderr-ok') done(() => { process.stderr.write('auth required'); process.exit(0) })
if (mode === 'silent-ok') done(() => process.exit(0))
if (mode === 'many-tools') done(() => {
  out({ type: 'thread.started', thread_id: 't9' })
  for (let i = 1; i <= 5; i++) out({ type: 'item.started', item: { type: 'command_execution', command: 'cmd' + i } })
  setTimeout(() => {}, 60000) // sem o teto, ficaria rodando
})
if (mode === 'codex-activity') done(() => {
  out({ type: 'thread.started', thread_id: 't7' })
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Vou olhar o arquivo.' } })
  out({ type: 'item.started', item: { type: 'command_execution', command: 'rg -n foo src' } })
  out({ type: 'error', message: 'Reconnecting... 1/5' })
  out({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Achei: o bug esta em a.ts.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4 } })
})
if (mode === 'claude-explicit') done(() => {
  out({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'comentario intermediario' }, { type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10 } } })
  out({ type: 'result', session_id: 's1', result: 'RESPOSTA FINAL EXPLICITA', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } })
})
if (mode === 'opencode-dup-step') done(() => {
  const step = { type: 'step_finish', sessionID: 's2', part: { id: 'prt_1', reason: 'tool-calls', tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 50, write: 5 } } } }
  out({ type: 'text', sessionID: 's2', part: { text: 'passo 1' } })
  out(step); out(step) // o mesmo passo emitido duas vezes: conta uma so
  out({ type: 'step_finish', sessionID: 's2', part: { id: 'prt_2', reason: 'stop', tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 60, write: 0 } } } })
})
if (mode === 'early-exit') { process.stderr.write('bad flag'); process.exit(2) }
if (mode === 'partial-fail') done(() => { out({ type: 'item.completed', item: { type: 'agent_message', text: 'resposta parcial' } }); process.stderr.write('conexao caiu'); process.exit(3) })
if (mode === 'codex-fail') done(() => {
  out({ type: 'thread.started', thread_id: 't9' }); out({ type: 'error', message: 'Reconnecting... 1/5' })
  out({ type: 'turn.failed', error: { message: 'stream disconnected' } }); process.exit(1)
})
if (mode === 'codex-soft-only') done(() => { out({ type: 'error', message: 'Reconnecting... 1/5' }); process.exit(1) })
if (mode === 'hang-tree') {
  const kid = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  fs.writeFileSync(arg, String(kid.pid))
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'antes de travar' } })
  setInterval(() => {}, 1000)
}
`)

const run = (mode: string, over: Record<string, any> = {}) =>
  runChat({ cmd: process.execPath, args: [script, mode, over.arg ?? ''], cwd: tmp, input: over.input ?? 'oi', parse: AGENTS[over.agent ?? 'codex'].parse, ...over.opts })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('a mensagem vai pelo stdin e a sessao/uso/conclusao chegam como eventos', async () => {
  const sessions: string[] = [], live: any[] = []
  const r = await run('echo-input', { input: 'ola "mundo" & echo perigoso %PATH%', opts: { onSession: (id: string) => sessions.push(id), onMetric: (m: any) => live.push(m) } }).result
  assert.equal(r.status, 'completed')
  assert.equal(r.text, 'recebi:ola "mundo" & echo perigoso %PATH%') // texto do usuario intacto, sem passar por shell
  assert.deepEqual(sessions, ['t1'])
  assert.deepEqual([r.metric?.consumedIn, r.metric?.scope], [1, 'thread'])
  assert.deepEqual(live, [r.metric]) // medidor ao vivo recebe a mesma medida que fica gravada no fim
})

test('JSON fragmentado entre chunks e ultimo evento sem newline sao tratados', async () => {
  const r = await run('fragmented').result
  assert.equal(r.status, 'completed')
  assert.equal(r.text, 'uma resposta longa')
})

test('erro so no stdout (opencode) vira falha com mensagem, nao erro em branco', async () => {
  const r = await run('opencode-error', { agent: 'opencode' }).result
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /Unexpected server error/)
  assert.equal(r.session, 's1')
})

test('evento de erro do codex no stdout vira falha com a mensagem do turno', async () => {
  const r = await run('codex-fail').result
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /stream disconnected/) // turn.failed vence o "Reconnecting..." transitorio
  const s = await run('codex-soft-only').result
  assert.equal(s.status, 'failed')
  assert.match(s.error!, /Reconnecting/) // sem turn.failed: usa o ultimo erro transitorio
})

test('codigo 0 so com stderr ou sem resposta NAO e sucesso', async () => {
  const a = await run('stderr-ok').result
  assert.equal(a.status, 'failed')
  assert.match(a.error!, /auth required/)
  assert.equal(a.category, 'auth')
  const b = await run('silent-ok').result
  assert.equal(b.status, 'failed')
  assert.equal(b.category, 'protocol')
})

test('resposta parcial e preservada junto do estado de falha', async () => {
  const r = await run('partial-fail').result
  assert.equal(r.status, 'failed')
  assert.equal(r.text, 'resposta parcial')
  assert.match(r.error!, /conexao caiu/)
  assert.equal(r.code, 3)
})

test('CLI que sai antes de ler um stdin grande nao derruba o processo', async () => {
  process.once('uncaughtException', () => assert.fail('excecao nao tratada'))
  const r = await run('early-exit', { input: 'x'.repeat(3_000_000) }).result
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /bad flag/)
  process.removeAllListeners('uncaughtException')
})

test('executavel inexistente vira falha de comando', async () => {
  const r = await runChat({ cmd: 'cli-que-nao-existe-xyz', args: [], cwd: tmp, input: 'x', parse: () => [] }).result
  assert.equal(r.status, 'failed')
  assert.equal(r.category, 'command')
})

test('cancelar encerra o processo E os descendentes e devolve o texto parcial como cancelado', async () => {
  const pidFile = path.join(tmp, 'kid.pid')
  const run1 = run('hang-tree', { arg: pidFile })
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8')) await sleep(50)
  await sleep(300)
  const kid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(alive(kid))
  run1.cancel()
  const r: ChatResult = await run1.result
  assert.equal(r.status, 'cancelled')
  assert.equal(r.text, 'antes de travar')
  await sleep(500)
  assert.ok(!alive(kid), 'o processo descendente deveria ter sido encerrado')
})

test('cancelar antes de o processo iniciar tambem termina como cancelado', async () => {
  const h = run('hang-tree', { arg: path.join(tmp, 'kid2.pid') })
  h.cancel()
  assert.equal((await h.result).status, 'cancelled')
})

// ---- Adaptadores: eventos de amostra (formatos conferidos nas versoes instaladas) ----
test('claude: texto, ferramenta, sessao, negacao de permissao e erro', () => {
  const p = AGENTS.claude.parse
  assert.deepEqual(p({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'oi' }, { type: 'tool_use', name: 'Bash' }] } }),
    [{ kind: 'session', id: 's' }, { kind: 'text', text: 'oi' }, { kind: 'tool', name: 'Bash' }])
  const res = p({ type: 'result', is_error: false, result: 'fim', permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }] })
  assert.equal(res[0].kind, 'note')
  assert.match((res[0] as any).text, /Bash/)
  assert.deepEqual(res[1], { kind: 'done', text: 'fim' })
  assert.deepEqual(p({ type: 'result', is_error: true, result: 'Credit balance is too low' }), [{ kind: 'error', message: 'Credit balance is too low', fatal: true }])
})

test('gemini: deltas concatenam sem separador; erro warning nao e fatal; resultado com erro e fatal', () => {
  const p = AGENTS.gemini.parse
  assert.deepEqual(p({ type: 'init', session_id: 'g1' }), [{ kind: 'session', id: 'g1' }])
  assert.deepEqual(p({ type: 'message', role: 'assistant', content: 'ol', delta: true }), [{ kind: 'text', text: 'ol', delta: true }])
  assert.deepEqual(p({ type: 'message', role: 'user', content: 'eco' }), [])
  assert.equal((p({ type: 'error', severity: 'warning', message: 'x' })[0] as any).fatal, false)
  assert.equal((p({ type: 'error', severity: 'error', message: 'x' })[0] as any).fatal, true)
  assert.equal((p({ type: 'result', status: 'error' })[0] as any).fatal, true)
})

test('gemini: streaming em deltas vira texto continuo', async () => {
  const gscript = path.join(tmp, 'gem.js')
  fs.writeFileSync(gscript, `process.stdin.resume(); process.stdin.on('end', () => { for (const c of ['Ol', 'a, ', 'mundo']) console.log(JSON.stringify({ type: 'message', role: 'assistant', content: c, delta: true })); console.log(JSON.stringify({ type: 'result', status: 'success' })) })`)
  const r = await runChat({ cmd: process.execPath, args: [gscript], cwd: tmp, input: 'x', parse: AGENTS.gemini.parse }).result
  assert.equal(r.text, 'Ola, mundo')
})

test('retomada usa o id exato da sessao (nunca latest) e recusa ids suspeitos', () => {
  assert.deepEqual(AGENTS.gemini.chatArgs('abc-123').slice(-2), ['--resume', 'abc-123'])
  assert.ok(!AGENTS.gemini.chatArgs('abc-123').includes('latest'))
  assert.deepEqual(AGENTS.gemini.resumeArgs('abc-123'), ['--resume', 'abc-123'])
  assert.deepEqual(AGENTS.codex.chatArgs('t1').slice(-3), ['resume', 't1', '-'])
  assert.ok(AGENTS.codex.chatArgs().includes('--skip-git-repo-check'))
  for (const a of Object.values(AGENTS)) assert.throws(() => a.chatArgs('x & calc'), /nao permitidos/)
  assert.throws(() => safeArg('a"b'), /nao permitidos/)
})

test('codex e opencode: sessao, texto, ferramenta e erros', () => {
  const c = AGENTS.codex.parse
  assert.deepEqual(c({ type: 'thread.started', thread_id: 'th' }), [{ kind: 'session', id: 'th' }])
  assert.deepEqual(c({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }), [{ kind: 'tool', name: 'ls' }])
  assert.equal((c({ type: 'error', message: 'Reconnecting... 1/5' })[0] as any).fatal, false)
  assert.equal((c({ type: 'turn.failed', error: { message: 'x' } })[0] as any).fatal, true)
  const o = AGENTS.opencode.parse
  assert.deepEqual(o({ type: 'text', sessionID: 'ses', part: { text: 'oi' } }), [{ kind: 'session', id: 'ses' }, { kind: 'text', text: 'oi' }])
  assert.deepEqual(o({ type: 'step_finish', sessionID: 'ses', part: { reason: 'tool-calls' } }), [{ kind: 'session', id: 'ses' }])
  assert.equal((o({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1 } } })[1] as any).kind, 'done')
})

test('resultado de ferramenta: Claude marca is_error, Codex informa exit code; sem informacao fica null', () => {
  const cl = AGENTS.claude.parse
  assert.deepEqual(cl({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } })[0], { kind: 'tool', name: 'Bash', detail: 'npm test', ref: 'tu1' })
  assert.deepEqual(cl({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'Exit code 1' }] }] } }),
    [{ kind: 'toolResult', ref: 'tu1', ok: false, output: 'Exit code 1' }])
  assert.equal((cl({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } })[0] as any).ok, null)
  const cx = AGENTS.codex.parse
  assert.deepEqual(cx({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'ℹ tests 3' } }),
    [{ kind: 'toolResult', ref: 'i1', ok: true, output: 'ℹ tests 3' }])
  assert.equal((cx({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'x' } })[0] as any).ok, null)
})

test('resposta, atividade e estado separados: o texto de chat continua igual, o resto e recuperavel', async () => {
  const r = await run('codex-activity').result
  assert.equal(r.status, 'completed')
  assert.deepEqual(r.messages, ['Vou olhar o arquivo.', 'Achei: o bug esta em a.ts.']) // so texto do agente, sem marcadores
  assert.deepEqual(r.tools, ['rg -n foo src', 'npm test'])
  assert.match(r.text, /`> rg -n foo src`/) // a visao de chat mantem a atividade visivel
  assert.equal(r.answer, 'Achei: o bug esta em a.ts.')
  assert.equal(r.answerBasis, 'limited') // o codex nao marca a resposta final: extracao rotulada como limitada
  assert.equal(r.retries, 1) // o "Reconnecting" transitorio foi contado, nao virou falha
  assert.ok(r.durationMs! >= 0)
  assert.deepEqual([r.metric?.consumedIn, r.metric?.cacheRead, r.metric?.reasoning, r.metric?.reasoningIncluded], [100, 40, 4, true])
  const c = await run('claude-explicit', { agent: 'claude' }).result
  assert.equal(c.answer, 'RESPOSTA FINAL EXPLICITA'); assert.equal(c.answerBasis, 'explicit')
  assert.deepEqual(c.messages, ['comentario intermediario']); assert.deepEqual(c.tools, ['Read'])
  assert.deepEqual([c.metric?.consumedIn, c.metric?.cacheRead, c.metric?.cacheReadIncluded], [10, 90, false])
})

test('opencode: erro generico do provedor e trocado pela causa real do stderr (modelo inexistente vira config)', async () => {
  const r = await run('opencode-generic-cause', { agent: 'opencode' }).result
  assert.equal(r.status, 'failed')
  assert.match(r.error!, /^ProviderModelNotFoundError: Model not found: opencode\/x-preview-f-free\. Did you mean: longcat-2\.5-preview-free/)
  assert.ok(!/Unexpected server error/.test(r.error!))
  assert.equal(r.category, 'config') // acionavel: corrigir o modelo, nao "causa nao classificada"
  const g = await run('opencode-generic-only', { agent: 'opencode' }).result // sem causa no stderr: mantem a mensagem do provedor
  assert.match(g.error!, /Unexpected server error/)
  const args = AGENTS.opencode.chatArgs('ses_1', { model: 'a/b' })
  assert.deepEqual(args.slice(0, 6), ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR']) // logs de erro no stderr, stdout intacto
})

test('passo de consumo repetido (mesmo id) conta uma vez; passos distintos somam; raciocinio segue separado', async () => {
  const r = await run('opencode-dup-step', { agent: 'opencode' }).result
  assert.equal(r.status, 'completed')
  assert.deepEqual([r.metric?.consumedIn, r.metric?.consumedOut, r.metric?.reasoning, r.metric?.cacheRead, r.metric?.cacheWrite], [300, 30, 2, 110, 5])
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('teto de ferramentas pausa a mensagem antes da ferramenta seguinte e mantem a sessao', async () => {
  const r = await run('many-tools', { opts: { maxTools: 3 } }).result
  assert.equal(r.status, 'cancelled'); assert.equal(r.paused, true)
  assert.deepEqual(r.tools, ['cmd1', 'cmd2', 'cmd3']) // a 4a nao entrou
  assert.equal(r.session, 't9')
  assert.match(r.notes.join(), /continuar/)
})

test('ferramenta do Claude traz o alvo curto (arquivo sem pasta, comando) para "o que o agente faz agora"', () => {
  const tool = (input: any) => AGENTS.claude.parse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'X', input }] } }).find(e => e.kind === 'tool') as any
  assert.equal(tool({ file_path: String.raw`C:\proj\src\Chat.tsx` }).detail, 'Chat.tsx')
  assert.equal(tool({ command: 'npm   test' }).detail, 'npm test')
  assert.equal(tool({}).detail, undefined)
})
