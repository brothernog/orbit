import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AGENTS, api, errText, type Account, type Catalog, type Metric, type Msg, type Provider, type Sel, type Task } from './api'
import { cap, Dropdown, type Opt } from './Dropdown'
import { Avatar, Icon, PROVIDER } from './icons'
import { Markdown } from './Markdown'
import { Confirm, ContextMenu, type MenuItem } from './Nav'
import { PermissionPrompt } from './PermissionPrompt'
import { QuestionPrompt, SuggestionChips } from './AgentAsks'
import { ChildAgents, parentDoing, useTaskAgents } from './LiveAgents'
import { SharedFiles } from './SharedFiles'
import { ContextRequests, TaskInspector, UnsentMessages, usePackages } from './TaskContext'
import { CONN_STATE, effortLabel, modelName } from './labels'
import { Bar } from './UsageBar'
import { shrink, Thumbs, type TodoDraft } from './Todo'
import { Workflow } from './Workflow'
import { Checkpoints } from './Checkpoints'
import { ActivityLog } from './ActivityLog'
import { parseSteps } from './stepsView'
import { ProjectCommands } from './ProjectCommands'
import { fileRefs, imageRefs, sentCaption, stripMarks } from './msgImages'
import { loadRead } from './readCache'
import { useCachedRead } from './useCachedRead'
import { usageNote, type QuotaSnapshot } from './usageText'
import { useTaskChat } from './useTaskChat'
import { agoText } from './time'

const parseSel = (s: string | null | undefined): Sel | null => {
  try { const v = JSON.parse(s ?? 'null'); return v && typeof v.provider === 'string' ? v : null } catch { return null }
}

// Status/quotas compartilham o snapshot com Configuracoes e o popup de limites.
function useClaudeStatus(accountId: number | undefined, enabled: boolean) {
  const { data } = useCachedRead<{ state: string }>(enabled && accountId ? `accountStatus:${accountId}` : null, () => api.accountStatus(accountId), 60_000)
  return data?.state ?? 'unknown'
}

// Cotas da conta Claude (5 horas e semana), com o mesmo cache curto; recarrega quando uma execucao termina.
type Usage = QuotaSnapshot
const USAGE_EVERY = 30_000
function useUsage(accountId: number | undefined, enabled: boolean, bump: unknown) {
  const key = enabled && accountId ? `accountUsage:${accountId}` : null
  const { data, error, reload } = useCachedRead<Usage | null>(key, () => api.accountUsage(accountId), USAGE_EVERY)
  useEffect(() => {
    if (!key) return
    loadRead(key, () => api.accountUsage(accountId), USAGE_EVERY).catch(() => {})
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload().catch(() => {}) }, USAGE_EVERY)
    return () => clearInterval(t)
  }, [key, bump, reload])
  return data ?? (error ? { error: errText(error) } : null)
}

// Catalogo de modelos/esforcos do provedor (fonte nativa quando existe); falha aqui nao afeta login nem chat.
function useCatalog(provider: string) {
  const { data, error } = useCachedRead<Catalog>(`catalog:${provider}`, () => api.catalog(provider), 600_000)
  return data ?? (error ? { provider, source: 'manual' as const, at: '', models: [], efforts: [], allowCustomModel: false, error: errText(error) } : null)
}

const label = (m: Msg, accounts: Account[]) => {
  if (m.role !== 'agent' || !m.provider) return null
  const acc = m.provider === 'claude' && accounts.length > 1 ? accounts.find(a => a.id === m.account_id)?.name : null
  return [PROVIDER[m.provider]?.label ?? m.provider, acc, m.model && modelName(m.model), m.effort && effortLabel(m.effort)].filter(Boolean).join('  ')
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n))
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
              <small>Fonte: {m.source ?? 'desconhecida'}, {agoText(m.at)}{stale ? `. Medida do modelo ${m.model ?? 'padrão'}; atualiza na próxima execução.` : ''}</small>
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
              {usageNote(u) && <small>{usageNote(u)}</small>}
            </>}
      </span>
    </span>
  )
}

