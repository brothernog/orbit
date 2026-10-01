import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, name, onChat } from './api'
import { Icon, PROVIDER } from './icons'
import { expireRead, loadRead } from './readCache'
import { useCachedRead } from './useCachedRead'
import './permission.css'

type Sug = { pattern: string; label: string; risk: 'low' | 'broad' | 'destructive'; reason: string }
export type PermissionReq = {
  id: number; task_id: number | null; provider: string; tool: string; kind: 'bash' | 'tool'; command: string | null; summary: string
  cwd: string | null; state: string; risk: string | null; suggestions?: Sug[]
}

// Uma so consulta para todas as instancias (pop-up global + cartao do chat): o evento recarrega na hora (descartando uma consulta
// anterior ainda em voo, que pode nao ter o pedido novo) e a rede de seguranca de 4 s so roda com a janela visivel.
const KEY = 'listPermissionRequests'
const loadReqs = (fresh = false) => { if (fresh) expireRead(KEY); loadRead<PermissionReq[]>(KEY, () => api.listPermissionRequests()).catch(() => {}) }
let watchers = 0, unwatch = () => {}
function watchRequests() {
  if (watchers++ === 0) {
    const visible = () => { if (document.visibilityState === 'visible') loadReqs() }
    const off = onChat(ev => { if (ev?.permissionRequest || ev?.permissionResolved) loadReqs(true) })
    const t = setInterval(visible, 4000)
    document.addEventListener('visibilitychange', visible)
    unwatch = () => { off(); clearInterval(t); document.removeEventListener('visibilitychange', visible) }
  }
  return () => { if (--watchers === 0) unwatch() }
}

// Pop-up de permissao dos agentes (equivalente ao dos apps Claude Code/Codex): aparece quando o Claude pede para executar algo que nao
// esta liberado por regra. Componente isolado: usa so `api` (IPC listPermissionRequests/resolvePermissionRequest) e o evento do chat.
// Encaixe: montar UMA vez, perto da raiz de App.tsx (ex.: ao lado do <main>), como <PermissionPrompt />. Nao exige props.
// inline: cartao acima do composer do chat, so com os pedidos da tarefa aberta. Global: modal para os pedidos das outras tarefas.
export function PermissionPrompt({ taskId, inline }: { taskId?: number; inline?: boolean } = {}) {
  const all = useCachedRead<PermissionReq[]>(KEY, () => api.listPermissionRequests()).data
  const reqs = useMemo(() => (all ?? []).filter(r => r.state === 'pending' && (inline ? r.task_id === taskId : taskId == null || r.task_id !== taskId)), [all, taskId, inline])
  const [always, setAlways] = useState(false)
  const [pick, setPick] = useState(0)
  const [project, setProject] = useState(false)
  const [ack, setAck] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(watchRequests, [])

  const r = reqs[0]
  useEffect(() => { setAlways(false); setPick(0); setProject(false); setAck(false); setErr('') }, [r?.id])
  useEffect(() => { if (r) box.current?.querySelector<HTMLButtonElement>('[data-first]')?.focus() }, [r?.id])
  if (!r) return null

  const sugs = r.suggestions ?? []
  const chosen = sugs[pick]
  const wildcard = !!chosen && (chosen.pattern === '*' || chosen.pattern.endsWith(' *'))
  const refused = !!chosen && chosen.risk === 'destructive' && wildcard // curinga sobre destrutivo: o backend recusa sempre
  const needAck = !!chosen && chosen.risk !== 'low'
  const destructive = r.risk === 'destructive'
  const answer = (decision: 'allow_once' | 'allow_always' | 'deny') => {
    setBusy(true); setErr('')
    api.resolvePermissionRequest(r.id, decision, { pattern: chosen?.pattern, project, acknowledged: ack })
      .then(() => loadReqs(true), (e: any) => setErr(errText(e)))
      .finally(() => setBusy(false))
  }
  const key = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); answer('deny') } } // Esc nega: o caminho seguro

  return (
    <div className={inline ? 'pp-inline' : 'pp-backdrop'}>
      <div className="pp" role="alertdialog" aria-modal={!inline} aria-labelledby="pp-title" aria-describedby="pp-body" ref={box} onKeyDown={key}>
        <h2 id="pp-title"><Icon n="alert" size={18} /> {PROVIDER[r.provider]?.label ?? r.provider} pede permissão{reqs.length > 1 && <small className="pp-count">1 de {reqs.length}</small>}</h2>
        <div id="pp-body">
          <p className="pp-what">{r.kind === 'bash' ? 'Executar este comando' : `Usar a ferramenta ${r.tool}`}{r.cwd && <> em <b>{name(r.cwd)}</b></>}:</p>
          <pre className="pp-cmd">{r.summary}</pre>
          {destructive && <p className="pp-warn" role="alert">Este comando parece <b>destrutivo</b> (apagar, sobrescrever histórico, publicar ou executar código baixado). Confira antes de permitir.</p>}
        </div>
        {always && (
          <fieldset className="pp-always">
            <legend>Sempre permitir para {PROVIDER[r.provider]?.label ?? r.provider}</legend>
            {sugs.map((s, i) => {
              const bad = s.risk === 'destructive' && (s.pattern === '*' || s.pattern.endsWith(' *'))
              return (
                <label key={s.pattern} className={`pp-opt ${bad ? 'off' : ''}`}>
                  <input type="radio" name="pp-pattern" checked={pick === i} disabled={bad} onChange={() => { setPick(i); setAck(false) }} />
                  <span>{s.label}<code>{s.pattern}</code>{s.risk !== 'low' && <em className={`pp-risk ${s.risk}`}>{bad ? 'recusada: ' : s.risk === 'destructive' ? 'destrutivo: ' : 'ampla: '}{s.reason}</em>}</span>
                </label>
              )
            })}
            {r.cwd && <label className="check"><input type="checkbox" checked={project} onChange={e => setProject(e.target.checked)} /> Só neste projeto ({name(r.cwd)})</label>}
            {needAck && !refused && <label className="check pp-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> Entendo o risco desta regra</label>}
          </fieldset>
        )}
        {err && <small className="err" role="alert">{err}</small>}
        <div className="pp-actions">
          {!always ? (
            <>
              <button type="button" className="primary" data-first={destructive ? undefined : true} disabled={busy} onClick={() => answer('allow_once')}>Permitir uma vez</button>
              <button type="button" disabled={busy} onClick={() => setAlways(true)}>Sempre permitir…</button>
              <button type="button" data-first={destructive ? true : undefined} disabled={busy} onClick={() => answer('deny')}>Negar</button>
            </>
          ) : (
            <>
              <button type="button" className="primary" data-first disabled={busy || !chosen || refused || (needAck && !ack)} onClick={() => answer('allow_always')}>Sempre permitir</button>
              <button type="button" disabled={busy} onClick={() => setAlways(false)}>Voltar</button>
              <button type="button" disabled={busy} onClick={() => answer('deny')}>Negar</button>
            </>
          )}
        </div>
        <small>Sem resposta o pedido expira e a ação é negada. Esc nega.</small>
      </div>
    </div>
  )
}
