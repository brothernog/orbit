import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { api, errText, name, onChat, setAliases, type Account, type Active, type Provider, type Task } from './api'
import { Chat } from './Chat'
import type { TodoDraft } from './Todo'
import { AlsoRunning, doingText, statusOf, useBriefCard, type Brief } from './TaskBrief'
import { ATTENTION_LABEL, attentionOf, markSeen, needsYou, RANK, useSeen, type Attention } from './attention'
import { Home } from './Home'
import { ProjectHome } from './ProjectHome'
import { Avatar, Icon, PROVIDER } from './icons'
import { ProjectPanel } from './ProjectPanel'
import { Settings } from './Settings'
import { PermissionPrompt } from './PermissionPrompt'
import { Toasts } from './Toasts'
import { Limits } from './Limits'
import { Palette } from './Palette'
import { WorkspaceFiles } from './WorkspaceFiles'
import { LinkedIn } from './LinkedIn'
import orbitMark from './orbit-mark.svg'
import { Confirm, ContextMenu, GroupDialog, ProjectIcon, RenameInput, type MenuItem } from './Nav'
import { groupOf, initials, moveTo, newGroup, placeBefore, taskToRemember, type Group } from './groups'
import { expireRead, loadRead, readSnapshot, setRead } from './readCache'
import type { QuotaSnapshot } from './usageText'
import { ago, clock, same } from './time'

const ls = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }

// Paineis auxiliares abrem so quando ha largura; ao estreitar recolhem (o chat nunca e comprimido primeiro).
function useAuto(query: string, initial: boolean) {
  const [open, setOpen] = useState(() => initial && window.matchMedia(query).matches)
  useEffect(() => {
    // So reage quando a largura cruza o limite (nao reabre o que o usuario fechou). resize cobre casos em que o
    // Chromium nao dispara "change" da media query (ex.: emulacao de tela no e2e).
    const m = window.matchMedia(query)
    let last = m.matches
    const f = () => { if (m.matches !== last) { last = m.matches; setOpen(last) } }
    m.addEventListener('change', f)
    window.addEventListener('resize', f)
    return () => { m.removeEventListener('change', f); window.removeEventListener('resize', f) }
  }, [query])
  return [open, setOpen] as const
}

// Agentes ativos em todos os projetos. ponytail: polling de 3 s num Map local; trocar por evento se ficar pesado.
// Lista igual nao troca o estado (nada re-renderiza) e janela oculta/minimizada nao consulta.
function useActive() {
  const [list, setList] = useState<Active[]>([])
  useEffect(() => {
    const load = () => api.listActive().then((next: Active[]) => setList(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)), () => {})
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 3000)
    const vis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', vis)
    const off = onChat(ev => { if (ev.done || ev.refresh) load() })
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); off() }
  }, [])
  return list
}

// Textos relativos ("há 5 min") da gaveta e do Inicio: um re-render por minuto com a janela visivel.
function useMinuteTick() {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') tick(n => n + 1) }, 60_000)
    return () => clearInterval(t)
  }, [])
}


// Uma conversa que pede voce (fila do Ctrl+J, do dock e do Ctrl+K).
export type QueueItem = { t: Task; a: Attention }

