import { createContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api, depth, errText, name, onChat, type Active, type Task } from './api'
import { effortLabel, modelName } from './Chat'

import { Markdown } from './Markdown'
import { Dropdown } from './Dropdown'
import { Icon, PROVIDER } from './icons'
import { dirtyCount, minutesSince, useProjects } from './projects'
import { TodoBoard, useTodo, type TodoApi, type TodoDraft } from './Todo'
import { ProjectIcon } from './Nav'
import { OrbitMark, usePulse } from './PulseCore'
import { digest, type Tone } from './nova'
import { attentionOf, needsYou, RANK, useSeen, type Attention } from './attention'
import { doingText, type Brief } from './TaskBrief'

// Estado que so o banco sabe (conversas esperando voce, concluidas hoje). Recarrega com os eventos dos agentes.
function useNovaState() {
  const [st, setSt] = useState<{ waiting: { id: number; game: string; title: string; why: string }[]; doneToday: Record<string, number> }>({ waiting: [], doneToday: {} })
  useEffect(() => {
    let live = true
    const load = () => api.novaState().then((s: any) => { if (live) setSt(s) }, () => {})
    load()
    const t = setInterval(load, 30_000)
    const off = onChat((ev: any) => { if (ev?.done || ev?.permissionRequest || ev?.permissionResolved || ev?.contextRequest || ev?.contextResolved) load() })
    return () => { live = false; clearInterval(t); off() }
  }, [])
  return st
}
const TONE_ICON: Record<Tone, string> = { wait: 'alert', live: 'spark', push: 'send', pull: 'down', dirty: 'edit' }
const SHOWN = 5 // o resto fica recolhido: poucas coisas na tela por vez

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite' }
const since = (min: number) => (min < 2 ? 'agora' : min < 90 ? `há ${min} min` : min < 2160 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} d`)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const ts = (iso: string) => new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime()
const ago = (iso: string) => since(Math.round((Date.now() - ts(iso)) / 60000))

// Fila de atencao do Inicio: tarefas de todas as pastas que pedem voce, falharam, estao prontas para revisar ou rodando.
// So leitura (listTasks + taskBriefs por pasta); recarrega com os eventos dos agentes.
type QRow = { key: string; att: Attention; game: string; id: number; title: string; why: string; when: string; rank: number; at: number }
function useQueue(games: string[], active: Active[], on: boolean) {
  const [data, setData] = useState<Record<string, { tasks: Task[]; briefs: Brief[] }>>({})
  const seen = useSeen()
  const key = `${on}|${games.join('|')}#${active.map(a => a.taskId).join(',')}`
  useEffect(() => {
    if (!on) return
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const load = () => Promise.all(games.map(g => Promise.all([api.listTasks(g, {}), api.taskBriefs(g)]).then(([tasks, briefs]) => [g, { tasks, briefs }] as const, () => null)))
      .then(l => { if (live) setData(Object.fromEntries(l.filter(x => x !== null))) })
    load()
    const off = onChat((ev: any) => { if (ev?.done || ev?.refresh || ev?.permissionRequest || ev?.permissionResolved || ev?.contextRequest || ev?.contextResolved) { clearTimeout(timer); timer = setTimeout(load, 300) } })
    const t = setInterval(load, 60_000)
    return () => { live = false; off(); clearTimeout(timer); clearInterval(t) }
  }, [key])
  if (!on) return []
  const rows: QRow[] = [], shown = new Set<number>()
  for (const g of games) {
    const d = data[g]
    if (!d) continue
    const bs = new Map(d.briefs.map(b => [b.id, b]))
    for (const t of d.tasks) {
      const b = bs.get(t.id), who = active.find(a => a.taskId === t.id), att = attentionOf(t, b, who, seen[t.id])
      // falha antiga ja vista (ou de mais de um dia, sem registro) nao ocupa a fila para sempre
      if (!needsYou(att) && att !== 'working') continue
      const why = att === 'wait' ? (b?.permission ? `Permitir: ${b.permission}` : 'Aprovar o contexto para continuar')
        : att === 'error' ? 'A última execução falhou'
        : att === 'unseen' ? (b?.result ?? 'Resposta pronta para revisar')
        : `${PROVIDER[who!.provider]?.label ?? who!.provider} · ${doingText(who!.doing) ?? 'trabalhando'}`
      rows.push({ key: `t${t.id}`, att, game: g, id: t.id, title: t.title, why, rank: RANK[att], at: who ? who.startedAt : ts(t.updated_at),
        when: who ? since(Math.round((Date.now() - who.startedAt) / 60000)).replace('há ', '') : ago(t.updated_at) })
      shown.add(t.id)
    }
  }
  // agente que acabou de comecar numa tarefa que a lista ainda nao trouxe
  for (const a of active) { const g = games.find(x => same(x, a.game)); if (g && !shown.has(a.taskId))
    rows.push({ key: `t${a.taskId}`, att: 'working', game: g, id: a.taskId, title: a.title, why: `${PROVIDER[a.provider]?.label ?? a.provider} · ${doingText(a.doing) ?? 'trabalhando'}`, rank: RANK.working, at: a.startedAt, when: since(Math.round((Date.now() - a.startedAt) / 60000)).replace('há ', '') }) }
  return rows.sort((a, b) => a.rank - b.rank || b.at - a.at)
}

