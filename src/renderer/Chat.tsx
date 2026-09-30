import { useEffect, useRef, useState } from 'react'
import { AGENTS, api, errText, onChat, type Account, type Catalog, type Metric, type Msg, type Provider, type Sel, type Task } from './api'
import { cap, Dropdown, type Opt } from './Dropdown'
import { Avatar, Icon, PROVIDER } from './icons'
import { Markdown } from './Markdown'
import { Confirm, ContextMenu, type MenuItem } from './Nav'
import { PermissionPrompt } from './PermissionPrompt'
import { ContextRequests, TaskInspector, UnsentMessages, usePackages } from './TaskContext'
import { Bar, STATE } from './Settings'
import { shrink, Thumbs, type TodoDraft } from './Todo'
import { Workflow } from './Workflow'
import { Checkpoints } from './Checkpoints'
import { ProjectCommands } from './ProjectCommands'
import { imageRefs, stripMarks } from './msgImages'

const parseSel = (s: string | null | undefined): Sel | null => {
  try { const v = JSON.parse(s ?? 'null'); return v && typeof v.provider === 'string' ? v : null } catch { return null }
}

// Estado de login das contas Claude (consulta gratuita), com cache curto para nao abrir a CLI a cada troca.
const statusCache = new Map<number, { at: number; state: string }>()
function useClaudeStatus(accountId: number | undefined, enabled: boolean) {
  const [state, setState] = useState<string>('unknown')
  useEffect(() => {
    if (!enabled || !accountId) return
    const c = statusCache.get(accountId)
    if (c && Date.now() - c.at < 60_000) return setState(c.state)
    setState('unknown')
    api.accountStatus(accountId).then(s => { statusCache.set(accountId, { at: Date.now(), state: s.state }); setState(s.state) }, () => setState('unknown'))
  }, [accountId, enabled])
  return state
}

// Cotas da conta Claude (5 horas e semana), com o mesmo cache curto; recarrega quando uma execucao termina.
type Window_ = { utilization: number; resets_at: string } | null
type Usage = { fiveHour?: Window_; sevenDay?: Window_; cached?: boolean; error?: string }
const usageCache = new Map<number, { at: number; u: Usage }>()
const USAGE_EVERY = 30_000 // o endpoint recusa excesso (429 cai no ultimo valor visto); 30 s mantem o medidor vivo
function useUsage(accountId: number | undefined, enabled: boolean, bump: unknown) {
  const [u, setU] = useState<Usage | null>(null)
  useEffect(() => {
    if (!enabled || !accountId) return setU(null)
    const load = () => api.accountUsage(accountId).then(v => { usageCache.set(accountId, { at: Date.now(), u: v }); setU(v) }, e => setU(p => p ?? { error: errText(e) }))
    const c = usageCache.get(accountId)
    if (c) setU(c.u)
    if (!c || Date.now() - c.at >= USAGE_EVERY) load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, USAGE_EVERY)
    return () => clearInterval(t)
  }, [accountId, enabled, bump])
  return u
}

// Catalogo de modelos/esforcos do provedor (fonte nativa quando existe); falha aqui nao afeta login nem chat.
function useCatalog(provider: string) {
  const [cat, setCat] = useState<Catalog | null>(null)
  useEffect(() => {
    let live = true
    setCat(null)
    api.catalog(provider).then(c => live && setCat(c), e => live && setCat({ provider, source: 'manual', at: '', models: [], efforts: [], allowCustomModel: false, error: errText(e) }))
    return () => { live = false }
  }, [provider])
  return cat
}

