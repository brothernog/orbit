import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { api, errText, onChat, type OrbitActivity, type OrbitAgent, type OrbitFile, type Task } from './api'
import { Icon, PROVIDER } from './icons'
import { OrbitGlobe } from './OrbitGlobe'
import { useOrbitWidth } from './useOrbitWidth'
import { isOrbitProjectPath, latestOrbitFile, mergeOrbitAgents, orbitAddedLines, orbitDiffPosition, orbitTaskFiles, type OrbitDiskFile, type OrbitPosition } from './orbitView'
import './OrbitPanel.css'

type DiskState = { repo: boolean; isolated: boolean; files: OrbitDiskFile[] }
type AgentTag = { id: string; label: string; provider: string; line: number }
type SourceState = { key: string; file?: OrbitFile; position?: OrbitPosition; added?: Set<number>; error?: string; loading?: boolean }
const activityNames: Record<OrbitActivity['kind'], string> = {
  read: 'Lendo arquivo', edit: 'Editando arquivo', image: 'Visualizando imagem', thinking: 'Pensando', tool: 'Executando ferramenta', message: 'Mensagem'
}
const agentName = (agent: OrbitAgent, agents: OrbitAgent[]) => {
  const label = PROVIDER[agent.provider]?.label ?? agent.provider
  const peers = agents.filter(a => a.provider === agent.provider)
  return peers.length > 1 ? `${label} ${peers.findIndex(a => a.id === agent.id) + 1}` : label
}

