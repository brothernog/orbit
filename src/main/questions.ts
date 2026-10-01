// Perguntas do agente ao usuario (ferramenta MCP `ask_user`, so do agente pai): a chamada fica aberta ate a resposta no chat,
// o tempo limite ou a desistencia da CLI (signal). Pendentes ficam so em memoria: sem CLI esperando, a pergunta nao tem para
// quem voltar (reinicio, fim da execucao). A resposta e ordem direta do usuario, nao contexto existente: nao passa por pacote.
// Pergunta e resposta viram nota no chat da tarefa para o historico. Sem dependencia de 'electron'.
import type { ToolDef, ToolResult } from './mcp.ts'

export const ASK_TOOL_NAME = 'ask_user'
export const ASK_TOOL: ToolDef = {
  name: ASK_TOOL_NAME,
  description: 'Pergunta ao usuario e ESPERA a resposta (ele pode demorar). So para duvida real que muda o trabalho: requisito ambiguo, escolha de gosto/prioridade, confirmacao antes de algo caro ou irreversivel. Nao pergunte o que o codigo, os testes ou o contexto respondem. Opcoes curtas e distintas; o usuario sempre pode escrever outra resposta. Recomendada primeiro, com "(Recomendado)" no rotulo.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Pergunta completa, terminando em "?".' },
            header: { type: 'string', description: 'Rotulo curto (ate 20 caracteres).' },
            options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
            multiSelect: { type: 'boolean', description: 'Permite marcar varias opcoes.' }
          },
          required: ['question', 'header', 'options']
        }
      }
    },
    required: ['questions']
  }
}

export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
export type Answer = { selected: string[]; other: string }
export type PendingQuestion = { id: number; taskId: number; runId: number; provider: string; questions: Question[]; createdAt: string }
export type AskCtx = { taskId: number; runId: number; provider: string }
type Deps = { timeoutMin: () => number; emit: (ev: object) => void; note: (taskId: number, text: string) => void }

const bad = (m: string): never => { throw new Error(m) }
const str = (v: unknown, name: string, max: number, required = true) => {
  if (v == null || v === '') return required ? bad(`${name} vazio.`) : ''
  if (typeof v !== 'string') return bad(`${name} invalido.`)
  const s = v.trim()
  if (required && !s) bad(`${name} vazio.`)
  if (s.length > max) bad(`${name} passa de ${max} caracteres.`)
  return s
}

// Valida o que o agente mandou; o erro volta para ele corrigir e chamar de novo (nada aparece ao usuario).
export function parseQuestions(args: any): Question[] {
  const qs = args?.questions
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) bad('questions: de 1 a 4 perguntas.')
  return qs.map((q: any, i: number) => {
    const n = `Pergunta ${i + 1}`
    const opts = q?.options
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) bad(`${n}: de 2 a 4 opcoes.`)
    const options = opts.map((o: any, j: number) => ({ label: str(o?.label, `${n}, opcao ${j + 1}: label`, 80), description: str(o?.description, `${n}, opcao ${j + 1}: description`, 300, false) }))
    if (new Set(options.map((o: { label: string }) => o.label.toLowerCase())).size !== options.length) bad(`${n}: rotulos repetidos.`)
    return { question: str(q?.question, `${n}: question`, 500), header: str(q?.header, `${n}: header`, 30), options, multiSelect: q?.multiSelect === true }
  })
}

// Resposta vinda da interface: cada opcao marcada precisa existir; escolha unica aceita uma so; "outro" e texto livre.
export function parseAnswers(qs: Question[], raw: any): Answer[] {
  if (!Array.isArray(raw) || raw.length !== qs.length) bad('Responda todas as perguntas.')
  return qs.map((q, i) => {
    const a = raw[i]
    const selected = Array.isArray(a?.selected) ? a.selected.filter((s: unknown) => typeof s === 'string') as string[] : []
    if (selected.some(s => !q.options.some(o => o.label === s))) bad('Opcao inexistente.')
    if (!q.multiSelect && selected.length > 1) bad(`"${q.header}" aceita uma opcao so.`)
    const other = typeof a?.other === 'string' ? a.other.trim().slice(0, 2000) : ''
    if (!selected.length && !other) bad(`Responda "${q.header}" (escolha uma opcao ou escreva a sua).`)
    return { selected: [...new Set(selected)], other }
  })
}

