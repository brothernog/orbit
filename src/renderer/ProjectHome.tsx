import { useContext, useEffect, useState, type CSSProperties } from 'react'
import { api, type Active, type Task } from './api'
import { NewInHeader, RoadmapCard } from './Home'
import { Icon, PROVIDER } from './icons'
import { ATTENTION_LABEL, attentionOf, RANK, useSeen } from './attention'
import { doingText, useBriefs } from './TaskBrief'
import { BranchPanel } from './Branch'
import { useProjects } from './projects'
import { useTodo } from './Todo'
import { coverTitle, totalText, type TotalLike } from './usageText'
import { Production } from './Production'

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()) / 1000
  return s < 90 ? 'agora' : s < 5400 ? `há ${Math.round(s / 60)} min` : s < 129600 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} d`
}
const elapsed = (from: number) => { const m = Math.max(0, Math.round((Date.now() - from) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min` }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const SHOWN = 8

// Parte de baixo da Nova de uma pasta: proximo passo, recentes, branch e roadmap. O topo (roda, titulo, chat) e o da Nova.
export function ProjectHome({ game, tasks, active, onOpenTask, onNewTask, onErr }: {
  game: string; tasks: Task[] | null; active: Active[]; onOpenTask: (id: number) => void; onNewTask: (title?: string) => unknown; onErr: (m: string) => void
}) {
  const todo = useTodo()
  const [usage, setUsage] = useState<Record<number, TotalLike>>({})
  const info = useProjects([game], 20_000)[game]
  useEffect(() => { api.projectUsage(game).then((rows: { taskId: number; tokens: number | null; state: TotalLike['state']; estimated: boolean }[]) => setUsage(Object.fromEntries(rows.map(r => [r.taskId, { sum: r.tokens, state: r.state, estimated: r.estimated }]))), () => {}) }, [game, tasks])

  const here = active.filter(a => same(a.game, game))
  const briefs = useBriefs(game, tasks, active)
  const seen = useSeen()
  const inHeader = useContext(NewInHeader)
  // Mesma ordem da fila do Inicio: o que pede voce, depois o que esta rodando, depois o mais recente.
  const rows = (tasks ?? []).map(t => { const who = here.find(a => a.taskId === t.id); return { t, who, att: attentionOf(t, briefs.get(t.id), who, seen[t.id]) } })
    .sort((a, b) => RANK[a.att] - RANK[b.att] || b.t.updated_at.localeCompare(a.t.updated_at)).slice(0, SHOWN)
  const nextTodo = todo.topics.flatMap(t => t.items.map(i => ({ t, i }))).find(x => !x.i.done && x.i.project && same(x.i.project, game))
  // Pasta principal e worktrees das tarefas isoladas: o painel de branch troca entre elas.
  const dirs = [{ path: game, label: info?.git?.branch ?? 'principal' }, ...(info?.worktrees ?? []).map(w => ({ path: w.path, label: w.task ?? w.branch ?? 'worktree' }))]

  return (
    <>
        <div className="ph-grid">
          <div className="ph-main">
            {nextTodo && <div className="now ph-next">
              <span className="now-label">Próximo passo</span>
              <p className="now-text">{nextTodo.i.text}</p>
              <small className="muted">Da sua to-do, em {nextTodo.t.title}</small>
            </div>}

            <section className="ph-sec">
              <div className="ph-sec-head"><h2 className="sec-label">Tarefas</h2>
                {!inHeader && <button className="text-btn" title="Nova tarefa (Ctrl+N)" onClick={() => onNewTask()}><Icon n="plus" size={14} />Nova tarefa</button>}</div>
              {tasks === null ? <span className="loader" aria-label="Carregando tarefas" />
                : rows.length === 0 ? <p className="muted ph-empty">Nenhuma tarefa ainda. {inHeader ? 'Use "Nova tarefa" para começar.' : ''}</p>
                : <ul className="ph-tasks stagger">
                    {rows.map(({ t, who, att }, i) => {
                      const b = briefs.get(t.id)
                      const state = who ? `${PROVIDER[who.provider]?.label ?? who.provider} · ${doingText(who.doing) ?? 'trabalhando'}`
                        : att === 'wait' && b?.permission ? `Permitir: ${b.permission}` : att === 'wait' ? 'Aprovar contexto' : ATTENTION_LABEL[att]
                      return (
                        <li key={t.id} style={{ '--i': i } as CSSProperties}>
                          <button className={`a-${att}`} onClick={() => onOpenTask(t.id)}>
                            <span className="att" data-att={att} />
                            <span className="pt-title">{t.title}</span>
                            <span className="pt-state" title={state}>{state}</span>
                            <span className="pt-tokens" title={`Tokens informados pelos provedores (entrada + saída). ${coverTitle(usage[t.id])}`}>{totalText(usage[t.id]) === '—' ? '' : totalText(usage[t.id])}</span>
                            <span className="pt-when">{who ? elapsed(who.startedAt) : ago(t.updated_at)}</span>
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