// A prévia é só leitura: eventos escolhem o arquivo; o disco fornece o texto em janelas limitadas.
export function OrbitPanel({ task, provider, onClose, onDisable }: { task: Task; provider?: string; onClose: () => void; onDisable: () => void }) {
  const [agents, setAgents] = useState<OrbitAgent[]>([]), [selectedId, setSelectedId] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState<string | null>(null), [disk, setDisk] = useState<DiskState | null>(null)
  const [writes, setWrites] = useState<Record<string, number>>({}), [error, setError] = useState('')
  const [ready, setReady] = useState(false), [sourceVersion, setSourceVersion] = useState(0), [now, setNow] = useState(Date.now())
  const [source, setSource] = useState<SourceState>({ key: '' })
  const sourceReads = useRef<{ pending: boolean; queued?: () => void; generation: number }>({ pending: false, generation: 0 })
  const imageCache = useRef(new Map<string, string>()), diffCache = useRef(new Map<string, { position?: OrbitPosition; added: Set<number> }>())
  const resizer = useOrbitWidth()
  const selected = agents.find(a => a.id === selectedId) ?? agents.find(a => a.active) ?? agents[0]
  const fileActivity = latestOrbitFile(selected), path = manualPath ?? fileActivity?.path
  const shownActivity = selected?.activity

  useEffect(() => {
    let live = true, orbitPending = false, orbitAgain = false, filesPending = false, filesAgain = false
    let received = new Map<string, OrbitAgent>(), timer: ReturnType<typeof setTimeout> | undefined
    const loadOrbit = async () => {
      if (!live) return
      if (orbitPending) { orbitAgain = true; return }
      orbitPending = true; received = new Map()
      try {
        const result: { agents: OrbitAgent[] } = await api.taskOrbit(task.id)
        if (live) { setAgents(mergeOrbitAgents(result.agents, received.values())); setReady(true) }
      } catch (e) { if (live) { setError(errText(e)); setReady(true) } }
      finally { orbitPending = false; if (live && orbitAgain) { orbitAgain = false; void loadOrbit() } }
    }
    const loadFiles = async () => {
      if (!live) return
      if (filesPending) { filesAgain = true; return }
      filesPending = true
      try { const result: DiskState = await api.taskFiles(task.id); if (live) { setDisk(result); setError('') } }
      catch (e) { if (live) setError(errText(e)) }
      finally { filesPending = false; if (live && filesAgain) { filesAgain = false; void loadFiles() } }
    }
    const soon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { void loadFiles(); setSourceVersion(n => n + 1) }, 600)
    }
    setAgents([]); setSelectedId(null); setManualPath(null); setDisk(null); setWrites({}); setError(''); setReady(false)
    imageCache.current.clear(); diffCache.current.clear()
    const off = onChat(ev => {
      if (ev.orbitActivity?.taskId === task.id) {
        const agent: OrbitAgent = ev.orbitActivity.agent
        if (orbitPending) received.set(agent.id, agent)
        setAgents(rows => mergeOrbitAgents(rows, [agent]))
        setReady(true)
      }
      if (ev.fileWrite?.taskId === task.id) {
        const p: string = ev.fileWrite.path
        setWrites(rows => {
          const { [p]: previous, ...rest } = rows
          return Object.fromEntries([...Object.entries(rest), [p, Date.now()]].slice(-200))
        })
        imageCache.current.delete(`${task.id}:${p}`); diffCache.current.delete(p)
        soon()
      } else if (ev.taskId === task.id && (ev.done || ev.refresh)) { void loadOrbit(); soon() }
    })
    void loadOrbit(); void loadFiles()
    const fallback = setInterval(() => { diffCache.current.clear(); void loadOrbit(); void loadFiles(); setSourceVersion(n => n + 1) }, 15000)
    return () => { live = false; off(); clearTimeout(timer); clearInterval(fallback); api.stopFiles().catch(() => {}) }
  }, [task.id])

  const files = useMemo(() => orbitTaskFiles(agents, disk?.files ?? [], writes, now), [agents, disk, writes, now])
  const hot = files.some(file => file.hot)
  useEffect(() => { if (!hot) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [hot])
  const sourceActivity = manualPath ? [...(selected?.events ?? [])].reverse().find(event => event.path === manualPath) : fileActivity
  const suppliedLine = sourceActivity?.line, suppliedEnd = suppliedLine ? sourceActivity?.endLine : undefined
  const suppliedPosition = suppliedLine ? sourceActivity?.position ?? 'reported' : undefined
  const sourceKey = `${task.id}:${selected?.id ?? ''}:${path ?? ''}:${suppliedLine ?? ''}:${suppliedEnd ?? ''}:${suppliedPosition ?? ''}`
  const sourceAt = sourceActivity?.at

  useEffect(() => {
    const reads = sourceReads.current, generation = ++reads.generation
    let live = true
    if (!path || (!manualPath && fileActivity?.kind === 'image')) { setSource({ key: sourceKey }); return () => { live = false } }
    const read = async () => {
      if (!live) return
      if (reads.pending) { reads.queued = () => { void read() }; return }
      reads.pending = true
      setSource(value => value.key === sourceKey ? { ...value, loading: true, error: undefined } : { key: sourceKey, loading: true })
      try {
        let position: OrbitPosition | undefined = suppliedLine ? { line: suppliedLine, endLine: suppliedEnd, position: suppliedPosition! } : undefined
        if (!diffCache.current.has(path)) {
          const diff: string = await api.fileDiff(task.id, path, false).catch(() => '')
          if (!live || generation !== reads.generation) return
          diffCache.current.set(path, { position: orbitDiffPosition(diff), added: orbitAddedLines(diff) })
          if (diffCache.current.size > 64) diffCache.current.delete(diffCache.current.keys().next().value!)
        }
        const info = diffCache.current.get(path)
        position ??= info?.position
        const file: OrbitFile = await api.orbitFile(task.id, path, position?.line)
        if (live && generation === reads.generation) setSource({ key: sourceKey, file, position, added: info?.added })
      } catch (e) { if (live && generation === reads.generation) setSource({ key: sourceKey, error: errText(e) }) }
      finally { reads.pending = false; const queued = reads.queued; reads.queued = undefined; queued?.() }
    }
    const timer = setTimeout(() => { void read() }, 60)
    return () => { live = false; clearTimeout(timer) }
  }, [task.id, selected?.id, path, manualPath, fileActivity?.kind, suppliedLine, suppliedEnd, suppliedPosition, sourceAt, sourceVersion])

  const currentSource = source.key === sourceKey ? source : { key: sourceKey, loading: !!path }
  const pickAgent = (id: string) => { setSelectedId(id); setManualPath(null) }
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % agents.length : event.key === 'ArrowLeft' ? (index + agents.length - 1) % agents.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? agents.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault(); pickAgent(agents[next].id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')
    buttons?.[next]?.focus()
  }
  const thinking = !manualPath && shownActivity?.kind === 'thinking'
  const imageRef = !manualPath && !thinking ? (shownActivity?.kind === 'image' ? shownActivity.path : fileActivity?.kind === 'image' ? fileActivity.path : undefined) : undefined
  const activityText = selected && !selected.active ? 'Execução encerrada' : shownActivity ? activityNames[shownActivity.kind] : selected?.active ? 'Aguardando atividade da CLI' : 'Sem execução ativa'
  const position = currentSource.position ?? (suppliedLine ? { line: suppliedLine, endLine: suppliedEnd, position: suppliedPosition! } : undefined)
  const tags: AgentTag[] = path ? agents.flatMap(agent => {
    const at = latestOrbitFile(agent)
    return at?.path === path && at.line ? [{ id: agent.id, label: agentName(agent, agents), provider: agent.provider, line: at.line }] : []
  }) : []
  const details = selected?.events.filter(event => ['thinking', 'message', 'image', 'tool'].includes(event.kind)) ?? []

  return <aside className="panel orbit-panel" aria-label="Órbita dos agentes" style={{ '--c': `var(--p-${selected?.provider ?? provider ?? 'codex'})` } as CSSProperties}>
    <div className="orbit-resizer" role="separator" aria-orientation="vertical" aria-label="Ajustar largura do painel" tabIndex={0} {...resizer} />
    <header><Icon n="planet" size={18} /><h2>Órbita</h2><button className="text-btn orbit-disable" onClick={onDisable} title="Desativar o planeta e voltar à lista">Ver lista de arquivos</button><button className="icon" aria-label="Fechar órbita" onClick={onClose}><Icon n="close" size={15} /></button></header>
    {agents.length > 0 && <div className="orbit-agent-tabs" role="tablist" aria-label="Agentes desta tarefa">{agents.map((agent, index) => <button key={agent.id} type="button" role="tab" aria-selected={agent.id === selected?.id} aria-controls="orbit-agent-view" id={`orbit-agent-${index}`} tabIndex={agent.id === selected?.id ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => pickAgent(agent.id)} className={agent.id === selected?.id ? 'on' : ''} style={{ '--agent-color': `var(--p-${agent.provider})` } as CSSProperties}><span className={`orbit-agent-dot ${agent.active ? 'live' : ''}`} />{agentName(agent, agents)}</button>)}</div>}
    <section className="orbit-top" role={selected ? 'tabpanel' : undefined} id="orbit-agent-view" aria-labelledby={selected ? `orbit-agent-${agents.indexOf(selected)}` : undefined}>
      <div className="orbit-status"><span className={selected?.active ? 'live' : ''}>{activityText}</span><span>somente leitura</span></div>
      {error && <p className="orbit-note err" role="alert">{error}</p>}
      {manualPath && <div className="orbit-manual"><span>Arquivo selecionado</span><button className="text-btn" onClick={() => setManualPath(null)}><Icon n="target" size={14} />Seguir agente</button></div>}
      <div className="orbit-filehead"><span title={imageRef ?? path}>{thinking ? 'Raciocínio exposto pela CLI' : imageRef ?? path ?? 'Aguardando o primeiro arquivo'}</span>{path && !thinking && !imageRef && <small>{position ? `${position.position === 'diff' ? 'Estimativa pelo diff · ' : 'CLI · '}linha ${position.line}${position.endLine && position.endLine !== position.line ? `–${position.endLine}` : ''}` : 'Linha não informada'}</small>}</div>
      <div className="orbit-source-area">
        {thinking ? <div className="orbit-thought" aria-label="Raciocínio exposto pela CLI"><small>Texto disponibilizado pela CLI</small>{shownActivity.summary || shownActivity.textId ? <OrbitText taskId={task.id} agentId={selected!.id} event={shownActivity} /> : <p>A CLI informou que o agente está pensando, sem texto adicional.</p>}</div>
          : imageRef ? <OrbitImage taskId={task.id} path={imageRef} cache={imageCache.current} version={sourceVersion} />
          : !path ? <div className="orbit-wait"><Icon n="target" size={24} /><p>{ready ? 'O arquivo aparece quando o agente o visitar.' : 'Consultando os agentes…'}</p><small>Visitas e edições desta tarefa formam os pontos no planeta.</small></div>
          : currentSource.error ? <p className="orbit-note err" role="alert">{currentSource.error}</p>
          : !currentSource.file ? <div className="orbit-wait" role="status"><span className="loader" /><p>Lendo arquivo…</p></div>
          : <OrbitSource taskId={task.id} file={currentSource.file} position={position} added={currentSource.added} tags={tags} selectedId={selected?.id} cache={imageCache.current} />}
      </div>
      {currentSource.loading && currentSource.file && !thinking && !imageRef && <span className="orbit-updating" role="status">Atualizando do disco…</span>}
      {details.length > 0 && <details className="orbit-activity"><summary>Atividade da CLI <span>{details.length}</span></summary><div className="orbit-activity-list">{details.map((event, index) => <details key={`${event.at}:${index}`} className="orbit-event"><summary><span>{event.direction === 'sent' ? 'Mensagem enviada' : event.direction === 'received' ? 'Mensagem recebida' : activityNames[event.kind]}</span><time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></summary>{event.title && <b>{event.title}</b>}{event.tool && <code>{event.tool}</code>}{event.path && <code>{event.path}</code>}{(event.summary || event.textId) && <OrbitText taskId={task.id} agentId={selected!.id} event={event} />}{event.kind === 'image' && event.path && <OrbitImage taskId={task.id} path={event.path} cache={imageCache.current} version={sourceVersion} lazy />}</details>)}{selected?.historyTruncated && <p className="orbit-note">Histórico recente: eventos anteriores foram cortados para limitar memória.</p>}</div></details>}
    </section>
    <section className="orbit-bottom" aria-label="Planeta do projeto"><OrbitGlobe files={files} agents={agents.map(agent => {
      const filePath = latestOrbitFile(agent)?.path
      return { id: agent.id, provider: agent.provider, path: isOrbitProjectPath(filePath) ? filePath : undefined, active: agent.active, label: agentName(agent, agents) }
    })} selectedAgent={selected?.id} selectedFile={isOrbitProjectPath(path) ? path : undefined} onSelectAgent={pickAgent} onSelectFile={setManualPath} />
      <div className="orbit-legend"><span>{files.length} {files.length === 1 ? 'arquivo visitado' : 'arquivos visitados'}</span><span>da tarefa</span></div>
      {disk && !disk.isolated && <p className="orbit-scope">As contagens de linhas vêm da pasta compartilhada e podem incluir outras tarefas.</p>}
    </section>
  </aside>
}

