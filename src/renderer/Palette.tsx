import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, name, type Active, type Task } from './api'
import { Icon } from './icons'
import { ATTENTION_LABEL, type Attention } from './attention'

type Item = { key: string; group: string; label: string; hint?: string; att?: Attention; kbd?: string; run: () => void }

// Ctrl+K: ir para tarefa, projeto ou acao pelo teclado. Busca as tarefas do projeto atual (inclusive arquivadas, sob pedido).
// ponytail: busca de tarefas so no projeto atual; busca global pede um listTasks sem projeto no processo principal.
// Com a busca vazia, o que precisa de voce (de qualquer pasta) vem primeiro: Enter abre a mais urgente.
export function Palette({ game, games, active, queue, attOf, onClose, onProject, onTask, onOpenTask, onNewTask, onHome, onSettings }: {
  game: string | null; games: string[]; active: Active[]; queue: { t: Task; a: Attention }[]; attOf: (t: Task) => Attention; onClose: () => void
  onProject: (g: string) => void; onTask: (id: number) => void; onOpenTask: (t: Task) => void; onNewTask: () => void; onHome: () => void; onSettings: () => void
}) {
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [hi, setHi] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!game) return
    let live = true
    const t = setTimeout(() => api.listTasks(game, { search: q.trim() || undefined, archived }).then((l: Task[]) => live && setTasks(l), () => {}), q ? 150 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [game, q, archived])
  useEffect(() => setHi(0), [q, archived])

  const s = q.trim().toLowerCase()
  const done = (f: () => void) => () => { onClose(); f() }
  const running = (id: number) => active.find(a => a.taskId === id)
  const sorted = [...tasks].sort((a, b) => Number(!!running(b.id)) - Number(!!running(a.id)) || Number(a.state === 'concluida') - Number(b.state === 'concluida'))
  const urgent = s || archived ? [] : queue.slice(0, 5)
  const items: Item[] = [
    ...urgent.map(q => ({ key: `q${q.t.id}`, group: 'Precisa de você', label: q.t.title, att: q.a, hint: `${ATTENTION_LABEL[q.a]} · ${name(q.t.game)}`, run: done(() => onOpenTask(q.t)) })),
    ...sorted.filter(t => !urgent.some(q => q.t.id === t.id)).slice(0, 12).map(t => ({
      key: `t${t.id}`, group: archived ? `Arquivadas em ${name(game!)}` : `Tarefas em ${name(game!)}`, label: t.title, att: archived ? undefined : attOf(t),
      hint: archived ? 'Restaurar e abrir' : t.state === 'concluida' ? 'Concluída' : undefined,
      run: done(() => archived ? api.archiveTask(t.id, false).then(() => onTask(t.id)) : onTask(t.id)),
    })),
    ...games.filter(g => g !== game && (!s || name(g).toLowerCase().includes(s))).slice(0, 6)
      .map(g => ({ key: `p${g}`, group: 'Projetos', label: name(g), hint: active.some(a => a.game.toLowerCase() === g.toLowerCase()) ? 'Agente trabalhando' : undefined, run: done(() => onProject(g)) })),
    ...([
      queue.length > 0 && { key: 'next', group: 'Ações', label: 'Próxima que precisa de você', kbd: 'Ctrl J', run: done(() => onOpenTask(queue[0].t)) },
      game && { key: 'new', group: 'Ações', label: `Nova tarefa em ${name(game)}`, kbd: 'Ctrl N', run: done(onNewTask) },
      game && { key: 'arch', group: 'Ações', label: archived ? 'Voltar às tarefas ativas' : 'Mostrar tarefas arquivadas', run: () => setArchived(!archived) },
      { key: 'home', group: 'Ações', label: 'Início', run: done(onHome) },
      { key: 'set', group: 'Ações', label: 'Configurações', run: done(onSettings) },
    ].filter(x => x && (!s || x.label.toLowerCase().includes(s) || x.key === 'arch')) as Item[]),
  ]
  const cur = Math.min(hi, items.length - 1)
  useEffect(() => { list.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' }) }, [cur])

  const key = (e: KeyboardEvent) => {
    if (!items.length && e.key !== 'Escape') return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((cur + 1) % items.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((cur - 1 + items.length) % items.length) }
    else if (e.key === 'Enter') { e.preventDefault(); items[cur]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="pal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Ir para">
        <div className="pal-in"><Icon n="search" size={17} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={key} placeholder={game ? `Buscar tarefa em ${name(game)}, projeto ou ação` : 'Buscar projeto ou ação'}
            role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant={items[cur] ? `pal-${items[cur].key}` : undefined} aria-label="Buscar" />
        </div>
        <ul id="pal-list" role="listbox" ref={list}>
          {items.map((it, i) => [
            (i === 0 || items[i - 1].group !== it.group) && <li key={`g${it.group}`} className="pal-group" role="presentation">{it.group}</li>,
            <li key={it.key} id={`pal-${it.key}`} role="option" aria-selected={i === cur} className={i === cur ? 'hi' : ''} onMouseMove={() => setHi(i)} onClick={it.run}>
              {it.att ? <span className="att" data-att={it.att} /> : <span className="pal-dot" />}
              <span className="pal-label">{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
              {it.kbd && <kbd>{it.kbd}</kbd>}
            </li>,
          ])}
          {items.length === 0 && <li className="pal-empty">Nada encontrado.</li>}
        </ul>
      </div>
    </div>
  )
}
