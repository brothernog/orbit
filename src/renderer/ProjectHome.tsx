import { useEffect, useState, type CSSProperties } from 'react'
import { api, type Active, type Task } from './api'
import { RoadmapCard } from './Home'
import { Avatar, Icon, PROVIDER } from './icons'
import { BranchPanel } from './Branch'
import { useProjects } from './projects'
import type { TodoApi } from './Todo'
import { coverTitle, totalText, type TotalLike } from './usageText'
import { Production } from './Production'
import { agoText, elapsedMin, same } from './time'

const STATE = { aberta: 'Aberta', andamento: 'Em andamento', concluida: 'Concluída' }

// Parte de baixo da Nova de uma pasta: proximo passo, recentes, branch e roadmap. O topo (roda, titulo, chat) e o da Nova.
export function ProjectHome({ game, todo, tasks, active, onOpenTask, onNewTask, onErr }: {
  game: string; todo: TodoApi; tasks: Task[] | null; active: Active[]; onOpenTask: (id: number) => void; onNewTask: (title?: string) => unknown; onErr: (m: string) => void
}) {
  const [usage, setUsage] = useState<Record<number, TotalLike>>({})
  const info = useProjects([game], 20_000)[game]
  useEffect(() => { api.projectUsage(game).then((rows: { taskId: number; tokens: number | null; state: TotalLike['state']; estimated: boolean }[]) => setUsage(Object.fromEntries(rows.map(r => [r.taskId, { sum: r.tokens, state: r.state, estimated: r.estimated }]))), () => {}) }, [game, tasks])

  const here = active.filter(a => same(a.game, game))
  const recent = [...(tasks ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6)
  const nextTodo = todo.topics.flatMap(t => t.items.map(i => ({ t, i }))).find(x => !x.i.done && x.i.project && same(x.i.project, game))
  // Pasta principal e worktrees das tarefas isoladas: o painel de branch troca entre elas.
  const dirs = [{ path: game, label: info?.git?.branch ?? 'principal' }, ...(info?.worktrees ?? []).map(w => ({ path: w.path, label: w.task ?? w.branch ?? 'worktree' }))]

  return (
    <>
        <div className="ph-grid">
          <div className="ph-main">
            {here.length
              ? <div className="now live-now">
                  <span className="now-label">Agora</span>
                  {here.map(a => (
                    <button key={`${a.kind}${a.id}`} className="now-agent" onClick={() => onOpenTask(a.taskId)}>
                      <Avatar provider={a.provider} live />
                      <span className="now-body"><span className="now-text">{a.title}</span><small>{PROVIDER[a.provider]?.label ?? a.provider}{a.model ? ` ${a.model}` : ''}, há {elapsedMin(a.startedAt)}{a.kind === 'delegation' ? ', delegação' : ''}</small></span>
                      <Icon n="chevron" size={16} />
                    </button>
                  ))}
                </div>
              : <div className="now">
                  <span className="now-label">Próximo passo</span>
                  <p className="now-text">{nextTodo ? nextTodo.i.text : recent.find(t => t.state !== 'concluida')?.title ?? 'Nada pendente nesta pasta.'}</p>
                  <small className="muted">{nextTodo ? `Da sua to-do, em ${nextTodo.t.title}` : recent.find(t => t.state !== 'concluida') ? 'Tarefa aberta mais recente' : 'Use "Nova tarefa" para começar.'}</small>
                </div>}

            <section className="ph-sec">
              <div className="ph-sec-head"><h2>Recentes</h2>
                <button className="text-btn" onClick={() => onNewTask()}><Icon n="plus" size={14} />Nova tarefa<kbd>Ctrl N</kbd></button></div>
              {tasks === null ? <span className="loader" aria-label="Carregando tarefas" />
                : recent.length === 0 ? <p className="muted">Nenhuma tarefa ainda.</p>
                : <ul className="ph-tasks">
                    {recent.map((t, i) => {
                      const who = here.find(a => a.taskId === t.id)
                      return (
                        <li key={t.id} style={{ '--i': i } as CSSProperties}>
                          <button onClick={() => onOpenTask(t.id)}>
                            <span className={`task-dot s-${t.state}`} aria-hidden="true" />
                            <span className="pt-title">{t.title}</span>
                            {who && <Avatar provider={who.provider} live size="sm" />}
                            <span className="pt-state">{STATE[t.state]}</span>
                            <span className="pt-tokens" title={`Tokens informados pelos provedores (entrada + saída). ${coverTitle(usage[t.id])}`}>{totalText(usage[t.id])}</span>
                            <span className="pt-when">{agoText(t.updated_at)}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>}
            </section>
          </div>

          <div className="ph-side">
            {!info ? <section className="branch"><span className="loader" aria-label="Lendo o Git" /></section>
              : !info.repo ? <section className="branch"><p className="br-note">{info.error ? `Não foi possível ler o Git: ${info.error}` : 'Esta pasta não é um repositório Git.'}</p></section>
              : <BranchPanel key={dirs.map(d => d.path).join('|')} dirs={dirs} onErr={onErr} />}
            <RoadmapCard key={game} games={[game]} initial={game} todo={todo} onOpen={() => {}} fixed />
          </div>
        </div>
        <Production key={game} game={game} onOpenTask={onOpenTask} onErr={onErr} />
    </>
  )
}