function OrbitText({ taskId, agentId, event }: { taskId: number; agentId: string; event: OrbitActivity }) {
  const key = `${taskId}:${agentId}:${event.ref ?? event.textId ?? event.at}:${event.textId ?? ''}`
  const [state, setState] = useState<{ key: string; text?: string; next?: number | null; total?: number; at?: number; loading?: boolean; error?: string }>({ key })
  const currentKey = useRef(key), pending = useRef<string | null>(null)
  currentKey.current = key
  useEffect(() => { currentKey.current = key; return () => { currentKey.current = '' } }, [key])
  const current = state.key === key ? state : { key }
  const load = async (offset: number) => {
    if (!event.textId || pending.current === key) return
    const requested = key
    pending.current = key
    setState(value => value.key === key ? { ...value, loading: true, error: undefined } : { key, loading: true })
    try {
      const page: { text: string | null; next: number | null; total: number } = await api.orbitActivityText(taskId, agentId, event.textId, offset)
      if (currentKey.current !== requested) return
      if (page.text === null) { setState(value => ({ ...value, loading: false, error: 'O texto completo não está mais disponível no histórico recente.' })); return }
      setState(value => ({ key: requested, text: offset === 0 ? page.text! : (value.text ?? '') + page.text!, next: page.next, total: page.total, at: event.at }))
    } catch (e) { if (currentKey.current === requested) setState(value => ({ ...value, loading: false, error: errText(e) })) }
    finally { if (pending.current === requested) pending.current = null }
  }
  return <div className="orbit-text"><pre>{current.text ?? event.summary}</pre>{event.truncated && current.text === undefined && <small>Prévia do texto disponibilizado pela CLI.{event.textId ? '' : ' O restante não está mais disponível no histórico recente.'}</small>}{event.truncated && event.textId && current.text === undefined && <button className="text-btn" disabled={current.loading} onClick={() => { void load(0) }}>{current.loading ? 'Carregando…' : 'Ver texto completo'}</button>}{current.text !== undefined && current.next != null && <><small>{current.text.length.toLocaleString()} de {current.total?.toLocaleString()} caracteres disponíveis</small><button className="text-btn" disabled={current.loading} onClick={() => { void load(current.next!) }}>{current.loading ? 'Carregando…' : 'Carregar mais'}</button></>}{current.text !== undefined && current.next === null && event.at > (current.at ?? 0) && <button className="text-btn" disabled={current.loading} onClick={() => { void load(0) }}>Atualizar texto completo</button>}{current.error && <p className="orbit-note err" role="alert">{current.error}</p>}</div>
}

