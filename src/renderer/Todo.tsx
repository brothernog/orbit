import { useEffect, useRef, useState } from 'react'
import { api, errText, name, onChat } from './api'
import type { TodoItem as Item, TodoTopic as Topic, TodoBoard as Board } from '../main/planning'
export type { Item, Topic }
export type TodoDraft = { taskId: number; text: string; images: string[]; agent?: string }
import { Dropdown } from './Dropdown'
import { Avatar, Icon, PROVIDER } from './icons'
import { Confirm } from './Nav'

// SQLite é a fonte de verdade. O localStorage antigo permanece como cópia recuperável.
const KEY = 'todo'
const uid = () => Math.random().toString(36).slice(2, 10)
const legacy = (): Topic[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (Array.isArray(v)) return v } catch {} return [] }
export function useTodo() {
  const [topics, set] = useState<Topic[]>(() => { const old = legacy(); return old.length ? old : [{ id: uid(), title: 'Entrada', open: true, items: [] }] })
  const [warn, setWarn] = useState(''), [ready, setReady] = useState(false)
  const board = useRef<Board | null>(null), queue = useRef<Promise<unknown>>(Promise.resolve())
  const accept = (b: Board) => { board.current = b; set(b.topics); setReady(true) }
  useEffect(() => {
    let live = true
    const load = () => api.todoBoard(legacy()).then((b: Board) => { if (live) accept(b) })
    queue.current = load().catch(e => { if (live) setWarn(errText(e)); throw e })
    void queue.current.catch(() => {})
    const off = onChat(ev => { if (ev.todoChanged) queue.current = queue.current.catch(() => {}).then(load).catch(e => { if (live) setWarn(errText(e)) }) })
    return () => { live = false; off() }
  }, [])
  const save = (f: (t: Topic[]) => Topic[]) => {
    const result = queue.current.catch(() => {}).then(async () => {
      if (!board.current) throw Error('A lista ainda não foi carregada. Reabra a tela para tentar novamente.')
      const next = f(board.current.topics)
      try { accept(await api.saveTodo(board.current.revision, next)); setWarn(''); return true }
      catch (e) { accept(await api.todoBoard()); throw e }
    }).catch(e => { setWarn(errText(e)); return false })
    queue.current = result
    return result
  }
  const prepare = (tid: string, iid: string) => {
    const result = queue.current.catch(() => {}).then(async () => {
      const item = board.current?.topics.find(t => t.id === tid)?.items.find(i => i.id === iid)
      if (!item?.project) throw Error('Escolha o projeto do item.')
      const r = await api.todoTask(tid, iid, item.project); accept(r.board); return r
    })
    queue.current = result.catch(e => setWarn(errText(e)))
    return result
  }
  const edit = (tid: string, iid: string, patch: Partial<Item>) =>
    save(ts => ts.map(t => t.id !== tid ? t : { ...t, items: t.items.map(i => i.id === iid ? { ...i, ...patch } : i) }))
  return {
    topics, warn, ready, prepare,
    add: async (tid: string, text: string, images: string[] = [], project?: string) => {
      const id = uid()
      const saved = await save(ts => { if (!ts.some(t => t.id === tid)) throw Error('O tópico foi removido. Escolha outro.'); return ts.map(t => t.id === tid ? { ...t, open: true, items: [...t.items, { id, text, done: false, images, project }] } : t) })
      return saved ? id : null
    },
    edit,
    remove: (tid: string, iid: string) => save(ts => ts.map(t => t.id !== tid ? t : { ...t, items: t.items.filter(i => i.id !== iid) })),
    addTopic: (title: string) => save(ts => [...ts, { id: uid(), title, open: true, items: [] }]),
    patchTopic: (tid: string, patch: Partial<Topic>) => save(ts => ts.map(t => t.id === tid ? { ...t, ...patch } : t)),
    removeTopic: (tid: string) => save(ts => ts.filter(t => t.id !== tid)),
    delegateTopic: (tid: string, agent: string) => save(ts => ts.map(t => t.id !== tid ? t : { ...t, items: t.items.map(i => i.done ? i : { ...i, agent }) })),
  }
}
export type TodoApi = ReturnType<typeof useTodo>

