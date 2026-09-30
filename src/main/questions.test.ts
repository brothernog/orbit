// Perguntas do agente (ask_user): validacao, espera pela resposta, pular, prazo, desistencia da CLI e fim da execucao. Sem CLIs reais.
import test from 'node:test'
import assert from 'node:assert/strict'
import { noticeFor, DEFAULT_NOTIFY } from './notify.ts'
import { parseAnswers, parseQuestions, QuestionBroker } from './questions.ts'
import { runtimeBrief } from './prompt.ts'

const Q = { question: 'Qual engine de fisica?', header: 'Fisica', options: [{ label: 'Jolt (Recomendado)', description: 'mais rapida' }, { label: 'Godot Physics' }] }
const MULTI = { question: 'Quais plataformas?', header: 'Plataformas', options: [{ label: 'PC' }, { label: 'Steam Deck' }, { label: 'Web' }], multiSelect: true }
const ctx = { taskId: 7, runId: 3, provider: 'claude' }
const tick = () => new Promise(r => setImmediate(r))
function mk(timeoutMin = 1) {
  const events: any[] = [], notes: string[] = []
  const b = new QuestionBroker({ timeoutMin: () => timeoutMin, emit: ev => events.push(ev), note: (_t, text) => notes.push(text) })
  return { b, events, notes }
}

test('validacao: limites do ask_user voltam ao agente como erro, sem aparecer ao usuario', async () => {
  assert.equal(parseQuestions({ questions: [Q, MULTI] }).length, 2)
  assert.equal(parseQuestions({ questions: [Q] })[0].options[1].description, '')
  for (const bad of [{}, { questions: [] }, { questions: [Q, Q, Q, Q, Q] }, { questions: [{ ...Q, options: [Q.options[0]] }] },
    { questions: [{ ...Q, options: [{ label: 'A' }, { label: 'a' }] }] }, { questions: [{ ...Q, header: '' }] }, { questions: [{ ...Q, question: 'x'.repeat(501) }] }])
    assert.throws(() => parseQuestions(bad))
  const { b, events } = mk()
  const r = await b.ask(ctx, { questions: [] }, new AbortController().signal)
  assert.equal(r.isError, true)
  assert.match(r.text, /Corrija/)
  assert.equal(events.length, 0)
  assert.deepEqual(b.list(), [])
})

test('respostas: opcao inexistente, duas na escolha unica e resposta vazia sao recusadas; "outro" e texto livre', () => {
  const qs = parseQuestions({ questions: [Q, MULTI] })
  assert.deepEqual(parseAnswers(qs, [{ selected: ['Godot Physics'] }, { selected: ['PC', 'Web', 'PC'], other: ' Switch ' }]), [{ selected: ['Godot Physics'], other: '' }, { selected: ['PC', 'Web'], other: 'Switch' }])
  assert.deepEqual(parseAnswers(qs, [{ other: 'Rapier' }, { selected: ['PC'] }])[0], { selected: [], other: 'Rapier' })
  assert.throws(() => parseAnswers(qs, [{ selected: ['Havok'] }, { selected: ['PC'] }]), /inexistente/)
  assert.throws(() => parseAnswers(qs, [{ selected: ['Godot Physics', 'Jolt (Recomendado)'] }, { selected: ['PC'] }]), /uma opcao so/)
  assert.throws(() => parseAnswers(qs, [{ selected: [] }, { selected: ['PC'] }]), /Responda/)
  assert.throws(() => parseAnswers(qs, [{ selected: ['PC'] }]), /todas/)
})