// Rotulo do modelo no seletor: o nome do catalogo quando existe; senao o id, sem o prefixo do provedor (ele vira o grupo).
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
      <Dropdown label="Modelo" title={cat.note ?? 'Modelo (vale a partir da próxima mensagem)'} value={sel.model ?? ''} options={models} placeholder="Modelo padrão" disabled={disabled}
        search={cat.models.length > 8 || !native} custom={!native} onChange={v => onChange({ ...sel, model: v || undefined, effort: undefined })} />
      <Dropdown label="Esforço" value={sel.effort ?? ''} placeholder="Esforço padrão" disabled={disabled || !efforts.length || needsModel}
        title={!efforts.length ? 'Este provedor/modelo não expõe esforço nesta versão' : needsModel ? 'Escolha um modelo para definir o esforço' : 'Esforço de raciocínio (vale a partir da próxima execução)'}
        options={[{ value: '', label: 'Esforço padrão' }, ...efforts.map(f => ({ value: f, label: effortLabel(f), hint: model?.defaultEffort === f ? 'padrão' : undefined }))]}
        onChange={v => onChange({ ...sel, effort: v || undefined })} />
      {cat.error && <span className="warn" role="status" title={cat.error}>Catálogo indisponível</span>}
    </>
  )
}

export function Chat({ task, accounts, providers, onChange, draft, onDraftUsed, onOpenDraft }: {
  task: Task; accounts: Account[]; providers: Provider[] | null; onChange: () => void; draft?: TodoDraft; onDraftUsed?: () => void
  onOpenDraft?: (game: string, taskId: number, draft: TodoDraft) => void // sugestao do agente: abre a tarefa nova com a ordem no compositor
}) {
  const [sel, setSelState] = useState<Sel>(() => parseSel(task.sel) ?? { provider: 'claude', accountId: accounts[0]?.id })
  const [liveMetric, setLiveMetric] = useState<{ occupied: number; capacity: number | null; estimated: boolean; source?: string } | null>(null)
  const [stepId, setStepId] = useState<number | undefined>()
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([]) // data: URLs ja reduzidas; viram arquivo so no envio
  const [sending, setSending] = useState(false) // sendTask pendente: segundo Ctrl+Enter nao reenvia
  const [view, setView] = useState<string | null>(null) // imagem ampliada
  const file = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')
  const [atEnd, setAtEnd] = useState(true)
  const msgs = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // so acompanha o fim se o usuario nao estiver lendo mensagens antigas
  const known = useRef<{ task: number; ids: Set<number> } | null>(null) // mensagens ja na tela ao abrir: so as novas entram com animacao
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

  const { hist, live, liveSteps, load, send: sendChat } = useTaskChat(task.id, {
    sel: () => sel, msgs, stick, onError: setErr,
    // Sem escolha gravada: sugere o provedor/conta da ultima resposta desta tarefa.
    onLoaded: h => {
      if (known.current?.task !== task.id) known.current = { task: task.id, ids: new Set(h.messages.map(m => m.id)) }
      if (h.sel) return
      const last = [...h.messages].reverse().find(m => m.role === 'agent' && m.provider)
      if (last && last.provider !== sel.provider) setSelState({ provider: last.provider!, accountId: last.account_id ?? undefined })
    },
    onMetric: setLiveMetric,
    onDone: loaded => { loaded.then(() => setLiveMetric(null)); onChange() }, // sem piscar vazio no meio
    onStart: onChange, // execucao iniciada por fora desta tela (ex.: outra janela): sincroniza a lista de tarefas
  })
  useEffect(() => { setErr(''); setLiveMetric(null); load() }, [task.id, sel.provider, sel.accountId])
  // A area das mensagens encolhe (janela menor, painel de etapas aberto, cartao de contexto): quem estava no fim continua vendo o fim.
  useEffect(() => {
    const m = msgs.current
    if (!m) return
    const ro = new ResizeObserver(() => { if (stick.current) m.scrollTop = m.scrollHeight })
    ro.observe(m)
    return () => ro.disconnect()
  }, [])

  const provider = providers?.find(p => p.id === sel.provider)
  const claudeEnabled = sel.provider === 'claude' && accounts.find(a => a.id === sel.accountId)?.login?.state !== 'connecting'
  const claudeState = useClaudeStatus(sel.accountId, claudeEnabled)
  const conn = sel.provider === 'claude' ? claudeState : provider?.auth?.state ?? 'unknown'
  const missing = providers && provider && !provider.exe
  const running = hist?.running ?? false
  const agents = useTaskAgents(task.id, running)
  const doing = parentDoing(agents)
  const usage = useUsage(sel.accountId, claudeEnabled, hist?.metric?.at)

  const awaiting = !!hist?.awaitingContext || pkgs.sends.some(s => s.state === 'awaiting_context_approval')
  const send = () => {
    if ((!text.trim() && !images.length) || running || awaiting || sending) return
    setErr(''); setSending(true)
    const sent = text, sentImages = images
    // Havendo contexto anterior a decidir, a mensagem fica RETIDA (nenhum agente inicia): o cartao acima do compositor pede a decisao.
    // So sai do compositor o que foi enviado: texto e imagens acrescentados durante o envio ficam.
    sendChat(sent.trim(), sentImages, stepId).then(() => {
      setText(t => (t.startsWith(sent) ? t.slice(sent.length).trimStart() : t)); setImages(i => i.filter(x => !sentImages.includes(x)))
      setStepId(undefined); stick.current = true; pkgs.load(); onChange()
    }, e => setErr(errText(e))).finally(() => setSending(false))
  }
  // 1568 px: o maior lado que o Claude usa sem reduzir de novo; screenshot continua legivel. Cada imagem custa ~1.500 tokens por chamada.
  const attach = (files: Blob[]) => Promise.all(files.map(f => shrink(f, 1568))).then(out => setImages(i => [...i, ...out].slice(0, 6)), () => setErr('Não foi possível ler a imagem.'))
  const act = (f: Promise<any>) => f.then(() => { load(); onChange() }, e => setErr(errText(e)))
  const t = hist?.task ?? task
  const connLabel = missing ? 'não instalado' : CONN_STATE[conn as keyof typeof CONN_STATE] ?? conn

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
          {hist && <Thread messages={hist.messages} known={known.current?.ids ?? null} accounts={accounts} taskId={task.id} onOpen={setView} />}
          {running && <div className="msg agent streaming enter-rise">
            <ActivityLog steps={liveSteps ?? { total: 0, items: [], totals: { edit: 0, read: 0, run: 0, search: 0, web: 0, other: 0, failed: 0, added: 0, removed: 0, files: 0 } }} live />
            {live && live !== '…' && <Markdown text={live} />}
            <ChildAgents list={agents} />
          </div>}
        </div>
      </div>
      {!atEnd && <button className="jump" aria-label="Ir para o fim" onClick={() => { const m = msgs.current!; m.scrollTop = m.scrollHeight }}><Icon n="down" size={16} /></button>}

      <div className="dock-composer">
        {/* Faixa de ferramentas da tarefa: chips que abrem um painel por vez (details name=task-tools); Esc fecha */}
        <div className="task-tools" onKeyDown={e => { if (e.key !== 'Escape') return; const d = (e.target as HTMLElement).closest('.task-tools > details[open]') as HTMLDetailsElement | null; if (d) { e.stopPropagation(); d.open = false; d.querySelector('summary')?.focus() } }}>
          <Workflow taskId={task.id} disabled={running || awaiting} onPrepare={s => { setText(s.instruction); setImages([]); setStepId(s.id) }} />
          <ProjectCommands taskId={task.id} game={task.game} disabled={running || awaiting} />
        </div>
        {stepId && <p className="muted step-note">Ordem da etapa #{stepId} preparada. Revise e envie pelo chat. <button className="link" onClick={() => setStepId(undefined)}>Enviar como mensagem comum</button></p>}
        {err && <div className="banner" role="alert">{err}<button className="icon sm" aria-label="Fechar aviso" onClick={() => setErr('')}><Icon n="close" size={14} /></button></div>}
        <ContextRequests pkgs={pkgs.list} sends={pkgs.sends} accounts={accounts} reload={() => { pkgs.load(); load(); onChange() }} />
        <UnsentMessages sends={pkgs.sends} reload={pkgs.load} onRecover={t => setText(cur => (cur.trim() ? `${cur}\n\n${t}` : t))} />
        <PermissionPrompt inline taskId={task.id} />
        <QuestionPrompt taskId={task.id} />
        {onOpenDraft && <SuggestionChips taskId={task.id} onStart={(g, id, t) => onOpenDraft(g, id, { taskId: id, text: t, images: [] })} />}
        <form className={`composer ${running ? 'running' : ''}`} onSubmit={e => { e.preventDefault(); send() }}>
          <textarea aria-label="Mensagem" placeholder={awaiting ? 'Decida sobre o contexto pendente acima para continuar' : `Mensagem para ${PROVIDER[sel.provider]?.label ?? sel.provider} (Ctrl+Enter envia)`} value={text} rows={1}
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
            <button type="button" className="icon sm" aria-label="Anexar imagem" title="Anexar imagem (ou cole com Ctrl+V)" disabled={running || awaiting || images.length >= 6} onClick={() => file.current?.click()}><Icon n="image" size={16} /></button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { attach([...(e.target.files ?? [])]); e.target.value = '' }} />
            {/* Enviar e Parar ocupam o mesmo lugar: o botao e o mesmo elemento, so o icone troca (com entrada curta) */}
            {running
              ? <button type="button" className="send stop" aria-label="Parar" title="Parar" onClick={() => api.stopTask(task.id).then(load)}><Icon key="stop" n="stop" size={16} /></button>
              : <button type="submit" className="send" aria-label="Enviar" title={awaiting ? 'Há uma mensagem retida aguardando a sua decisão sobre contexto' : 'Enviar (Ctrl+Enter)'} disabled={!!missing || (!text.trim() && !images.length) || awaiting || sending}><Icon key="send" n="send" size={18} /></button>}
          </div>
        </form>
        {view && <div className="lightbox" role="dialog" aria-label="Imagem" tabIndex={-1} ref={el => el?.focus()} onClick={() => setView(null)} onKeyDown={e => { if (e.key === 'Escape') setView(null) }}><img src={view} alt="" /></div>}
        {inspect && <TaskInspector taskId={task.id} pkgs={pkgs.list} reload={pkgs.load} onClose={() => setInspect(false)} />}
        {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        {cps && <Checkpoints taskId={task.id} onClose={() => { setCps(false); load(); onChange() }} />}
        {ask && <Confirm title={ask.title} body={ask.body} action={ask.action} tone="primary" onConfirm={ask.run} onClose={() => setAsk(null)} />}
      </div>
    </section>
  )
}