// A pasta aberta tem "Nova tarefa" no titulo: a lista de tarefas embaixo nao repete o botao.
export const NewInHeader = createContext(false)

// Roadmap de um projeto: progresso e os proximos itens, com marcar feito (grava no .md) e mandar para a to-do.
const LINE = /^(\s*[-*] )\[( |x)\] (.*)$/i
export function RoadmapCard({ games, initial, todo, onOpen, fixed }: { games: string[]; initial: string | null; todo: TodoApi; onOpen: (g: string) => void; fixed?: boolean }) {
  const [game, setGame] = useState<string | null>(initial)
  const [doc, setDoc] = useState<{ path: string; text: string } | null | undefined>(undefined)
  const [err, setErr] = useState('')
  useEffect(() => { if (!game && initial) setGame(initial) }, [initial])
  useEffect(() => {
    if (!game) return
    setDoc(undefined); setErr('')
    api.listDocs(game).then(async (d: string[]) => {
      const r = d.filter(p => name(p).toLowerCase() === 'roadmap.md').sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0]
      setDoc(r ? { path: r, text: await api.readDoc(game, r) } : null)
    }, e => { setErr(errText(e)); setDoc(null) })
  }, [game])

  const lines = doc?.text.split('\n') ?? []
  let section = ''
  const items = lines.map((l, n) => {
    if (/^#{1,3} /.test(l)) section = l.replace(/^#+ /, '').trim()
    const m = l.match(LINE)
    return m ? { n, done: m[2].toLowerCase() === 'x', text: m[3].trim(), section } : null
  }).filter(Boolean) as { n: number; done: boolean; text: string; section: string }[]
  const done = items.filter(i => i.done).length
  const next = items.filter(i => !i.done && i.text).slice(0, 5)
  const toggle = (n: number) => {
    if (!game || !doc) return
    const ls = [...lines]
    ls[n] = ls[n].replace(LINE, (_, a, x, t) => `${a}[${x === ' ' ? 'x' : ' '}] ${t}`)
    const text = ls.join('\n')
    setDoc({ ...doc, text })
    api.writeDoc(game, doc.path, text).catch((e: any) => { setErr(errText(e)); setDoc(doc) })
  }

  return (
    <aside className="roadmap-card" aria-label="Roadmap">
      <div className="rc-head">
        <Icon n="map" size={16} />
        <b>Roadmap</b>
        {!fixed && games.length > 0 && <Dropdown down label="Projeto do roadmap" value={game ?? ''} placeholder="Escolher projeto" search={games.length > 8}
          options={games.map(g => ({ value: g, label: name(g) }))} onChange={setGame} />}
      </div>
      {!game ? <p className="muted">Escolha um projeto para ver o roadmap.</p>
        : doc === undefined ? <span className="loader" aria-label="Carregando roadmap" />
        : doc === null ? <div className="rc-empty"><p className="muted">Este projeto ainda não tem ROADMAP.md.</p>{!fixed && <button className="text-btn" onClick={() => onOpen(game)}>Abrir projeto</button>}</div>
        : <>
            <div className="rc-progress" role="progressbar" aria-label="Progresso do roadmap" aria-valuenow={done} aria-valuemin={0} aria-valuemax={items.length}>
              <div style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
            </div>
            <small>{done} de {items.length} concluídos</small>
            <ul className="rc-list">
              {next.map(i => (
                <li key={i.n}>
                  <button className="check-btn" role="checkbox" aria-checked={false} aria-label={`Concluir: ${i.text}`} onClick={() => toggle(i.n)}>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M6 10.5l2.6 2.5L14 7.5" /></svg>
                  </button>
                  <span className="rc-text">{i.text}{i.section && !/^roadmap$/i.test(i.section) && <small>{i.section}</small>}</span>
                  <button className="icon sm" aria-label="Mandar para a to-do" title="Mandar para a to-do" onClick={() => todo.add(todo.topics[0].id, i.text, [], game)}><Icon n="plus" size={14} /></button>
                </li>
              ))}
              {next.length === 0 && <li className="muted">Tudo concluído no roadmap.</li>}
            </ul>
          </>}
      {err && <small className="err">{err}</small>}
    </aside>
  )
}

