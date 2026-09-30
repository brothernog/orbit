// Agentes nomeados para delegacao: validacao ao salvar, resolucao por nome e catalogo na descricao da ferramenta.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeAliases, foldName, parseAliases, resolveAlias, validateAliases } from './agents.ts'
import { delegateTool, DEFAULT_SETTINGS, parseArgs, TOOL_NAME } from './delegation.ts'

const ok = async () => null
const LUNA = { name: 'Fabricio', provider: 'codex', model: 'gpt-6-luna' }

test('salvar: aceita nome + provedor + modelo (+ esforco) e devolve a lista normalizada', async () => {
  const v = await validateAliases([{ name: '  Fabrício  ', provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, { name: 'Leitor-2', provider: 'claude', model: 'sonnet', effort: '' }], ok)
  assert.deepEqual(v, [{ name: 'Fabrício', provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, { name: 'Leitor-2', provider: 'claude', model: 'sonnet' }])
  assert.deepEqual(await validateAliases([], ok), []) // lista vazia limpa os apelidos
})

test('salvar: recusa nome repetido (sem acento/caixa), nome de provedor, nome invalido, provedor/modelo invalidos e excesso', async () => {
  const bad = (list: unknown, re: RegExp) => assert.rejects(() => validateAliases(list, ok), re)
  await bad([LUNA, { ...LUNA, name: 'FABRÍCIO' }], /Nome repetido/)
  await bad([{ ...LUNA, name: 'Codex' }], /nome de um provedor/)
  await bad([{ ...LUNA, name: '' }], /nome deve ter/)
  await bad([{ ...LUNA, name: 'x'.repeat(41) }], /nome deve ter/)
  await bad([{ ...LUNA, name: '@@' }], /nome deve ter/)
  await bad([{ ...LUNA, provider: 'rm' }], /provedor invalido/)
  await bad([{ ...LUNA, model: 'a & calc' }], /modelo valido/)
  await bad([{ ...LUNA, model: undefined }], /modelo valido/)
  await bad([{ ...LUNA, effort: 'a b' }], /esforco invalido/)
  await bad('texto', /lista/)
  await bad([null], /entrada invalida/)
  await bad(Array.from({ length: 31 }, (_, i) => ({ ...LUNA, name: `n${i}` })), /No maximo 30/)
})

test('salvar: modelo ou esforco ausentes do catalogo recusam a lista inteira (sem substituir)', async () => {
  const check = async (_p: string, model?: string, effort?: string) => (model === 'gpt-inexistente' ? 'O modelo "gpt-inexistente" nao consta no catalogo de codex.' : effort === 'turbo' ? 'esforco nao suportado' : null)
  await assert.rejects(() => validateAliases([LUNA, { name: 'Ruim', provider: 'codex', model: 'gpt-inexistente' }], check), /"Ruim": O modelo "gpt-inexistente" nao consta/)
  await assert.rejects(() => validateAliases([{ ...LUNA, effort: 'turbo' }], check), /esforco nao suportado/)
})

test('resolver: sem acento e sem caixa; catalogo legivel; leitura tolerante ignora entradas ruins', () => {
  const list = parseAliases([LUNA, { ...LUNA, name: 'fabricio' }, { name: 'X', provider: 'nada', model: 'm' }, { name: 'Y', provider: 'codex' }, null, 'z'])
  assert.deepEqual(list, [LUNA]) // repetido, provedor invalido, sem modelo e lixo sao descartados sem derrubar nada
  assert.equal(resolveAlias(list, ' fabrício ')?.model, 'gpt-6-luna')
  assert.equal(resolveAlias(list, 'outro'), undefined)
  assert.equal(foldName('  Fabrício   Souza '), 'fabricio souza')
  assert.equal(describeAliases([LUNA, { name: 'Leitor', provider: 'claude', model: 'sonnet', effort: 'low' }]), 'Fabricio = codex / gpt-6-luna; Leitor = claude / sonnet (esforco low)')
  assert.deepEqual(parseAliases(null), [])
})

test('ferramenta de delegacao: o catalogo de agentes vai na descricao e no esquema; sem agentes o esquema e o de antes', () => {
  const plain = delegateTool()
  assert.deepEqual((plain.inputSchema as any).required, ['objective', 'provider'])
  assert.ok(!('agent' in (plain.inputSchema as any).properties) && !/Agentes nomeados/.test(plain.description))
  const t = delegateTool([LUNA, { name: 'Leitor', provider: 'claude', model: 'sonnet' }])
  assert.equal(t.name, TOOL_NAME)
  assert.match(t.description, /Agentes nomeados pelo usuario: Fabricio = codex \/ gpt-6-luna; Leitor = claude \/ sonnet\./)
  assert.match(t.description, /NAO pergunte provedor nem id de modelo/)
  assert.deepEqual((t.inputSchema as any).properties.agent.enum, ['Fabricio', 'Leitor'])
  assert.deepEqual((t.inputSchema as any).required, ['objective']) // provider dispensavel com agent
  assert.ok(!/api[_-]?key|token|senha/i.test(t.description)) // so nome/provedor/modelo/esforco
})

test('argumentos: agent define provedor/modelo/esforco; conflito, agente inexistente e provedor nao permitido sao recusados', () => {
  const S = DEFAULT_SETTINGS
  const list = [{ ...LUNA, effort: 'high' }]
  const a = parseArgs({ objective: 'leia x', agent: 'fabrício' }, S, list)
  assert.deepEqual([a.provider, a.model, a.effort, a.agent], ['codex', 'gpt-6-luna', 'high', 'Fabricio'])
  assert.equal(parseArgs({ objective: 'x', agent: 'Fabricio', provider: 'codex', model: 'gpt-6-luna' }, S, list).provider, 'codex') // igual ao cadastrado: ok
  assert.throws(() => parseArgs({ objective: 'x', agent: 'Fabricio', provider: 'claude' }, S, list), /nada e substituido em silencio/)
  assert.throws(() => parseArgs({ objective: 'x', agent: 'Fabricio', model: 'outro' }, S, list), /nada e substituido em silencio/)
  assert.throws(() => parseArgs({ objective: 'x', agent: 'Ninguem' }, S, list), /nao existe\. Agentes cadastrados: Fabricio/)
  assert.throws(() => parseArgs({ objective: 'x', agent: 'Ninguem' }, S, []), /nenhum \(o usuario os cria em Configuracoes\)/)
  assert.throws(() => parseArgs({ objective: 'x', agent: 'Fabricio' }, { ...S, allowedProviders: ['claude'] }, list), /nao esta permitido/) // as regras de delegacao valem para o apelido
  assert.ok(!('agent' in parseArgs({ objective: 'x', provider: 'codex' }, S, list))) // sem agent, nada muda
})

test('agente padrao de leitura: so preenche leitura sem agent/provider; edicao e escolha explicita ficam como estao', () => {
  const list = [LUNA, { name: 'Leitor', provider: 'opencode', model: 'deepseek/deepseek-flash' }]
  const S = { ...DEFAULT_SETTINGS, readAgent: 'leitor' }
  assert.deepEqual([parseArgs({ objective: 'rode os testes' }, S, list).agent, parseArgs({ objective: 'x', mode: 'read' }, S, list).model], ['Leitor', 'deepseek/deepseek-flash'])
  assert.equal(parseArgs({ objective: 'x', agent: 'Fabricio' }, S, list).agent, 'Fabricio') // escolha explicita vence
  assert.equal(parseArgs({ objective: 'x', provider: 'claude' }, S, list).provider, 'claude')
  assert.throws(() => parseArgs({ objective: 'x', mode: 'edit' }, S, list), /provider invalido/) // edicao nunca vai sozinha para o padrao
  assert.throws(() => parseArgs({ objective: 'x' }, { ...S, readAgent: 'Sumiu' }, list), /"Sumiu" nao existe/) // padrao apagado: recusa com motivo
  assert.throws(() => parseArgs({ objective: 'x' }, DEFAULT_SETTINGS, list), /provider invalido/) // sem padrao: como antes
  assert.match(delegateTool(list, 'Leitor').description, /mode "read" vai para Leitor/)
  assert.ok(!/vai para/.test(delegateTool(list, 'Sumiu').description) && !/vai para/.test(delegateTool(list).description))
  assert.match(delegateTool().description, /trazendo so as falhas/) // regra fixa por tipo de trabalho, sem estimativa de custo
})