// Historico: memoizado para que digitar no compositor e cada trecho do streaming nao reprocessem todas as mensagens antigas.
// Nao usa name()/apelidos de projeto; se passar a usar, precisa de uma prop que mude com eles.
// `known`: ids ja na tela ao abrir a tarefa; as mensagens do usuario que chegam depois entram com animacao.
const Thread = memo(function Thread({ messages, known, accounts, taskId, onOpen }: { messages: Msg[]; known: Set<number> | null; accounts: Account[]; taskId: number; onOpen: (src: string) => void }) {
  return <>{messages.map(m => <MsgRow key={m.id} m={m} rise={m.role !== 'agent' && !!known && !known.has(m.id)} accounts={accounts} taskId={taskId} onOpen={onOpen} />)}</>
})

const MsgRow = memo(function MsgRow({ m, rise, accounts, taskId, onOpen }: { m: Msg; rise: boolean; accounts: Account[]; taskId: number; onOpen: (src: string) => void }) {
  const plain = useMemo(() => (m.role === 'agent' ? '' : stripMarks(m.text)), [m.role, m.text])
  const steps = useMemo(() => (m.role === 'agent' ? parseSteps(m.steps) : null), [m.role, m.steps])
  const files = useMemo(() => (m.role === 'system' ? fileRefs(m.text) : []), [m.role, m.text]) // arquivo enviado pelo agente: cartao no lugar da nota
  return (
    <div className={`msg ${m.role} ${files.length ? 'sent' : ''} ${m.status ?? ''} ${rise ? 'enter-rise' : ''}`}>
      {m.role === 'agent' && <div className="who">{m.provider && <Avatar provider={m.provider} size="sm" />}<span>{label(m, accounts)}</span>
        {m.status === 'failed' && <span className="flag">falhou</span>}{m.status === 'cancelled' && <span className="flag">interrompida</span>}</div>}
      {steps && <ActivityLog steps={steps} />}
      {m.role === 'agent' ? <Markdown text={m.text} /> : !files.length && plain && <p>{plain}</p>}
      <MsgImages taskId={taskId} text={m.text} marksOnly={m.role !== 'agent'} onOpen={onOpen} />
      {files.length > 0 && <SharedFiles taskId={taskId} refs={files} caption={sentCaption(plain)} onOpen={onOpen} />}
    </div>
  )
})

// Miniaturas das imagens citadas na mensagem. O processo principal so devolve imagens do projeto da tarefa ou dos anexos dela;
// o resto (caminho inexistente, fora das pastas, internet) simplesmente nao aparece.
function MsgImages({ taskId, text, marksOnly, onOpen }: { taskId: number; text: string; marksOnly?: boolean; onOpen: (src: string) => void }) {
  const refs = useMemo(() => imageRefs(text, marksOnly).join('|'), [text, marksOnly]) // chave estavel para o efeito ('|' nao aparece em caminho)
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
