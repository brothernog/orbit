// Cartao dos arquivos que o agente enviou (send_user_file), no lugar da nota de sistema. O processo principal so devolve copias da
// pasta de envios da tarefa; marcador apontando para outro lugar aparece como indisponivel. "Abrir" so para tipos que nao executam.
import { useEffect, useState } from 'react'
import { api, errText } from './api'
import { Icon } from './icons'
import type { SharedInfo } from '../main/sharedFiles'

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)
const base = (p: string) => p.split(/[\\/]/).pop() ?? p
const ext = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toUpperCase()

export function SharedFiles({ taskId, refs, caption, onOpen }: { taskId: number; refs: string[]; caption: string; onOpen: (src: string) => void }) {
  const [info, setInfo] = useState<Record<string, SharedInfo | null>>({}) // ausente = carregando; null = indisponivel
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    setInfo({})
    for (const p of refs) api.sharedFile(taskId, p).then((i: SharedInfo | null) => i, () => null).then(i => { if (live) setInfo(m => ({ ...m, [p]: i })) })
    return () => { live = false }
  }, [taskId, refs.join('|')])
  const act = (p: string, reveal: boolean) => { setErr(''); api.openSharedFile(taskId, p, reveal).catch(e => setErr(errText(e))) }
  return (
    <div className="sent-files">
      {caption && <p className="sent-caption">{caption}</p>}
      {refs.map(p => {
        const f = info[p], name = f?.name ?? base(p), gone = f === null
        return (
          <div key={p} className={`sent-card ${f?.image ? 'has-img' : ''} ${gone ? 'gone' : ''}`}>
            {f?.image && <button className="sent-preview" aria-label={`Ampliar ${name}`} onClick={() => onOpen(f.image!)}><img src={f.image} alt="" /></button>}
            <div className="sent-row">
              {!f?.image && <span className="sent-type" aria-hidden>{ext(name) || <Icon n="files" size={16} />}</span>}
              <span className="sent-name">
                <b title={name}>{name}</b>
                <small>{gone ? 'não está mais disponível' : f ? `${ext(name) || 'arquivo'} · ${size(f.size)}` : 'carregando…'}</small>
              </span>
              {f?.openable && <button className="icon sm" aria-label={`Abrir ${name}`} title="Abrir" onClick={() => act(p, false)}><Icon n="eye" size={15} /></button>}
              {f && <button className="icon sm" aria-label={`Mostrar ${name} na pasta`} title="Mostrar na pasta" onClick={() => act(p, true)}><Icon n="folder" size={15} /></button>}
            </div>
          </div>
        )
      })}
      {err && <p className="sent-err" role="alert">{err}</p>}
    </div>
  )
}