function OrbitSource({ taskId, file, position, added, tags, selectedId, cache }: { taskId: number; file: OrbitFile; position?: OrbitPosition; added?: Set<number>; tags: AgentTag[]; selectedId?: string; cache: Map<string, string> }) {
  const code = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const element = code.current
    if (!element) return
    const followLine = () => {
      const line = element.querySelector<HTMLElement>('.orbit-line.active')
      if (line) element.scrollTop = Math.max(0, line.offsetTop - element.clientHeight / 2)
    }
    followLine()
    const resize = new ResizeObserver(followLine)
    resize.observe(element)
    return () => resize.disconnect()
  }, [file.path, file.startLine, position?.line])
  if (file.kind === 'image') return <OrbitImage taskId={taskId} path={file.path} cache={cache} version={file.modifiedAt} />
  if (file.kind !== 'text') return <div className="orbit-wait"><Icon n="files" size={24} /><p>{file.kind === 'missing' ? 'Arquivo removido ou ainda não existe no disco.' : file.kind === 'large' ? 'Arquivo acima de 1 MB. Prévia limitada para manter o painel leve.' : 'Arquivo binário: prévia de texto indisponível.'}</p></div>
  return <><pre className="orbit-code" ref={code} tabIndex={0} aria-label={`Prévia de ${file.path}`}><code>{file.lines.map((text, index) => {
    const line = file.startLine + index, active = !!position && line >= position.line && line <= (position.endLine ?? position.line)
    const here = tags.filter(tag => tag.line === line)
    return <span key={line} className={`orbit-line ${active ? 'active' : ''} ${added?.has(line) ? 'added' : ''} ${position?.position === 'diff' ? 'estimated' : ''}`}><span className="orbit-line-number" aria-hidden="true">{line}</span><span className="orbit-line-text">{text || ' '}</span>{here.map(tag => <span key={tag.id} className={`orbit-line-tag ${tag.id === selectedId ? 'sel' : ''}`} style={{ '--agent-color': `var(--p-${tag.provider})` } as CSSProperties} title={`${tag.label} está na linha ${line}`}>{tag.label}</span>)}</span>
  })}</code></pre><small className="orbit-window">Linhas {file.startLine}–{file.startLine + file.lines.length - 1}{file.totalLines != null && ` de ${file.totalLines}`} · do disco</small></>
}

