// Persistencia das execucoes de chat (running | completed | failed | cancelled). Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import type { ChatResult } from './runner.ts'

type Reply = Pick<ChatResult, 'status' | 'text' | 'notes' | 'error' | 'category'> & Partial<Pick<ChatResult, 'messages' | 'answer' | 'answerBasis'>>
// Configuracao efetiva da execucao: fica gravada na execucao e na mensagem do agente.
export type RunConfig = { taskId: number; provider: string; accountId?: number | null; model?: string | null; effort?: string | null }

// Resposta do agente sem atividade de ferramentas nem avisos: explicita quando a CLI marcou a conclusao; senao todas as mensagens
// de texto (a CLI nao distingue comentario de resposta final, entao nada e descartado). null = execucao sem esse detalhe.
export const cleanReply = (r: Reply): string | null =>
  r.messages ? (r.answerBasis === 'explicit' && r.answer ? r.answer : r.messages.join('\n\n')).trim() : null

// Falas separadas (JSON) quando a resposta NAO foi marcada pela CLI e ha mais de uma: a transferencia de contexto prioriza as ultimas (tasks.contextFor).
export const cleanParts = (r: Reply): string | null => {
  if (!r.messages || (r.answerBasis === 'explicit' && r.answer)) return null
  const parts = r.messages.map(m => m.trim()).filter(Boolean)
  return parts.length > 1 ? JSON.stringify(parts) : null
}

// Texto que vai para o historico: resposta (parcial se falhou/cancelou) + avisos + estado final visivel.
export function composeReply(r: Reply) {
  const parts = [r.text, ...r.notes.map(n => `> ${n}`)]
  if (r.status === 'failed') parts.push(`**Falhou** (${r.category ?? 'unknown'}):\n\n\`\`\`\n${(r.error ?? '').replace(/```/g, "'''")}\n\`\`\``)
  if (r.status === 'cancelled' && !(r as any).paused) parts.push('_Execucao cancelada._')
  return parts.filter(Boolean).join('\n\n')
}

const touch = (db: DatabaseSync, taskId: number) =>
  db.prepare("UPDATE tasks SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now'), state=CASE WHEN state='aberta' THEN 'andamento' ELSE state END WHERE id=?").run(taskId)

// Mensagem do usuario (e, opcionalmente, um aviso do sistema) + execucao 'running' no mesmo passo.
export function startRun(db: DatabaseSync, c: RunConfig, userText: string, notice?: string) {
  const key = `task:${c.taskId}`
  db.exec('BEGIN')
  try {
    if (notice) db.prepare("INSERT INTO messages (chat_key, role, text, task_id) VALUES (?, 'system', ?, ?)").run(key, notice, c.taskId)
    db.prepare("INSERT INTO messages (chat_key, role, text, task_id, provider, account_id, model, effort) VALUES (?, 'user', ?, ?, ?, ?, ?, ?)")
      .run(key, userText, c.taskId, c.provider, c.accountId ?? null, c.model ?? null, c.effort ?? null)
    const id = Number(db.prepare('INSERT INTO runs (chat_key, task_id, provider, account_id, model, effort) VALUES (?,?,?,?,?,?)')
      .run(key, c.taskId, c.provider, c.accountId ?? null, c.model ?? null, c.effort ?? null).lastInsertRowid)
    touch(db, c.taskId)
    db.exec('COMMIT')
    return id
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const savePartial = (db: DatabaseSync, runId: number, text: string) =>
  db.prepare("UPDATE runs SET partial=? WHERE id=? AND status='running'").run(text, runId)

// O parcial so serve para reconcileRuns (queda do app): a UI ao vivo usa o texto em memoria. Cada gravacao reescreve o
// texto inteiro, entao grava no maximo a cada `everyMs` e so quando mudou; o texto final vai por finishRun.
export function partialSaver(db: DatabaseSync, runId: number, everyMs = 10_000, now = Date.now) {
  let last = now(), saved = ''
  return (text: string) => {
    if (text === saved || now() - last < everyMs) return
    last = now(); saved = text; savePartial(db, runId, text)
  }
}

// Encerra a execucao e grava a mensagem do agente uma unica vez (repetir a chamada nao duplica nada).
export function finishRun(db: DatabaseSync, runId: number, r: Reply) {
  db.exec('BEGIN')
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any
    const done = db.prepare("UPDATE runs SET status=?, error=?, category=?, partial='', ended_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'")
      .run(r.status, r.error ?? null, r.category ?? null, runId)
    if (done.changes) {
      db.prepare('INSERT INTO messages (chat_key, role, text, status, task_id, provider, account_id, model, effort, clean, clean_parts) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(run.chat_key, 'agent', composeReply(r), r.status, run.task_id, run.provider, run.account_id, run.model, run.effort, cleanReply(r), cleanParts(r))
      if (run.task_id) touch(db, run.task_id)
    }
    db.exec('COMMIT')
    return done.changes > 0
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// Na abertura do app: execucoes que ficaram 'running' foram interrompidas (o processo do app morreu).
export function reconcileRuns(db: DatabaseSync) {
  const rows = db.prepare("SELECT id, partial FROM runs WHERE status='running'").all() as any[]
  for (const r of rows)
    finishRun(db, r.id, {
      status: 'failed', text: r.partial, notes: [], category: 'unknown',
      error: 'Execucao interrompida: o app foi fechado ou reiniciado antes de terminar.'
    })
  return rows.length
}