const said = (a: Answer) => [...a.selected, ...(a.other ? [a.other] : [])].join('; ')
export const answerText = (qs: Question[], as: Answer[]) =>
  'O usuario respondeu:\n' + qs.map((q, i) => `${i + 1}. ${q.question}\n   Resposta: ${said(as[i])}`).join('\n') + '\nSiga com essas respostas.'

type Outcome = { kind: 'answered'; answers: Answer[] } | { kind: 'skipped' } | { kind: 'expired' } | { kind: 'gone' } // gone: a CLI desistiu ou a execucao acabou

export class QuestionBroker {
  private pending = new Map<number, { q: PendingQuestion; done: (o: Outcome) => void }>()
  private seq = 0
  private d: Deps
  constructor(d: Deps) { this.d = d }

  async ask(ctx: AskCtx, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    let questions: Question[]
    try { questions = parseQuestions(args) } catch (e: any) { return { text: `Pergunta invalida: ${e.message} Corrija e chame de novo.`, isError: true } }
    const id = ++this.seq
    const q: PendingQuestion = { id, taskId: ctx.taskId, runId: ctx.runId, provider: ctx.provider, questions, createdAt: new Date().toISOString() }
    const min = this.d.timeoutMin()
    const out = await new Promise<Outcome>(resolve => {
      const done = (o: Outcome) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.pending.delete(id); resolve(o) }
      const onAbort = () => done({ kind: 'gone' })
      const timer = setTimeout(() => done({ kind: 'expired' }), min * 60_000)
      this.pending.set(id, { q, done })
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort)
      this.d.emit({ taskId: ctx.taskId, questionRequest: id })
    })
    this.d.emit({ taskId: ctx.taskId, questionResolved: id })
    const asked = questions.map(x => x.question).join(' / ')
    if (out.kind === 'answered') {
      this.d.note(ctx.taskId, questions.map((x, i) => `↳ Pergunta: ${x.question}\nSua resposta: ${said(out.answers[i])}`).join('\n'))
      return { text: answerText(questions, out.answers), isError: false }
    }
    if (out.kind === 'skipped') {
      this.d.note(ctx.taskId, `↳ Pergunta sem resposta (voce pulou): ${asked}`)
      return { text: 'O usuario preferiu nao responder. Siga com a suposicao mais razoavel e diga qual foi na resposta final.', isError: false }
    }
    if (out.kind === 'gone') return { text: 'Pergunta cancelada.', isError: true } // ninguem le esta resposta
    this.d.note(ctx.taskId, `↳ Pergunta expirou sem resposta em ${min} min: ${asked}`)
    return { text: `Sem resposta do usuario em ${min} min. Siga com a suposicao mais segura e diga qual foi, ou termine deixando a pergunta no texto final.`, isError: false }
  }

  // Interface: answers null = pular. Erro de validacao nao encerra a pergunta (o usuario corrige).
  answer(id: number, answers: unknown | null) {
    const p = this.pending.get(id) ?? bad('Esta pergunta ja foi respondida ou expirou.')
    p.done(answers === null ? { kind: 'skipped' } : { kind: 'answered', answers: parseAnswers(p.q.questions, answers) })
  }
  get = (id: number) => this.pending.get(id)?.q
  list = (taskId?: number) => [...this.pending.values()].map(p => p.q).filter(q => taskId == null || q.taskId === taskId)
  // Fim da execucao (a CLI nao espera mais): o que ainda estiver pendente some, sem nota.
  expire(o: { runId: number }) { for (const p of [...this.pending.values()]) if (p.q.runId === o.runId) p.done({ kind: 'gone' }) }
}