function OrbitImage({ taskId, path, cache, lazy = false, version }: { taskId: number; path: string; cache: Map<string, string>; lazy?: boolean; version?: number }) {
  const key = `${taskId}:${path}`, [result, setResult] = useState<{ key: string; src?: string; error?: string }>({ key, src: cache.get(key) })
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true, observer: IntersectionObserver | undefined
    const load = async () => {
      if (cache.has(key)) { if (live) setResult({ key, src: cache.get(key) }); return }
      try {
        const src: string | null = await api.taskImage(taskId, path, true)
        if (!live) return
        if (!src) { setResult({ key, error: 'A CLI indicou a imagem, mas a prévia não está disponível.' }); return }
        cache.set(key, src)
        if (cache.size > 8) cache.delete(cache.keys().next().value!)
        setResult({ key, src })
      } catch (e) { if (live) setResult({ key, error: errText(e) }) }
    }
    if (lazy && container.current) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load() } }); observer.observe(container.current) }
    else void load()
    return () => { live = false; observer?.disconnect() }
  }, [key, cache, lazy, version])
  const current = result.key === key ? result : { key }
  return <div className="orbit-image" ref={container}>{current.src ? <img src={current.src} alt={`Imagem vista pelo agente: ${path}`} /> : current.error ? <p className="orbit-note">{current.error}</p> : <p className="orbit-note" role="status">Carregando imagem…</p>}<code>{path}</code></div>
}
