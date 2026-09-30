import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS } from './adapters.ts'
import { claudeModels, claudeName, getCatalog, parseClaudeHelp, parseOpencodeProviders, parseOpencodeVerbose, validateSelection, type Catalog } from './catalog.ts'
import { codexContextFromRollout, codexLimits, findRollout } from './codexSession.ts'
import { openDb } from './db.ts'
import { mergeMetric } from './runner.ts'
import { createTask, getMetric, getSel, saveMetric, saveSel } from './tasks.ts'

// Amostras sanitizadas de saidas reais das versoes instaladas (claude 2.1.284, opencode 1.18.31).
const CLAUDE_HELP = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session`
const OPENCODE_VERBOSE = `deepseek/deepseek-flash
{
  "id": "deepseek-flash",
  "name": "DeepSeek V4.1 Flash",
  "limit": { "context": 1000000, "output": 393216 },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
deepseek/deepseek-v4-pro
{
  "id": "deepseek-v4-pro",
  "name": "sem variantes",
  "limit": { "context": 200000, "output": 8000 }
}
`
const OPENCODE_AUTH = `┌  Credentials ~\\.local\\share\\opencode\\auth.json
│
●  DeepSeek api
│
●  OpenRouter api
│
└  2 credentials

┌  Environment
│
●  Google GOOGLE_API_KEY
│
└  1 environment variable`

test('claude: apelidos e niveis de esforco vem do --help', () => {
  assert.deepEqual(parseClaudeHelp(CLAUDE_HELP), { aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
  assert.deepEqual(parseClaudeHelp('texto sem as opcoes'), { aliases: [], efforts: [] }) // ausencia nao inventa nada
})

test('claude: ids completos com nome e versao; apelido rotulado como o mais recente', () => {
  const m = claudeModels(['sonnet'])
  assert.equal(m.find(x => x.id === 'claude-sonnet-5-5')?.label, 'Sonnet 5.5')
  assert.equal(m.find(x => x.id === 'claude-sonnet-5')?.label, 'Sonnet 5')
  assert.equal(m.at(-1)?.label, 'Sonnet (sempre o mais recente)')
  assert.equal(claudeName('claude-haiku-4-5'), 'Haiku 4.5')
  assert.equal(claudeName('opus'), 'opus') // apelido nao ganha versao inventada
})

test('opencode: modelos, variantes (esforco) e janela vem do catalogo nativo', () => {
  const m = parseOpencodeVerbose(OPENCODE_VERBOSE)
  assert.deepEqual(m.map(x => [x.id, x.efforts, x.contextWindow]), [['deepseek/deepseek-flash', ['low', 'high', 'max'], 1000000], ['deepseek/deepseek-v4-pro', [], 200000]])
  assert.deepEqual(parseOpencodeProviders(OPENCODE_AUTH).sort(), ['deepseek', 'google', 'opencode', 'openrouter'])
})

const codexCat: Catalog = {
  provider: 'codex', source: 'native', at: '', allowCustomModel: false, efforts: [],
  models: [{ id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-5.5', efforts: ['low', 'medium'] }]
}
const claudeCat: Catalog = { provider: 'claude', source: 'help', at: '', allowCustomModel: true, efforts: ['low', 'high'], models: [{ id: 'opus', efforts: null }] }
const geminiCat: Catalog = { provider: 'gemini', source: 'manual', at: '', allowCustomModel: true, efforts: [], models: [] }

test('validacao de modelo/esforco: nada incompativel e oferecido nem trocado em silencio', () => {
  assert.equal(validateSelection(codexCat, 'gpt-6-luna', 'high'), null)
  assert.equal(validateSelection(codexCat), null) // padrao do provedor
  assert.match(validateSelection(codexCat, 'modelo-que-nao-existe')!, /nao consta no catalogo/)
  assert.match(validateSelection(codexCat, 'gpt-5.5', 'high')!, /nao e suportado.*low, medium/)
  assert.match(validateSelection(codexCat, undefined, 'high')!, /Escolha um modelo/) // esforco depende do modelo
  assert.equal(validateSelection(claudeCat, undefined, 'high'), null) // claude: niveis gerais
  assert.match(validateSelection(claudeCat, 'opus', 'ultra')!, /nao e suportado/)
  assert.equal(validateSelection(claudeCat, 'claude-opus-5-5'), null) // id completo digitado (sem descoberta)
  assert.equal(validateSelection(geminiCat, 'gemini-2.5-flash'), null)
  assert.match(validateSelection(geminiCat, 'gemini-2.5-flash', 'high')!, /nao expoe esforco/) // so o que esta comprovado
  assert.match(validateSelection({ ...codexCat, models: [], error: 'app-server caiu' }, 'gpt-6-luna')!, /Catalogo de codex indisponivel/)
})

test('a configuracao escolhida chega ao provedor correto (flags por CLI)', () => {
  const o = { model: 'gpt-6-luna', effort: 'high' }
  assert.deepEqual(AGENTS.claude.chatArgs('s1', { model: 'opus', effort: 'max' }).slice(-6), ['--model', 'opus', '--effort', 'max', '--resume', 's1'])
  const cx = AGENTS.codex.chatArgs('t1', o)
  assert.deepEqual(cx.slice(cx.indexOf('-m')), ['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high', 'resume', 't1', '-'])
  assert.ok(cx.indexOf('-m') < cx.indexOf('resume')) // opcoes do exec ficam antes de `resume`
  assert.deepEqual(AGENTS.opencode.chatArgs(undefined, { model: 'deepseek/deepseek-flash', effort: 'max' }), ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR', '-m', 'deepseek/deepseek-flash', '--variant', 'max'])
  assert.deepEqual(AGENTS.gemini.chatArgs(undefined, { model: 'gemini-2.5-flash' }).slice(-2), ['-m', 'gemini-2.5-flash'])
  assert.ok(!AGENTS.gemini.chatArgs(undefined, { model: 'x', effort: 'high' }).includes('high')) // gemini nunca recebe esforco
  assert.ok(!AGENTS.claude.chatArgs().includes('--model')) // sem escolha: padrao da CLI, nada e injetado
  for (const a of Object.values(AGENTS)) assert.throws(() => a.chatArgs(undefined, { model: 'x & calc' }), /nao permitidos/)
})

test('medidas: contexto ocupado, janela e consumo sao campos separados; ausencia nao vira zero', () => {
  const p = AGENTS.claude.parse
  const a = p({ type: 'assistant', message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } } })
  assert.deepEqual(a[0], { kind: 'context', metric: { occupied: 105, source: 'usage da ultima mensagem do Claude' } })
  const r = p({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 300, output_tokens: 40 }, modelUsage: { 'claude-x': { contextWindow: 200000 } } })
  const ctx = r.find(e => e.kind === 'context') as any
  assert.deepEqual([ctx.metric.capacity, ctx.metric.consumedIn, ctx.metric.consumedOut, ctx.metric.occupied], [200000, 300, 40, undefined])
  assert.equal(p({ type: 'result', is_error: false, result: 'ok' }).filter(e => e.kind === 'context').length, 0) // sem dados: sem evento
  const codex = AGENTS.codex.parse({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } })[0] as any
  assert.equal(codex.metric.scope, 'thread')
  assert.equal(codex.metric.occupied, undefined) // exec nao informa contexto
  const oc = AGENTS.opencode.parse({ type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } } } })[0] as any
  assert.deepEqual([oc.metric.occupied, oc.metric.estimated, oc.metric.consumedOut, oc.metric.reasoning, oc.accumulate], [160, true, 20, 5, true])

  let m = mergeMetric(undefined, oc.metric, true)
  m = mergeMetric(m, { occupied: 300, consumedIn: 200, consumedOut: 10, estimated: true, source: 'passo 2' }, true)
  assert.deepEqual([m.occupied, m.consumedIn, m.consumedOut], [300, 300, 30]) // consumo soma, contexto = ultimo passo
})

test('medida guardada por sessao: mudar de modelo invalida contexto/janela anteriores', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-metric-'))
  const db = openDb(path.join(tmp, 'm.db'))
  const t = createTask(db, 'C:/g')
  assert.equal(getMetric(db, t, 'claude', '1'), null)
  saveMetric(db, t, 'claude', '1', 'opus', 'high', { occupied: 1000, capacity: 200000, source: 'a' })
  saveMetric(db, t, 'claude', '1', 'opus', 'high', { consumedIn: 5, consumedOut: 6, scope: 'run', source: 'b' }) // mesmo modelo: herda contexto e janela
  let g = getMetric(db, t, 'claude', '1')!
  assert.deepEqual([g.occupied, g.capacity, g.consumed_in, g.consumed_out, g.source], [1000, 200000, 5, 6, 'b'])
  saveMetric(db, t, 'claude', '1', 'sonnet', 'high', { consumedIn: 1, source: 'c' }) // outro modelo: nada herdado
  g = getMetric(db, t, 'claude', '1')!
  assert.deepEqual([g.model, g.occupied, g.capacity], ['sonnet', null, null]) // ausencia = NULL, nunca 0
  assert.equal(getSel(db, t), null)
  saveSel(db, t, { provider: 'codex', model: 'gpt-6-luna', effort: 'high' })
  assert.deepEqual(getSel(db, t), { provider: 'codex', model: 'gpt-6-luna', effort: 'high' })
  db.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
})

test('codex: limites de 5 h e semanal vem do rollout mais recente; janela reiniciada nao vira 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-codexlim-'))
  const now = Date.parse('2026-09-29T12:00:00Z'), sec = (iso: string) => Date.parse(iso) / 1000
  const write = (day: string, name: string, lines: object[]) => {
    const dir = path.join(home, 'sessions', '2026', '09', day)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  assert.equal(codexLimits(home, now), null) // sem sessoes: sem dado
  write('20', 'rollout-2026-09-20T10-00-00-a.jsonl', [{ timestamp: '2026-09-20T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 90, window_minutes: 300, resets_at: sec('2026-09-20T14:00:00Z') } } } }])
  write('29', 'rollout-2026-09-29T09-00-00-b.jsonl', [
    { timestamp: '2026-09-29T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: sec('2026-09-29T13:00:00Z') }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: sec('2026-10-02T00:00:00Z') } } } },
    { timestamp: '2026-09-29T09:05:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'fim' } },
  ])
  assert.deepEqual(codexLimits(home, now), { fiveHour: { utilization: 12.5, resets_at: '2026-09-29T13:00:00.000Z' }, sevenDay: { utilization: 40, resets_at: '2026-10-02T00:00:00.000Z' }, seenAt: '2026-09-29T09:00:00.000Z', expired: false })
  const later = codexLimits(home, Date.parse('2026-09-29T14:00:00Z'))
  assert.equal(later?.fiveHour, null) // janela de 5 h ja reiniciou: sem numero, nao 0
  assert.equal(later?.expired, true)
  // formato antigo: resets_in_seconds relativo ao evento
  write('29', 'rollout-2026-09-29T10-00-00-c.jsonl', [{ timestamp: '2026-09-29T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 7, window_minutes: 300, resets_in_seconds: 3600 } } } }])
  assert.deepEqual(codexLimits(home, now)?.fiveHour, null) // 10h + 1h ja passou das 12h
  // sessao mais nova sem rate_limits (so citado no texto): usa a anterior que tem
  write('29', 'rollout-2026-09-29T11-00-00-d.jsonl', [{ timestamp: '2026-09-29T11:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'rate_limits citado no texto' } }])
  assert.equal(codexLimits(home, Date.parse('2026-09-29T10:30:00Z'))?.fiveHour?.utilization, 7)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('codex: contexto vem do arquivo de sessao; formato diferente vira indisponivel', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-codex-'))
  const dir = path.join(home, 'sessions', '2026', '09', '28')
  fs.mkdirSync(dir, { recursive: true })
  const id = '0199aaaa-bbbb-cccc-dddd-eeeeffff0001'
  const file = path.join(dir, `rollout-2026-09-28T10-00-00-${id}.jsonl`)
  const line = (o: object) => JSON.stringify(o)
  fs.writeFileSync(file, [
    line({ type: 'event_msg', payload: { type: 'agent_message', message: 'texto com a palavra token_count no meio' } }),
    line({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9999 }, last_token_usage: { total_tokens: 1200, reasoning_output_tokens: 200 }, model_context_window: 272000 } } }),
    ''
  ].join('\n'))
  assert.equal(findRollout(id, home), file)
  assert.equal(findRollout('nao-existe-000', home), null)
  assert.equal(findRollout('../../etc', home), null) // id suspeito nao vira caminho
  assert.deepEqual(codexContextFromRollout(file), { occupied: 1000, capacity: 272000, estimated: true, source: 'arquivo de sessao do Codex (token_count; formato nao documentado)' })
  fs.writeFileSync(file, line({ type: 'event_msg', payload: { type: 'token_count', info: { formato: 'novo' } } }) + '\n')
  assert.equal(codexContextFromRollout(file), null) // divergencia: sem numero inventado
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('catalogo: consultas simultaneas compartilham a mesma em andamento (inclusive forcadas); depois do fim, nova consulta', async () => {
  const a = getCatalog('gemini', undefined, true), b = getCatalog('gemini'), c = getCatalog('gemini', undefined, true)
  assert.equal(a, b); assert.equal(a, c) // uma unica consulta a CLI, nao tres
  const cat = await a
  assert.equal(await getCatalog('gemini'), cat) // cache
  const again = getCatalog('gemini', undefined, true)
  assert.notEqual(again, a); assert.notEqual(await again, cat)
})
