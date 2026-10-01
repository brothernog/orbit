// Agentes de uma tarefa agora: o pai (execucao em curso) e os filhos que ele chamou NESTA execucao, com a ferramenta atual.
// So leitura do banco + estado em memoria; nada daqui alimenta prompt ou memoria.
import type { DatabaseSync } from 'node:sqlite'

export type Doing = { tool: string; detail?: string }
export type TaskAgent = {
  kind: 'parent' | 'child'; id: number; provider: string; model: string | null; title: string
  status: string; mode: string | null; startedAt: number | null; endedAt: number | null; doing?: Doing
}
export type ParentRun = { runId: number; provider?: string; model?: string | null; startedAt?: number; doing?: Doing }

const ms = (s: string | null) => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : null)

// Sem pai rodando nao ha ninguem ativo: filhos sao cancelados junto com o pai (delegation.ts).
// childDoing: ferramenta atual por delegacao (preenchida pelo runner do filho, limpa quando ele termina).
export function taskAgents(db: DatabaseSync, taskId: number, parent: ParentRun | undefined, childDoing: Map<number, Doing>): TaskAgent[] {
  if (!parent) return []
  const kids = db.prepare('SELECT id, provider, model, mode, objective, status, started_at, ended_at FROM delegations WHERE task_id=? AND parent_run_id=? ORDER BY id')
    .all(taskId, parent.runId) as any[]
  return [
    { kind: 'parent', id: parent.runId, provider: parent.provider ?? '', model: parent.model ?? null, title: '', status: 'running', mode: null, startedAt: parent.startedAt ?? null, endedAt: null, doing: parent.doing },
    ...kids.map((d): TaskAgent => ({
      kind: 'child', id: d.id, provider: d.provider, model: d.model, title: d.objective, status: d.status, mode: d.mode,
      startedAt: ms(d.started_at), endedAt: ms(d.ended_at), doing: d.status === 'running' ? childDoing.get(d.id) : undefined
    }))
  ]
}
