import { useEffect, useRef, useState } from 'react'
import { api, errText, onChat, type Account } from './api'
import { Avatar, Icon, PROVIDER } from './icons'
import { coverTitle, totalText, type TotalLike } from './usageText'
import { useCachedRead } from './useCachedRead'

// Contexto da tarefa: pedidos de aprovacao (o que vai para outro agente), memoria, uso e pacotes ja enviados.
// A aprovacao manda so ID + hash do que foi exibido (e, se o usuario desmarcou itens, as refs mantidas); o processo principal valida e decide o resto.
type Item = { ref: string; kind: string; title: string; content: string }
type Recipient = { provider: string; profile?: string; model?: string | null; effort?: string | null; workspace?: string; scope: string[] }
type Pkg = {
  id: number; source: string; recipient: Recipient
  items: Item[]; hash: string; size: number; state: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'; reason: string | null; created_at: string; resolved_at: string | null
  delivery?: { confirmed: number; sent: number; failed: number } // entrega e um estado SEPARADO do consentimento
  omitted?: { ref: string; kind: string; title: string; why: string; requirement?: boolean }[] // candidatos que NAO entraram (nao sao enviados)
}
// Mensagem retida ate a decisao sobre o contexto de que depende (nenhum agente foi iniciado).
export type PendingSend = { id: number; task_id: number; package_id: number | null; text: string; sel: { provider: string; model?: string; effort?: string }; state: 'awaiting_context_approval' | 'starting' | 'sent' | 'cancelled' | 'expired'; reason: string | null; created_at: string }
const when = (iso: string) => new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))
const fmt = (n: number | null | undefined) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n))
const SOURCE = { delegation: 'para a delegação', history: 'anterior da tarefa (memória pertinente e histórico)', memory: 'memória da tarefa' } as Record<string, string>
const who = (r: Recipient) => [PROVIDER[r.provider]?.label ?? r.provider, r.model, r.effort].filter(Boolean).join(' ')

// Pacotes e mensagens retidas da tarefa, recarregados quando o processo principal avisa (pedido novo, resolvido ou mensagem de sistema).
export function usePackages(taskId: number) {
  const [list, setList] = useState<Pkg[]>([])
  const [sends, setSends] = useState<PendingSend[]>([])
  const load = () => Promise.all([api.listContextPackages(taskId).then(setList, () => {}), api.listPendingSends(taskId).then(setSends, () => {})])
  useEffect(() => {
    load()
    return onChat(ev => { if (ev.taskId === taskId && (ev.contextRequest || ev.contextResolved || ev.refresh || ev.done)) load() })
  }, [taskId])
  return { list, sends, load }
}

// O prazo so EXPIRA o pedido: nunca inicia a execucao. Para delegacao o pai desiste e o filho nao comeca; para mensagem retida ela nao e enviada.
function Countdown({ from, minutes, what }: { from: string; minutes: number; what: 'send' | 'delegation' }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const left = Math.max(0, when(from).getTime() + minutes * 60000 - Date.now())
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000)
  const consequence = what === 'send' ? 'a mensagem NÃO é enviada e nenhum agente é iniciado (o texto fica guardado para você recuperar)' : 'a delegação NÃO inicia (o agente pai é avisado)'
  return <span className={`countdown ${left < 60000 ? 'hot' : ''}`} title={`Sem decisão até o fim do prazo, ${consequence}.`}>{left ? `${m}:${String(s).padStart(2, '0')}` : 'expirando'}</span>
}

