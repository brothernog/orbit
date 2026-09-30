// Fixtures pequenas (leitura de arquivo, implementacao, correcao do mesmo filho, troca de provedor, historico longo) com executores
// SIMULADOS. Medem o tamanho (em caracteres) do que a dashboard monta/devolve antes e depois deste ciclo. Isto prova reducao de
// PAYLOAD e controle de fluxo; NAO e economia real de tokens do provedor (isso exige medicao real, autorizada). Resultados de
// referencia em fixtures/reference.json; regenere com UPDATE_REFERENCE=1 npm test quando uma mudanca for intencional.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEnvelope } from './envelope.ts'
import { openDb } from './db.ts'
import { planHistoryContext, type Recipient } from './consent.ts'
import { DEFAULT_LIMITS } from './limits.ts'
import { buildChildInput, runtimeBrief } from './prompt.ts'
import { contextFor, createTask } from './tasks.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpd-scn-'))
const db = openDb(path.join(tmp, 't.db'))
const REF = path.join(import.meta.dirname, 'fixtures', 'reference.json')
const measured: Record<string, Record<string, number>> = {}
const para = (n: number, w = 60) => Array.from({ length: n }, (_, i) => `${'detalhe '.repeat(Math.ceil(w / 8)).slice(0, w)} ${i}`).join('\n\n')
const env = (over: any) => buildEnvelope({ id: 1, status: 'completed', answer: '', changed: [], outOfScope: [], violation: false, artifactId: 1, totalChars: 0, toolCount: 0, conclusionChars: DEFAULT_LIMITS.conclusionChars, ...over })
const brief = runtimeBrief({ memoryTools: true, workspaceTools: true })

test('cenario 1: leitura de arquivo (resposta longa do filho ao pai)', () => {
  const answer = para(300) // ~19k caracteres de analise
  const before = Math.min(answer.length, 50_000) + 80 // contrato anterior: ate 50.000 caracteres + rodape
  const after = env({ answer, answerBasis: 'limited', totalChars: answer.length, toolCount: 6 }).length
  measured.leitura = { antes: before, depois: after, recuperavel_no_artefato: answer.length }
  assert.ok(after < before / 3 && after < 4200)
})

test('cenario 2: implementacao com arquivos alterados e alerta (metadados nunca descartados)', () => {
  const answer = para(120)
  const changed = Array.from({ length: 5 }, (_, i) => `src/mod${i}.ts`)
  const text = env({ answer, changed, outOfScope: ['fora.txt'], violation: false, totalChars: answer.length, toolCount: 12 })
  measured.implementacao = { antes: answer.length + 200, depois: text.length }
  for (const f of changed) assert.ok(text.includes(f))
  assert.match(text, /FORA DO ESCOPO: fora\.txt/)
})

test('cenario 3: correcao do mesmo filho (continuacao nao repete instrucoes nem pacote)', () => {
  const pkg = '[Contexto aprovado pelo usuario ...]\n' + para(20, 70)
  const first = buildChildInput({ mode: 'edit', scope: ['src'], objective: 'implemente X com testes', brief, packageText: pkg, delegationId: 1 })
  const fresh = buildChildInput({ mode: 'edit', scope: ['src'], objective: 'corrija o caso B', brief, packageText: pkg, delegationId: 2 }) // sem continuacao: repete tudo
  const cont = buildChildInput({ mode: 'edit', scope: ['src'], objective: 'corrija o caso B', brief, delegationId: 2, continuationOf: 1 })
  measured.correcao = { primeira_entrada: first.length, nova_sessao_repetindo: fresh.length, continuacao: cont.length }
  assert.ok(cont.length < fresh.length / 3 && !cont.includes('requisito') && !cont.includes(pkg))
})

test('cenarios 4 e 5: troca de provedor e historico longo (nada segue sem aprovacao; depois so o limite aprovado)', () => {
  const t = createTask(db, 'C:/g', 'historico')
  const ins = (role: string, text: string, provider: string | null) =>
    db.prepare("INSERT INTO messages (chat_key, role, text, task_id, provider, status) VALUES (?,?,?,?,?,?)").run(`task:${t}`, role, text, t, provider, role === 'agent' ? 'completed' : null)
  for (let i = 0; i < 200; i++) {
    ins('user', `pergunta ${i}: ${para(1, 300)}`, null)
    ins('agent', `${para(1, 500)}\n\n\`> rg -n termo${i} src\`\n\n\`> npm test\`\n\n${para(1, 500)}`, 'claude')
  }
  const old = contextFor(db, t, 'codex', null, false, 12_000)!.text.length // antes: mais recentes ate 12.000, com marcadores, enviado direto
  const cand = contextFor(db, t, 'codex', null, false, DEFAULT_LIMITS.packageChars)!
  const R: Recipient = { logicalId: `chat:${t}:codex:`, provider: 'codex', profile: '', model: null, effort: null, workspace: 'C:/g', scope: [] }
  const plan = planHistoryContext(db, DEFAULT_LIMITS, { taskId: t, recipient: R, sessionId: null, candidate: { body: cand.body, count: cand.count } })
  const sentBeforeApproval = plan.deliver.reduce((n, d) => n + d.items.reduce((m, i) => m + i.content.length, 0), 0)
  measured.troca_de_provedor = { antes_enviado_direto: old, depois_enviado_antes_da_aprovacao: sentBeforeApproval, pedido_para_aprovar: plan.pending!.size }
  measured.historico_longo = { mensagens: 400, limite_antes: 12_000, limite_depois: DEFAULT_LIMITS.packageChars, marcadores_de_ferramenta_no_pedido: (cand.body.match(/`> /g) ?? []).length }
  assert.equal(sentBeforeApproval, 0)
  assert.ok(plan.pending!.size <= DEFAULT_LIMITS.packageChars && measured.historico_longo.marcadores_de_ferramenta_no_pedido === 0)
})

test('resultados de referencia dos cenarios simulados', () => {
  if (process.env.UPDATE_REFERENCE || !fs.existsSync(REF)) {
    fs.mkdirSync(path.dirname(REF), { recursive: true })
    fs.writeFileSync(REF, JSON.stringify({ aviso: 'Caracteres de payload em cenarios SIMULADOS; nao sao tokens do provedor nem economia real.', ...measured }, null, 2) + '\n')
  }
  const ref = JSON.parse(fs.readFileSync(REF, 'utf8'))
  delete ref.aviso
  assert.deepEqual(measured, ref)
})

test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