// Screenshot colado/escolhido: reduz para no maximo `max` px em JPEG (960 cabe no armazenamento local; o chat usa mais, para o texto seguir legivel).
export const shrink = (file: Blob, max = 960) => new Promise<string>((ok, fail) => {
  const rd = new FileReader() // data: URL (a CSP da janela nao libera blob:)
  rd.onerror = fail
  rd.onload = () => {
    const img = new Image()
    img.onerror = fail
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      ok(c.toDataURL('image/jpeg', 0.8))
    }
    img.src = rd.result as string
  }
  rd.readAsDataURL(file)
})

export const AGENT_OPTS = [{ value: 'auto', label: 'Escolher no chat' }, ...['claude', 'codex', 'gemini', 'opencode'].map(p => ({ value: p, label: PROVIDER[p].label }))]

function AgentBadge({ agent }: { agent: string }) {
  return agent === 'auto'
    ? <span className="delegated" title="Escolha o agente no chat"><Icon n="spark" size={13} />No chat</span>
    : <span className="delegated" title={`Agente sugerido: ${PROVIDER[agent]?.label ?? agent}`}><Avatar provider={agent} size="sm" live />{PROVIDER[agent]?.label ?? agent}</span>
}

export function Thumbs({ images, onOpen, onRemove }: { images: string[]; onOpen: (src: string) => void; onRemove?: (i: number) => void }) {
  if (!images.length) return null
  return (
    <span className="thumbs">
      {images.map((src, i) => (
        <span key={i} className="thumb">
          <button type="button" onClick={() => onOpen(src)} aria-label={`Ver imagem ${i + 1}`}><img src={src} alt="" /></button>
          {onRemove && <button type="button" className="thumb-x" aria-label="Remover imagem" onClick={() => onRemove(i)}><Icon n="close" size={11} /></button>}
        </span>
      ))}
    </span>
  )
}

// Campo de novo item: aceita colar screenshot (Ctrl+V) ou escolher arquivo.
function AddItem({ onAdd, projects, autoFocus }: { onAdd: (text: string, images: string[], project?: string) => Promise<string | null>; projects: string[]; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [project, setProject] = useState(''), [saving, setSaving] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const attach = async (files: Blob[]) => { const out = await Promise.all(files.map(f => shrink(f))); setImages(i => [...i, ...out]) }
  const submit = async () => { if (saving || (!text.trim() && !images.length)) return; setSaving(true); try { if (await onAdd(text.trim() || 'Screenshot', images, project || undefined)) { setText(''); setImages([]) } } finally { setSaving(false) } }
  return (
    <div className="add-item">
      <div className="add-row">
        <Icon n="plus" size={16} />
        <input disabled={saving} autoFocus={autoFocus} aria-label="Novo item" placeholder="Adicionar item (cole um screenshot com Ctrl+V)" value={text}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }}
          onPaste={e => { const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); attach(imgs) } }} />
        {projects.length > 0 && <Dropdown down label="Projeto" value={project} placeholder="Sem projeto" onChange={setProject}
          options={[{ value: '', label: 'Sem projeto' }, ...projects.map(p => ({ value: p, label: name(p) }))]} search={projects.length > 8} />}
        <button disabled={saving} className="icon sm" aria-label="Anexar screenshot" title="Anexar screenshot" onClick={() => file.current?.click()}><Icon n="image" size={16} /></button>
        <input disabled={saving} ref={file} type="file" accept="image/*" multiple hidden onChange={e => { attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
      {images.length > 0 && <Thumbs images={images} onOpen={() => {}} onRemove={i => setImages(im => im.filter((_, j) => j !== i))} />}
    </div>
  )
}

