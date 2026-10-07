import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, errText, type Account, type Auth, type Provider } from './api'
import { AgentNames } from './AgentNames'
import { PermissionRules } from './PermissionRules'
import { BackupSettings } from './BackupSettings'
import { Automations } from './Automations'
import { Handover } from './Handover'
import { CONN_STATE as STATE, effortLabel, modelName } from './labels'
import { Bar } from './UsageBar'
import { Dropdown } from './Dropdown'
import { Icon, PROVIDER } from './icons'
import { compact, totalText, usageNote, type QuotaSnapshot } from './usageText'
import { invalidateRead } from './readCache'
import { useCachedRead } from './useCachedRead'

const LOGIN_CMD: Record<string, string> = { codex: 'codex login', opencode: 'opencode auth login', gemini: 'gemini (escolha o método de login na primeira execução)' }
const CATEGORY_HINT: Record<string, string> = {
  auth: 'falha de autenticação: refaça o login desse provedor',
  permission: 'permissão/pasta não confiável: verifique a pasta do projeto e as permissões da CLI',
  command: 'comando ou argumento recusado: a versão instalada pode ser incompatível',
  config: 'configuração da CLI (modelo/provedor) inválida',
  protocol: 'saída inesperada da CLI',
  unknown: 'causa não classificada; veja diagnostics.log'
}

function AccountRow({ a, reload }: { a: Account; reload: () => void }) {
  const [err, setErr] = useState('')
  const connecting = a.login?.state === 'connecting'
  const usageRead = useCachedRead<QuotaSnapshot | null>(connecting ? null : `accountUsage:${a.id}`, () => api.accountUsage(a.id), 30_000)
  const statusRead = useCachedRead<Auth>(connecting ? null : `accountStatus:${a.id}`, () => api.accountStatus(a.id), 60_000)
  const usage = usageRead.data, status = statusRead.data
  useEffect(() => { // a cada 30 s: o processo principal consulta de novo e o evento accountUsage atualiza a barra
    if (connecting) return
    const t = setInterval(() => { usageRead.reload().catch(() => {}) }, 30_000)
    return () => clearInterval(t)
  }, [connecting, usageRead.reload])
  const state = connecting ? 'connecting' : a.login?.state === 'error' ? 'error' : status?.state ?? 'unknown'
  const run = (f: () => Promise<any>) => {
    invalidateRead(`accountStatus:${a.id}`); invalidateRead(`accountUsage:${a.id}`)
    f().then(reload, (e: any) => { setErr(errText(e)); void statusRead.reload().catch(() => {}); void usageRead.reload().catch(() => {}) })
  }
  return (
    <div className="account">
      <div className="account-head">
        <b>{a.name}</b><span className={`state ${state}`}>{STATE[state]}</span>
        {status?.email && <small className="account-id" title={status.email}>{status.email}{status.plan ? ` · ${status.plan}` : ''}</small>}
        {connecting
          ? <button className="set-sm" onClick={() => run(() => api.cancelLogin(a.id))}>Cancelar login</button>
          : <button className="set-sm" onClick={() => { setErr(''); run(() => api.loginAccount(a.id)) }}>{state === 'connected' ? 'Refazer login' : 'Login'}</button>}
      </div>
      {connecting && <small>Conclua o login no navegador que abriu (expira em 5 minutos).</small>}
      {a.login?.state === 'error' && <small className="err">{a.login.error}</small>}
      {err && <small className="err">{err}</small>}
      {a.collision && <small className="err">Mesma pasta de perfil de outra conta: os logins se sobrescrevem.</small>}
      {!connecting && (usage?.error ? <small className="err">Uso: {usage.error}</small> : <>
        <Bar label="Limite de 5 horas" w={usage?.fiveHour ?? null} />
        <Bar label="Semanal" w={usage?.sevenDay ?? null} />
        {usageNote(usage) && <small>{usageNote(usage)}</small>}
        {usageRead.error && <small className="err">Uso: {errText(usageRead.error)}</small>}
      </>)}
    </div>
  )
}