test('a chamada espera a resposta do usuario; a resposta volta ao agente e fica como nota no chat', async () => {
  const { b, events, notes } = mk()
  const pending = b.ask(ctx, { questions: [Q] }, new AbortController().signal)
  await tick()
  const [q] = b.list(7)
  assert.ok(q && b.list(8).length === 0 && b.get(q.id)?.provider === 'claude')
  assert.deepEqual(events, [{ taskId: 7, questionRequest: q.id }])
  assert.throws(() => b.answer(q.id, [{ selected: ['Havok'] }])) // erro de validacao nao encerra a pergunta
  assert.equal(b.list().length, 1)
  b.answer(q.id, [{ selected: ['Jolt (Recomendado)'] }])
  const r = await pending
  assert.equal(r.isError, false)
  assert.match(r.text, /Qual engine de fisica\?\n   Resposta: Jolt \(Recomendado\)/)
  assert.match(notes[0], /Sua resposta: Jolt/)
  assert.deepEqual(events.at(-1), { taskId: 7, questionResolved: q.id })
  assert.deepEqual(b.list(), [])
  assert.throws(() => b.answer(q.id, [{ selected: ['Godot Physics'] }]), /ja foi respondida/) // clique repetido
})

test('pular, prazo, desistencia da CLI e fim da execucao encerram a pergunta sem travar o agente', async () => {
  const { b, notes } = mk(0.0005) // 30 ms
  const skip = b.ask(ctx, { questions: [Q] }, new AbortController().signal)
  await tick(); b.answer(b.list()[0].id, null)
  assert.match((await skip).text, /preferiu nao responder/)
  assert.match(notes.at(-1)!, /voce pulou/)

  const late = await b.ask(ctx, { questions: [Q] }, new AbortController().signal)
  assert.equal(late.isError, false)
  assert.match(late.text, /Sem resposta do usuario/)
  assert.match(notes.at(-1)!, /expirou/)

  const { b: b2, notes: n2 } = mk()
  const ac = new AbortController()
  const gone = b2.ask(ctx, { questions: [Q] }, ac.signal)
  await tick(); ac.abort()
  assert.equal((await gone).isError, true)
  const other = b2.ask({ ...ctx, runId: 4 }, { questions: [Q] }, new AbortController().signal)
  const mine = b2.ask(ctx, { questions: [Q] }, new AbortController().signal)
  await tick(); b2.expire({ runId: 3 })
  assert.equal((await mine).text, 'Pergunta cancelada.')
  assert.equal(b2.list().length, 1) // a pergunta de outra execucao continua
  b2.expire({ runId: 4 }); await other
  assert.deepEqual(n2, []) // CLI que ja nao espera nao deixa nota
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await b2.ask(ctx, { questions: [Q] }, aborted.signal)).isError, true)
})

test('aviso: pergunta pendente vira cartao "Responder" que some quando resolvida', () => {
  const info = { task: { title: 'Fisica', game: 'C:/jogo', project: 'jogo' }, question: { provider: 'codex', summary: 'Qual engine de fisica?' } }
  const n = noticeFor({ taskId: 7, questionRequest: 5 }, info, DEFAULT_NOTIFY)
  assert.equal(n?.kind, 'question')
  assert.deepEqual(n?.ref, { question: 5 })
  assert.equal(noticeFor({ taskId: 7, questionRequest: 5 }, info, { ...DEFAULT_NOTIFY, approval: false }), null)
})

// Teste real (Claude 2.1.284, haiku): sem "SEMPRE pela ferramenta" ele perguntava so no texto; sem citar TaskCreate usava a lista interna dele.
test('brief do pai: pergunta pela ferramenta e sugestao nao vira TaskCreate; filho e sem MCP nao recebem a regra', () => {
  const parent = runtimeBrief({ memoryTools: true, workspaceTools: false, skills: 'parent' })
  assert.match(parent, /SEMPRE pela ferramenta ask_user/)
  assert.match(parent, /suggest_task do dashboard[^\n]*TaskCreate\/TodoWrite sao so a sua lista interna/)
  assert.ok(!/ask_user|suggest_task/.test(runtimeBrief({ memoryTools: true, workspaceTools: true, skills: 'child' })))
  assert.ok(!/ask_user|suggest_task/.test(runtimeBrief({ memoryTools: false, workspaceTools: false })))
})