function TodoTaskButton({ topic, item, todo, projects, onOpen }: { topic: string; item: Item; todo: TodoApi; projects: string[]; onOpen: (game: string, id: number, draft?: TodoDraft) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const open = async () => {
    setBusy(true); setError('')
    try { const r = await todo.prepare(topic, item.id); onOpen(r.game, r.taskId, r.created ? { taskId: r.taskId, text: r.text, images: r.images, agent: r.agent } : undefined) }
    catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return <span className="todo-task-action">
    {!item.taskId && <Dropdown down label="Projeto da tarefa" value={item.project ?? ''} placeholder="Escolher projeto" options={projects.map(p => ({ value: p, label: name(p) }))} onChange={project => todo.edit(topic, item.id, { project })} />}
    <button className="text-btn" disabled={busy || !todo.ready || !item.project || item.done} onClick={open}>{busy ? 'Preparando…' : item.taskId ? 'Abrir tarefa' : 'Preparar tarefa'}</button>
    {error && <span role="alert" className="err">{error}</span>}
  </span>
}

function Row({ t, i, todo, onView, projects, onOpen }: { t: Topic; i: Item; todo: TodoApi; onView: (s: string) => void; projects: string[]; onOpen: (game: string, id: number, draft?: TodoDraft) => void }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(i.text)
  const done = async () => { if (v.trim() && v.trim() !== i.text) { if (await todo.edit(t.id, i.id, { text: v.trim() })) setEdit(false) } else { setV(i.text); setEdit(false) } }
  return (
    <li className={`item ${i.done ? 'done' : ''}`}>
      <button className="check-btn" role="checkbox" aria-checked={i.done} aria-label={i.done ? 'Desmarcar' : 'Concluir'} onClick={() => todo.edit(t.id, i.id, { done: !i.done })}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M6 10.5l2.6 2.5L14 7.5" /></svg>
      </button>
      <div className="item-body">
        {edit
          ? <input className="item-edit" autoFocus value={v} aria-label="Editar item" onChange={e => setV(e.target.value)} onBlur={done}
              onKeyDown={e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { setV(i.text); setEdit(false) } }} />
          : <span className="item-text" onDoubleClick={() => setEdit(true)}>{i.text}</span>}
        {(i.project || i.agent || i.images.length > 0) && <span className="item-meta">
          {i.project && <span className="proj-chip">{name(i.project)}</span>}
          {i.agent && !i.done && <AgentBadge agent={i.agent} />}
          <Thumbs images={i.images} onOpen={onView} onRemove={n => todo.edit(t.id, i.id, { images: i.images.filter((_, j) => j !== n) })} />
        </span>}
      </div>
      <div className="item-actions">
        <TodoTaskButton topic={t.id} item={i} todo={todo} projects={projects} onOpen={onOpen} />
        {!i.done && <Dropdown down label="Agente sugerido" value={i.agent ?? ''} placeholder="Agente" options={AGENT_OPTS} onChange={a => todo.edit(t.id, i.id, { agent: a })} />}
        <button className="icon sm" aria-label="Editar" title="Editar" onClick={() => setEdit(true)}><Icon n="edit" size={14} /></button>
        <button className="icon sm" aria-label="Remover item" title="Remover" onClick={() => todo.remove(t.id, i.id)}><Icon n="close" size={14} /></button>
      </div>
    </li>
  )
}

export function TodoBoard({ todo, projects, onOpen }: { todo: TodoApi; projects: string[]; onOpen: (game: string, id: number, draft?: TodoDraft) => void }) {
  const [askTopic, setAskTopic] = useState<Topic | null>(null)
  const [view, setView] = useState<string | null>(null)
  const [newTopic, setNewTopic] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  useEffect(() => {
    if (!view) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setView(null) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [view])

  // "Agora": o primeiro item aberto e o foco da tela; o resto fica abaixo, mais discreto.
  const next = todo.topics.flatMap(t => t.items.filter(i => !i.done).map(i => ({ t, i })))[0]

  return (
    <section className="todo" aria-label="Lista de tarefas">
      {askTopic && <Confirm title={`Remover o tópico "${askTopic.title}"?`} body="O tópico e os itens dele saem da lista. Tarefas criadas a partir deles continuam." action="Remover tópico"
        onClose={() => setAskTopic(null)} onConfirm={() => todo.removeTopic(askTopic.id)} />}
      {next
        ? <div className="now" key={next.i.id}>
            <span className="now-label">Agora</span>
            <div className="now-main">
              <button className="check-btn big" role="checkbox" aria-checked={false} aria-label="Concluir" onClick={() => todo.edit(next.t.id, next.i.id, { done: true })}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M6 10.5l2.6 2.5L14 7.5" /></svg>
              </button>
              <div className="now-body">
                <p className="now-text">{next.i.text}</p>
                <span className="item-meta">
                  <span className="topic-chip">{next.t.title}</span>
                  {next.i.project && <span className="proj-chip">{name(next.i.project)}</span>}
                  {next.i.agent && <AgentBadge agent={next.i.agent} />}
                  <Thumbs images={next.i.images} onOpen={setView} />
                </span>
              </div>
              <Dropdown down label="Agente sugerido" value={next.i.agent ?? ''} placeholder="Agente" options={AGENT_OPTS} onChange={a => todo.edit(next.t.id, next.i.id, { agent: a })} />
            </div>
          </div>
        : null}

      {todo.warn && <p className="err">{todo.warn}</p>}

      <ul className="topics">
        {todo.topics.map(t => {
          const open = t.items.filter(i => !i.done).length
          return (
            <li key={t.id} className="topic">
              <div className="topic-head">
                <button className="topic-toggle" aria-expanded={t.open} onClick={() => todo.patchTopic(t.id, { open: !t.open })}>
                  <Icon n="chevron" size={13} /><span>{t.title}</span><span className="count">{open}</span>
                </button>
                <div className="topic-actions">
                  {open > 0 && <Dropdown down label="Agente do tópico" value="" placeholder="Agente do tópico" options={AGENT_OPTS} onChange={a => todo.delegateTopic(t.id, a)} />}
                  <button className="icon sm" aria-label="Adicionar item ao tópico" title="Adicionar item" onClick={() => { todo.patchTopic(t.id, { open: true }); setAdding(t.id) }}><Icon n="plus" size={15} /></button>
                  {todo.topics.length > 1 && <button className="icon sm" aria-label="Remover tópico" title="Remover tópico" onClick={() => setAskTopic(t)}><Icon n="close" size={14} /></button>}
                </div>
              </div>
              {t.open && <div className="topic-body">
                <ul>{t.items.filter(i => !i.done).concat(t.items.filter(i => i.done)).map(i => <Row key={i.id} t={t} i={i} todo={todo} onView={setView} projects={projects} onOpen={onOpen} />)}</ul>
                {(adding === t.id || t.items.length === 0) && <AddItem autoFocus={adding === t.id} projects={projects} onAdd={(text, images, project) => todo.add(t.id, text, images, project)} />}
              </div>}
            </li>
          )
        })}
      </ul>
      {newTopic === null
        ? <button className="text-btn new-topic" onClick={() => setNewTopic('')}><Icon n="plus" size={15} />Novo tópico</button>
        : <form className="new-topic-form" onSubmit={async e => { e.preventDefault(); if (newTopic.trim() && await todo.addTopic(newTopic.trim())) setNewTopic(null) }}>
            <input autoFocus aria-label="Nome do tópico" placeholder="Nome do tópico" value={newTopic} onChange={e => setNewTopic(e.target.value)} onBlur={() => !newTopic.trim() && setNewTopic(null)} />
            <button className="primary">Criar</button>
          </form>}

      {view && <div className="lightbox" role="dialog" aria-label="Imagem" onClick={() => setView(null)}><img src={view} alt="" /></div>}
    </section>
  )
}