// Uma linha por CLI; detalhes recolhidos. Abre sozinho quando ha algo a resolver.
function ProviderRow({ p }: { p: Provider }) {
  const state = p.exe ? p.auth?.state ?? 'unknown' : 'error'
  const credEnv = p.env.filter(n => /API_KEY|AUTH_TOKEN|OAUTH_TOKEN/.test(n))
  const credClash = p.id === 'claude' && credEnv.length > 0
  const problem = !p.exe || !!p.failed || !!p.lastError || credClash || (state !== 'connected' && !!LOGIN_CMD[p.id])
  return (
    <details className="prov" open={problem}>
      <summary><b>{PROVIDER[p.id]?.label ?? p.id}</b><span className={`state ${state}`}>{p.exe ? STATE[state as keyof typeof STATE] : 'não instalado'}</span></summary>
      <div className="prov-body">
        {p.exe && <small>{p.version ?? 'versão indisponível'} · {p.exe}</small>}
        {p.failed && <small className="err">{p.failed}</small>}
        {p.exe && state !== 'connected' && LOGIN_CMD[p.id] && <small>Para entrar, rode no terminal: <code>{LOGIN_CMD[p.id]}</code></small>}
        {p.auth?.detail && <small>{p.auth.detail}</small>}
        {credClash && <small className="err">{credEnv.join(', ')} sobrepõe o login; o dashboard ignora nos perfis Claude.</small>}
        {p.lastError && <small className="err">Última falha: {CATEGORY_HINT[p.lastError.category]}<br />{p.lastError.detail}</small>}
        {p.missing.length > 0 && <small>Esta versão não mostra: {p.missing.join(', ')}</small>}
        {p.env.length > 0 && <small>Variáveis detectadas: {p.env.join(', ')}</small>}
      </div>
    </details>
  )
}

