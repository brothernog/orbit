// Mensagens retidas ate o usuario decidir sobre o contexto de que dependem. O usuario ve o pacote EXATO e escolhe: aprovar e executar,
// executar sem contexto ou cancelar. Antes da decisao nenhum processo e iniciado; tempo esgotado, reinicio ou cancelamento NUNCA iniciam a
// execucao e deixam o texto recuperavel. Estados de aprovacao (consent.ts) e de envio ficam separados. Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'
import { invalidatePending } from './consent.ts'
import type { TaskSel } from './tasks.ts'

const get = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any
const all = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[]
const NOW = "strftime('%Y-%m-%d %H:%M:%f','now')"

export type SendState = 'awaiting_context_approval' | 'starting' | 'sent' | 'cancelled' | 'expired'
export type SendRow = {
  id: number; task_id: number; package_id: number | null; text: string; sel: TaskSel; state: SendState
  decision: string | null; reason: string | null; dismissed: number; created_at: string; resolved_at: string | null
}
const load = (r: any): SendRow => ({ ...r, sel: JSON.parse(r.sel) })

export const getSend = (db: DatabaseSync, id: number): SendRow | null => { const r = get(db, 'SELECT * FROM pending_sends WHERE id=?', id); return r ? load(r) : null }
export const awaitingSend = (db: DatabaseSync, taskId: number): SendRow | null => {
  const r = get(db, "SELECT * FROM pending_sends WHERE task_id=? AND state='awaiting_context_approval'", taskId)
  return r ? load(r) : null
}

// Reserva a tarefa: so uma mensagem aguardando por vez (indice unico parcial: vale mesmo sob corrida).
export function createSend(db: DatabaseSync, o: { taskId: number; packageId: number; text: string; sel: TaskSel }): SendRow {
  try {
    const id = Number(db.prepare('INSERT INTO pending_sends (task_id, package_id, text, sel) VALUES (?,?,?,?)').run(o.taskId, o.packageId, o.text, JSON.stringify(o.sel)).lastInsertRowid)
    return getSend(db, id)!
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message))) throw new Error(AWAITING_MSG)
    throw e
  }
}
export const AWAITING_MSG = 'Ha uma mensagem aguardando a sua decisao sobre contexto nesta tarefa: aprove, execute sem contexto ou cancele o envio antes de mandar outra.'

// Transicao atomica (clique duplo, decisao concorrente e timeout so vencem uma vez): devolve false se o estado ja mudou.
export function moveSend(db: DatabaseSync, id: number, from: SendState, to: SendState, o: { decision?: string; reason?: string } = {}): boolean {
  const done = to === 'starting' || to === 'sent' ? '' : `, resolved_at=${NOW}`
  return Number(db.prepare(`UPDATE pending_sends SET state=?, decision=COALESCE(?, decision), reason=COALESCE(?, reason)${done} WHERE id=? AND state=?`)
    .run(to, o.decision ?? null, o.reason ?? null, id, from).changes) > 0
}

// Cancelar/expirar o envio tambem invalida o pedido de contexto dele: aprovar depois nao faz nada e nada inicia.
export function endSend(db: DatabaseSync, id: number, state: 'cancelled' | 'expired', reason: string): boolean {
  const s = getSend(db, id)
  if (!s || !moveSend(db, id, 'awaiting_context_approval', state, { reason })) return false
  if (s.package_id) invalidatePending(db, { id: s.package_id, state, reason })
  return true
}

// Envios que a decisao humana nunca alcancou (reinicio do app): expiram; o texto continua recuperavel.
export const reconcileSends = (db: DatabaseSync) =>
  all(db, "SELECT id FROM pending_sends WHERE state='awaiting_context_approval'").filter(r => endSend(db, r.id, 'expired', 'app reiniciado antes da decisao')).length
// Uma decisao aceita ('starting') cuja CLI nao chegou a iniciar antes de o app fechar tambem nao pode ficar presa.
export const reconcileStarting = (db: DatabaseSync) =>
  Number(db.prepare(`UPDATE pending_sends SET state='cancelled', reason='app reiniciado antes de iniciar', resolved_at=${NOW} WHERE state='starting'`).run().changes)

// Aguardando + cancelados/expirados ainda nao dispensados (mensagem recuperavel).
export const listSends = (db: DatabaseSync, taskId: number): SendRow[] =>
  all(db, "SELECT * FROM pending_sends WHERE task_id=? AND (state='awaiting_context_approval' OR (state IN ('cancelled','expired') AND dismissed=0)) ORDER BY id", taskId).map(load)

// Recuperar devolve o texto e tira o envio da lista (so de envios NAO iniciados).
export function recoverSend(db: DatabaseSync, id: number): string | null {
  const s = getSend(db, id)
  if (!s || !['cancelled', 'expired'].includes(s.state)) return null
  db.prepare('UPDATE pending_sends SET dismissed=1 WHERE id=?').run(id)
  return s.text
}

// Prazo de espera humana. O relogio so serve para EXPIRAR: nunca inicia nada.
export function scheduleExpiry(db: DatabaseSync, id: number, ms: number, onExpired: (s: SendRow) => void): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (endSend(db, id, 'expired', `sem decisao em ${Math.round(ms / 60000) || '<1'} min`)) onExpired(getSend(db, id)!)
  }, ms)
  timer.unref?.()
  return timer
}
