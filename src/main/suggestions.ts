// Sugestoes de tarefa (ferramenta MCP `suggest_task`, so do agente pai): o agente acha algo fora do escopo (bug, teste faltando,
// doc velha) e registra uma ordem autocontida sem desviar do pedido atual. Nada executa: o usuario ve o cartao no chat e, se quiser,
// abre uma tarefa NOVA no mesmo projeto com a ordem so preenchida no compositor (ele revisa, edita e envia). A ordem e texto novo do
// agente; memoria e historico da tarefa de origem nao vao junto. Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import type { ToolDef, ToolResult } from './mcp.ts'
import { createTask } from './tasks.ts'

export const SUGGEST_TOOL_NAME = 'suggest_task'
export const SUGGEST_TOOL: ToolDef = {
  name: SUGGEST_TOOL_NAME,
  description: 'Sugere ao usuario uma tarefa SEPARADA para algo que voce notou e que foge do pedido atual (bug, teste faltando, codigo morto, doc desatualizada, falha de seguranca). Nao espera resposta: continue o trabalho atual. A ordem vai para uma conversa NOVA que nao ve esta: inclua caminhos, sintoma e o que fazer. Nao use para o proprio pedido, nem para palpites vagos ou correcoes triviais que voce pode fazer agora.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Acao curta no imperativo (ate 60 caracteres), ex.: "Corrigir colisao do inimigo na rampa".' },
      tldr: { type: 'string', description: '1-2 frases ao usuario: o que voce notou e por que vale uma tarefa.' },
      prompt: { type: 'string', description: 'Ordem autocontida para o agente da nova tarefa.' }
    },
    required: ['title', 'tldr', 'prompt']
  }
}

export type Suggestion = { id: number; task_id: number; run_id: number | null; provider: string | null; title: string; tldr: string; prompt: string; state: 'open' | 'started' | 'dismissed'; created_at: string }
export const MAX_OPEN = 8 // por tarefa: evita que um agente encha o chat de cartoes

const bad = (m: string): never => { throw new Error(m) }
const field = (v: unknown, name: string, max: number) => {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) bad(`${name} vazio.`)
  if (s.length > max) bad(`${name} passa de ${max} caracteres.`)
  return s
}

export function suggestTask(db: DatabaseSync, ctx: { taskId: number; runId?: number; provider?: string }, args: any): ToolResult {
  try {
    const title = field(args?.title, 'title', 80), tldr = field(args?.tldr, 'tldr', 400), prompt = field(args?.prompt, 'prompt', 6000)
    const open = db.prepare("SELECT id, title FROM task_suggestions WHERE task_id=? AND state='open'").all(ctx.taskId) as { id: number; title: string }[]
    const dup = open.find(s => s.title.toLowerCase() === title.toLowerCase())
    if (dup) return { text: `Ja existe a sugestao #${dup.id} com este titulo. Continue o trabalho atual.`, isError: false }
    if (open.length >= MAX_OPEN) return { text: `Ja ha ${MAX_OPEN} sugestoes abertas nesta tarefa esperando o usuario. Cite as demais na resposta final.`, isError: true }
    const id = Number(db.prepare('INSERT INTO task_suggestions (task_id, run_id, provider, title, tldr, prompt) VALUES (?,?,?,?,?,?)')
      .run(ctx.taskId, ctx.runId ?? null, ctx.provider ?? null, title, tldr, prompt).lastInsertRowid)
    return { text: `Sugestao #${id} mostrada ao usuario; ele decide se abre uma tarefa nova. Continue o trabalho atual.`, isError: false }
  } catch (e: any) {
    return { text: `Sugestao invalida: ${e.message} Corrija e chame de novo.`, isError: true }
  }
}

export const listSuggestions = (db: DatabaseSync, taskId: number) =>
  db.prepare("SELECT * FROM task_suggestions WHERE task_id=? AND state='open' ORDER BY id").all(taskId) as Suggestion[]

export function dismissSuggestion(db: DatabaseSync, id: number) {
  if (!db.prepare("UPDATE task_suggestions SET state='dismissed', decided_at=CURRENT_TIMESTAMP WHERE id=? AND state='open'").run(id).changes) bad('Esta sugestao ja foi usada ou dispensada.')
}

// Abre a tarefa nova no projeto da tarefa de origem; a ordem volta para a interface preencher o compositor (nada e enviado).
export function startSuggestion(db: DatabaseSync, id: number): { game: string; taskId: number; text: string } {
  db.exec('BEGIN')
  try {
    const s = db.prepare("SELECT s.*, t.game FROM task_suggestions s JOIN tasks t ON t.id=s.task_id WHERE s.id=? AND s.state='open'").get(id) as (Suggestion & { game: string }) | undefined
    if (!s) bad('Esta sugestao ja foi usada ou dispensada.')
    db.prepare("UPDATE task_suggestions SET state='started', decided_at=CURRENT_TIMESTAMP WHERE id=?").run(id)
    const taskId = createTask(db, s!.game, s!.title)
    db.exec('COMMIT')
    return { game: s!.game, taskId, text: s!.prompt }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
