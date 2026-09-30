// Etapas sequenciais persistentes; o chat continua responsável por execução e consentimento.
import type { DatabaseSync } from 'node:sqlite'
export type StepState = 'pending' | 'starting' | 'awaiting_context' | 'running' | 'review' | 'accepted' | 'failed' | 'cancelled'
export type Step = { id: number; task_id: number; position: number; title: string; instruction: string; state: StepState; run_id: number | null; send_id: number | null; error: string | null }
const ACTIVE = ['starting', 'awaiting_context', 'running']
export const getStep = (db: DatabaseSync, id: number) => db.prepare('SELECT * FROM task_steps WHERE id=?').get(id) as Step | undefined
export const activeStep = (db: DatabaseSync, taskId: number) => db.prepare("SELECT * FROM task_steps WHERE task_id=? AND state IN ('starting','awaiting_context','running')").get(taskId) as Step | undefined
export function listSteps(db: DatabaseSync, taskId: number): Step[] {
  reconcileSteps(db)
  return db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY position').all(taskId) as Step[]
}
export function addStep(db: DatabaseSync, taskId: number, title: unknown, instruction: unknown) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 20000) throw Error('Preencha o título e a ordem da etapa (até 20.000 caracteres).')
  const n = (db.prepare('SELECT COUNT(*) n, COALESCE(MAX(position),0) p FROM task_steps WHERE task_id=?').get(taskId) as any)
  if (n.n >= 20) throw Error('No máximo 20 etapas por tarefa.')
  return Number(db.prepare('INSERT INTO task_steps(task_id,position,title,instruction) VALUES (?,?,?,?)').run(taskId, n.p + 1, title.trim(), instruction.trim()).lastInsertRowid)
}
export function beginStep(db: DatabaseSync, taskId: number, id: number) {
  reconcileSteps(db)
  const step = getStep(db, id)
  if (!step || step.task_id !== taskId) throw Error('Etapa não pertence a esta tarefa.')
  if (!['pending','failed','cancelled'].includes(step.state) || activeStep(db, taskId)) throw Error('A etapa já está em execução ou aguardando revisão.')
  const earlier = db.prepare("SELECT 1 FROM task_steps WHERE task_id=? AND position<? AND state<>'accepted' LIMIT 1").get(taskId, step.position)
  if (earlier) throw Error('Aceite as etapas anteriores antes de iniciar esta.')
  db.prepare("UPDATE task_steps SET state='starting',run_id=NULL,send_id=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id)
}
export function bindStep(db: DatabaseSync, id: number, result: { status: string; runId?: number; sendId?: number }) {
  const step = getStep(db, id)
  if (!step || !['starting','awaiting_context'].includes(step.state)) return
  if (result.status === 'awaiting_context_approval' && result.sendId) {
    const send = db.prepare('SELECT task_id FROM pending_sends WHERE id=?').get(result.sendId) as any
    if (send?.task_id !== step.task_id) throw Error('Envio de outra tarefa.')
    db.prepare("UPDATE task_steps SET state='awaiting_context',send_id=? WHERE id=?").run(result.sendId, id)
  } else if (result.runId) {
    const run = db.prepare('SELECT task_id FROM runs WHERE id=?').get(result.runId) as any
    if (run?.task_id !== step.task_id) throw Error('Execução de outra tarefa.')
    db.prepare("UPDATE task_steps SET state='running',run_id=? WHERE id=?").run(result.runId, id)
  } else throw Error('Execução da etapa não foi iniciada.')
  reconcileSteps(db)
}
export function failStep(db: DatabaseSync, id: number, error: string) {
  db.prepare("UPDATE task_steps SET state='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='starting'").run(error.slice(0, 500), id)
}
export function reviewStep(db: DatabaseSync, id: number, accept: boolean) {
  const step = getStep(db, id)
  if (step?.state !== 'review') throw Error('A etapa ainda não tem uma execução concluída para revisar.')
  db.prepare('UPDATE task_steps SET state=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(accept ? 'accepted' : 'pending', id)
}
export function reconcileSteps(db: DatabaseSync, startup = false) {
  const rows = db.prepare("SELECT * FROM task_steps WHERE state IN ('starting','awaiting_context','running')").all() as Step[]
  for (const step of rows) {
    const run = step.run_id ? db.prepare('SELECT status,error FROM runs WHERE id=?').get(step.run_id) as any : null
    const send = step.send_id ? db.prepare('SELECT state,reason FROM pending_sends WHERE id=?').get(step.send_id) as any : null
    let state: StepState | null = null, error: string | null = null
    if (run && run.status !== 'running') { state = run.status === 'completed' ? 'review' : run.status; error = run.error }
    else if (step.state === 'awaiting_context' && (!send || ['cancelled','expired'].includes(send.state))) { state = 'cancelled'; error = send?.reason ?? 'Envio indisponível.' }
    else if (startup && step.state === 'awaiting_context' && send?.state === 'sent') { state = 'failed'; error = 'O app reiniciou antes de vincular a execução da etapa. Confira o histórico antes de repetir.' }
    else if (startup && step.state === 'starting') { state = 'failed'; error = 'O app reiniciou antes de iniciar esta etapa.' }
    else if (startup && step.state === 'running' && !run) { state = 'failed'; error = 'Execução indisponível após reiniciar.' }
    if (state && !ACTIVE.includes(state)) db.prepare('UPDATE task_steps SET state=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(state, error, step.id)
  }
}