const account = (r: Recipient, accounts: Account[]) => (r.provider === 'claude' && r.profile ? accounts.find(a => String(a.id) === r.profile)?.name ?? `conta ${r.profile}` : null)
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// Cartao acima do compositor: um pedido por vez, com destinatario completo e o conteudo exato que sera enviado. Nada roda antes da decisao.
export function ContextRequests({ pkgs, sends, accounts = [], reload }: { pkgs: Pkg[]; sends: PendingSend[]; accounts?: Account[]; reload: () => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const limit = useCachedRead<{ approvalTimeoutMin: number }>('getContextLimits', () => api.getContextLimits()).data?.approvalTimeoutMin ?? 10
  const [drop, setDrop] = useState<Set<string>>(new Set()) // itens desmarcados: nao vao (o backend cria um pacote novo so com os marcados)
  const primary = useRef<HTMLButtonElement>(null)
  const pending = pkgs.filter(p => p.state === 'pending')
  const p = pending[pending.length - 1] // o mais antigo primeiro: e o que expira antes
  const send = p ? sends.find(s => s.package_id === p.id && s.state === 'awaiting_context_approval') : undefined
  useEffect(() => { if (p) primary.current?.focus(); setDrop(new Set()) }, [p?.id]) // o teclado cai na decisao quando ela aparece; selecao volta a "tudo"
  if (!p) return null
  const kept = p.items.filter(i => !drop.has(i.ref))
  const toggle = (ref: string) => setDrop(d => { const n = new Set(d); if (n.has(ref)) n.delete(ref); else n.add(ref); return n })
  const decide = (d: 'approve' | 'reject' | 'cancel') => {
    setBusy(true); setErr('')
    const keep = d === 'approve' && drop.size ? kept.map(i => i.ref) : undefined // so com algo desmarcado; senao a aprovacao e a normal
    const call = send ? api.decideSend(send.id, p.hash, d, keep) : api.resolveContextPackage(p.id, p.hash, d, keep)
    call.then(reload, e => setErr(errText(e))).finally(() => setBusy(false))
  }
  const r = p.recipient, acc = account(r, accounts)
  const labels = send
    ? { ok: 'Aprovar e executar', okHint: 'Envia o contexto exato abaixo junto com a sua mensagem e só então inicia o agente', no: 'Executar sem contexto', noHint: 'Inicia o agente só com a sua mensagem; o contexto recusado não é enviado', cancel: 'Cancelar envio' }
    : p.source === 'delegation'
      ? { ok: 'Aprovar e enviar', okHint: 'O filho recebe exatamente este pacote', no: 'Continuar sem contexto', noHint: 'A delegação continua, mas sem este contexto', cancel: 'Cancelar delegação' }
      : { ok: 'Aprovar', okHint: 'Vale para as próximas mensagens a este destino', no: 'Recusar contexto', noHint: 'O agente continua sem este contexto', cancel: 'Cancelar pedido' }
  return (
    <div className="ctx-req" role="region" aria-label="Decisão sobre contexto pendente" aria-describedby="cr-desc">
      <div className="cr-head">
        <Avatar provider={r.provider} size="sm" />
        <span className="cr-title" id="cr-desc">{send ? <>Sua mensagem está <b>retida</b>: <b>{who(r)}</b> só inicia depois da sua decisão sobre o contexto {SOURCE[p.source] ?? ''}</> : <><b>{who(r)}</b> pede contexto {SOURCE[p.source] ?? ''}</>}</span>
        {pending.length > 1 && <span className="count">{pending.length} pedidos</span>}
        <Countdown from={p.created_at} minutes={limit} what={send ? 'send' : 'delegation'} />
      </div>
      <dl className="cr-dest" aria-label="Destinatário">
        <div><dt>Provedor</dt><dd>{PROVIDER[r.provider]?.label ?? r.provider}</dd></div>
        {acc && <div><dt>Conta</dt><dd>{acc}</dd></div>}
        <div><dt>Modelo</dt><dd>{r.model ?? 'padrão'}</dd></div>
        <div><dt>Esforço</dt><dd>{r.effort ?? 'padrão'}</dd></div>
        {r.workspace && <div><dt>Pasta</dt><dd title={r.workspace}>{base(r.workspace)}</dd></div>}
        <div><dt>Escopo</dt><dd>{r.scope.length ? r.scope.join(', ') : 'pasta inteira'}</dd></div>
      </dl>
      {send && <p className="cr-msg"><small>Sua mensagem (será enviada só depois da decisão):</small><q>{send.text.length > 240 ? `${send.text.slice(0, 240)}…` : send.text}</q></p>}
      <button className="cr-summary" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
        <Icon n="chevron" size={12} />{drop.size ? `${kept.length} de ${p.items.length} itens marcados` : `${p.items.length} ${p.items.length === 1 ? 'item' : 'itens'}`}, {fmt(drop.size ? kept.reduce((n, i) => n + i.title.length + i.content.length, 0) : p.size)} caracteres. Ver exatamente o que vai{p.items.length > 1 ? ' (e desmarcar o que não precisa)' : ''}.
      </button>
      {open === p.id && <ul className="cr-items">
        {p.items.map(i => <li key={i.ref} className={drop.has(i.ref) ? 'dropped' : ''}>
          {p.items.length > 1 && <label className="cr-pick" title="Desmarcado: não é enviado (o que já está na memória estruturada pode bastar)">
            <input type="checkbox" checked={!drop.has(i.ref)} disabled={busy} onChange={() => toggle(i.ref)} aria-label={`Enviar “${i.title}”`} />
          </label>}
          <b>{i.title}</b><small>{i.kind}</small><pre>{i.content}</pre></li>)}
      </ul>}
      {drop.size > 0 && p.items.some(i => drop.has(i.ref) && (i.kind === 'objective' || i.kind === 'constraint')) &&
        <small className="err" role="note">Você desmarcou objetivo/restrição: o agente não vai recebê-los.</small>}
      {!!p.omitted?.length && <div className={`cr-omitted ${p.omitted.some(o => o.requirement) ? 'warn' : ''}`} role="note">
        {p.omitted.some(o => o.requirement) && <b>Atenção: {p.omitted.filter(o => o.requirement).length} objetivo(s)/restrição(ões) NÃO couberam neste pacote. Cancele e amplie os limites em Configurações, ou execute sem este contexto sabendo disso.</b>}
        <details><summary>{p.omitted.length} item(ns) não incluído(s): não serão enviados</summary>
          <ul>{p.omitted.map(o => <li key={o.ref + o.why}><b>{o.title}</b> <small>{o.kind}</small> — {o.why}</li>)}</ul>
        </details>
      </div>}
      <div className="cr-actions">
        <button ref={primary} className="primary" disabled={busy || !kept.length} title={kept.length ? labels.okHint : `Nenhum item marcado: use “${labels.no}”`} onClick={() => decide('approve')}>{drop.size && kept.length ? `${labels.ok} (${kept.length} de ${p.items.length})` : labels.ok}</button>
        <button disabled={busy} onClick={() => decide('reject')} title={labels.noHint}>{labels.no}</button>
        <button className="text-btn danger" disabled={busy} onClick={() => decide('cancel')}>{labels.cancel}</button>
      </div>
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

// Mensagens que NAO foram enviadas (canceladas ou expiradas): o texto nao se perde.
export function UnsentMessages({ sends, reload, onRecover }: { sends: PendingSend[]; reload: () => void; onRecover: (text: string) => void }) {
  const [err, setErr] = useState('')
  const unsent = sends.filter(s => s.state === 'cancelled' || s.state === 'expired')
  if (!unsent.length) return null
  return (
    <div className="ctx-req unsent" role="region" aria-label="Mensagem não enviada">
      {unsent.map(s => (
        <div key={s.id} className="cr-head">
          <span className="cr-title"><b>Mensagem não enviada</b> ({s.state === 'expired' ? 'sem decisão no prazo' : 'cancelada'}). Nenhum agente foi iniciado. <q>{s.text.length > 80 ? `${s.text.slice(0, 80)}…` : s.text}</q></span>
          <button className="text-btn" onClick={() => api.recoverSend(s.id).then(t => { if (t != null) onRecover(t); reload() }, e => setErr(errText(e)))}>Recuperar texto</button>
        </div>
      ))}
      {err && <small className="err" role="alert">{err}</small>}
    </div>
  )
}

const KIND: Record<string, string> = { objective: 'Objetivo', constraint: 'Restrição', decision: 'Decisão', todo: 'A fazer', finding: 'Descoberta', validation: 'Validação', checkpoint: 'Checkpoint' }
const VALID: Record<string, [string, string]> = { valid: ['Válido', 'ok'], stale: ['Arquivos mudaram', 'warn'], superseded: ['Substituído', 'faint'], unknown: ['Não verificado', 'faint'] }
const TODO: Record<string, string> = { open: 'Aberto', doing: 'Fazendo', done: 'Feito', blocked: 'Bloqueado' }
// Consentimento e entrega sao estados diferentes: "aprovado" nao quer dizer "enviado".
const STATE: Record<string, string> = { rejected: 'Recusado (sem contexto)', expired: 'Expirou (nada foi enviado)', cancelled: 'Cancelado', pending: 'Aguardando decisão' }
export function pkgStatus(p: Pkg): [string, 'ok' | 'faint' | 'warn'] {
  if (p.state === 'cancelled' && p.reason === 'revogado pelo usuario') return ['Revogado (envios futuros bloqueados)', 'faint']
  if (p.state !== 'approved') return [STATE[p.state] ?? p.state, 'faint']
  const d = p.delivery ?? { confirmed: 0, sent: 0, failed: 0 }
  if (d.confirmed) return ['Entregue', 'ok']
  if (d.sent) return ['Enviado, confirmação pendente', 'warn']
  if (d.failed) return ['Falhou ao enviar', 'warn']
  return ['Aprovado, ainda não enviado', 'ok']
}

function Memory({ taskId }: { taskId: number }) {
  const [items, setItems] = useState<any[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { api.taskMemory(taskId).then(setItems, () => setItems([])) }, [taskId])
  if (!items) return <span className="loader" aria-label="Carregando memória" />
  if (!items.length) return <p className="muted">Nada na memória ainda. Os agentes guardam aqui objetivos, decisões e descobertas enquanto trabalham.</p>
  const groups = Object.keys(KIND).map(k => [k, items.filter(i => i.kind === k)] as const).filter(([, l]) => l.length)
  return (
    <div className="mem">
      {groups.map(([k, l]) => (
        <section key={k}>
          <h3>{KIND[k]} <span className="count">{l.length}</span></h3>
          <ul>
            {l.map(m => {
              const [v, tone] = VALID[m.validity] ?? VALID.unknown
              return (
                <li key={m.id} className={m.state !== 'active' ? 'dim' : ''}>
                  <button className="mem-row" aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                    <span className="mem-title">{m.title}</span>
                    {m.todo_state && <span className="tag">{TODO[m.todo_state] ?? m.todo_state}</span>}
                    <span className={`vtag ${tone}`}>{v}</span>
                  </button>
                  {open === m.id && <div className="mem-body">
                    <p>{m.content}</p>
                    {m.paths.length > 0 && <small>{m.paths.join(', ')}</small>}
                  </div>}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

// Entrada + saida so sao "completas" quando os DOIS campos foram informados por todas as execucoes (calculado no processo principal: usage.ts).
const tokens = (b: any): TotalLike => b.tokens
const detail = (b: any) => `Entrada ${totalText(b.input)}, saída ${totalText(b.output)}, cache lido ${totalText(b.cacheRead)}, cache gravado ${totalText(b.cacheWrite)}, raciocínio ${totalText(b.reasoning)}; ${b.records} execução(ões). Ferramentas executadas: ${totalText(b.toolCalls)} (não são chamadas ao modelo).`

function Usage({ taskId }: { taskId: number }) {
  const [u, setU] = useState<any>(null)
  useEffect(() => { api.taskUsage(taskId).then(setU, () => setU({ error: true })) }, [taskId])
  if (!u) return <span className="loader" aria-label="Carregando uso" />
  if (u.error || !u.all.records) return <p className="muted">Nenhum uso registrado nesta tarefa ainda.</p>
  const all = tokens(u.all)
  const max = Math.max(1, ...u.byProvider.map((b: any) => tokens(b).sum ?? 0))
  const r = u.rework
  return (
    <div className="usage-p">
      {all.state !== 'complete' && <p className="muted" role="note">{all.state === 'partial' ? 'Total conhecido (parcial): algumas execuções não informaram todos os campos, então o consumo real é maior ou igual ao mostrado.' : 'Nenhum provedor informou tokens nesta tarefa: não há total, e isso não significa consumo zero.'}</p>}
      <div className="u-sum">
        <div><span>{all.state === 'partial' ? 'Total conhecido (parcial)' : 'Total'}</span><b title={coverTitle(all)}>{totalText(all)}</b><small>tokens informados</small></div>
        <div><span>Conversa (pai)</span><b title={coverTitle(tokens(u.parent))}>{totalText(tokens(u.parent))}</b></div>
        <div><span>Delegações (filhos)</span><b title={coverTitle(tokens(u.children))}>{totalText(tokens(u.children))}</b></div>
      </div>
      <ul className="u-list">
        {u.byProvider.map((b: any) => (
          <li key={b.provider + b.model}>
            <Avatar provider={b.provider} size="sm" />
            <span className="u-name">{PROVIDER[b.provider]?.label ?? b.provider}{b.model ? ` ${b.model}` : ''}</span>
            <span className="u-bar"><i style={{ width: `${((tokens(b).sum ?? 0) / max) * 100}%` }} /></span>
            <span className="u-val" title={`${coverTitle(tokens(b))} ${detail(b)}`}>{totalText(tokens(b))}</span>
          </li>
        ))}
      </ul>
      <small className="muted">Retrabalho: {r.continuations} continuação(ões) de filho, {r.failedDelegations} delegação(ões) que falharam, {r.retries} nova(s) tentativa(s) da CLI. Chamadas ao modelo: indisponível (as CLIs não informam).</small>
      {u.all.unavailable > 0 && <small className="muted">{u.all.unavailable} execução(ões) sem medida: o provedor não informou tokens.</small>}
    </div>
  )
}

function Sent({ pkgs, reload }: { pkgs: Pkg[]; reload: () => void }) {
  const done = pkgs.filter(p => p.state !== 'pending')
  const [err, setErr] = useState('')
  if (!done.length) return <p className="muted">Nenhum contexto foi pedido nesta tarefa.</p>
  return (
    <ul className="sent">
      {done.map(p => (
        <li key={p.id}>
          <Avatar provider={p.recipient.provider} size="sm" />
          <span className="sent-body"><b>{who(p.recipient)}</b><small>{p.items.length} {p.items.length === 1 ? 'item' : 'itens'}, {fmt(p.size)} caracteres{p.reason ? `. ${p.reason}` : ''}</small></span>
          <span className={`vtag ${pkgStatus(p)[1]}`}>{pkgStatus(p)[0]}</span>
          {p.state === 'approved' && <button className="text-btn" title="Impede envios futuros deste pacote; o que já foi recebido não é apagado"
            onClick={() => api.revokeContextPackage(p.id).then(reload, (e: any) => setErr(errText(e)))}>Revogar</button>}
        </li>
      ))}
      {err && <li><small className="err">{err}</small></li>}
    </ul>
  )
}

// Gaveta lateral dentro do chat.
export function TaskInspector({ taskId, pkgs, reload, onClose }: { taskId: number; pkgs: Pkg[]; reload: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<'mem' | 'use' | 'sent'>('mem')
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [])
  return (
    <aside className="inspector" aria-label="Contexto da tarefa">
      <header>
        <div role="tablist" aria-label="Contexto da tarefa">
          {([['mem', 'Memória'], ['use', 'Uso'], ['sent', 'Contexto']] as const).map(([id, t]) =>
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{t}</button>)}
        </div>
        <button className="icon sm" aria-label="Fechar" onClick={onClose}><Icon n="close" size={15} /></button>
      </header>
      <div className="insp-body">
        {tab === 'mem' && <Memory taskId={taskId} />}
        {tab === 'use' && <Usage taskId={taskId} />}
        {tab === 'sent' && <Sent pkgs={pkgs} reload={reload} />}
      </div>
    </aside>
  )
}