const label = (m: Msg, accounts: Account[]) => {
  if (m.role !== 'agent' || !m.provider) return null
  const acc = m.provider === 'claude' && accounts.length > 1 ? accounts.find(a => a.id === m.account_id)?.name : null
  return [PROVIDER[m.provider]?.label ?? m.provider, acc, m.model && modelName(m.model), m.effort && effortLabel(m.effort)].filter(Boolean).join('  ')
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n))
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000
  return s < 90 ? 'agora' : s < 5400 ? `há ${Math.round(s / 60)} min` : s < 129600 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} d`
}
const NO_CONTEXT: Record<string, string> = {
  codex: 'o codex exec não informa o contexto e o arquivo da sessão não trouxe a medida',
  gemini: 'o Gemini CLI não informa contexto ocupado nem janela',
  claude: 'a execução não trouxe esta medida', opencode: 'a execução não trouxe esta medida'
}

// Medida ao vivo por cima da ultima gravada: o Claude so informa a janela no fim, entao ela vem da medida anterior (mesmo modelo).
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
function withLive(m: Metric | null, l: { occupied: number; capacity: number | null; estimated: boolean; source?: string }, sel: Sel): Metric {
  const base: Metric = m ?? { model: sel.model ?? null, effort: sel.effort ?? null, occupied: null, capacity: null, estimated: false, consumed_in: null, consumed_out: null, scope: null, source: null, at: '' }
  return { ...base, occupied: l.occupied, estimated: l.estimated, capacity: l.capacity ?? base.capacity, source: `${l.source ?? 'execução atual'} (ao vivo)`, at: nowSql() }
}

// Medidor de contexto: anel continuo que enche conforme a janela do modelo e ocupada.
// Contexto ocupado, janela e consumo sao coisas diferentes; percentual so com numerador e denominador conhecidos.
function ContextRing({ m, sel }: { m: Metric | null; sel: Sel }) {
  const pct = m?.occupied != null && m.capacity ? Math.min(100, Math.round((m.occupied / m.capacity) * 100)) : null
  const stale = m && (m.model ?? null) !== (sel.model ?? null)
  const C = 2 * Math.PI * 9
  return (
    <span className={`meter ctx-ring ${pct == null ? 'none' : pct > 80 ? 'hot' : ''}`} tabIndex={0} aria-label={`Contexto: ${pct == null ? 'sem medida' : `${pct}%`}`}>
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <circle className="track" cx="12" cy="12" r="9" />
        {pct != null && <circle className="fill" cx="12" cy="12" r="9" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />}
      </svg>
      <span className="tip" role="tooltip">
        <b>Contexto{pct != null ? ` ${m!.estimated ? '≈' : ''}${pct}%` : ''}</b>
        {!m ? <span>Sem medida ainda. Aparece depois da primeira execução com {PROVIDER[sel.provider]?.label ?? sel.provider}.</span>
          : <>
              <span>{m.occupied == null ? `Indisponível: ${NO_CONTEXT[sel.provider] ?? 'sem dados'}.`
                : pct != null ? `${fmt(m.occupied)} de ${fmt(m.capacity!)} tokens ocupados`
                : `${fmt(m.occupied)} tokens${m.estimated ? ' (estimado)' : ''}; janela do modelo desconhecida`}</span>
              {(m.consumed_in != null || m.consumed_out != null) && <span>
                Consumo {m.scope === 'thread' ? 'acumulado' : 'da última execução'}: {[m.consumed_in != null && `entrada ${fmt(m.consumed_in)}`, m.consumed_out != null && `saída ${fmt(m.consumed_out)}`].filter(Boolean).join(', ')}
              </span>}
              <small>Fonte: {m.source ?? 'desconhecida'}, {ago(m.at)}{stale ? `. Medida do modelo ${m.model ?? 'padrão'}; atualiza na próxima execução.` : ''}</small>
            </>}
      </span>
    </span>
  )
}

// Medidor de limites: dois aneis segmentados (fora: 5 horas, dentro: semana). Formato diferente do contexto de proposito.
const SEG = 12
const arc = (r: number, i: number) => {
  const gap = 0.12, a0 = (i / SEG) * 2 * Math.PI + gap, a1 = ((i + 1) / SEG) * 2 * Math.PI - gap
  const p = (a: number) => `${12 + r * Math.sin(a)} ${12 - r * Math.cos(a)}`
  return `M${p(a0)}A${r} ${r} 0 0 1 ${p(a1)}`
}
function Segments({ r, pct, cls }: { r: number; pct: number | null; cls: string }) {
  const on = pct == null ? 0 : Math.ceil((Math.min(pct, 100) / 100) * SEG)
  return <g className={cls}>{Array.from({ length: SEG }, (_, i) => <path key={i} d={arc(r, i)} className={i < on ? 'on' : ''} />)}</g>
}
function LimitRing({ u, provider }: { u: Usage | null; provider: string }) {
  const h5 = u?.fiveHour ? Math.round(u.fiveHour.utilization) : null
  const wk = u?.sevenDay ? Math.round(u.sevenDay.utilization) : null
  const hot = Math.max(h5 ?? 0, wk ?? 0) > 80
  return (
    <span className={`meter limit-ring ${h5 == null && wk == null ? 'none' : ''} ${hot ? 'hot' : ''}`} tabIndex={0}
      aria-label={`Limites da conta: ${h5 == null ? 'sem dados' : `5 horas ${h5}%, semana ${wk ?? '?'}%`}`}>
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <Segments r={10.2} pct={h5} cls="outer" />
        <Segments r={5.8} pct={wk} cls="inner" />
      </svg>
      <span className="tip" role="tooltip">
        <b>Limites de uso</b>
        {provider !== 'claude' ? <span>Só as contas Claude informam limites de uso.</span>
          : u?.error ? <span>Indisponível: {u.error}</span>
          : !u ? <span>Consultando…</span>
          : <>
              <Bar label="Limite de 5 horas" w={u.fiveHour ?? null} />
              <Bar label="Semanal" w={u.sevenDay ?? null} />
              {u.cached && <small>Último valor visto.</small>}
            </>}
      </span>
    </span>
  )
}

export const EFFORT: Record<string, string> = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' }
export const effortLabel = (f: string) => EFFORT[f] ?? cap(f)
// Rotulo do modelo: o nome do catalogo quando existe; senao o id, sem o prefixo do provedor (ele vira o grupo).
// Id completo do Claude vira nome legivel ("claude-sonnet-5-5" = "Sonnet 5.5"); o resto so ganha maiuscula.
export const modelName = (id: string) => { const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id); return m ? `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : cap(id) }
const modelLabel = (m: { id: string; label?: string }) => cap(m.label ?? (m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id))

