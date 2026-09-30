import { useEffect, useRef, useState } from 'react'
import { api, errText, type Account, type Msg, type Sel } from './api'
import { effortLabel, modelName } from './labels'
import { Icon, PROVIDER } from './icons'
import { Markdown } from './Markdown'
import { PermissionPrompt } from './PermissionPrompt'
import { ContextRequests, UnsentMessages, usePackages } from './TaskContext'
import { stripMarks } from './msgImages'
import { Confirm } from './Nav'
import { useCachedRead } from './useCachedRead'
import { useTaskChat } from './useTaskChat'
import './linkedin.css'
import { CMDS, expand, fold } from './linkedinText'

type Entry = { date: string; kind: string; topic: string; status: string }
type Draft = { name: string; text: string; at: number }
type Desk = { hasProfile: boolean; goal: string | null; perWeek: number | null; history: Entry[]; drafts: Draft[]; videos: { name: string; at: number }[] }

const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('sv-SE') }
const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`

type Auth = { redirect: string; clientId: string; connected: boolean; name: string; expiresAt: number | null }

function DraftCard({ d, connected, onPublished, onErr }: { d: Draft; connected: boolean; onPublished: (url?: string) => void; onErr: (e: string) => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ask, setAsk] = useState(false)
  const [posting, setPosting] = useState(false)
  const post = () => { setPosting(true); api.linkedinPost(d.name).then((u: string) => onPublished(u), (e: any) => { setPosting(false); onErr(errText(e)) }) }
  const text = d.text.trim(), cut = fold(text)
  const copy = () => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }, () => onErr('Não foi possível copiar.'))
  return (
    <li className="li-draft">
      <div className="li-paper">
        <p>{open || !cut ? text : cut}{cut && !open && <>… <button className="li-more" onClick={() => setOpen(true)}>ver mais</button></>}</p>
      </div>
      <div className="li-draft-bar">
        <small className={text.length > 3000 ? 'err' : ''} title="O LinkedIn aceita até 3.000 caracteres por post">{text.length.toLocaleString('pt-BR')} de 3.000</small>
        <button className="text-btn" title={connected ? 'Copiar o texto' : 'Copia o texto e abre o LinkedIn com a caixa de novo post; é só colar'}
          onClick={() => copy().then(() => { if (!connected) api.openUrl('https://www.linkedin.com/feed/?shareActive=true') })}>
          <Icon n={copied ? 'check' : 'files'} size={14} />{copied ? 'Copiado' : connected ? 'Copiar' : 'Copiar e abrir'}</button>
        {connected
          ? <button className="text-btn li-post" disabled={posting || text.length > 3000} onClick={() => setAsk(true)}><Icon n="send" size={14} />{posting ? 'Publicando…' : 'Publicar'}</button>
          : <button className="text-btn" title="Tira da mesa e registra no histórico com a data de hoje" onClick={() => api.linkedinPublished(d.name).then(() => onPublished(), (e: any) => onErr(errText(e)))}><Icon n="check" size={14} />Publiquei</button>}
      </div>
      {ask && <Confirm title="Publicar no seu perfil?" action="Publicar agora" onClose={() => setAsk(false)} onConfirm={post}
        body={`O post vai para o seu feed como público, exatamente como está no cartão (${text.length.toLocaleString('pt-BR')} caracteres). Dá para editar ou apagar depois só pelo LinkedIn.`} />}
    </li>
  )
}

// Conexao com a API oficial: os passos no app de desenvolvedor do LinkedIn sao feitos pelo usuario, uma vez.
function Connect({ auth, onAuth, onErr }: { auth: Auth; onAuth: (a: Auth) => void; onErr: (e: string) => void }) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState(auth.clientId)
  const [secret, setSecret] = useState('')
  const [waiting, setWaiting] = useState(false)
  const connect = () => { setWaiting(true); api.linkedinConnect(id, secret).then((a: Auth) => { onAuth(a); setOpen(false); setSecret('') }, (e: any) => onErr(errText(e))).finally(() => setWaiting(false)) }
  if (auth.connected) return (
    <p className="li-conn">Publicando como <b>{auth.name || 'você'}</b>{auth.expiresAt && <>, acesso até {new Date(auth.expiresAt).toLocaleDateString('pt-BR')}</>}.
      <button className="link" onClick={() => api.linkedinDisconnect().then(onAuth)}>Desconectar</button></p>
  )
  if (!open) return <button className="text-btn li-conn-open" onClick={() => setOpen(true)}><Icon n="send" size={14} />Publicar direto daqui</button>
  return (
    <form className="li-connect" onSubmit={e => { e.preventDefault(); connect() }}>
      <h2>Conectar ao LinkedIn</h2>
      <ol>
        <li><button type="button" className="link" onClick={() => api.openUrl('https://www.linkedin.com/developers/apps/new')}>Crie um app</button> no portal de desenvolvedor (pede uma página de empresa; pode ser uma sua, simples).</li>
        <li>Em Products, ative <b>Share on LinkedIn</b> e <b>Sign In with LinkedIn using OpenID Connect</b>. A liberação é imediata.</li>
        <li>Em Auth, adicione este endereço de retorno:
          <span className="li-redirect"><code>{auth.redirect}</code><button type="button" className="icon sm" aria-label="Copiar endereço" onClick={() => navigator.clipboard.writeText(auth.redirect)}><Icon n="files" size={13} /></button></span></li>
        <li>Cole o Client ID e o Client Secret do app:</li>
      </ol>
      <input aria-label="Client ID" placeholder="Client ID" value={id} onChange={e => setId(e.target.value)} autoComplete="off" />
      <input aria-label="Client Secret" placeholder={auth.clientId && auth.clientId === id ? 'Client Secret (já salvo)' : 'Client Secret'} type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" />
      <small>Fica cifrado neste computador. A dashboard só publica quando você clica em Publicar.</small>
      <footer>
        <button type="button" onClick={() => { if (waiting) api.linkedinCancelConnect(); setOpen(false) }}>Cancelar</button>
        <button className="primary" disabled={waiting || !id.trim()}>{waiting ? 'Conclua no navegador…' : 'Conectar'}</button>
      </footer>
    </form>
  )
}

type Agent = { name: string; provider: string; model: string; effort?: string }
const selOf = (a: Agent, accounts: Account[]): Sel => ({ provider: a.provider, accountId: a.provider === 'claude' ? accounts[0]?.id : undefined, model: a.model, effort: a.effort || undefined })
const isSel = (a: Agent, s: Sel) => a.provider === s.provider && a.model === s.model && (a.effort || undefined) === (s.effort || undefined)

export function LinkedIn({ accounts, onErr }: { accounts: Account[]; onErr: (e: string) => void }) {
  const [page, setPage] = useState<{ taskId: number; desk: Desk } | null>(null)
  const agents = useCachedRead<Agent[]>('getAgentAliases', () => api.getAgentAliases()).data ?? [] // mesma chave de Configuracoes > Agentes
  const [auth, setAuth] = useState<Auth | null>(null)
  const [posted, setPosted] = useState('') // link do ultimo post publicado pela API
  const [text, setText] = useState('')
  const msgs = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const taskId = page?.taskId ?? 0
  const pkgs = usePackages(taskId)
  const { hist, live, load, send: sendChat } = useTaskChat(taskId, {
    sel: () => sel, msgs, onError: onErr, onDone: () => { loadDesk() },
  })
  // Sem escolha gravada: o primeiro agente nomeado (Configuracoes > Agentes); sem nenhum, o Claude com o modelo padrao da CLI.
  const sel: Sel = hist?.sel?.provider ? hist.sel : agents[0] ? selOf(agents[0], accounts) : { provider: 'claude', accountId: accounts[0]?.id }
  const pick = (a: Agent) => api.setTaskSel(taskId, selOf(a, accounts)).then(() => load(), (e: any) => onErr(errText(e)))

  const loadDesk = () => api.linkedin().then(setPage, (e: any) => onErr(errText(e)))
  useEffect(() => { loadDesk(); api.linkedinAuth().then(setAuth, () => {}) }, [])
  useEffect(() => { load() }, [taskId])

  const running = hist?.running ?? false
  const awaiting = !!hist?.awaitingContext || pkgs.sends.some(s => s.state === 'awaiting_context_approval')
  const send = (raw = text) => {
    const t = raw.trim()
    if (!t || running || awaiting || !taskId) return
    sendChat(expand(t)).then(() => { setText(''); pkgs.load() }, (e: any) => onErr(errText(e)))
  }

  const desk = page?.desk
  const week = desk ? desk.history.filter(e => e.status === 'publicado' && e.kind === 'post' && e.date >= monday()).length : 0
  const status = !page ? 'Abrindo sua mesa…'
    : running ? 'Trabalhando.'
    : !desk!.hasProfile ? 'Ainda não conheço seu perfil. Comece por ele.'
    : desk!.drafts.length ? `${n(desk!.drafts.length, 'rascunho esperando', 'rascunhos esperando')} a sua leitura.`
    : 'Mesa vazia. Peça rascunhos novos.'
  const model = sel.model ? modelName(sel.model) : PROVIDER[sel.provider]?.label ?? sel.provider
  const msgList = hist?.messages.filter(m => m.role !== 'system') ?? []

  return (
    <main className="li">
      <section className="li-talk" aria-label="Conversa com o agente do LinkedIn">
        <header className="li-head">
          <span className={`li-orb ${running ? 'on' : ''}`} aria-hidden="true" />
          <div>
            <h1>LinkedIn</h1>
            <p className="li-status" role="status">{status}</p>
          </div>
          {desk?.perWeek != null && <div className="li-week" title={`Meta do perfil: ${desk.perWeek} por semana. Conta os marcados como publicados desde segunda.`}>
            <span className="li-ticks" aria-hidden="true">{Array.from({ length: Math.max(desk.perWeek, week) }, (_, i) => <i key={i} className={i < week ? 'on' : ''} />)}</span>
            <small>{week} de {n(desk.perWeek, 'post', 'posts')} esta semana</small>
          </div>}
        </header>

        <div className="li-msgs" ref={msgs} aria-live="polite">
          {msgList.length === 0 && !running && <div className="li-empty">
            <p>Eu escrevo, pesquiso e edito. Quem publica é você.</p>
            {!desk?.hasProfile && <button className="primary" onClick={() => send('Vamos montar o meu perfil.md.')} disabled={!page}>Montar meu perfil</button>}
          </div>}
          {msgList.map(m => m.role === 'user'
            ? <p key={m.id} className="li-you">{stripMarks(m.text)}</p>
            : <div key={m.id} className={`li-agent ${m.status ?? ''}`}><Markdown text={m.text} />{m.status === 'failed' && <small className="err">Falhou. Tente de novo.</small>}</div>)}
          {running && <div className="li-agent streaming">{live && live !== '…' ? <Markdown text={live} /> : <span className="typing" aria-label="Trabalhando"><i /><i /><i /></span>}</div>}
        </div>

        <div className="li-dock">
          {taskId > 0 && <>
            <ContextRequests pkgs={pkgs.list} sends={pkgs.sends} accounts={accounts} reload={() => { pkgs.load(); load() }} />
            <UnsentMessages sends={pkgs.sends} reload={pkgs.load} onRecover={t => setText(t)} />
            <PermissionPrompt inline taskId={taskId} />
          </>}
          <div className="li-cmds">
            {CMDS.map(([c, label]) => <button key={c} className="li-cmd" disabled={running} title={c} onClick={() => { setText(c + ' '); input.current?.focus() }}>{label}</button>)}
          </div>
          <form className={`li-console ${running ? 'on' : ''}`} onSubmit={e => { e.preventDefault(); send() }}>
            <textarea ref={input} rows={1} aria-label="Mensagem para o agente do LinkedIn" value={text} disabled={!page}
              placeholder={awaiting ? 'Decida sobre o contexto pendente acima para continuar' : 'Fale com seu agente, ou use / para um comando'}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
            {agents.length
              ? <span className="li-agents" role="radiogroup" aria-label="Agente">
                  {agents.map(a => <button type="button" key={a.name} role="radio" aria-checked={isSel(a, sel)} disabled={running || awaiting}
                    title={`${PROVIDER[a.provider]?.label ?? a.provider} ${modelName(a.model)}${a.effort ? `, esforço ${effortLabel(a.effort).toLowerCase()}` : ''}. Vale a partir da próxima mensagem.`}
                    onClick={() => !isSel(a, sel) && pick(a)}>{a.name}</button>)}
                </span>
              : <span className="li-model" title="Crie agentes com nome em Configurações, Agentes, para alternar aqui">{model}</span>}
            {running
              ? <button type="button" className="send stop" aria-label="Parar" onClick={() => api.stopTask(taskId).then(load)}><Icon n="stop" size={16} /></button>
              : <button className="send" aria-label="Enviar" disabled={!text.trim() || awaiting}><Icon n="send" size={18} /></button>}
          </form>
        </div>
      </section>

      <aside className="li-desk" aria-label="Mesa">
        {posted && <p className="li-posted" role="status"><Icon n="check" size={14} />Publicado.<button className="link" onClick={() => api.openUrl(posted)}>Ver no LinkedIn</button></p>}
        <div className="li-desk-head"><h2>Rascunhos</h2>
          <button className="icon sm" aria-label="Abrir pasta dos rascunhos" title="Abrir pasta" onClick={() => api.linkedinOpen('rascunhos')}><Icon n="folder" size={15} /></button></div>
        {!desk ? <span className="loader" aria-label="Carregando" />
          : desk.drafts.length === 0 ? <p className="hint">Os posts que o agente escrever aparecem aqui como vão ficar no feed.</p>
          : <ul className="li-drafts">{desk.drafts.map(d => <DraftCard key={d.name} d={d} connected={!!auth?.connected} onPublished={u => { setPosted(u ?? ''); loadDesk() }} onErr={onErr} />)}</ul>}
        {desk && desk.videos.length > 0 && <>
          <div className="li-desk-head"><h2>Vídeos</h2>
            <button className="icon sm" aria-label="Abrir pasta dos vídeos" title="Abrir pasta" onClick={() => api.linkedinOpen('videos')}><Icon n="folder" size={15} /></button></div>
          <ul className="li-videos">{desk.videos.map(v => <li key={v.name}><Icon n="image" size={14} />{v.name}</li>)}</ul>
        </>}
        {auth && <div className="li-desk-foot"><Connect auth={auth} onAuth={setAuth} onErr={onErr} /></div>}
      </aside>
    </main>
  )
}
