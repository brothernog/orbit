import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { invalidatePending } from './consent.ts'
import { asInt, samePath } from './guard.ts'
import { endSend } from './sends.ts'

function atomic<T>(db: DatabaseSync, name: 'worktree_reset' | 'worktree_unlink', change: () => T): T {
  db.exec(`SAVEPOINT ${name}`)
  try { const result = change(); db.exec(`RELEASE ${name}`); return result }
  catch (e) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw e }
}

// A mudança de pasta cria outra sessão; pedidos ainda não enviados continuam recuperáveis.
export function resetWorkspace(db: DatabaseSync, taskIds: number[], reason: string): { packageIds: number[] } {
  const ids = [...new Set(taskIds.map(id => asInt(id, 'tarefa')))]
  return atomic(db, 'worktree_reset', () => {
    for (const id of ids) {
      const busy = db.prepare(`SELECT 1 FROM pending_sends WHERE task_id=? AND state='starting'
        UNION SELECT 1 FROM delegations WHERE task_id=? AND status IN ('running','awaiting_context_approval')
        UNION SELECT 1 FROM runs WHERE task_id=? AND status='running'
        UNION SELECT 1 FROM command_runs WHERE task_id=? AND status='running' LIMIT 1`).get(id, id, id, id)
      if (busy) throw Error('Pare as execuções desta tarefa antes de mudar a pasta de trabalho.')
    }
    const packageIds: number[] = []
    for (const id of ids) {
      const packages = db.prepare("SELECT id FROM context_packages WHERE task_id=? AND state='pending'").all(id) as { id: number }[]
      packageIds.push(...packages.map(p => p.id))
      const sends = db.prepare("SELECT id FROM pending_sends WHERE task_id=? AND state='awaiting_context_approval'").all(id) as { id: number }[]
      for (const send of sends) endSend(db, send.id, 'cancelled', reason)
      for (const pkg of packages) invalidatePending(db, { id: pkg.id, state: 'cancelled', reason })
      db.prepare('DELETE FROM task_sessions WHERE task_id=?').run(id)
      db.prepare('DELETE FROM metrics WHERE task_id=?').run(id)
    }
    return { packageIds }
  })
}

// Git já removeu a pasta: o pai ainda permite reconhecer junctions e nomes curtos.
function workspacePath(value: string) {
  const abs = path.resolve(value)
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)) }
  catch { return abs }
}

export function unlinkWorktree(db: DatabaseSync, removedPath: string): { taskIds: number[]; packageIds: number[] } {
  const removed = workspacePath(removedPath)
  const matches = (r: { id: number; worktree: string }) => samePath(workspacePath(r.worktree), removed)
  return atomic(db, 'worktree_unlink', () => {
    const tasks = (db.prepare('SELECT id,worktree FROM tasks WHERE worktree IS NOT NULL').all() as { id: number; worktree: string }[]).filter(matches)
    const pins = (db.prepare('SELECT id,worktree FROM pins WHERE worktree IS NOT NULL').all() as { id: number; worktree: string }[]).filter(matches)
    const taskIds = tasks.map(t => t.id)
    const { packageIds } = resetWorkspace(db, taskIds, 'Worktree removida; revise o contexto para a nova pasta de trabalho.')
    for (const t of tasks) db.prepare('UPDATE tasks SET worktree=NULL,branch=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(t.id)
    for (const p of pins) db.prepare('UPDATE pins SET worktree=NULL,branch=NULL WHERE id=?').run(p.id)
    return { taskIds, packageIds }
  })
}