type JAction = { type: 'todo'; text: string; project?: string; topic?: string; done?: { tid: string; iid: string; topic: string } } | { type: 'open'; project: string }

// Nova: topo igual em toda parte (marca, titulo, campo da Nova). Embaixo, por secao: no Inicio, a fila do que pede voce,
// a to-do e o roadmap; numa pasta (`below`), as secoes dela. `tag` = organizador da pasta.
export function Home({ games, tag, siblings, below, active, onOpen, onAdd, lastGame, onTodoTask, onNewTask }: {
  games: string[]; tag?: { name: string; color: string } | null; siblings?: string[]; below?: ReactNode; active: Active[]; onOpen: (g: string) => void; onAdd: () => void; lastGame: string | null
  onTodoTask: (game: string, id: number, draft?: TodoDraft) => void; onNewTask?: () => void
}) {
  const nova = useNovaState()
  const [all, setAll] = useState(false)
  const todo = useTodo()
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [thinking, setThinking] = useState(false)
  const [stream, setStream] = useState('')
  const [asking, setAsking] = useState('')
  const [turns, setTurns] = useState<{ q: string; a: string; actions: JAction[]; error?: string }[]>([])
  const [jcfg, setJcfg] = useState<{ model: string; effort: string } | null>(null)
  useEffect(() => { api.getJarvisSettings().then(setJcfg, () => {}) }, [])
  useEffect(() => onChat(ev => { if (ev.jarvis) setStream(ev.text) }), [])
  const pulse = usePulse()
  const nextItem = todo.topics.flatMap(t => t.items).find(i => !i.done)
  const info = useProjects(games)
  const live = (g: string) => active.some(a => same(a.game, g))
  const byActivity = [...games].sort((a, b) => Number(live(b)) - Number(live(a)) || minutesSince(info[a]?.lastActivity ?? null) - minutesSince(info[b]?.lastActivity ?? null))
  const here = below ? active.filter(a => same(a.game, games[0])) : active.filter(a => games.some(g => same(g, a.game)))

  // Fila: tarefas primeiro (atencao), depois o Git que ficou aberto. Numa pasta a lista de tarefas dela faz esse papel.
  const queue = useQueue(games, active, !below)
  const git = digest({ games, info, active: [], waiting: [], name, label: p => p, now: Date.now() }).items
  const needs = queue.filter(r => needsYou(r.att)).length, working = queue.length - needs
  const rows = [...queue.map(r => ({ ...r, git: false as const })), ...git.map(g => ({ ...g, git: true as const }))]
  const shown = all ? rows : rows.slice(0, SHOWN)
  const doneToday = games.reduce((n, g) => n + (nova.doneToday[g] ?? 0), 0)
  const headline = below ? projLine(games[0])
    : needs ? `${working ? `${working === 1 ? 'Um agente trabalhando' : `${working} agentes trabalhando`}; o resto` : 'Nenhum agente trabalhando. A fila abaixo'} espera você.`
    : working ? `${working === 1 ? 'Um agente trabalhando' : `${working} agentes trabalhando`}. Nada esperando você.`
    : git.length ? 'Nenhum agente agora. Falta fechar o que ficou aberto no Git.'
    : 'Tudo em dia. Nada pede você agora.'

  // Frase curta de uma pasta: quem esta nela e como esta o Git. Tambem vira a dica dos chips de pasta.
  function projLine(g: string) {
    const i = info[g], on = active.filter(a => same(a.game, g)), m = minutesSince(i?.lastActivity ?? null), n = dirtyCount(i)
    return [
      on.length ? `${PROVIDER[on[0].provider]?.label ?? on[0].provider} está em "${on[0].title}".` : m === Infinity ? 'Nenhuma tarefa ainda.' : `Sem agente agora; última atividade ${since(Math.round(m))}.`,
      !i ? '' : !i.repo ? `${i.stack}, sem Git.` : n ? `${n} arquivo${n > 1 ? 's' : ''} sem commit.` : `Git limpo em ${i.git?.branch ?? 'HEAD'}.`,
    ].filter(Boolean).join(' ')
  }

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    const pin = t.match(/^\/(fixar|todo)\s+(.+)/i)
    if (pin) { if (await todo.add(todo.topics[0].id, pin[2], [], below ? games[0] : undefined)) { setText(''); setNote(`Fixado em "${todo.topics[0].title}".`) } return }
    setText(''); setNote(''); setStream(''); setAsking(t); setThinking(true)
    const q = t.replace(/^\/resumo\b\s*/i, 'Resuma o que foi concluído e o que falta nos projetos, em poucas linhas. ')
    const only = below ? games[0] : undefined // Nova de uma pasta: so a to-do dela vai junto
    const snapTodo = todo.topics.flatMap(tp => tp.items.filter(i => !only || (i.project && same(i.project, only))).map(i => ({ topic: tp.title, text: i.text, done: i.done, project: i.project && name(i.project), agent: i.agent })))
    const history = turns.slice(-3).flatMap(x => [{ role: 'user', text: x.q }, { role: 'jarvis', text: x.a }])
    api.askJarvis(q, snapTodo, history, only).then(async (r: { status: string; text: string; actions: JAction[]; error?: string }) => {
      if (r.status === 'cancelled') return
      // Acoes: "todo" entra direto na lista (com desfazer); "open" vira um botao, nunca navega sozinho.
      const actions = await Promise.all(r.actions.map(async a => {
        if (a.type !== 'todo') return a
        const tp = todo.topics.find(x => a.topic && x.title.toLowerCase() === a.topic.toLowerCase()) ?? todo.topics[0]
        const g = games.find(x => a.project && name(x) === a.project)
        const iid = await todo.add(tp.id, a.text, [], g)
        return iid ? { ...a, done: { tid: tp.id, iid, topic: tp.title } } : a
      }))
      setTurns(ts => [...ts, { q: t, a: r.text, actions, error: r.status === 'failed' ? r.error : undefined }].slice(-6))
    }, (e: any) => setTurns(ts => [...ts, { q: t, a: '', actions: [], error: errText(e) }])).finally(() => { setThinking(false); setStream('') })
  }
  const last = turns[turns.length - 1]
  const coreGames = below ? [games[0]] : games

  return (
    <main className="home">
      <div className="home-inner">
        <header className="bridge" key={below ? games[0] : '-'}>
          <OrbitMark events={coreGames.flatMap(g => pulse.events[g] ?? [])} commits={coreGames.flatMap(g => pulse.proj[g]?.commits ?? [])} busy={here.length > 0} thinking={thinking}>
            {below ? <ProjectIcon game={games[0]} size={28} /> : undefined}
          </OrbitMark>
          <div className="brief">
            {tag && <span className="scope-tag" style={{ '--g': tag.color } as CSSProperties}>{tag.name}</span>}
            <h1>{below ? name(games[0]) : `${greeting()}.`}</h1>
            <p>{headline}{!below && doneToday > 0 && <span className="done-today"><Icon n="check" size={13} />{doneToday} {doneToday === 1 ? 'concluída' : 'concluídas'} hoje</span>}</p>
          </div>
          {below && onNewTask && <button className="primary bridge-new" title="Nova tarefa (Ctrl+N)" onClick={onNewTask}><Icon n="plus" size={16} />Nova tarefa<kbd>Ctrl N</kbd></button>}
          {below && siblings && siblings.length > 1 && <nav className="sibs" aria-label={`Pastas em ${tag?.name ?? 'Sem organizador'}`}>
            {siblings.map(g => <button key={g} aria-current={g === games[0]} title={g} onClick={() => g !== games[0] && onOpen(g)}>
              <i className={`dot ${live(g) ? 'live' : ''}`} />{name(g)}</button>)}
          </nav>}
        </header>

        {!below && rows.length > 0 && (
          <section className="queue" aria-label="O que pede você">
            <h2 className="sec-label">{needs ? <>Pede você <span className="att-count">{needs}</span></> : queue.length ? 'Em andamento' : 'Git'}</h2>
            <ul className="q-list stagger">
              {shown.map((r, i) => (
                <li key={r.key} style={{ '--i': i } as CSSProperties}>
                  {r.git
                    ? <button className={`q-row git t-${r.tone}`} onClick={() => onOpen(r.game)}>
                        <span className="q-ico"><Icon n={TONE_ICON[r.tone]} size={13} /></span>
                        <span className="q-title">{r.text}</span>
                        <span className="q-why">{r.meta}</span>
                        <Icon n="chevron" size={14} />
                      </button>
                    : <button className={`q-row a-${r.att}`} onClick={() => onTodoTask(r.game, r.id)}>
                        <span className="att" data-att={r.att} title={r.att === 'wait' ? 'Precisa de você' : undefined} />
                        <span className="q-title">{r.title}</span>
                        <span className="q-why">{r.why}</span>
                        <span className="q-proj">{name(r.game)}</span>
                        <span className="q-when">{r.when}</span>
                        <Icon n="chevron" size={14} />
                      </button>}
                </li>
              ))}
            </ul>
            {rows.length > SHOWN && <button className="text-btn q-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Mostrar menos' : `Mais ${rows.length - SHOWN}`}</button>}
          </section>
        )}

        <div className="nova-box">
          <form className={`jarvis ${thinking ? 'thinking' : ''}`} onSubmit={e => { e.preventDefault(); submit() }}>
            <Icon n="spark" size={18} />
            <input aria-label="Fale com a Nova" placeholder={thinking ? 'Pensando…' : below ? `Pergunte sobre ${name(games[0])}, ou "/fixar texto"` : 'Peça algo à Nova, ou "/fixar texto" para mandar para a lista'} value={text} disabled={thinking} onChange={e => setText(e.target.value)} />
            <span className="cmds">
              {[['/fixar', 'Mandar para a to-do'], ['/resumo', 'O que foi concluído e o que falta']].map(([c, d]) =>
                <button type="button" key={c} className="cmd" title={d} onClick={() => setText(c + ' ')}>{c}</button>)}
            </span>
            <span className="jarvis-model" title="Modelo do assistente (muda em Configurações)">{jcfg ? `${modelName(jcfg.model)}, ${effortLabel(jcfg.effort).toLowerCase()}` : 'Nova'}</span>
            {thinking
              ? <button type="button" className="send stop" aria-label="Parar" title="Parar" onClick={() => api.stopJarvis()}><Icon n="stop" size={15} /></button>
              : <button className="send" aria-label="Enviar" title="Enviar (Enter)" disabled={!text.trim()}><Icon n="send" size={16} /></button>}
          </form>
          {note && <p className="jarvis-note" role="status">{note}</p>}
          {(thinking || last) && (
            <div className={`jarvis-reply ${thinking ? 'streaming' : ''}`} aria-live="polite">
              <p className="jr-q">{thinking ? asking : last!.q}</p>
              {thinking
                ? stream ? <Markdown text={stream} /> : <span className="typing" aria-label="Pensando"><i /><i /><i /></span>
                : last!.error ? <p className="err">{last!.error}</p> : <Markdown text={last!.a || 'Sem resposta.'} />}
              {!thinking && last!.actions.length > 0 && <div className="jr-actions">
                {last!.actions.map((a, i) => a.type === 'open'
                  ? <button key={i} className="mini" onClick={() => { const g = games.find(x => name(x) === a.project); if (g) onOpen(g) }}>Abrir {a.project}</button>
                  : <span key={i} className="jr-done"><Icon n="plus" size={13} />Na to-do ({a.done!.topic}): {a.text}
                      <button className="link" onClick={() => { todo.remove(a.done!.tid, a.done!.iid); setTurns(ts => ts.map(x => x === last ? { ...x, actions: x.actions.filter(y => y !== a) } : x)) }}>Desfazer</button></span>)}
              </div>}
              {!thinking && <button className="icon sm jr-close" aria-label="Fechar resposta" onClick={() => setTurns([])}><Icon n="close" size={13} /></button>}
            </div>
          )}
        </div>

        {below ? <NewInHeader.Provider value={!!onNewTask}>{below}</NewInHeader.Provider> : <>
        <div className="focus-grid">
          <TodoBoard todo={todo} projects={games} onOpen={onTodoTask} />
          <RoadmapCard games={games} initial={lastGame && games.includes(lastGame) ? lastGame : byActivity[0] ?? null} todo={todo} onOpen={onOpen} />
        </div>

        <section className="proj-strip" aria-label="Projetos">
          <div className="sec-head"><h2 className="sec-label">Pastas</h2>
            <button className="text-btn" onClick={onAdd}><Icon n="plus" size={14} />Adicionar pasta</button></div>
          {games.length === 0
            ? <p className="muted">Nenhuma pasta de projetos ainda. Use "Adicionar pasta" para trazer a pasta de um jogo, app ou site.</p>
            : <div className="chips">
                {byActivity.map(g => {
                  const i = info[g], on = live(g), dirty = dirtyCount(i)
                  return (
                    <button key={g} className={`pchip ${on ? 'live' : ''}`} title={`${g}\n${projLine(g)}`} onClick={() => onOpen(g)}>
                      <span className="pchip-icon"><ProjectIcon game={g} size={18} /></span>
                      <span>{name(g)}</span>
                      {on ? <span className="att" data-att="working" aria-label="agente trabalhando" />
                        : <i className={`dot ${dirty ? 'dirty' : 'clean'}`} aria-label={dirty ? `${dirty} arquivos sem commit` : 'limpo'} />}
                    </button>
                  )
                })}
              </div>}
        </section>
        </>}
      </div>
    </main>
  )
}