function ModelPicker({ cat, sel, disabled, onChange }: { cat: Catalog | null; sel: Sel; disabled: boolean; onChange: (s: Sel) => void }) {
  if (!cat) return <Dropdown label="Modelo" value="" options={[]} placeholder="Carregando…" disabled onChange={() => {}} />
  const model = cat.models.find(m => m.id === sel.model)
  const efforts = model?.efforts ?? cat.efforts
  const needsModel = !model && cat.models.some(m => m.efforts !== null)
  const native = cat.source === 'native' && cat.models.length > 0
  const grouped = native && new Set(cat.models.map(m => m.id.split('/')[0])).size > 1 && cat.models.some(m => m.id.includes('/'))
  const models: Opt[] = [{ value: '', label: 'Modelo padrão' }, ...cat.models.map(m => ({ value: m.id, label: modelLabel(m), group: grouped ? (m.id.includes('/') ? m.id.split('/')[0] : 'outros') : undefined }))]
  return (
    <>
      <Dropdown label="Modelo" title={cat.note ?? 'Modelo'} value={sel.model ?? ''} options={models} placeholder="Modelo padrão" disabled={disabled}
        search={cat.models.length > 8 || !native} custom={!native} onChange={v => onChange({ ...sel, model: v || undefined, effort: undefined })} />
      <Dropdown label="Esforço" value={sel.effort ?? ''} placeholder="Esforço padrão" disabled={disabled || !efforts.length || needsModel}
        title={!efforts.length ? 'Este provedor/modelo não expõe esforço nesta versão' : needsModel ? 'Escolha um modelo para definir o esforço' : 'Esforço de raciocínio (vale a partir da próxima execução)'}
        options={[{ value: '', label: 'Esforço padrão' }, ...efforts.map(f => ({ value: f, label: effortLabel(f), hint: model?.defaultEffort === f ? 'padrão' : undefined }))]}
        onChange={v => onChange({ ...sel, effort: v || undefined })} />
      {cat.error && <span className="warn" role="status" title={cat.error}>Catálogo indisponível</span>}
    </>
  )
}

