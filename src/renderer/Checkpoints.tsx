// Checkpoints do turno: com o commit automatico ligado (Configuracoes > Agentes) a pasta congela antes de cada mensagem;
// aqui o usuario cria um ponto manual e volta a qualquer ponto (reset --hard + clean -fd,
// com previa e confirmacao). Arquivos ignorados (.env, .godot/) nunca entram nem saem.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, errText, onChat } from './api'
import { Icon } from './icons'
import { Confirm } from './Nav'

type Cp = { id: number; task_id: number; run_id: number | null; workspace: string; head: string | null; base: string | null; committed: number; message: string; created_at: string }
type Preview = { checkpoint: Cp; headNow: string | null; dirtyNow: boolean; token: string; blocked: string[] }

const short = (h: string | null) => h?.slice(0, 7) ?? '—'
const when = (c: string) => c.slice(0, 16).replace('T', ' ')

export function Checkpoints({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const [list, setList] = useState<Cp[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [prev, setPrev] = useState<Preview | null>(null)

  const load = () => api.listCheckpoints(taskId).then(setList, (e: any) => setErr(errText(e)))
  useEffect(() => { load() }, [taskId])
  useEffect(() => onChat(ev => { if (ev.taskId === taskId && (ev.refresh || ev.done)) load() }), [taskId])
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') prev ? setPrev(null) : onClose() }; document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [prev])

  const create = () => { setBusy(true); setErr(''); api.createCheckpoint(taskId).then(() => load(), (e: any) => setErr(errText(e))).finally(() => setBusy(false)) }
  const askBack = (id: number) => { setErr(''); api.previewCheckpointRewind(taskId, id).then(setPrev, (e: any) => setErr(errText(e))) }
  const goBack = () => {
    if (!prev || prev.blocked.length) return
    setBusy(true)
    api.rewindCheckpoint(taskId, prev.checkpoint.id, prev.token).then(() => { setPrev(null); load() }, (e: any) => { setPrev(null); setErr(errText(e)) }).finally(() => setBusy(false))
  }

  return createPortal(
    <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal publish" role="dialog" aria-modal="true" aria-label="Checkpoints do turno">
        <header><h2>Checkpoints do turno</h2><button type="button" className="icon sm" aria-label="Fechar" onClick={onClose}><Icon n="close" size={15} /></button></header>
        <p className="muted">A pasta congela sozinha antes de cada mensagem. Voltar descarta o que veio depois (mudanças não salvas e arquivos novos); ignorados como .env ficam intactos.</p>
        {err && <p className="err">{err}</p>}
        {!list
          ? <span className="loader" aria-label="Lendo checkpoints" />
          : list.length === 0
            ? <p className="muted">Nenhum checkpoint ainda. Crie um agora ou ligue o commit automático em Configurações › Agentes.</p>
            : <ul className="br-commits">
              {list.map(c => (
                <li key={c.id}><code>{short(c.head)}</code><span>Checkpoint #{c.id}{c.run_id ? ` · execução ${c.run_id}` : ''}{c.committed ? '' : ' · sem mudanças'}</span><small>{when(c.created_at)}</small>
                  <button type="button" className="icon sm" aria-label={`Voltar ao checkpoint ${c.id}`} title={`Voltar a ${short(c.head)}`} disabled={busy} onClick={() => askBack(c.id)}><Icon n="restore" size={15} /></button>
                </li>
              ))}
            </ul>}
        <footer>
          <span />
          <button type="button" onClick={create} disabled={busy}><Icon n="plus" size={14} />{busy ? ' Congelando…' : ' Criar checkpoint agora'}</button>
        </footer>
        {prev && <Confirm title={`Voltar ao checkpoint #${prev.checkpoint.id} (${short(prev.checkpoint.head)})?`}
          body={[`A pasta volta exatamente ao estado de ${when(prev.checkpoint.created_at)}.`,
            prev.dirtyNow ? 'Há mudanças não salvas e/ou arquivos novos: tudo será descartado.' : 'A pasta já está limpa; só os commits posteriores saem do caminho.',
            ...prev.blocked].join(' ')}
          action="Voltar a este ponto" tone="danger" onConfirm={goBack} onClose={() => setPrev(null)} />}
      </div>
    </div>, document.body)
}