// Dock no canto superior direito: primeiro o que precisa de voce, depois quem esta trabalhando e ha quanto tempo.
// O numero ambar conta so "precisa de voce" (mesma regra do trilho e da gaveta).
function AgentDock({ active, queue, onOpen, onOpenTask, onNext }: {
  active: Active[]; queue: QueueItem[]; onOpen: (a: Active) => void; onOpenTask: (t: Task) => void; onNext: () => void
}) {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => tick(n => n + 1), 1000)
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    return () => { clearInterval(t); document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])
  const shown = active.slice(0, 3)
  const waits = queue.filter(q => q.a === 'wait').length
  const flag = queue.find(q => q.a !== 'wait')?.a // falhou ou pronto: ponto, sem numero
  const label = [waits && `${waits} precisa(m) de você`, active.length && `${active.length} agente(s) trabalhando`].filter(Boolean).join(', ') || (queue.length ? `${queue.length} para revisar` : 'Nenhum agente trabalhando')
  return (
    <div className="dock" ref={ref}>
      <button className={`dock-btn ${active.length ? 'busy' : ''} ${queue.length ? 'ask' : ''}`} aria-expanded={open} aria-haspopup="dialog"
        aria-label={label} title={`${label}. Próxima que precisa de você: Ctrl+J`} onClick={() => setOpen(!open)}>
        {waits > 0 && <span className="att-count">{waits}</span>}
        {!waits && flag && <span className="att" data-att={flag} />}
        {active.length
          ? <span className="stack">{shown.map(a => <Avatar key={`${a.kind}${a.id}`} provider={a.provider} live size="sm" />)}<span className="dock-count">{active.length}</span></span>
          : !queue.length && <span className="att" data-att="idle" />}
      </button>
      {open && (
        <div className="dock-pop" role="dialog" aria-label="Agentes e pendências">
          {queue.length > 0 && <>
            <div className="dock-head">Precisa de você<button className="text-btn" onClick={() => { setOpen(false); onNext() }}>Próxima<kbd>Ctrl J</kbd></button></div>
            <ul>
              {queue.map(q => (
                <li key={q.t.id}>
                  <button onClick={() => { setOpen(false); onOpenTask(q.t) }}>
                    <span className="att" data-att={q.a} />
                    <span className="dock-body"><span className="dock-task">{q.t.title}</span><span className="dock-meta">{name(q.t.game)}</span></span>
                    <span className={`dock-state s-${q.a}`}>{ATTENTION_LABEL[q.a]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>}
          {(active.length > 0 || !queue.length) && <div className="dock-head">{active.length ? 'Trabalhando' : 'Nenhum agente trabalhando'}</div>}
          <ul>
            {active.map(a => (
              <li key={`${a.kind}${a.id}`}>
                <button onClick={() => { setOpen(false); onOpen(a) }}>
                  <Avatar provider={a.provider} live size="sm" />
                  <span className="dock-body">
                    <span className="dock-task">{a.title}</span>
                    <span className="dock-meta">{doingText(a.doing) ?? `${PROVIDER[a.provider]?.label ?? a.provider}${a.model ? ` ${a.model}` : ''}`} · {name(a.game)}{a.kind === 'delegation' ? ', delegação' : ''}</span>
                  </span>
                  <span className="dock-time">{a.startedAt ? clock(a.startedAt) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// Conversas e resumos de TODAS as pastas: alimentam o modelo de atencao (gaveta, trilho, dock, Ctrl+J, Ctrl+K).
// Leituras locais do SQLite; recarrega em lote quando um agente termina, pede permissao ou contexto.
// Leitura que falha sem lista anterior guarda o erro (string): a gaveta mostra o motivo em vez de carregar para sempre.
type Folder = { tasks: Task[]; briefs: Map<number, Brief> }
function useWorld(games: string[], deps: unknown[]) {
  const [map, setMap] = useState<Record<string, Folder | string>>({})
  const key = games.join('|')
  useEffect(() => {
    let live = true, t: ReturnType<typeof setTimeout> | undefined
    const load = () => games.forEach(g => Promise.all([api.listTasks(g, {}), api.taskBriefs(g)]).then(([l, b]: [Task[], Brief[]]) => {
      if (live) setMap(m => ({ ...m, [g.toLowerCase()]: { tasks: l, briefs: new Map(b.map(x => [x.id, x])) } }))
    }, (e: unknown) => { if (live) setMap(m => (typeof m[g.toLowerCase()] === 'object' ? m : { ...m, [g.toLowerCase()]: errText(e) })) }))
    load()
    const off = onChat((ev: any) => {
      if (ev?.done || ev?.refresh || ev?.permissionRequest || ev?.permissionResolved || ev?.contextRequest || ev?.contextResolved) { clearTimeout(t); t = setTimeout(load, 120) }
    })
    return () => { live = false; clearTimeout(t); off() }
  }, [key, ...deps])
  return map
}

const INBOX = '__inbox' // organizador virtual com as pastas que nao estao em nenhum outro

// Troca de tela com animacao nativa do Chromium (View Transitions): o centro some e o novo resumo sobe. Sem suporte ou com
// "reduzir movimento", troca direto.
const transition = (f: () => void) => {
  const d = document as any
  if (d.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) d.startViewTransition(() => flushSync(f))
  else f()
}

// Liga/desliga o planeta da area de trabalho (Planet.tsx). Desligado, os avisos com a Orbita fora de foco continuam aparecendo.
function PlanetToggle() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => { api.planetState().then((s: { on: boolean }) => setOn(s.on), () => {}) }, [])
  const label = on ? 'Planeta na área de trabalho: ligado' : 'Planeta na área de trabalho: desligado'
  return (
    <button className={`rail-btn rail-planet ${on ? 'on' : ''}`} aria-label={label} aria-pressed={!!on} disabled={on === null}
      onClick={() => api.setPlanet(!on).then((s: { on: boolean }) => setOn(s.on), () => {})}>
      <Icon n="planet" /><span className="rail-tip">{label}</span>
    </button>
  )
}

export default function App() {
  const [draft, setDraft] = useState<TodoDraft | undefined>()
  const [games, setGames] = useState<string[]>([])
  const [game, setGame] = useState<string | null>(ls('game'))
  const [accounts, setAccounts] = useState<Account[]>([])
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [taskId, setTaskId] = useState<number | null>(null)
  const [settings, setSettings] = useState(false)
  const [home, setHome] = useState(true)
  const [li, setLi] = useState(false) // pagina LinkedIn
  const [taskView, setTaskView] = useState(false) // no projeto: visao geral (false) ou chat da tarefa (true)
  const [recent, setRecent] = useState<Record<string, number>>(() => { try { return JSON.parse(ls('recent') ?? '{}') } catch { return {} } })
  const [palette, setPalette] = useState(false)
  const [panel, setPanel] = useAuto('(min-width: 1250px)', false)
  const [chats, setChats] = useAuto('(min-width: 900px)', true)
  const [files, setFiles] = useAuto('(min-width: 1250px)', true)
  // Gaveta: quais pastas estao abertas e quais mostram as concluidas (lembrado por pasta).
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(ls('folderOpen') ?? '{}') } catch { return {} } })
  const [doneOpen, setDoneOpen] = useState<Record<string, boolean>>({})
  const toggleFolder = (g: string, v: boolean) => setFolderOpen(m => { const n = { ...m, [g]: v }; lsSet('folderOpen', JSON.stringify(n)); return n })
  const [newTitle, setNewTitle] = useState('')
  const [err, setErr] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<number | string | null>(null) // id da tarefa ou caminho do projeto
  const [toDelete, setToDelete] = useState<Task | null>(null)
  const [toHide, setToHide] = useState<string | null>(null) // projeto a tirar da lista (nada e apagado)
  // Grupos do trilho (pastas so do app). groupDlg: criar (com os projetos que vao entrar) ou editar um grupo.
  const [groups, setGroups] = useState<Group[]>([])
  const [groupDlg, setGroupDlg] = useState<{ games: string[]; edit?: Group } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [dragWs, setDragWs] = useState<string | null>(null) // organizador sendo arrastado no trilho (reordenar)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [, setAliasVer] = useState(0)
  const req = useRef(0)
  const active = useActive()
  useMinuteTick()

  const loadAccounts = () => api.listAccounts().then((list: Account[]) => {
    setAccounts(list)
    for (const a of list) {
      if (a.login?.state === 'connecting') continue
      const key = `accountUsage:${a.id}`, previous = readSnapshot<QuotaSnapshot | null>(key)
      if (previous.data !== undefined) continue
      api.accountUsageSnapshot(a.id).then((usage: QuotaSnapshot | null) => {
        if (usage && readSnapshot(key) === previous) { setRead(key, usage); expireRead(key) }
      }, () => {})
    }
  })
  const refreshProviders = () => {
    loadRead<Provider[]>('diagnose', () => api.diagnose()).then(setProviders, e => {
      setProviders(p => p ?? []); setErr(errText(e))
    })
  }
  const loadAliases = () => api.projectNames().then((a: Record<string, string>) => { setAliases(a); setAliasVer(v => v + 1) }, () => {})
  const loadGames = () => { api.listGames().then(setGames, (e: any) => setErr(errText(e))) }
  const saveGroups = (n: Group[]) => { setGroups(n); api.setProjectGroups(n).catch((e: any) => setErr(errText(e))) }
  useEffect(() => {
    const load = () => api.getProjectGroups().then(setGroups, () => {})
    load()
    return onChat(e => { if (e.groupsChanged) load() })
  }, [])
  useEffect(() => {
    loadGames(); loadAccounts(); loadAliases()
    loadRead<Provider[]>('diagnose', () => api.diagnose(), 600_000).then(setProviders, () => setProviders([]))
    // So metadados locais; catalogos/CLIs e consulta de quotas continuam sob demanda.
    for (const read of ['getContextLimits', 'getNotifySettings', 'getJarvisSettings', 'getDelegationSettings', 'getPermissionSettings', 'getAgentAliases', 'summaryTitles', 'turnCheckpoints', 'backupInfo'])
      loadRead(read, () => api[read]()).catch(() => {})
  }, [])
  // Atalhos que dependem da pasta aberta: Ctrl+N nova tarefa, Ctrl+B mostra/oculta a gaveta, F2 renomeia a conversa aberta.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    const f = (e: KeyboardEvent) => keys.current(e)
    document.addEventListener('keydown', f)
    return () => document.removeEventListener('keydown', f)
  }, [])
  // Ctrl+K abre a busca de tarefas, projetos e acoes de qualquer tela.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p) } }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [])

  // Tarefas do projeto (sem arquivadas; essas ficam no Ctrl+K); restaura a ultima tarefa valida.
  const loadTasks = (keepSelection = true) => {
    if (!game) return Promise.resolve()
    const n = ++req.current
    return api.listTasks(game, {}).then((list: Task[]) => {
      if (n !== req.current) return
      setTasks(list)
      setTaskId(cur => {
        if (keepSelection && cur != null && list.some(t => t.id === cur)) return cur
        const saved = Number(ls(`task:${game}`))
        return list.find(t => t.id === saved)?.id ?? list[0]?.id ?? null
      })
    }, e => setErr(errText(e)))
  }
  useEffect(() => { setTasks(null); setTaskId(null); setErr('') }, [game])
  useEffect(() => { loadTasks() }, [game])
  useEffect(() => { // so a tarefa que e desta pasta (openIn ja gravou a escolhida antes de trocar)
    const id = game ? taskToRemember(game, taskId, tasks) : null
    if (id != null) lsSet(`task:${game}`, String(id))
  }, [game, taskId, tasks])

  const pick = (g: string) => {
    const w = groupOf(groups, g)
    if (w) lsSet(`ws:${w.id}`, g) // ao voltar ao organizador, reabre a ultima pasta usada nele
    lsSet('game', g); setGame(g); setSettings(false); setHome(false); setLi(false); setTaskView(false)
    setRecent(r => { const n = { ...r, [g]: Date.now() }; lsSet('recent', JSON.stringify(n)); return n })
  }
  const addGame = (groupId?: string) => api.addGame().then((g: string | null) => {
    if (!g) return
    if (groupId && groupId !== INBOX) saveGroups(moveTo(groups, g, groupId))
    loadGames(); pick(g)
  }, (e: any) => setErr(errText(e)))
  // Organizador no trilho: a Nova troca (animada) para a ultima pasta usada nele, com a gaveta aberta. Vazio: pede a primeira pasta.
  const openGroup = (x: Group) => {
    const list = x.id === INBOX ? x.games : games.filter(g => x.games.includes(g))
    if (!list.length) return addGame(x.id)
    const last = ls(`ws:${x.id}`)
    transition(() => { pick(list.find(g => g === last) ?? [...list].sort((a, b) => (recent[b] ?? 0) - (recent[a] ?? 0))[0]); setChats(true) })
  }
  const createIn = (g: string) => (g === game ? create() : api.createTask(g).then((id: number) => openIn(g, id), (e: any) => setErr(errText(e))))
  const goHome = () => transition(() => { setHome(true); setSettings(false); setLi(false) })
  const goSettings = () => { setSettings(true); setLi(false) }
  const goLi = () => { setLi(true); setSettings(false) }
  const openTask = (id: number) => {
    setSettings(false); setHome(false); setLi(false); setTaskView(true)
    setTaskId(id)
    loadTasks().then(() => setTaskId(id))
  }
  // Abre uma tarefa de qualquer projeto, trocando de projeto se preciso (a selecao salva e restaurada ao carregar).
  const openIn = (gameOf: string, id: number) => {
    if (game && same(gameOf, game)) return openTask(id)
    const g = games.find(x => same(x, gameOf))
    if (!g) { if (/[\\/]linkedin$/i.test(gameOf)) goLi(); return } // a conversa da pagina LinkedIn nao e projeto
    lsSet(`task:${g}`, String(id))
    pick(g)
    setTaskView(true)
  }
  const openActive = (a: Active) => openIn(a.game, a.taskId)
  const renameTask = (t: Task, v: string | null) => { setRenaming(null); if (v) api.renameTask(t.id, v).then(() => { loadTasks(); bump() }, (e: any) => setErr(errText(e))) }
  const [ver, setVer] = useState(0) // acoes em conversas de outras pastas da gaveta: recarrega as listas delas
  const bump = () => setVer(v => v + 1)
  const archiveTask = (t: Task) => api.archiveTask(t.id, true).then(() => { loadTasks(false); bump() }, (e: any) => setErr(errText(e)))
  const deleteTask = (t: Task) => api.deleteTask(t.id).then(() => { loadTasks(false); bump() }, (e: any) => setErr(errText(e)))
  const renameProject = (g: string, v: string | null) => { setRenaming(null); if (v) api.renameProject(g, v).then(loadAliases, (e: any) => setErr(errText(e))) }
  const setState = (t: Task, st: string) => api.setTaskState(t.id, st).then(() => { loadTasks(); bump() }, (e: any) => setErr(errText(e)))
  const taskSel = (t: Task) => { try { const v = JSON.parse(t.sel ?? 'null'); if (v?.provider) return v } catch {} return { provider: 'claude', accountId: accounts[0]?.id } }
  const taskMenu = (t: Task, x: number, y: number) => setMenu({ x, y, items: [
    { label: 'Renomear', hint: 'F2 ou duplo clique', run: () => setRenaming(t.id) },
    t.state === 'concluida' ? { label: 'Reabrir', run: () => setState(t, 'aberta') } : { label: 'Marcar como concluída', run: () => setState(t, 'concluida') },
    { label: 'Continuar no terminal', hint: 'Mesma sessão do provedor', run: () => { api.launchTask(t.id, taskSel(t), { resume: true }).catch((e: any) => setErr(errText(e))) } },
    { label: 'Copiar título', run: () => { navigator.clipboard.writeText(t.title).catch(() => {}) } },
    { label: 'Arquivar', hint: 'Ctrl+K mostra as arquivadas', run: () => archiveTask(t) },
    { label: 'Excluir…', danger: true, run: () => setToDelete(t) },
  ] })
  const projectMenu = (g: string, x: number, y: number) => setMenu({ x, y, items: [
    { label: 'Renomear projeto', run: () => { pick(g); setChats(true); setRenaming(g) } },
    ...groups.filter(x => !x.games.includes(g)).map(x => ({ label: `Mover para ${x.name}`, run: () => saveGroups(moveTo(groups, g, x.id)) })),
    { label: 'Novo organizador com esta pasta…', run: () => setGroupDlg({ games: [g] }) },
    ...(groupOf(groups, g) ? [{ label: `Tirar de ${groupOf(groups, g)!.name}`, run: () => saveGroups(moveTo(groups, g, null)) }] : []),
    { label: 'Nova tarefa aqui', hint: 'Ctrl+N na pasta aberta', run: () => createIn(g) },
    { label: 'Terminal nesta pasta', hint: 'Claude, conta principal', run: () => api.launchGame(g, { provider: 'claude', accountId: accounts[0]?.id }).catch((e: any) => setErr(errText(e))) },
    { label: 'Abrir no Explorer', run: () => api.openFolder(g).catch((e: any) => setErr(errText(e))) },
    { label: 'Copiar caminho', run: () => { navigator.clipboard.writeText(g).catch(() => {}) } },
    { label: 'Remover da lista…', hint: 'Não apaga nada; volta por Configurações', danger: true, run: () => setToHide(g) },
  ] })
  const hideProject = (g: string) => api.hideGame(g).then(() => {
    setGames(list => list.filter(x => x !== g))
    if (game === g) { setGame(null); goHome() }
  }, (e: any) => setErr(errText(e)))
  const create = (title?: string): unknown => game && api.createTask(game, title).then((id: number) => { setNewTitle(''); openTask(id) }, e => setErr(errText(e)))
  const task = tasks?.find(t => t.id === taskId) ?? null
  keys.current = e => {
    const typing = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); goNext(); return } // de qualquer tela
    if (!game || home || settings || li) return
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); create() }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setChats(c => !c) }
    else if (e.key === 'F2' && !typing && task && taskView) { e.preventDefault(); setChats(true); setRenaming(task.id) }
  }
  const inProject = !!game && !home && !settings && !li
  const showFiles = inProject && taskView && !!task && files && !panel // arquivos ao vivo e painel do projeto dividem a coluna da direita
  // Trilho: so organizadores (pastas-mae do app). Pastas que nao estao em nenhum ficam no organizador padrao "Sem organizador".
  const loose = games.filter(g => !groupOf(groups, g)).sort((a, b) => (recent[b] ?? 0) - (recent[a] ?? 0))
  const inbox: Group = { id: INBOX, name: 'Sem organizador', color: '#8791a3', games: loose, open: true }
  const shownGroups = [...groups, ...(loose.length ? [inbox] : [])].map(x => ({ ...x, list: games.filter(g => x.games.includes(g)) }))
  const ws = game ? groupOf(groups, game) ?? inbox : null
  const drawer = inProject && chats
  const folders = ws ? ws.games.filter(g => games.includes(g)) : []
  // Modelo unico de atencao (attention.ts): o mesmo estado na gaveta, no trilho, no dock, no Ctrl+K e no Ctrl+J.
  const seen = useSeen()
  // Sem `tasks` nas dependencias: o `done`/`refresh` que recarrega a pasta atual ja recarrega o mundo.
  const worldRaw = useWorld(games, [ver, active.map(a => a.taskId).join(',')])
  const world: Record<string, Folder> = {}, worldErr: Record<string, string> = {}
  for (const [k, v] of Object.entries(worldRaw)) if (typeof v === 'string') worldErr[k] = v; else world[k] = v
  const tasksOf = (g: string) => (game && same(g, game) && tasks) || world[g.toLowerCase()]?.tasks || null
  const briefOf = (t: Task) => world[t.game.toLowerCase()]?.briefs.get(t.id)
  const attOf = (t: Task) => attentionOf(t, briefOf(t), active.find(a => a.taskId === t.id), seen[t.id])
  const allBriefs = new Map<number, Brief>()
  for (const f of Object.values(world)) f.briefs.forEach((b, id) => allBriefs.set(id, b))
  const briefCard = useBriefCard(allBriefs)
  // Fila "precisa de voce": esperando > falhou > pronto; dentro de cada estado, quem espera ha mais tempo primeiro.
  const queue: QueueItem[] = games.flatMap(g => (tasksOf(g) ?? []).map(t => ({ t, a: attOf(t) })))
    .filter(q => needsYou(q.a)).sort((x, y) => RANK[x.a] - RANK[y.a] || x.t.updated_at.localeCompare(y.t.updated_at))
  const sumOf = (list: string[]) => {
    const q = queue.filter(x => list.some(g => same(g, x.t.game)))
    return { wait: q.filter(x => x.a === 'wait').length, flag: q.find(x => x.a !== 'wait')?.a, live: list.some(g => active.some(a => same(a.game, g))) }
  }
  // Ctrl+J / "Proxima": a primeira da fila depois da conversa aberta (volta ao inicio no fim).
  const openQueued = (t: Task, animate = true) => { briefCard.hide(); if (animate) transition(() => openIn(t.game, t.id)); else openIn(t.game, t.id) }
  const goNext = () => {
    if (!queue.length) return
    const i = queue.findIndex(q => q.t.id === task?.id && inProject && taskView)
    openQueued(queue[(i + 1) % queue.length].t, false) // atalho de teclado: troca na hora
  }
  // Conversa aberta na tela = vista. Ao terminar com ela aberta (updated_at muda) continua vista; so conta com a janela em foco.
  const onScreen = inProject && taskView && task ? task.id : null
  const onScreenAt = task && world[task.game.toLowerCase()]?.tasks.find(t => t.id === task.id)?.updated_at
  useEffect(() => {
    if (onScreen == null) return
    const f = () => { if (document.hasFocus()) markSeen(onScreen) }
    f()
    window.addEventListener('focus', f)
    return () => { window.removeEventListener('focus', f); f() }
  }, [onScreen, task?.updated_at, onScreenAt, active.some(a => a.taskId === onScreen)])

  const when = (t: Task) => {
    const who = active.find(x => x.taskId === t.id)
    if (who?.startedAt) return clock(who.startedAt)
    return ago(t.updated_at)
  }
  const taskRow = (t: Task) => {
    const sel = inProject && t.id === taskId && taskView && t.game === game
    const who = active.find(a => a.taskId === t.id)
    const a = attOf(t)
    const st = statusOf(t, briefOf(t), who, ago(t.updated_at))
    // Segunda linha so quando diz algo: o que o agente faz agora, o que ele pede ou que falhou.
    const sub = a === 'working' ? doingText(who?.doing) : a === 'wait' ? st.text : a === 'error' ? ATTENTION_LABEL.error : null
    return (
      <li key={t.id} className="task-row" onContextMenu={e => { e.preventDefault(); taskMenu(t, e.clientX, e.clientY) }}>
        {renaming === t.id
          ? <div className="task editing"><span className="att" data-att={a} aria-hidden="true" /><RenameInput value={t.title} label="Novo nome da conversa" onDone={v => renameTask(t, v)} /></div>
          : <button className={`task ${sel ? 'active' : ''} s-${t.state} a-${a}`} data-att={a} aria-current={sel} aria-label={`${t.title}: ${a === 'idle' || a === 'done' ? st.text : ATTENTION_LABEL[a]}${sub && a !== 'error' ? `, ${sub}` : ''}${t.worktree ? `, branch ${t.branch}` : ''}`}
              onClick={() => { briefCard.hide(); if (t.game !== game || !inProject) return openIn(t.game, t.id); setTaskId(t.id); setTaskView(true) }} onDoubleClick={() => setRenaming(t.id)}
              onMouseEnter={e => briefCard.show(e, t.id)} onMouseLeave={briefCard.hide}>
              <span className="att" data-att={a} aria-hidden="true" />
              <span className="task-text">
                <span className="task-line"><span className="task-title">{t.title}</span><span className="task-when">{when(t)}</span></span>
                {(sub || t.worktree) && <span className={`task-sub ${a}`}>{t.worktree && <span className="task-branch"><Icon n="branch" size={11} />{t.branch}</span>}{sub}</span>}
              </span>
            </button>}
        {renaming !== t.id && <button className="row-more icon sm" aria-label={`Opções de ${t.title}`} title="Renomear, arquivar ou excluir"
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); taskMenu(t, r.left, r.bottom + 4) }}><Icon n="more" size={16} /></button>}
      </li>
    )
  }

  // Uma pasta na gaveta: cabecalho (abre a visao geral, + cria conversa ali) e as conversas dela, ordenadas por atencao
  // (precisa de voce > falhou > pronto > trabalhando > resto; depois as mais recentes). Concluidas ficam recolhidas.
  // Arraste a pasta para um organizador do trilho.
  const folderSection = (g: string) => {
    const cur = g === game
    const list = tasksOf(g), failed = list === null ? worldErr[g.toLowerCase()] ?? null : null
    const open = folderOpen[g] ?? cur
    const rows = (list ?? []).map(t => ({ t, a: attOf(t) }))
    const sorted = rows.sort((x, y) => RANK[x.a] - RANK[y.a] || y.t.updated_at.localeCompare(x.t.updated_at))
    const openList = sorted.filter(x => x.a !== 'done').map(x => x.t)
    const done = sorted.filter(x => x.a === 'done').map(x => x.t)
    const sum = sumOf([g])
    const body = (
      <ul className="tasklist">
        {failed != null ? <li className="chats-empty" role="alert">{failed}</li>
          : list === null ? <li className="chats-empty"><span className="loader sm" aria-label="Carregando conversas" /></li> : openList.map(taskRow)}
        {list?.length === 0 && <li className="chats-empty">Nenhuma conversa ainda.</li>}
        {done.length > 0 && <li className="chats-group" role="presentation">
          <button className="group-toggle" aria-expanded={!!doneOpen[g]} onClick={() => setDoneOpen(m => ({ ...m, [g]: !m[g] }))}><Icon n="chevron" size={12} />Concluídas <span>{done.length}</span></button>
        </li>}
        {doneOpen[g] && done.map(taskRow)}
      </ul>
    )
    return (
      <li key={g} className={`folder ${cur ? 'cur' : ''} ${open ? 'open' : ''} ${drag === g ? 'dragging' : ''} ${dropOn === `f:${g}` ? 'drop-before' : ''}`}
        onDragOver={e => { if (drag && drag !== g && ws && ws.id !== INBOX && ws.games.includes(drag)) { e.preventDefault(); setDropOn(`f:${g}`) } }}
        onDragLeave={() => setDropOn(d => (d === `f:${g}` ? null : d))}
        onDrop={e => { if (drag && ws && ws.id !== INBOX && ws.games.includes(drag)) { e.preventDefault(); const d = drag; endDrag(); saveGroups(groups.map(x => (x.id === ws.id ? { ...x, games: placeBefore(x.games, d, g) } : x))) } }}>
        <div className="folder-row" onContextMenu={e => { e.preventDefault(); projectMenu(g, e.clientX, e.clientY) }}>
          <button className="folder-chev" aria-label={open ? `Recolher ${name(g)}` : `Expandir ${name(g)}`} aria-expanded={open} onClick={() => toggleFolder(g, !open)}><Icon n="chevron" size={12} /></button>
          {renaming === g
            ? <RenameInput value={name(g)} label="Novo nome do projeto (vazio volta ao nome da pasta)" onDone={v => renameProject(g, v)} />
            : <button className="folder-name" data-path={g} aria-current={cur && inProject && !taskView} title={`${g}\nClique: visão geral. Arraste para um organizador do trilho`} draggable
                onDragStart={e => { e.dataTransfer.setData('text/plain', g); e.dataTransfer.effectAllowed = 'move'; setDrag(g) }} onDragEnd={endDrag} onClick={() => { pick(g); toggleFolder(g, true) }} onDoubleClick={() => setRenaming(g)}>
                <ProjectIcon game={g} size={18} /><span>{name(g)}</span>
                {sum.wait > 0 ? <span className="att-count" title={`${sum.wait} precisa(m) de você`}>{sum.wait}</span>
                  : sum.flag ? <span className="att" data-att={sum.flag} title={ATTENTION_LABEL[sum.flag]} />
                  : sum.live && !open ? <span className="att" data-att="working" title="Agente trabalhando" /> : null}
              </button>}
          <button className="icon sm folder-add" aria-label={`Nova tarefa em ${name(g)}`} title="Nova tarefa nesta pasta" onClick={() => createIn(g)}><Icon n="plus" size={15} /></button>
          <button className="icon sm folder-more" aria-label={`Opções de ${name(g)}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); projectMenu(g, r.left, r.bottom + 4) }}><Icon n="more" size={15} /></button>
        </div>
        <div className="folder-body">{body}</div>
      </li>
    )
  }

  // Dica do trilho: nome e pasta. Fixed porque a lista rolavel cortaria um tooltip absoluto.
  const [tip, setTip] = useState<{ group: Group; y: number } | null>(null)
  const showTip = (e: { currentTarget: HTMLElement }, t: { group: Group }) => { if (drag) return; const r = e.currentTarget.getBoundingClientRect(); setTip({ ...t, y: r.top + r.height / 2 }) }
  const endDrag = () => { setDrag(null); setDragWs(null); setDropOn(null) }
  // Soltar uma pasta num organizador do trilho: entra nele ("Sem organizador" tira de qualquer um).
  const dropHere = (id: string) => {
    const g = drag
    endDrag()
    if (g) saveGroups(moveTo(groups, g, id === INBOX ? null : id))
  }
  const groupMenu = (x: Group, cx: number, cy: number) => setMenu({ x: cx, y: cy, items: x.id === INBOX ? [
    { label: 'Adicionar pasta…', run: () => addGame() },
    { label: 'Novo organizador…', run: () => setGroupDlg({ games: [] }) },
    { label: 'Recolher todas as pastas', run: () => x.games.forEach(g => toggleFolder(g, false)) },
  ] : [
    { label: 'Adicionar pasta…', run: () => addGame(x.id) },
    { label: 'Configurar organizador…', hint: 'Nome, cor e integrações Godot, Unity e Blender', run: () => setGroupDlg({ games: [], edit: x }) },
    { label: 'Recolher todas as pastas', run: () => x.games.forEach(g => toggleFolder(g, false)) },
    { label: 'Desfazer organizador', hint: 'As pastas vão para "Sem organizador"; nada é apagado', run: () => saveGroups(groups.filter(y => y.id !== x.id)) },
  ] })
  const groupItem = (x: Group & { list: string[] }) => {
    const sum = sumOf(x.list), live = sum.live
    return (
      <li key={x.id} className={`${dropOn === x.id ? 'drop' : ''} ${dropOn === `w:${x.id}` ? 'drop-before' : ''}`}
        onDragOver={e => {
          if (drag) { e.preventDefault(); e.stopPropagation(); setDropOn(x.id) }
          else if (dragWs && dragWs !== x.id && x.id !== INBOX) { e.preventDefault(); setDropOn(`w:${x.id}`) }
        }}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation()
          if (dragWs) { const d = dragWs; endDrag(); if (x.id !== INBOX) saveGroups(placeBefore(groups, groups.find(y => y.id === d)!, groups.find(y => y.id === x.id)!)) }
          else dropHere(x.id)
        }}>
        <button className={`rail-ws ${live ? 'live' : ''} ${x.id === INBOX ? 'inbox' : ''} ${dragWs === x.id ? 'dragging' : ''}`} draggable={x.id !== INBOX}
          onDragStart={e => { e.dataTransfer.setData('text/plain', x.name); e.dataTransfer.effectAllowed = 'move'; setTip(null); setDragWs(x.id) }} onDragEnd={endDrag} aria-current={inProject && ws?.id === x.id} aria-label={`${x.name}, ${x.list.length} pasta(s)${sum.wait ? `, ${sum.wait} precisa(m) de você` : ''}`}
          style={{ '--g': x.color } as CSSProperties}
          onClick={() => { setTip(null); openGroup(x) }}
          onContextMenu={e => { e.preventDefault(); setTip(null); groupMenu(x, e.clientX, e.clientY) }}
          onMouseEnter={e => showTip(e, { group: x })} onFocus={e => showTip(e, { group: x })} onMouseLeave={() => setTip(null)} onBlur={() => setTip(null)}>
          <span className="ws-tile">{x.id === INBOX ? <Icon n="folder" size={17} /> : initials(x.name)}</span>
          {sum.wait > 0 ? <span className="att-count rail-badge" aria-hidden="true">{sum.wait}</span> : sum.flag && <span className={`rail-pip ${sum.flag}`} aria-hidden="true" />}
        </button>
      </li>
    )
  }
  const tipCard = () => {
    if (!tip) return null
    return (
      <div className="rail-float" role="tooltip" style={{ top: tip.y, '--g': tip.group.color } as CSSProperties}>
        <b className="rf-group">{tip.group.name}</b>
        <span className="rf-path rf-list">{tip.group.games.length ? tip.group.games.filter(g => games.includes(g)).map(name).join(' · ') : 'Vazio: clique para escolher a primeira pasta'}</span>
        {!drag && <span className="rf-hint">{tip.group.id === INBOX ? 'Arraste pastas daqui para um organizador' : 'Botão direito: adicionar pasta ou configurar'}</span>}
      </div>
    )
  }

  return (
    <div className={`app ${(panel && inProject) || showFiles ? 'panel-open' : ''} ${drawer ? 'chats-open' : ''}`}>
      <nav className="rail" aria-label="Projetos">
        <button className="rail-btn rail-logo" aria-label="Início" aria-current={home && !settings && !li} onClick={goHome}><img src={orbitMark} alt="" width={30} height={30} draggable={false} /><span className="rail-tip">Início</span></button>
        <button className="rail-btn rail-new" aria-label="Novo organizador" onClick={() => setGroupDlg({ games: [] })}><Icon n="plus" /><span className="rail-tip">Novo organizador</span></button>
        <ul className={`projects ${drag ? 'dragging' : ''}`}>{shownGroups.map(groupItem)}</ul>
        {tipCard()}
        <button className={`rail-btn rail-li ${active.some(a => /[\\/]linkedin$/i.test(a.game)) ? 'live' : ''}`} aria-label="LinkedIn" aria-current={li && !settings} onClick={goLi}><span className="li-glyph" aria-hidden="true">in</span><span className="rail-tip">LinkedIn</span></button>
        <PlanetToggle />
        <button className="rail-btn" aria-label="Configurações" aria-current={settings} onClick={goSettings}><Icon n="gear" /><span className="rail-tip">Configurações</span></button>
      </nav>

      {drawer && ws && (
        <nav className={`chats ws ${ws!.id === INBOX ? 'inbox' : ''}`} aria-label={ws!.name} style={{ '--g': ws!.color } as CSSProperties}>
          <header className="drawer-head">
            <span className="ws-tile sm" aria-hidden="true">{ws!.id === INBOX ? <Icon n="folder" size={13} /> : initials(ws!.name)}</span>
            {renaming === `ws:${ws!.id}`
              ? <RenameInput value={ws!.name} label="Novo nome do organizador" onDone={v => { setRenaming(null); if (v) saveGroups(groups.map(y => (y.id === ws!.id ? { ...y, name: v.slice(0, 40) } : y))) }} />
              : <b title={ws!.id === INBOX ? `${folders.length} pasta(s)` : `${folders.length} pasta(s). Duplo clique renomeia`} onDoubleClick={() => ws!.id !== INBOX && setRenaming(`ws:${ws!.id}`)} >{ws!.name}</b>}
            <button className="icon sm" aria-label={`Adicionar pasta em ${ws!.name}`} title="Adicionar pasta (de qualquer lugar do Windows)" onClick={() => addGame(ws!.id)}><Icon n="folder" size={16} /></button>
            <button className="icon sm" aria-label={`Opções de ${ws!.name}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); groupMenu(ws!, r.left, r.bottom + 4) }}><Icon n="more" size={16} /></button>
          </header>
          {game && <div className="drawer-new">
            <button className="new-task" title={`Nova tarefa em ${name(game)} (Ctrl+N)`} onClick={() => create()}><Icon n="plus" size={15} /><span>Nova tarefa</span><kbd>Ctrl N</kbd></button>
            <button className="icon sm" aria-label="Buscar ou ver arquivadas" title="Buscar conversas ou ver arquivadas (Ctrl+K)" onClick={() => setPalette(true)}><Icon n="search" size={15} /></button>
          </div>}
          <ul className="tree">{folders.map(g => folderSection(g))}</ul>
          {inProject && game && <AlsoRunning active={active} game={game} onOpen={openActive} />}
          {briefCard.view}
        </nav>
      )}

      <div className="center">
        <header className="topbar">
          {inProject && <button className={`icon ${chats ? 'on' : ''}`} aria-label={chats ? 'Ocultar conversas' : 'Mostrar conversas'} aria-expanded={chats} title="Conversas do projeto (Ctrl+B)" onClick={() => setChats(!chats)}><Icon n="sidebar" /></button>}
          <div className="crumb">
            {settings ? <b>Configurações</b> : li ? null : home ? <b>Início</b>
              : game && !chats ? <>{ws && ws.id !== INBOX && <><span className="crumb-ws">{ws.name}</span><Icon n="chevron" size={12} /></>}<b>{name(game)}</b></> : null}
          </div>
          <button className="jump-btn" aria-label="Ir para tarefa, projeto ou ação (Ctrl+K)" title="Ir para tarefa, projeto ou ação" onClick={() => setPalette(true)}><Icon n="search" size={15} /><span>Buscar</span><kbd>Ctrl K</kbd></button>
          {inProject && task?.worktree && taskView && <span className="tag" title={`Isolada na branch ${task.branch}`}><Icon n="branch" size={13} />{task.branch}</span>}
          {inProject && <div className="top-actions" role="group" aria-label="Projeto">
            <button className="icon" aria-label="Pasta e terminal do projeto" title="Pasta e terminal do projeto" aria-haspopup="menu"
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 6, items: [
                { label: 'Abrir pasta do projeto', run: () => api.openFolder(game).catch((e: any) => setErr(errText(e))) },
                { label: 'Terminal no projeto', hint: 'Claude, conta principal', run: () => api.launchGame(game, { provider: 'claude', accountId: accounts[0]?.id }).catch((e: any) => setErr(errText(e))) },
              ] }) }}><Icon n="terminal" /></button>
            {taskView && task && <button className={`icon ${showFiles ? 'on' : ''}`} aria-label={showFiles ? 'Ocultar arquivos alterados' : 'Mostrar arquivos alterados'} aria-expanded={showFiles} title="Arquivos alterados, ao vivo"
              onClick={() => { setFiles(!showFiles); if (!showFiles) setPanel(false) }}><Icon n="files" /></button>}
            <button className={`icon ${panel ? 'on' : ''}`} aria-label={panel ? 'Recolher painel do projeto' : 'Abrir painel do projeto'} aria-expanded={panel} title="Roadmap, problemas e documentos" onClick={() => setPanel(!panel)}><Icon n="panel" /></button>
          </div>}
          <Limits accounts={accounts} />
          <AgentDock active={active} queue={queue} onOpen={openActive} onOpenTask={openQueued} onNext={goNext} />
        </header>
        {err && <div className="banner" role="alert">{err}<button className="icon sm" aria-label="Fechar aviso" onClick={() => setErr('')}><Icon n="close" size={14} /></button></div>}
        {settings
          ? <Settings accounts={accounts} reload={loadAccounts} providers={providers} refreshProviders={refreshProviders} onGamesChange={loadGames} />
          : li ? <LinkedIn accounts={accounts} onErr={setErr} />
          : home ? <Home games={games} active={active} onOpen={pick} onAdd={addGame} lastGame={game} onTodoTask={(g, id, d) => { setDraft(d); openIn(g, id) }} />
          : !game ? <div className="empty"><h1>Escolha um projeto</h1><p>Selecione um projeto no trilho à esquerda ou adicione a pasta de um jogo ou app.</p></div>
          : tasks === null ? <div className="empty"><span className="loader" aria-label="Carregando tarefas" /></div>
          : !taskView ? <Home key={game} games={[game]} tag={ws && ws.id !== INBOX ? ws : null} siblings={folders} active={active} onOpen={g => transition(() => pick(g))} onAdd={addGame} lastGame={game} onNewTask={() => create()} onTodoTask={(g, id, d) => { setDraft(d); openIn(g, id) }}
              below={<ProjectHome game={game} tasks={tasks} active={active} onOpenTask={openTask} onNewTask={create} onErr={setErr} />} />
          : task ? <Chat key={task.id} task={task} accounts={accounts} providers={providers} onChange={() => loadTasks()} draft={draft?.taskId === task.id ? draft : undefined} onDraftUsed={() => setDraft(undefined)}
            onOpenDraft={(g, id, d) => { setDraft(d); openIn(g, id); bump() }} />
          : <section className="empty">
              <h1>Nova tarefa em {name(game)}</h1>
              <p>Cada tarefa tem o próprio chat e histórico. Dá para trocar de provedor dentro dela sem perder as mensagens.</p>
              <form className="inline" onSubmit={e => { e.preventDefault(); create(newTitle.trim() || undefined) }}>
                <input aria-label="Título da tarefa" placeholder="Título da tarefa (opcional)" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
                <button className="primary">Criar tarefa</button>
              </form>
            </section>}
      </div>

      {showFiles && <WorkspaceFiles key={task!.id} task={task!} provider={active.find(a => a.taskId === task!.id)?.provider} onClose={() => setFiles(false)} />}
      {inProject && panel && <ProjectPanel key={game} game={game} accounts={accounts} onOpenTask={openTask} onClose={() => setPanel(false)} />}
      {palette && <Palette game={game} games={games} active={active} queue={queue} attOf={attOf} onClose={() => setPalette(false)} onProject={pick} onTask={openTask}
        onOpenTask={t => openQueued(t, false)} onNewTask={() => create()} onHome={goHome} onSettings={goSettings} />}
      <PermissionPrompt taskId={inProject && taskView ? task?.id : undefined} />
      <Toasts openTaskId={inProject && taskView ? task?.id : undefined} onOpen={(g, id, f) => { openIn(g, id); if (f) { setFiles(true); setPanel(false) } }} />
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {groupDlg && <GroupDialog edit={groupDlg.edit} count={groupDlg.games.length} onClose={() => setGroupDlg(null)}
        onSave={(n, c, engines) => saveGroups(groupDlg.edit ? groups.map(y => (y.id === groupDlg.edit!.id ? { ...y, name: n, color: c, ...engines } : y)) : newGroup(groups, n, c, groupDlg.games, engines))} />}
      {toHide && <Confirm title={`Remover "${name(toHide)}" da lista?`} action="Remover da lista" onClose={() => setToHide(null)} onConfirm={() => hideProject(toHide)}
        body="Nada é apagado: a pasta, as conversas e o histórico continuam onde estão. Para trazer de volta, adicione a pasta de novo pelo +." />}
      {toDelete && <Confirm title={`Excluir "${toDelete.title}"?`} action="Excluir conversa" onClose={() => setToDelete(null)} onConfirm={() => deleteTask(toDelete)}
        body="As mensagens, o histórico e a memória desta conversa são apagados de vez. Arquivos do projeto e worktrees não são tocados. Para só tirar da lista, use Arquivar." />}
    </div>
  )
}