export function Chat({ task, accounts, providers, onChange, draft, onDraftUsed }: {
  task: Task; accounts: Account[]; providers: Provider[] | null; onChange: () => void; draft?: TodoDraft; onDraftUsed?: () => void
}) {
  const [sel, setSelState] = useState<Sel>(() => parseSel(task.sel) ?? { provider: 'claude', accountId: accounts[0]?.id })
  const [hist, setHist] = useState<{ running: boolean; awaitingContext?: boolean; messages: Msg[]; task: Task; metric: Metric | null } | null>(null)
  const [live, setLive] = useState('')
  const [liveMetric, setLiveMetric] = useState<{ occupied: number; capacity: number | null; estimated: boolean; source?: string } | null>(null)
  const [stepId, setStepId] = useState<number | undefined>()
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([]) // data: URLs ja reduzidas; viram arquivo so no envio
  const [view, setView] = useState<string | null>(null) // imagem ampliada
  const file = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')
  const [atEnd, setAtEnd] = useState(true)
  const msgs = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // so acompanha o fim se o usuario nao estiver lendo mensagens antigas
  const req = useRef(0) // descarta respostas antigas (troca rapida de tarefa/provedor)
  const cat = useCatalog(sel.provider)
  const pkgs = usePackages(task.id)
  const [inspect, setInspect] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [cps, setCps] = useState(false) // checkpoints do turno (congelam o Git antes de cada mensagem)
  const [ask, setAsk] = useState<{ title: string; body: string; action: string; run: () => void } | null>(null) // confirmacao no estilo do app, nao o confirm() do Windows

  useEffect(() => {
    if (!draft || draft.taskId !== task.id) return
    setText(draft.text); setImages(draft.images)
    if (draft.agent && AGENTS.includes(draft.agent)) setSel({ provider: draft.agent, accountId: draft.agent === 'claude' ? accounts[0]?.id : undefined })
    onDraftUsed?.()
  }, [draft, task.id])

  // A escolha fica gravada na tarefa e vale a partir da PROXIMA execucao; se for recusada (modelo/esforco invalidos), volta.
  const setSel = (next: Sel) => {
    const prev = sel
    setSelState(next)
    setErr('')
    api.setTaskSel(task.id, next).catch(e => { setSelState(prev); setErr(errText(e)) })
  }

  const load = () => {
    const n = ++req.current
    return api.taskChat(task.id, sel).then(h => {
      if (n !== req.current) return
      setHist(h)
      setLive(h.live || (h.running ? '…' : '')) // volta a mostrar o streaming de uma execucao ativa
      // Sem escolha gravada: sugere o provedor/conta da ultima resposta desta tarefa.
      if (!h.sel) {
        const last = [...h.messages].reverse().find((m: Msg) => m.role === 'agent' && m.provider)
        if (last && last.provider !== sel.provider) setSelState({ provider: last.provider!, accountId: last.account_id ?? undefined })
      }
    }, e => setErr(errText(e)))
  }
  useEffect(() => { setErr(''); setLiveMetric(null); load() }, [task.id, sel.provider, sel.accountId])
  useEffect(() => onChat(ev => {
    if (ev.taskId !== task.id) return
    if (ev.refresh) return void load() // delegacao iniciou/terminou: mensagem de sistema nova
    if (ev.metric) return void setLiveMetric(ev.metric)
    if (ev.done) { load().then(() => setLiveMetric(null)); onChange(); return } // load() limpa o streaming junto com a mensagem final: sem piscar vazio no meio
    if (typeof ev.text !== 'string') return // pedidos de permissao/contexto tambem trazem taskId, mas nao sao texto: nao apagam o streaming
    setLive(ev.text)
    // Execucao iniciada por fora desta tela (ex.: outra janela): sincroniza o estado "executando" e a lista de tarefas.
    setHist(h => { if (h && !h.running) { onChange(); return { ...h, running: true } } return h })
  }), [task.id, sel.provider, sel.accountId])
  useEffect(() => {
    const m = msgs.current
    if (m && stick.current) m.scrollTop = m.scrollHeight
  }, [hist, live])

  const provider = providers?.find(p => p.id === sel.provider)
  const claudeState = useClaudeStatus(sel.accountId, sel.provider === 'claude')
  const conn = sel.provider === 'claude' ? claudeState : provider?.auth?.state ?? 'unknown'
  const missing = providers && provider && !provider.exe
  const running = hist?.running ?? false
  const usage = useUsage(sel.accountId, sel.provider === 'claude', hist?.metric?.at)

  const awaiting = !!hist?.awaitingContext || pkgs.sends.some(s => s.state === 'awaiting_context_approval')
  const send = () => {
    if ((!text.trim() && !images.length) || running || awaiting) return
    setErr('')
    // Havendo contexto anterior a decidir, a mensagem fica RETIDA (nenhum agente inicia): o cartao acima do compositor pede a decisao.
    api.sendTask(task.id, sel, text.trim(), images, stepId).then(() => { setText(''); setImages([]); setStepId(undefined); stick.current = true; pkgs.load(); load(); onChange() }, e => setErr(errText(e)))
  }
  // 1568 px: o maior lado que o Claude usa sem reduzir de novo; screenshot continua legivel. Cada imagem custa ~1.500 tokens por chamada.
  const attach = (files: Blob[]) => Promise.all(files.map(f => shrink(f, 1568))).then(out => setImages(i => [...i, ...out].slice(0, 6)), () => setErr('Não foi possível ler a imagem.'))
  const act = (f: Promise<any>) => f.then(() => { load(); onChange() }, e => setErr(errText(e)))
  const t = hist?.task ?? task
  const connLabel = missing ? 'não instalado' : STATE[conn as keyof typeof STATE] ?? conn

  return (
    <section className="chat" aria-label="Conversa da tarefa">
      <header className="chat-head">
        <Title task={t} onRename={title => act(api.renameTask(task.id, title))} />
        <div className="chat-actions">
          <button className={`icon ${inspect ? 'on' : ''}`} aria-label="Memória, uso e contexto da tarefa" title="Memória, uso e contexto da tarefa" aria-expanded={inspect} onClick={() => setInspect(!inspect)}><Icon n="layers" /></button>
          <button className="icon" aria-label="Mais ações da tarefa" title="Nova sessão, terminal, worktree, checkpoints, arquivar" aria-haspopup="menu" aria-expanded={!!menu}
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 200, y: r.bottom + 6, items: [
              { label: 'Nova sessão', hint: 'A próxima mensagem começa com contexto vazio (economiza tokens em tarefas longas)', disabled: running,
                run: () => setAsk({ title: 'Começar uma nova sessão?', action: 'Nova sessão', body: 'O agente deixa de ver a conversa anterior; o histórico recente só segue se você aprovar.', run: () => act(api.newSession(task.id, sel)) }) },
              { label: 'Continuar num terminal', hint: 'Mesma sessão do provedor', run: () => { api.launchTask(task.id, sel, { resume: true }).catch(e => setErr(errText(e))) } },
              { label: t.worktree ? `Isolada em ${t.branch}` : 'Isolar em worktree', disabled: !!t.worktree || running, hint: 'Necessário só para implementar em isolamento',
                run: () => setAsk({ title: 'Isolar numa worktree Git?', action: 'Criar worktree', body: 'As sessões nativas dos provedores recomeçam e o histórico é enviado como contexto.', run: () => act(api.isolateTask(task.id)) }) },
              { label: 'Arquivar tarefa', hint: 'Não apaga mensagens, arquivos nem worktrees', disabled: running, run: () => act(api.archiveTask(task.id, true)) },
              { label: 'Checkpoints do turno…', hint: 'A pasta congela antes de cada mensagem; volte a um ponto anterior', run: () => setCps(true) },
            ] }) }}><Icon n="more" /></button>
        </div>
      </header>

      <div className="msgs" ref={msgs} tabIndex={0} aria-live="polite" aria-label="Mensagens"
        onScroll={e => { const m = e.currentTarget; const end = m.scrollHeight - m.scrollTop - m.clientHeight < 80; stick.current = end; setAtEnd(end) }}>
        <div className="thread">
          {hist?.messages.length === 0 && !running && <div className="thread-empty">
            <Avatar provider={sel.provider} />
            <p>Escreva abaixo para começar. O histórico fica na tarefa, mesmo se você trocar de provedor.</p>
          </div>}
          {hist?.messages.map(m => (
            <div key={m.id} className={`msg ${m.role} ${m.status ?? ''}`}>
              {m.role === 'agent' && <div className="who">{m.provider && <Avatar provider={m.provider} size="sm" />}<span>{label(m, accounts)}</span>
                {m.status === 'failed' && <span className="flag">falhou</span>}{m.status === 'cancelled' && <span className="flag">interrompida</span>}</div>}
              {m.role === 'agent' ? <Markdown text={m.text} /> : stripMarks(m.text) && <p>{stripMarks(m.text)}</p>}
              <MsgImages taskId={task.id} text={m.text} marksOnly={m.role !== 'agent'} onOpen={setView} />
            </div>
          ))}
          {running && <div className="msg agent streaming">
            <div className="who"><Avatar provider={sel.provider} size="sm" live /><span>{PROVIDER[sel.provider]?.label ?? sel.provider} trabalhando</span></div>
            {live && live !== '…' && <Markdown text={live} />}
            <span className="typing" aria-label="Trabalhando"><i /><i /><i /></span>
          </div>}
        </div>
      </div>
      {!atEnd && <button className="jump" aria-label="Ir para o fim" onClick={() => { const m = msgs.current!; m.scrollTop = m.scrollHeight }}><Icon n="down" size={16} /></button>}

      <div className="dock-composer">
        <ProjectCommands taskId={task.id} game={task.game} disabled={running || awaiting} />
        <Workflow taskId={task.id} disabled={running || awaiting} onPrepare={s => { setText(s.instruction); setImages([]); setStepId(s.id) }} />
        {stepId && <p className="muted">Ordem da etapa #{stepId} preparada. Revise e envie pelo chat. <button className="link" onClick={() => setStepId(undefined)}>Enviar como mensagem comum</button></p>}
        {err && <div className="banner" role="alert">{err}<button className="icon sm" aria-label="Fechar aviso" onClick={() => setErr('')}><Icon n="close" size={14} /></button></div>}
        <ContextRequests pkgs={pkgs.list} sends={pkgs.sends} accounts={accounts} reload={() => { pkgs.load(); load(); onChange() }} />
        <UnsentMessages sends={pkgs.sends} reload={pkgs.load} onRecover={t => setText(cur => (cur.trim() ? `${cur}\n\n${t}` : t))} />
        <PermissionPrompt inline taskId={task.id} />
        <form className={`composer ${running ? 'running' : ''}`} onSubmit={e => { e.preventDefault(); send() }}>
          <textarea aria-label="Mensagem" placeholder={awaiting ? 'Decida sobre o contexto pendente acima para continuar' : `Mensagem para ${PROVIDER[sel.provider]?.label ?? sel.provider}`} value={text} rows={1}
            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) send() }}
            onPaste={e => { const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); attach(imgs) } }} />
          {images.length > 0 && <div className="composer-imgs"><Thumbs images={images} onOpen={setView} onRemove={i => setImages(im => im.filter((_, j) => j !== i))} /></div>}
          <div className="composer-bar">
            <div className="pickers">
              <span className={`conn ${missing ? 'error' : conn}`} title={`${PROVIDER[sel.provider]?.label ?? sel.provider}: ${connLabel} (login e diagnóstico ficam em Configurações)`} aria-label={`Conexão: ${connLabel}`} />
              <Dropdown label="Provedor" title={awaiting ? 'Bloqueado: decida ou cancele o envio retido (a decisão vale para o destino em que a mensagem foi enviada)' : 'Provedor'} strong value={sel.provider} disabled={running || awaiting} placeholder="Provedor"
                options={AGENTS.map(a => ({ value: a, label: PROVIDER[a]?.label ?? cap(a) }))}
                onChange={v => setSel({ provider: v, accountId: v === 'claude' ? accounts[0]?.id : undefined })} />
              {sel.provider === 'claude' && accounts.length > 1 && <Dropdown label="Conta Claude" title="Conta Claude" value={String(sel.accountId ?? '')} disabled={running || awaiting} placeholder="Conta"
                options={accounts.map(a => ({ value: String(a.id), label: cap(a.name) }))} onChange={v => setSel({ ...sel, accountId: +v })} />}
              <ModelPicker cat={cat} sel={sel} disabled={running || awaiting} onChange={setSel} />
            </div>
            <div className="meters">
              <ContextRing m={liveMetric ? withLive(hist?.metric ?? null, liveMetric, sel) : hist?.metric ?? null} sel={sel} />
              <LimitRing u={usage} provider={sel.provider} />
            </div>
            {running
              ? <button type="button" className="send stop" aria-label="Parar" title="Parar" onClick={() => api.stopTask(task.id).then(load)}><Icon n="stop" size={16} /></button>
              : <>
                <button type="button" className="icon sm" aria-label="Anexar imagem" title="Anexar imagem (ou cole com Ctrl+V)" disabled={awaiting || images.length >= 6} onClick={() => file.current?.click()}><Icon n="image" size={16} /></button>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { attach([...(e.target.files ?? [])]); e.target.value = '' }} />
                <button className="send" aria-label="Enviar" title={awaiting ? 'Há uma mensagem retida aguardando a sua decisão sobre contexto' : 'Enviar (Ctrl+Enter)'} disabled={!!missing || (!text.trim() && !images.length) || awaiting}><Icon n="send" size={18} /></button>
              </>}
          </div>
        </form>
        {view && <div className="lightbox" role="dialog" aria-label="Imagem" tabIndex={-1} ref={el => el?.focus()} onClick={() => setView(null)} onKeyDown={e => { if (e.key === 'Escape') setView(null) }}><img src={view} alt="" /></div>}
        {inspect && <TaskInspector taskId={task.id} pkgs={pkgs.list} reload={pkgs.load} onClose={() => setInspect(false)} />}
        {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        {cps && <Checkpoints taskId={task.id} onClose={() => { setCps(false); load(); onChange() }} />}
        {ask && <Confirm title={ask.title} body={ask.body} action={ask.action} tone="primary" onConfirm={ask.run} onClose={() => setAsk(null)} />}
        <small className="kbd-hint">Ctrl+Enter envia. Modelo e esforço valem a partir da próxima mensagem.</small>
      </div>
    </section>
  )
}