type Deleg = { enabled: boolean; maxPerTask: number; timeoutMin: number; allowEdit: boolean; allowedProviders: string[]; readAgent: string; providers: string[]; mcpProviders: string[] }
function Delegation({ goAgents }: { goAgents: () => void }) {
  const read = useCachedRead<Deleg>('getDelegationSettings', () => api.getDelegationSettings())
  const aliases = useCachedRead<{ name: string }[]>('getAgentAliases', () => api.getAgentAliases())
  const d = read.data, names = (aliases.data ?? []).map(a => a.name)
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (!d) return <small>{err || 'Carregando…'}</small>
  const save = (patch: Partial<Deleg>) => {
    const next = { ...d, ...patch }
    api.setDelegationSettings({ enabled: next.enabled, maxPerTask: next.maxPerTask, timeoutMin: next.timeoutMin, allowEdit: next.allowEdit, allowedProviders: next.allowedProviders, readAgent: next.readAgent })
      .then(v => read.set({ ...next, ...v }), e => setErr(errText(e)))
  }
  const toggle = (p: string) => save({ allowedProviders: d.allowedProviders.includes(p) ? d.allowedProviders.filter(x => x !== p) : [...d.allowedProviders, p] })
  return (
    <div className="deleg">
      <label className="check"><input type="checkbox" checked={d.enabled} onChange={e => save({ enabled: e.target.checked })} /> Agentes podem delegar a outros provedores</label>
      <label className="check"><input type="checkbox" checked={d.allowEdit} disabled={!d.enabled} onChange={e => save({ allowEdit: e.target.checked })} /> Delegações podem editar arquivos (senão, só leitura)</label>
      <div className="deleg-read">
        <Dropdown down label="Leitura e testes vão para" value={d.readAgent} placeholder="O agente escolhe" disabled={!d.enabled}
          options={[{ value: '', label: 'O agente escolhe' }, ...[...new Set([...names, ...(d.readAgent ? [d.readAgent] : [])])].map(n => ({ value: n, label: names.includes(n) ? n : `${n} (removido)` }))]}
          onChange={v => save({ readAgent: v })} />
        {names.length ? <small>Leituras sem destino vão para este agente.</small>
          : <small>Nenhum agente nomeado. <button type="button" className="link" onClick={goAgents}>Criar um com modelo barato</button></small>}
      </div>
      <fieldset disabled={!d.enabled}>
        <legend>Podem receber</legend>
        {d.providers.map(p => <label key={p} className="check"><input type="checkbox" checked={d.allowedProviders.includes(p)} onChange={() => toggle(p)} /> {PROVIDER[p]?.label ?? p}</label>)}
      </fieldset>
      <details>
        <summary>Avançado</summary>
        <div className="deleg-adv">
          <label>Delegações por tarefa <input type="number" min={1} max={50} value={d.maxPerTask} disabled={!d.enabled} onChange={e => save({ maxPerTask: +e.target.value })} /></label>
          <label>Tempo limite (min) <input type="number" min={1} max={120} value={d.timeoutMin} disabled={!d.enabled} onChange={e => save({ timeoutMin: +e.target.value })} /></label>
          <small>Oferecida a: {d.mcpProviders.map(p => PROVIDER[p]?.label ?? p).join(', ')}. Um nível só, sem credenciais.</small>
        </div>
      </details>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Ultimos 7 dias de delegacoes: so o que foi medido (tokens dos filhos e caracteres devolvidos ao pai). Nenhuma estimativa de economia.
function DelegationReport() {
  const read = useCachedRead<any[]>('delegationReport', () => api.delegationReport())
  const rows = read.data
  if (!rows) return <small>{read.error ? errText(read.error) : 'Carregando…'}</small>
  if (!rows.length) return <small>Nenhuma delegação nos últimos 7 dias.</small>
  return (
    <ul className="deleg-report">
      {rows.map(r => (
        <li key={`${r.provider}|${r.model}`}>
          <b>{PROVIDER[r.provider]?.label ?? r.provider}{r.model ? ` · ${r.model}` : ''}</b>
          <small>{r.delegations} {r.delegations === 1 ? 'delegação' : 'delegações'}{r.failed ? ` (${r.failed} falhou)` : ''} · {totalText(r.tokens)} tokens no filho · {compact(r.returnedChars)} caracteres devolvidos</small>
        </li>
      ))}
    </ul>
  )
}

// Modelo do Jarvis: sempre pela CLI do Claude, na conta escolhida (usa a assinatura dela, sem chave de API).
function JarvisConfig({ accounts }: { accounts: Account[] }) {
  const read = useCachedRead<{ accountId?: number; model: string; effort: string }>('getJarvisSettings', () => api.getJarvisSettings())
  const catalog = useCachedRead<any>('catalog:claude', () => api.catalog('claude'), 600_000)
  const j = read.data, cat = catalog.data
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  const [ok, setOk] = useState(false)
  if (!j) return <small>{err || 'Carregando…'}</small>
  const save = (patch: object) => { setErr(''); setOk(false); api.setJarvisSettings({ ...j, ...patch }).then(v => { read.set(v); setOk(true) }, e => setErr(errText(e))) }
  const models = (cat?.models ?? []).map((m: any) => ({ value: m.id, label: (m.label ?? modelName(m.id)) + (m.id === 'claude-sonnet-5-5' ? ' (recomendado)' : '') }))
  return (
    <div className="jcfg">
      <div className="jcfg-row">
        {accounts.length > 1 && <Dropdown down label="Conta da Nova" value={String(j.accountId ?? '')} placeholder="Conta" options={accounts.map(a => ({ value: String(a.id), label: a.name }))} onChange={v => save({ accountId: +v })} />}
        <Dropdown down search custom label="Modelo da Nova" value={j.model} placeholder="Modelo" options={models.length ? models : [{ value: j.model, label: modelName(j.model) }]} onChange={v => save({ model: v })} />
        <Dropdown down label="Esforço da Nova" value={j.effort} placeholder="Esforço" options={(cat?.efforts?.length ? cat.efforts : [j.effort]).map((f: string) => ({ value: f, label: effortLabel(f) }))} onChange={v => save({ effort: v })} />
        {ok && <small className="an-ok" role="status">Salvo.</small>}
      </div>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Limites do contexto entre agentes (em caracteres, nao tokens). O processo principal normaliza e devolve o valor aceito.
const LIMITS: [string, string, string][] = [
  ['maxToolsPerMessage', 'Pausar a mensagem após (0 = nunca)', 'ferramentas'],
  ['packageChars', 'Tamanho máximo de um pacote de contexto', 'caracteres'],
  ['packageItems', 'Itens por pacote', 'itens'],
  ['itemChars', 'Tamanho máximo de cada item', 'caracteres'],
  ['conclusionChars', 'Tamanho da conclusão devolvida pela delegação', 'caracteres'],
  ['queryChars', 'Tamanho de cada consulta a artefatos', 'caracteres'],
  ['queryResults', 'Resultados por consulta', 'resultados'],
  ['approvalTimeoutMin', 'Tempo para aprovar um pedido de contexto', 'min'],
]
// Tres niveis prontos (Equilibrado = DEFAULT_LIMITS de src/main/limits.ts; mude os dois juntos); os numeros individuais ficam em "Avancado". O tempo de aprovacao nao e tamanho: fica fora dos niveis.
const LEVELS = [
  { name: 'Econômico', hint: 'Gasta menos. Menos contexto entre agentes; pausa após 100 ferramentas.',
    v: { packageChars: 3000, packageItems: 4, itemChars: 1000, conclusionChars: 1500, queryChars: 3000, queryResults: 5, maxToolsPerMessage: 100 } },
  { name: 'Equilibrado', hint: 'Padrão, serve para quase tudo. Pausa após 200 ferramentas.',
    v: { packageChars: 6000, packageItems: 8, itemChars: 2000, conclusionChars: 3000, queryChars: 6000, queryResults: 10, maxToolsPerMessage: 200 } },
  { name: 'Amplo', hint: 'Gasta mais. Mais contexto entre agentes; pausa após 400 ferramentas.',
    v: { packageChars: 12000, packageItems: 16, itemChars: 4000, conclusionChars: 6000, queryChars: 12000, queryResults: 20, maxToolsPerMessage: 400 } },
]
const levelOf = (l: Record<string, number>) => LEVELS.findIndex(x => Object.entries(x.v).every(([k, v]) => l[k] === v))
// Desligado por padrao: sem pausa por ferramentas e contexto no teto (effectiveLimits em src/main/limits.ts); o nivel guardado volta ao religar.
function Limits() {
  const read = useCachedRead<Record<string, number> & { enabled: boolean }>('getContextLimits', () => api.getContextLimits())
  const l = read.data
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (!l) return <small>{err || 'Carregando…'}</small>
  const put = (patch: Record<string, number | boolean>) => api.setContextLimits({ ...l, ...patch }).then(read.set, e => setErr(errText(e)))
  const lv = levelOf(l)
  const toggle = <label className="switch"><input type="checkbox" role="switch" checked={l.enabled} onChange={e => put({ enabled: e.target.checked })} /><span>Limitar o gasto dos agentes</span></label>
  if (!l.enabled) return (
    <div className="limits">
      {toggle}
      <small>Desligado: sem pausa por número de ferramentas e contexto entre agentes no tamanho máximo.</small>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
  return (
    <div className="limits">
      {toggle}
      <div className={lv < 0 ? 'lvl custom' : 'lvl'}>
        <input type="range" min={0} max={2} step={1} value={lv < 0 ? 1 : lv} aria-label="Nível de contexto" aria-valuetext={lv < 0 ? 'Personalizado' : LEVELS[lv].name}
          onChange={e => put(LEVELS[+e.target.value].v)} />
        <div className="lvl-names">{LEVELS.map((x, i) => <button key={x.name} className={i === lv ? 'on' : ''} onClick={() => put(x.v)}>{x.name}</button>)}</div>
        <small>{lv < 0 ? 'Personalizado (ajustado em Avançado). Escolha um nível para voltar ao padrão.' : LEVELS[lv].hint}</small>
      </div>
      <details className="lvl-adv">
        <summary>Avançado</summary>
        {LIMITS.map(([k, label, unit]) => (
          <label key={k}><span>{label}</span>
            <span className="lim-in"><input type="number" min={k === 'maxToolsPerMessage' ? 0 : 1} defaultValue={l[k]} key={l[k]} aria-label={label} onBlur={e => +e.target.value !== l[k] && put({ [k]: +e.target.value })} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><small>{unit}</small></span>
          </label>
        ))}
        <small>Pacote acima do limite é recusado, nunca cortado.</small>
      </details>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Titulo-resumo do chat: o agente o escreve na propria 1a resposta (sem chamada extra); desligado, fica o comeco da mensagem.
function SummaryTitles() {
  const read = useCachedRead<boolean>('summaryTitles', () => api.summaryTitles())
  const on = read.data
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (on === undefined) return <small>{err || 'Carregando…'}</small>
  return (
    <div className="deleg">
      <label className="check" title="Custa algumas palavras a mais só na primeira resposta. Desligado, o nome é o começo da sua mensagem."><input type="checkbox" checked={on} onChange={e => api.setSummaryTitles(e.target.checked).then(read.set, x => setErr(errText(x)))} /> O agente resume o pedido no nome do chat</label>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Checkpoint de turno (src/main/checkpoints.ts): antes de cada mensagem grava as mudancas pendentes num commit na branch atual.
function TurnCheckpoints() {
  const read = useCachedRead<boolean>('turnCheckpoints', () => api.turnCheckpoints())
  const on = read.data
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (on === undefined) return <small>{err || 'Carregando…'}</small>
  return (
    <div className="deleg">
      <label className="check" title="Antes de cada mensagem, as mudanças não salvas viram um commit “orbita-checkpoint:” na branch atual, para poder voltar atrás."><input type="checkbox" checked={on} onChange={e => api.setTurnCheckpoints(e.target.checked).then(read.set, x => setErr(errText(x)))} /> Commit automático antes de cada mensagem</label>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

const TABS = [['contas', 'Contas'], ['agentes', 'Agentes'], ['permissoes', 'Permissões'], ['delegacao', 'Delegação'], ['avisos', 'Avisos'], ['dados', 'Dados']] as const

// Avisos de atencao (src/main/notify.ts). Com o app em foco: cartao dentro dele; fora de foco: janela de aviso no canto da tela.
type Notify = { done: boolean; failed: boolean; approval: boolean; system: boolean; sound: boolean }
const NOTIFY: [keyof Notify, string][] = [
  ['done', 'Quando um agente terminar (e quando uma etapa ficar pronta para revisão)'],
  ['failed', 'Quando uma execução falhar ou pausar no teto de ferramentas'],
  ['approval', 'Quando um agente pedir permissão ou aprovação de contexto'],
]
function NotifySettings() {
  const read = useCachedRead<Notify>('getNotifySettings', () => api.getNotifySettings())
  const n = read.data
  const [writeErr, setErr] = useState('')
  const err = writeErr || (read.error ? errText(read.error) : '')
  if (!n) return <small>{err || 'Carregando…'}</small>
  const save = (patch: Partial<Notify>) => api.setNotifySettings({ ...n, ...patch }).then(read.set, e => setErr(errText(e)))
  return (
    <div className="deleg">
      <fieldset>
        {NOTIFY.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={n[k]} onChange={e => save({ [k]: e.target.checked })} /> {label}</label>)}
      </fieldset>
      <fieldset>
        <legend>Com o app em segundo plano</legend>
        <label className="check"><input type="checkbox" checked={n.system} onChange={e => save({ system: e.target.checked })} /> Mostrar o aviso no canto da tela e piscar na barra de tarefas</label>
        <label className="check"><input type="checkbox" checked={n.sound} disabled={!n.system} onChange={e => save({ sound: e.target.checked })} /> Tocar som</label>
      </fieldset>
      <div className="set-actions">
        <button type="button" onClick={() => api.testNotice(false).catch((e: any) => setErr(errText(e)))}>Mostrar um exemplo</button>
        <button type="button" onClick={() => api.testNotice(true).catch((e: any) => setErr(errText(e)))}>Exemplo com vários avisos do mesmo projeto</button>
        <small>Clicar no aviso só abre a tarefa: nada é aprovado nem executado por ele.</small>
      </div>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Pastas tiradas da lista de projetos: restaurar sem precisar achar a pasta de novo no seletor.
function HiddenFolders({ onChange }: { onChange: () => void }) {
  const read = useCachedRead<string[]>('listHidden', () => api.listHidden())
  const list = read.data
  const [err, setErr] = useState('')
  if (!list) return <small>{read.error ? errText(read.error) : 'Carregando pastas…'}</small>
  if (!list.length) return <small>Nenhuma pasta removida.</small>
  return (
    <ul className="hidden-list">
      {list.map(p => <li key={p}><span className="mono-sm" title={p}>{p}</span>
        <button className="set-sm" onClick={() => api.unhideGame(p).then(() => { setErr(''); void read.reload().catch(() => {}); onChange() }, (e: any) => setErr(errText(e)))}>Restaurar</button></li>)}
      {err && <li><small className="err" role="alert">{err}</small></li>}
    </ul>
  )
}

// Cartao das Configuracoes: titulo, uma linha opcional de contexto e uma acao no canto.
export function Card({ title, sub, action, children }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2>{title}{action}</h2>
      {sub && <p className="set-sub">{sub}</p>}
      {children}
    </section>
  )
}

type Tab = (typeof TABS)[number][0]
// Abas no topo com indicador que desliza; setas, Home e End trocam de aba (padrao ARIA de tablist).
function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number; ready: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = list.current, place = () => {
      const b = el?.querySelector<HTMLElement>('[aria-selected=true]')
      if (b) setInd(i => ({ x: b.offsetLeft, w: b.offsetWidth, ready: !!i }))
    }
    place()
    const ro = new ResizeObserver(place)
    if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [tab])
  const key = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([id]) => id === tab)
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (j < 0) return
    e.preventDefault()
    onTab(TABS[j][0])
    list.current?.querySelectorAll<HTMLElement>('[role=tab]')[j]?.focus()
  }
  return (
    <div role="tablist" aria-label="Seções das configurações" ref={list} onKeyDown={key}>
      {TABS.map(([id, text]) => <button key={id} role="tab" id={`set-tab-${id}`} aria-controls="set-panel" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
        className={tab === id ? 'on' : ''} onClick={() => onTab(id)}>{text}</button>)}
      {ind && <span className={`set-ind ${ind.ready ? 'ready' : ''}`} aria-hidden="true" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
    </div>
  )
}

export function Settings({ accounts, reload, providers, refreshProviders, onGamesChange }: {
  accounts: Account[]; reload: () => void; providers: Provider[] | null; refreshProviders: () => void; onGamesChange: () => void
}) {
  const [newName, setNewName] = useState(''), [addErr, setAddErr] = useState('')
  const [tab, setTab] = useState<Tab>('contas')
  useEffect(() => { // acompanha logins em andamento
    if (!accounts.some(a => a.login?.state === 'connecting')) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [accounts])
  return (
    <main className="settings">
      <header className="set-head">
        <h1>Configurações</h1>
        <Tabs tab={tab} onTab={setTab} />
      </header>
      <div className="set-panel" role="tabpanel" id="set-panel" aria-labelledby={`set-tab-${tab}`} key={tab}>
        {tab === 'contas' && <>
          <Card title="Contas Claude">
            {accounts.map(a => <AccountRow key={a.id} a={a} reload={reload} />)}
            <form className="inline add-account" onSubmit={e => { e.preventDefault(); if (newName.trim()) api.addAccount(newName.trim()).then(() => { setNewName(''); setAddErr(''); reload() }, (x: any) => setAddErr(errText(x))) }}>
              <input aria-label="Nome da nova conta" placeholder="Nome da nova conta" value={newName} onChange={e => setNewName(e.target.value)} />
              <button disabled={!newName.trim()}><Icon n="plus" size={14} /> Adicionar conta</button>
            </form>
            {addErr && <small className="err" role="alert">{addErr}</small>}
          </Card>
          {accounts.length > 1 && <Card title="Automações"><Automations /></Card>}
          {accounts.length > 1 && <Card title="Quando a conta atingir o limite"><Handover /></Card>}
          <Card title="Provedores" action={<button className="icon sm" onClick={refreshProviders} aria-label="Diagnosticar de novo" title="Diagnosticar de novo"><Icon n="refresh" size={16} /></button>}>
            {providers ? providers.map(p => <ProviderRow key={p.id} p={p} />) : <small>Consultando as CLIs…</small>}
          </Card>
          <Card title="Pastas removidas da lista" sub="Remover da lista nunca apaga a pasta. Restaure aqui."><HiddenFolders onChange={onGamesChange} /></Card>
        </>}
        {tab === 'agentes' && <>
          <Card title="Nova" sub="Assistente da home. Não lê os arquivos dos projetos."><JarvisConfig accounts={accounts} /></Card>
          <Card title="Agentes nomeados" sub={<>Dê um nome a um provedor e modelo para delegar por nome: <em>“delegue para o Fabricio”</em>.</>}><AgentNames /></Card>
          <Card title="Nome dos chats" sub="Vale para chats novos."><SummaryTitles /></Card>
          <Card title="Checkpoints" sub="Os commits ficam no histórico da branch e vão junto no push."><TurnCheckpoints /></Card>
        </>}
        {tab === 'permissoes' && <PermissionRules />}
        {tab === 'avisos' && <Card title="Quando avisar"><NotifySettings /></Card>}
        {tab === 'dados' && <BackupSettings />}
        {tab === 'delegacao' && <>
          <Card title="Delegação entre provedores"><Delegation goAgents={() => setTab('agentes')} /></Card>
          <Card title="Quanto os agentes podem gastar"><Limits /></Card>
          <section>
            <details>
              <summary><h2>Últimos 7 dias</h2></summary>
              <DelegationReport />
            </details>
          </section>
        </>}
      </div>
    </main>
  )
}
