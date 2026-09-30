import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { api, depth, errText, name, onChat, type Active } from './api'
import { effortLabel, modelName } from './labels'

import { Markdown } from './Markdown'
import { Dropdown } from './Dropdown'
import { Icon, PROVIDER } from './icons'
import { dirtyCount, useProjects } from './projects'
import { minutesSince, same } from './time'
import { TodoBoard, useTodo, type TodoApi, type TodoDraft } from './Todo'
import { ProjectIcon } from './Nav'
import { PulseCore, usePulse } from './PulseCore'
import { digest, type Tone } from './nova'
import { useCachedRead } from './useCachedRead'

// Estado que so o banco sabe (conversas esperando voce, concluidas hoje). Recarrega com os eventos dos agentes.
function useNovaState() {
  const [st, setSt] = useState<{ waiting: { id: number; game: string; title: string; why: string }[]; doneToday: Record<string, number> }>({ waiting: [], doneToday: {} })
  useEffect(() => {
    let live = true
    const load = () => api.novaState().then((s: any) => { if (live) setSt(prev => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s)) }, () => {})
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 30_000)
    const off = onChat((ev: any) => { if (ev?.done || ev?.permissionRequest || ev?.permissionResolved || ev?.contextRequest || ev?.contextResolved) load() })
    return () => { live = false; clearInterval(t); off() }
  }, [])
  return st
}
const TONE_ICON: Record<Tone, string> = { wait: 'alert', live: 'spark', push: 'send', pull: 'down', dirty: 'edit' }
const SHOWN = 4 // o resto fica recolhido: poucas coisas na tela por vez

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite' }
const since = (min: number) => (min < 2 ? 'agora' : min < 90 ? `há ${min} min` : min < 2160 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} d`)

// Roadmap de um projeto: progresso e os proximos itens, com marcar feito (grava no .md) e mandar para a to-do.
const LINE = /^(\s*[-*] )\[( |x)\] (.*)$/i
function parseRoadmap(text: string | undefined) {
  const lines = text?.split('\n') ?? []
  let section = ''
  const items = lines.map((l, n) => {
    if (/^#{1,3} /.test(l)) section = l.replace(/^#+ /, '').trim()
    const m = l.match(LINE)
    return m ? { n, done: m[2].toLowerCase() === 'x', text: m[3].trim(), section } : null
  }).filter(Boolean) as { n: number; done: boolean; text: string; section: string }[]
  return { lines, items }
}
export function RoadmapCard({ games, initial, todo, onOpen, fixed }: { games: string[]; initial: string | null; todo: TodoApi; onOpen: (g: string) => void; fixed?: boolean }) {
  const [game, setGame] = useState<string | null>(initial)
  const [doc, setDoc] = useState<{ path: string; text: string } | null | undefined>(undefined)
  const [err, setErr] = useState('')
  useEffect(() => { if (!game && initial) setGame(initial) }, [initial])
  useEffect(() => {
    if (!game) return
    let live = true
    setDoc(undefined); setErr('')
    api.listDocs(game).then(async (d: string[]) => {
      const r = d.filter(p => name(p).toLowerCase() === 'roadmap.md').sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0]
      const found = r ? { path: r, text: await api.readDoc(game, r) as string } : null
      if (live) setDoc(found)
    }).catch(e => { if (live) { setErr(errText(e)); setDoc(null) } })
    return () => { live = false }
  }, [game])

  const { lines, items } = useMemo(() => parseRoadmap(doc?.text), [doc?.text])
  const done = items.filter(i => i.done).length
  const next = items.filter(i => !i.done && i.text).slice(0, 5)
  const toggle = (n: number) => {
    if (!game || !doc) return
    const ls = [...lines]
    ls[n] = ls[n].replace(LINE, (_, a, x, t) => `${a}[${x === ' ' ? 'x' : ' '}] ${t}`)
    const text = ls.join('\n')
    setDoc({ ...doc, text })
    api.editDoc(game, doc.path, doc.text, text).catch((e: any) => { setErr(errText(e)); setDoc(doc) })
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
                  <span className="rc-text">{i.text}{i.section && <small>{i.section}</small>}</span>
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

// Texto ao vivo da Nova: o estado fica aqui para que cada trecho nao re-renderize o Inicio inteiro (nucleo, to-do, roadmap).
// Monta a cada pergunta (so aparece pensando), entao comeca vazio sem precisar limpar.
function NovaStream() {
  const [stream, setStream] = useState('')
  useEffect(() => onChat(ev => { if (ev.jarvis) setStream(ev.text) }), [])
  return stream ? <Markdown text={stream} /> : <span className="typing" aria-label="Pensando"><i /><i /><i /></span>
}

type JAction = { type: 'todo'; text: string; project?: string; topic?: string; done?: { tid: string; iid: string; topic: string } } | { type: 'open'; project: string }

// Nova: topo igual em toda parte (roda, titulo, chat). Embaixo, por secao: no Inicio, o resumo de tudo e as to-dos;
// numa pasta (`below`), as secoes dela. `tag` = organizador da pasta.
export function Home({ games, tag, siblings, below, active, onOpen, onAdd, lastGame, onTodoTask }: {
  games: string[]; tag?: { name: string; color: string } | null; siblings?: string[]; below?: ReactNode; active: Active[]; onOpen: (g: string) => void; onAdd: () => void; lastGame: string | null
  onTodoTask: (game: string, id: number, draft?: TodoDraft) => void
}) {
  const nova = useNovaState()
  const [all, setAll] = useState(false)
  const todo = useTodo()
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [thinking, setThinking] = useState(false)
  const [asking, setAsking] = useState('')
  const [turns, setTurns] = useState<{ q: string; a: string; actions: JAction[]; error?: string }[]>([])
  const jcfg = useCachedRead<{ model: string; effort: string }>('getJarvisSettings', () => api.getJarvisSettings()).data // atualiza junto com Configuracoes
  const [focus, setFocus] = useState<string | null>(null)
  const pulse = usePulse()
  const nextItem = todo.topics.flatMap(t => t.items).find(i => !i.done)
  const info = useProjects(games)
  const live = (g: string) => active.some(a => same(a.game, g))
  const byActivity = [...games].sort((a, b) => Number(live(b)) - Number(live(a)) || minutesSince(info[a]?.lastActivity ?? null) - minutesSince(info[b]?.lastActivity ?? null))

  // Nucleo: o projeto em foco ou todos somados. Limites de uso ficam no botao da barra de cima, nunca aqui.
  const core = focus ? [focus] : games
  const coreEvents = core.flatMap(g => pulse.events[g] ?? [])
  const coreCommits = core.flatMap(g => pulse.proj[g]?.commits ?? [])
  const dirts = core.map(g => pulse.proj[g]?.dirt).filter(Boolean) as { lines: number; files: number }[]
  const coreDirt = dirts.length ? { lines: dirts.reduce((n, d) => n + d.lines, 0), files: dirts.reduce((n, d) => n + d.files, 0) } : null

  // Resumo em no maximo duas frases: quem esta trabalhando e o proximo passo.
  const dg = digest({ games, info, active, waiting: nova.waiting, name, label: p => PROVIDER[p]?.label ?? p, now: Date.now() })
  const doneToday = games.reduce((n, g) => n + (nova.doneToday[g] ?? 0), 0)
  const shown = all ? dg.items : dg.items.slice(0, SHOWN)
  const brief = (() => {
    if (focus) {
      const i = info[focus], here = active.filter(a => same(a.game, focus)), m = minutesSince(i?.lastActivity ?? null), n = dirtyCount(i)
      return [
        here.length ? `${PROVIDER[here[0].provider]?.label ?? here[0].provider} está em "${here[0].title}".` : m === Infinity ? 'Sem agente agora e nenhuma tarefa ainda.' : `Sem agente agora. Última atividade ${since(Math.round(m))}.`,
        !i ? 'Lendo o Git…' : !i.repo ? `${i.stack}, sem repositório Git.` : n ? `${n} arquivo${n > 1 ? 's' : ''} sem commit${i.worktrees.length ? `, contando ${i.worktrees.length} worktree${i.worktrees.length > 1 ? 's' : ''}` : ''}.` : `Git limpo em ${i.git?.branch ?? 'HEAD'}.`,
      ]
    }
    const lead = active[0]
    return [
      lead ? `${PROVIDER[lead.provider]?.label ?? lead.provider} está trabalhando em "${lead.title}"${active.length > 1 ? `, e mais ${active.length - 1} em paralelo` : ''}.` : 'Nenhum agente trabalhando agora.',
      nextItem ? `Próximo na sua lista: "${nextItem.text}".` : 'Sua lista está vazia.',
    ]
  })()

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    const pin = t.match(/^\/(fixar|todo)\s+(.+)/i)
    if (pin) { if (await todo.add(todo.topics[0].id, pin[2], [], below ? games[0] : undefined)) { setText(''); setNote(`Fixado em "${todo.topics[0].title}".`) } return }
    setText(''); setNote(''); setAsking(t); setThinking(true)
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
    }, (e: any) => setTurns(ts => [...ts, { q: t, a: '', actions: [], error: errText(e) }])).finally(() => setThinking(false))
  }
  const last = turns[turns.length - 1]

  return (
    <main className="home">
      <div className="home-inner">
        <section className="bridge">
          <PulseCore events={coreEvents} commits={coreCommits} dirt={coreDirt} thinking={thinking} focus={focus}
            agents={focus ? active.filter(a => same(a.game, focus)).length : active.length} />
          <div className="brief" key={focus ?? (below ? games[0] : '-')}>
            {tag && !focus && <span className="scope-tag" style={{ '--g': tag.color } as CSSProperties}>{tag.name}</span>}
            <h1>{focus ? name(focus) : below ? name(games[0]) : `${greeting()}.`}</h1>
            {focus ? brief.map((b, i) => <p key={i} style={{ animationDelay: `${0.1 + i * 0.1}s` }}>{b}</p>)
              : <p style={{ animationDelay: '.1s' }}>{dg.headline}</p>}
            {below && !focus && siblings && siblings.length > 1 && <nav className="sibs" aria-label={`Pastas em ${tag?.name ?? 'Sem organizador'}`} style={{ animationDelay: '.15s' }}>
              {siblings.map(g => <button key={g} aria-current={g === games[0]} title={g} onClick={() => g !== games[0] && onOpen(g)}>
                <i className={`dot ${live(g) ? 'live' : ''}`} />{name(g)}</button>)}
            </nav>}
            {!focus && doneToday > 0 && <p className="done-today" style={{ animationDelay: '.2s' }}><Icon n="check" size={14} />{doneToday} {doneToday === 1 ? 'conversa concluída' : 'conversas concluídas'} hoje</p>}
          </div>
        </section>

        <div>
          <form className={`jarvis ${thinking ? 'thinking' : ''}`} onSubmit={e => { e.preventDefault(); submit() }}>
            <Icon n="spark" size={20} />
            <input aria-label="Fale com a Nova" placeholder={thinking ? 'Pensando…' : below ? `Pergunte sobre ${name(games[0])}, ou "/fixar texto"` : 'Peça algo, ou "/fixar texto" para mandar para a lista'} value={text} disabled={thinking} onChange={e => setText(e.target.value)} />
            <span className="jarvis-model" title="Modelo do assistente (muda em Configurações)">{jcfg ? `${modelName(jcfg.model)}, ${effortLabel(jcfg.effort).toLowerCase()}` : 'Nova'}</span>
            {thinking
              ? <button type="button" className="send stop" aria-label="Parar" title="Parar" onClick={() => api.stopJarvis()}><Icon n="stop" size={16} /></button>
              : <button className="send" aria-label="Enviar" disabled={!text.trim()}><Icon n="send" size={18} /></button>}
          </form>
          <div className="cmds">
            {[['/fixar', 'Mandar para a to-do'], ['/resumo', 'O que foi concluído e o que falta']].map(([c, d]) =>
              <button key={c} className="cmd" title={d} onClick={() => setText(c + ' ')}><b>{c}</b>{d}</button>)}
          </div>
          {note && <p className="jarvis-note" role="status">{note}</p>}
          {(thinking || last) && (
            <div className={`jarvis-reply ${thinking ? 'streaming' : ''}`} aria-live="polite">
              <p className="jr-q">{thinking ? asking : last!.q}</p>
              {thinking
                ? <NovaStream />
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

        {below ?? <>
        <section className="digest" aria-label="O que pede você">
          {dg.items.length === 0
            ? <p className="dg-empty"><Icon n="check" size={16} />Nada pede você agora. Bom momento para começar algo novo.</p>
            : <ul>
                {shown.map((it, i) => (
                  <li key={it.key} style={{ '--i': i } as CSSProperties}>
                    <button className={`dg t-${it.tone}`} onClick={() => (it.taskId ? onTodoTask(it.game, it.taskId) : onOpen(it.game))}>
                      <span className="dg-ico"><Icon n={TONE_ICON[it.tone]} size={16} /></span>
                      <span className="dg-text"><b>{it.text}</b><small>{it.meta}</small></span>
                      <Icon n="chevron" size={14} />
                    </button>
                  </li>
                ))}
              </ul>}
          {dg.items.length > SHOWN && <button className="text-btn dg-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Mostrar menos' : `Mais ${dg.items.length - SHOWN}`}</button>}
        </section>

        <div className="focus-grid">
          <TodoBoard todo={todo} projects={games} onOpen={onTodoTask} />
          <RoadmapCard games={games} initial={lastGame && games.includes(lastGame) ? lastGame : byActivity[0] ?? null} todo={todo} onOpen={onOpen} />
        </div>

        <section className="proj-strip" aria-label="Projetos">
          <div className="sec-head"><h2>Pastas</h2>
            <button className="text-btn" onClick={onAdd}><Icon n="plus" size={15} />Adicionar pasta</button></div>
          {games.length === 0
            ? <p className="muted">Nenhuma pasta de projetos ainda. Use "Adicionar pasta" para trazer a pasta de um jogo, app ou site.</p>
            : <div className="chips">
                {byActivity.map(g => {
                  const i = info[g], on = live(g), dirty = dirtyCount(i)
                  return (
                    <button key={g} className={`pchip ${on ? 'live' : ''}`} title={g} onClick={() => onOpen(g)}
                      onMouseEnter={() => setFocus(g)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(g)} onBlur={() => setFocus(null)}>
                      <span className="pchip-icon" title={i?.stack}><ProjectIcon game={g} size={20} /></span>
                      <span>{name(g)}</span>
                      <i className={`dot ${on ? 'live' : dirty ? 'dirty' : 'clean'}`} aria-label={on ? 'agente trabalhando' : dirty ? `${dirty} arquivos sem commit` : 'limpo'} title={on ? 'Agente trabalhando' : dirty ? `${dirty} arquivos sem commit` : 'Git limpo'} />
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
