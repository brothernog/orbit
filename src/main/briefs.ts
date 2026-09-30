// Resumo curto de cada tarefa para a coluna de conversas: so o que ja esta gravado (execucoes, memoria da tarefa, pedidos
// pendentes). Nenhuma chamada a modelo, nenhum token. Sem dependencia de 'electron'.
import type { DatabaseSync } from 'node:sqlite'

export type Brief = {
  id: number
  last: 'completed' | 'failed' | 'cancelled' | null // ultima execucao terminada
  awaiting: boolean // pedido de contexto esperando a decisao do usuario
  permission: string | null // pedido de permissao pendente (resumo da acao), ex.: rodar um comando
  goal: string | null; result: string | null; next: string | null
}

const clip = (s: string | null | undefined, n = 110) => {
  const t = (s ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, '').replace(/\s+/g, ' ').trim()
  return t ? (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t) : null
}
// Primeira frase da resposta: resumo de reserva quando o agente nao gravou memoria.
const firstSentence = (s: string | null | undefined) => clip((s ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?:])\s/)[0])

export function taskBriefs(db: DatabaseSync, game: string): Brief[] {
  const tasks = db.prepare('SELECT id FROM tasks WHERE game=? AND archived_at IS NULL').all(game) as { id: number }[]
  const lastRun = db.prepare("SELECT status FROM runs WHERE task_id=? AND status<>'running' ORDER BY id DESC LIMIT 1")
  const perm = db.prepare("SELECT summary FROM permission_requests WHERE task_id=? AND state='pending' ORDER BY id LIMIT 1")
  const pending = db.prepare("SELECT 1 FROM context_packages WHERE task_id=? AND state='pending' LIMIT 1")
  const mem = (kinds: string) => db.prepare(`SELECT title FROM memory_items WHERE task_id=? AND state='active' AND kind IN (${kinds}) ORDER BY id DESC LIMIT 1`)
  const goal = mem("'objective'"), result = mem("'checkpoint','finding','decision','validation'")
  const next = db.prepare("SELECT title FROM memory_items WHERE task_id=? AND state='active' AND kind='todo' AND COALESCE(todo_state,'open') <>'done' ORDER BY id LIMIT 1")
  const reply = db.prepare("SELECT COALESCE(clean, text) AS t FROM messages WHERE task_id=? AND role='agent' AND status='completed' ORDER BY id DESC LIMIT 1")
  return tasks.map(({ id }) => {
    const r = lastRun.get(id) as { status: Brief['last'] } | undefined
    const g = goal.get(id) as any, res = result.get(id) as any, nx = next.get(id) as any
    return {
      id, last: r?.status ?? null, awaiting: !!pending.get(id), permission: clip((perm.get(id) as any)?.summary, 60),
      goal: clip(g?.title), result: clip(res?.title) ?? firstSentence((reply.get(id) as any)?.t), next: clip(nx?.title)
    }
  })
}