// Miniaturas das imagens citadas na mensagem. O processo principal so devolve imagens do projeto da tarefa ou dos anexos dela;
// o resto (caminho inexistente, fora das pastas, internet) simplesmente nao aparece.
function MsgImages({ taskId, text, marksOnly, onOpen }: { taskId: number; text: string; marksOnly?: boolean; onOpen: (src: string) => void }) {
  const refs = imageRefs(text, marksOnly).join('|') // chave estavel para o efeito ('|' nao aparece em caminho)
  const [srcs, setSrcs] = useState<string[]>([])
  useEffect(() => {
    let live = true
    if (!refs) { setSrcs([]); return }
    Promise.all(refs.split('|').map(p => api.taskImage(taskId, p).catch(() => null))).then(r => { if (live) setSrcs(r.filter(Boolean)) })
    return () => { live = false }
  }, [taskId, refs])
  return srcs.length ? <div className="msg-imgs"><Thumbs images={srcs} onOpen={onOpen} /></div> : null
}

function Title({ task, onRename }: { task: Task; onRename: (t: string) => void }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(task.title)
  useEffect(() => setV(task.title), [task.title, task.id])
  const done = () => { setEdit(false); if (v.trim() && v.trim() !== task.title) onRename(v.trim()); else setV(task.title) }
  return edit
    ? <input className="title-edit" aria-label="Título da tarefa" autoFocus value={v} onChange={e => setV(e.target.value)} onBlur={done}
        onKeyDown={e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { setV(task.title); setEdit(false) } }} />
    : <h1 className="title" title="Clique para renomear" tabIndex={0} onClick={() => setEdit(true)} onKeyDown={e => { if (e.key === 'Enter') setEdit(true) }}>{task.title}</h1>
}
