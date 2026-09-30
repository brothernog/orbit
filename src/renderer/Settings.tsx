import { useEffect, useState } from 'react'
import { api, errText, type Account, type Auth, type Provider } from './api'
import { AgentNames } from './AgentNames'
import { PermissionRules } from './PermissionRules'
import { BackupSettings } from './BackupSettings'
import { effortLabel, modelName } from './Chat'
import { Dropdown } from './Dropdown'
import { Icon, PROVIDER } from './icons'
import { compact, resetText, totalText } from './usageText'

type Window_ = { utilization: number; resets_at: string } | null

// Uma linha por limite, como no Claude Desktop: nome, renovacao e % na mesma linha; barra embaixo. Tambem usada no medidor do chat.
export function Bar({ label, w }: { label: string; w: Window_ }) {
  if (!w) return null
  const pct = Math.round(w.utilization)
  return (
    <div className="usage">
      <div className="usage-row"><b>{label}</b><small>{resetText(w.resets_at)}</small><span>{pct}%</span></div>
      <div className="bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={pct > 80 ? 'hot' : ''} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

export const STATE = { connected: 'conectado', disconnected: 'desconectado', unknown: 'não verificado', connecting: 'conectando…', error: 'erro' }
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
  const [usage, setUsage] = useState<any>(null)
  const [status, setStatus] = useState<Auth | null>(null)
  const [err, setErr] = useState('')
  const connecting = a.login?.state === 'connecting'
  useEffect(() => {
    if (connecting) return
    api.accountStatus(a.id).then(setStatus, e => setStatus({ state: 'unknown', detail: errText(e) }))
    api.accountUsage(a.id).then(setUsage, e => setUsage({ error: errText(e) }))
  }, [a.id, a.login?.state])
  const state = connecting ? 'connecting' : a.login?.state === 'error' ? 'error' : status?.state ?? 'unknown'
  const run = (f: Promise<any>) => f.then(reload, (e: any) => setErr(errText(e)))
  return (
    <div className="account">
      <b>{a.name}</b> <span className={`state ${state}`}>{STATE[state]}</span>
      {status?.email && <small>{status.email}{status.plan ? ` · ${status.plan}` : ''}</small>}
      <div className="row">
        {connecting
          ? <button onClick={() => run(api.cancelLogin(a.id))}>Cancelar login</button>
          : <button onClick={() => { setErr(''); run(api.loginAccount(a.id)) }}>{state === 'connected' ? 'Refazer login' : 'Login'}</button>}
      </div>
      {connecting && <small>Conclua o login no navegador que abriu (expira em 5 minutos).</small>}
      {a.login?.state === 'error' && <small className="err">{a.login.error}</small>}
      {err && <small className="err">{err}</small>}
      {a.collision && <small className="err">Mesma pasta de perfil de outra conta: os logins se sobrescrevem.</small>}
      {!connecting && (usage?.error ? <small className="err">Uso: {usage.error}</small> : <>
        <Bar label="Limite de 5 horas" w={usage?.fiveHour} />
        <Bar label="Semanal" w={usage?.sevenDay} />
        {usage?.cached && <small>Último valor visto.</small>}
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
function Delegation() {
  const [d, setD] = useState<Deleg | null>(null)
  const [err, setErr] = useState('')
  const [names, setNames] = useState<string[]>([])
  useEffect(() => { api.getDelegationSettings().then(setD, e => setErr(errText(e))); api.getAgentAliases().then((v: any[]) => setNames(v.map(a => a.name)), () => {}) }, [])
  if (!d) return <small>{err || 'Carregando…'}</small>
  const save = (patch: Partial<Deleg>) => {
    const next = { ...d, ...patch }
    setD(next)
    api.setDelegationSettings({ enabled: next.enabled, maxPerTask: next.maxPerTask, timeoutMin: next.timeoutMin, allowEdit: next.allowEdit, allowedProviders: next.allowedProviders, readAgent: next.readAgent })
      .then(v => setD(x => ({ ...x!, ...v })), e => setErr(errText(e)))
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
        <small>{names.length ? 'Delegações de leitura sem destino vão para este agente.' : 'Crie um agente nomeado (aba Agentes) com um modelo barato.'}</small>
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
  const [rows, setRows] = useState<any[] | null>(null)
  useEffect(() => { api.delegationReport().then(setRows, () => setRows([])) }, [])
  if (!rows) return <small>Carregando…</small>
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
  const [j, setJ] = useState<{ accountId?: number; model: string; effort: string } | null>(null)
  const [cat, setCat] = useState<any>(null)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)
  useEffect(() => { api.getJarvisSettings().then(setJ, e => setErr(errText(e))); api.catalog('claude').then(setCat, () => setCat({ models: [], efforts: [] })) }, [])
  if (!j) return <small>{err || 'Carregando…'}</small>
  const save = (patch: object) => { setErr(''); setOk(false); api.setJarvisSettings({ ...j, ...patch }).then(v => { setJ(v); setOk(true) }, e => setErr(errText(e))) }
  const models = (cat?.models ?? []).map((m: any) => ({ value: m.id, label: (m.label ?? modelName(m.id)) + (m.id === 'claude-sonnet-5-5' ? ' (recomendado)' : '') }))
  return (
    <div className="jcfg">
      <p className="an-lede">Assistente da home. Não lê os arquivos dos projetos.</p>
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
function Limits() {
  const [l, setL] = useState<Record<string, number> | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.getContextLimits().then(setL, e => setErr(errText(e))) }, [])
  if (!l) return <small>{err || 'Carregando…'}</small>
  const put = (patch: Record<string, number>) => api.setContextLimits({ ...l, ...patch }).then(setL, e => setErr(errText(e)))
  const lv = levelOf(l)
  return (
    <div className="limits">
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
  const [on, setOn] = useState<boolean | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.summaryTitles().then(setOn, e => setErr(errText(e))) }, [])
  if (on === null) return <small>{err || 'Carregando…'}</small>
  return (
    <div className="deleg">
      <label className="check"><input type="checkbox" checked={on} onChange={e => api.setSummaryTitles(e.target.checked).then(setOn, x => setErr(errText(x)))} /> O agente resume o pedido no nome do chat</label>
      <small>Vale para chats novos. Custa algumas palavras a mais só na primeira resposta; desligado, o nome é o começo da sua mensagem.</small>
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
  const [n, setN] = useState<Notify | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.getNotifySettings().then(setN, e => setErr(errText(e))) }, [])
  if (!n) return <small>{err || 'Carregando…'}</small>
  const save = (patch: Partial<Notify>) => { const next = { ...n, ...patch }; setN(next); api.setNotifySettings(next).then(setN, e => setErr(errText(e))) }
  return (
    <div className="deleg">
      <fieldset>
        <legend>Avisar</legend>
        {NOTIFY.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={n[k]} onChange={e => save({ [k]: e.target.checked })} /> {label}</label>)}
      </fieldset>
      <fieldset>
        <legend>Com o app em segundo plano</legend>
        <label className="check"><input type="checkbox" checked={n.system} onChange={e => save({ system: e.target.checked })} /> Mostrar o aviso no canto da tela e piscar na barra de tarefas</label>
        <label className="check"><input type="checkbox" checked={n.sound} disabled={!n.system} onChange={e => save({ sound: e.target.checked })} /> Tocar som</label>
      </fieldset>
      <small>Clicar no aviso só abre a tarefa: nada é aprovado nem executado por ele.</small>
      <div className="step-actions">
        <button type="button" onClick={() => api.testNotice(false).catch((e: any) => setErr(errText(e)))}>Mostrar um exemplo</button>
        <button type="button" onClick={() => api.testNotice(true).catch((e: any) => setErr(errText(e)))}>Exemplo com vários avisos do mesmo projeto</button>
      </div>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Pastas tiradas da lista de projetos: restaurar sem precisar achar a pasta de novo no seletor.
function HiddenFolders({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<string[] | null>(null)
  const load = () => api.listHidden().then(setList, () => setList([]))
  useEffect(() => { load() }, [])
  if (!list?.length) return <small>Nenhuma pasta removida. Remover da lista nunca apaga nada; as removidas aparecem aqui para voltar.</small>
  return (
    <ul className="hidden-list">
      {list.map(p => <li key={p}><span className="mono-sm" title={p}>{p}</span>
        <button className="mini" onClick={() => api.unhideGame(p).then(() => { load(); onChange() })}>Restaurar</button></li>)}
    </ul>
  )
}

export function Settings({ accounts, reload, providers, refreshProviders, onGamesChange }: {
  accounts: Account[]; reload: () => void; providers: Provider[] | null; refreshProviders: () => void; onGamesChange: () => void
}) {
  const [newName, setNewName] = useState('')
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('contas')
  useEffect(() => { refreshProviders() }, [])
  useEffect(() => { // acompanha logins em andamento
    if (!accounts.some(a => a.login?.state === 'connecting')) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [accounts])
  return (
    <main className="settings">
      <header className="set-head">
        <h1>Configurações</h1>
        <div role="tablist" aria-label="Seções das configurações">
          {TABS.map(([id, text]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{text}</button>)}
        </div>
      </header>
      {tab === 'contas' && <>
        <section>
          <h2>Contas Claude</h2>
          {accounts.map(a => <AccountRow key={a.id} a={a} reload={reload} />)}
          <form className="inline" onSubmit={e => { e.preventDefault(); if (newName.trim()) api.addAccount(newName.trim()).then(() => { setNewName(''); reload() }) }}>
            <input aria-label="Nome da nova conta" placeholder="Nome da nova conta" value={newName} onChange={e => setNewName(e.target.value)} />
            <button className="primary">Adicionar conta</button>
          </form>
        </section>
        <section>
          <h2>Provedores <button className="icon sm" onClick={refreshProviders} aria-label="Diagnosticar de novo" title="Diagnosticar de novo"><Icon n="refresh" size={16} /></button></h2>
          {providers ? providers.map(p => <ProviderRow key={p.id} p={p} />) : <small>Consultando as CLIs…</small>}
        </section>
        <section><h2>Pastas removidas da lista</h2><HiddenFolders onChange={onGamesChange} /></section>
      </>}
      {tab === 'agentes' && <>
        <section><h2>Nova</h2><JarvisConfig accounts={accounts} /></section>
        <section><h2>Agentes nomeados</h2><AgentNames /></section>
        <section><h2>Nome dos chats</h2><SummaryTitles /></section>
      </>}
      {tab === 'permissoes' && <PermissionRules />}
      {tab === 'avisos' && <section><h2>Avisos</h2><NotifySettings /></section>}
      {tab === 'dados' && <BackupSettings />}
      {tab === 'delegacao' && <>
        <section><h2>Delegação entre provedores</h2><Delegation /></section>
        <section><h2>Quanto os agentes podem gastar</h2><Limits /></section>
        <section>
          <details>
            <summary><h2>Últimos 7 dias</h2></summary>
            <DelegationReport />
          </details>
        </section>
      </>}
    </main>
  )
}
